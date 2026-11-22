import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import {
  authenticateUser,
  createSession,
  createUser,
  deleteSession,
  purgeExpiredSessions,
  updateUserProfile,
  validateSession,
  type SafeUser,
} from './auth'
import type { RateLimiter } from './rate-limit'
import {
  checkEmailCodeSendGate,
  generateEmailCode,
  purgeStaleEmailCodes,
  storeEmailCode,
  verifyEmailCode,
} from './email-code'
import type { VerificationMailer } from './onemail'

export function extractSessionToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  const cookieHeader = request.headers.cookie
  if (typeof cookieHeader === 'string') {
    const match = cookieHeader.match(/oneimage_session=([^;]+)/)
    if (match) return match[1].trim()
  }
  return null
}

// Generation endpoints spend real operator money, so consuming routes share
// one gate: a valid session token is required, and anonymous/expired traffic
// gets a machine-readable 401 envelope the client turns into the login modal.
export function requireAuth(request: FastifyRequest, db: DatabaseSync): boolean {
  const token = extractSessionToken(request)
  if (!token) return false
  return validateSession(db, token) !== null
}

export function unauthorized(reply: FastifyReply, message: string): void {
  reply.status(401).send({ error: 'auth_required', message })
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    'Set-Cookie',
    `oneimage_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  )
}

function isValidEmail(email: string): boolean {
  return email.includes('@') && email.length <= 128
}

export interface AuthRoutesOptions {
  // Throttles the scrypt-backed endpoints (register/login): these are the only
  // public paths whose per-request CPU cost can be weaponized, and they are the
  // brute-force surface for credentials. The email-code sender shares this
  // limiter because each call triggers an outbound mail.
  rateLimiter?: RateLimiter
  // Verification-code mail delivery. Absent (env not configured) makes the
  // email-code endpoint return 503 while the rest of auth keeps working.
  mailer?: VerificationMailer
}

export function registerAuthRoutes(app: FastifyInstance, db: DatabaseSync, options: AuthRoutesOptions = {}): void {
  const rateLimiter = options.rateLimiter
  const mailer = options.mailer

  const denyWhenOverLimit = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (rateLimiter && !rateLimiter.allow(request)) {
      void reply.header('Retry-After', '60').status(429).send({
        error: 'rate_limited',
        message: '请求过于频繁，请稍后再试',
      })
      return true
    }
    return false
  }

  // Request a registration verification code. Gated three ways: the shared
  // per-client limiter, a per-email resend cooldown, and a per-email hourly
  // cap (both durable in SQLite) so a third party cannot mail-bomb an
  // arbitrary inbox through this endpoint. The code row is written only after
  // the mailer succeeds, so a transient delivery failure leaves any previous
  // still-valid code intact and consumes none of the send budget.
  const inFlightEmailCodes = new Set<string>()
  app.post('/api/v1/auth/email-code', async (request: FastifyRequest<{
    Body: { email?: string }
  }>, reply: FastifyReply) => {
    if (denyWhenOverLimit(request, reply)) return

    const email = (request.body?.email ?? '').trim().toLowerCase()
    if (!isValidEmail(email)) {
      return reply.status(400).send({
        error: 'invalid_email',
        message: '请输入有效的邮箱地址',
      })
    }

    if (!mailer) {
      return reply.status(503).send({
        error: 'mail_unconfigured',
        message: '邮件服务未配置，请联系站点管理员',
      })
    }

    const gate = checkEmailCodeSendGate(db, email)
    if (!gate.ok) {
      return reply.header('Retry-After', String(gate.retryAfterSeconds)).status(429).send({
        error: 'email_code_throttled',
        reason: gate.reason,
        message: gate.reason === 'cooldown' ? `发送过于频繁，请 ${gate.retryAfterSeconds} 秒后重试` : '该邮箱验证码发送次数已达上限，请 1 小时后重试',
        retryAfterSeconds: gate.retryAfterSeconds,
      })
    }

    // The send is awaited, so the durable gate alone cannot serialise
    // concurrent requests for one address; the in-flight mark closes that gap
    // within this process. The set is touched synchronously before the first
    // await, making the check-and-mark atomic per event-loop turn.
    if (inFlightEmailCodes.has(email)) {
      return reply.status(429).send({
        error: 'email_code_throttled',
        reason: 'cooldown',
        message: '验证码正在发送，请稍候',
      })
    }
    inFlightEmailCodes.add(email)
    try {
      const code = generateEmailCode()
      await mailer.sendVerificationCode(email, code)
      storeEmailCode(db, email, code)
    } catch (err: any) {
      request.log.error({ err }, 'Failed to send verification email')
      return reply.status(503).send({
        error: 'mail_send_failed',
        message: '验证码邮件发送失败，请稍后重试',
      })
    } finally {
      inFlightEmailCodes.delete(email)
    }
    return reply.status(200).send({ ok: true, resendAfterSeconds: 60 })
  })

  // Register
  app.post('/api/v1/auth/register', async (request: FastifyRequest<{
    Body: { username?: string; email?: string; password?: string; nickname?: string; email_code?: string }
  }>, reply: FastifyReply) => {
    if (denyWhenOverLimit(request, reply)) return
    const { username, email, password, nickname, email_code } = request.body || {}

    if (!username || !email || !password) {
      return reply.status(400).send({
        error: 'missing_fields',
        message: '用户名、邮箱和密码为必填项',
      })
    }

    const cleanUsername = username.trim().toLowerCase()
    const cleanEmail = email.trim().toLowerCase()

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(cleanUsername)) {
      return reply.status(400).send({
        error: 'invalid_username',
        message: '用户名须为 3-24 位字母、数字或下划线',
      })
    }

    if (!isValidEmail(cleanEmail)) {
      return reply.status(400).send({
        error: 'invalid_email',
        message: '请输入有效的邮箱地址',
      })
    }

    if (password.length < 8 || password.length > 128) {
      return reply.status(400).send({
        error: 'invalid_password',
        message: '密码长度需在 8-128 位之间',
      })
    }

    // Registration requires a valid email verification code: single-use
    // (deleted on success), 10-minute expiry, and locked after 5 wrong
    // attempts.
    if (!email_code) {
      return reply.status(400).send({
        error: 'email_code_required',
        message: '请先获取邮箱验证码',
      })
    }
    const codeResult = verifyEmailCode(db, cleanEmail, String(email_code))
    if (codeResult !== 'ok') {
      const errorCodes = {
        missing: 'email_code_required',
        expired: 'email_code_expired',
        locked: 'email_code_locked',
        mismatch: 'invalid_email_code',
      } as const
      const messages: Record<Exclude<typeof codeResult, 'ok'>, string> = {
        missing: '请先获取邮箱验证码',
        expired: '验证码已过期，请重新获取',
        locked: '验证码错误次数过多，请重新获取',
        mismatch: '验证码错误，请检查后重试',
      }
      return reply.status(400).send({
        error: errorCodes[codeResult],
        message: messages[codeResult],
      })
    }

    try {
      const user = await createUser(db, {
        username: cleanUsername,
        email: cleanEmail,
        password,
        nickname,
      })
      purgeExpiredSessions(db)
      purgeStaleEmailCodes(db)
      const session = createSession(db, user.id)

      // The token rides only the HttpOnly cookie; echoing it in the JSON body
      // would hand a usable credential to any script running on the page.
      setSessionCookie(reply, session.token)
      return reply.status(201).send({ user })
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint failed')) {
        return reply.status(409).send({
          error: 'user_exists',
          message: '用户名或邮箱已被注册',
        })
      }
      request.log.error({ err }, 'Failed to register user')
      return reply.status(500).send({ error: 'server_error', message: '注册失败，请重试' })
    }
  })

  // Login
  app.post('/api/v1/auth/login', async (request: FastifyRequest<{
    Body: { account?: string; password?: string }
  }>, reply: FastifyReply) => {
    if (denyWhenOverLimit(request, reply)) return

    const { account, password } = request.body || {}

    if (!account || !password) {
      return reply.status(400).send({
        error: 'missing_fields',
        message: '账号与密码不能为空',
      })
    }

    const user = await authenticateUser(db, account, password)
    if (!user) {
      return reply.status(401).send({
        error: 'invalid_credentials',
        message: '用户名/邮箱或密码错误',
      })
    }

    purgeExpiredSessions(db)
    purgeStaleEmailCodes(db)
    const session = createSession(db, user.id)
    setSessionCookie(reply, session.token)
    return reply.status(200).send({ user })
  })

  // Logout
  app.post('/api/v1/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractSessionToken(request)
    if (token) {
      deleteSession(db, token)
    }
    reply.header(
      'Set-Cookie',
      'oneimage_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    )
    return reply.status(200).send({ ok: true })
  })

  // Current session info (Guest friendly)
  app.get('/api/v1/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractSessionToken(request)
    if (!token) {
      return reply.status(200).send({ authenticated: false, user: null })
    }

    const user = validateSession(db, token)
    if (!user) {
      return reply.status(200).send({ authenticated: false, user: null })
    }

    return reply.status(200).send({ authenticated: true, user })
  })

  // Update profile
  app.patch('/api/v1/auth/profile', async (request: FastifyRequest<{
    Body: { nickname?: string; avatar_color?: string }
  }>, reply: FastifyReply) => {
    const token = extractSessionToken(request)
    if (!token) {
      return reply.status(401).send({ error: 'unauthorized', message: '请先登录' })
    }

    const user = validateSession(db, token)
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', message: '登录状态已过期，请重新登录' })
    }

    const updated = updateUserProfile(db, user.id, request.body || {})
    return reply.status(200).send({ user: updated })
  })
}
