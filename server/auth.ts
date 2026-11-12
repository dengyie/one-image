import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import type { UserRow, SessionRow } from './db'
import { AVATAR_COLORS, DEFAULT_AVATAR_COLOR, isAvatarColor } from '../src/domain/avatar'

// The promise-based scrypt runs on the libuv threadpool, keeping the event
// loop responsive while register/login burn their fixed hashing cost; the
// synchronous variant stalled every request on the process for tens of ms.
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N: number; r: number; p: number }
) => Promise<Buffer>

export interface SafeUser {
  id: string
  username: string
  email: string
  nickname: string
  avatar_color: string
  created_at: number
  updated_at: number
}

function getRandomAvatarColor(): string {
  const idx = Math.floor(Math.random() * AVATAR_COLORS.length)
  return AVATAR_COLORS[idx]
}

// Session tokens are stored hashed so a leaked database file does not yield
// usable credentials; only the SHA-256 digest of the token is persisted.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Password hashing: scrypt with explicit cost parameters. The stored hash is
// self-describing (`s2$<hex>` = current params, bare hex = the historical
// Node-default hash) so verifyPassword handles both without a migration, and
// authenticateUser re-hashes legacy hashes on successful login.
// N=2^16 (16MB per hash, 8x the Node default) instead of the OWASP 2^17: the
// deploy host OOM-kills allocation bursts and login concurrency × 32MB is a
// real risk there; revisit when the host has headroom. maxmem must cover the
// 128*N*r working set — OpenSSL's 32MB default rejects N=2^16 outright.
const SCRYPT_PARAMS = { N: 2 ** 16, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }
const SCRYPT_HASH_PREFIX = 's2$'

export async function hashPassword(password: string, salt: string): Promise<string> {
  return SCRYPT_HASH_PREFIX + (await scrypt(password, salt, 64, SCRYPT_PARAMS)).toString('hex')
}

export function needsPasswordRehash(storedHash: string): boolean {
  return !storedHash.startsWith(SCRYPT_HASH_PREFIX)
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  try {
    let computedBuf: Buffer
    let expectedBuf: Buffer
    if (expectedHash.startsWith(SCRYPT_HASH_PREFIX)) {
      computedBuf = Buffer.from(await scrypt(password, salt, 64, SCRYPT_PARAMS))
      expectedBuf = Buffer.from(expectedHash.slice(SCRYPT_HASH_PREFIX.length), 'hex')
    } else {
      // Legacy Node-default hash (N=16384): still verifiable, upgraded on
      // the next successful login.
      computedBuf = Buffer.from(await scrypt(password, salt, 64))
      expectedBuf = Buffer.from(expectedHash, 'hex')
    }
    if (computedBuf.length !== expectedBuf.length) return false
    return timingSafeEqual(computedBuf, expectedBuf)
  } catch {
    return false
  }
}

export function toSafeUser(row: UserRow): SafeUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    nickname: row.nickname,
    avatar_color: row.avatar_color,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function createUser(
  db: DatabaseSync,
  params: { username: string; email: string; password: string; nickname?: string }
): Promise<SafeUser> {
  const username = params.username.trim().toLowerCase()
  const email = params.email.trim().toLowerCase()
  // An empty or whitespace-only nickname falls back to the username instead of
  // persisting an empty display name.
  const nickname = (params.nickname?.trim() || username).slice(0, 32)
  const salt = randomBytes(16).toString('hex')
  const passwordHash = await hashPassword(params.password, salt)
  const id = `usr_${randomBytes(12).toString('hex')}`
  const now = Date.now()
  const avatarColor = getRandomAvatarColor()

  const stmt = db.prepare(`
    INSERT INTO users (id, username, email, password_hash, salt, nickname, avatar_color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(id, username, email, passwordHash, salt, nickname, avatarColor, now, now)

  return {
    id,
    username,
    email,
    nickname,
    avatar_color: avatarColor,
    created_at: now,
    updated_at: now,
  }
}

export async function authenticateUser(
  db: DatabaseSync,
  account: string,
  password: string
): Promise<SafeUser | null> {
  const cleanAccount = account.trim().toLowerCase()
  const stmt = db.prepare(`
    SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1
  `)
  const row = stmt.get(cleanAccount, cleanAccount) as unknown as UserRow | undefined
  if (!row) {
    // Burn one scrypt run even for unknown accounts so response timing does
    // not reveal whether a username/email is registered.
    await hashPassword(password, 'oneimage-timing-equalizer')
    return null
  }

  if (!(await verifyPassword(password, String(row.salt), String(row.password_hash)))) {
    return null
  }

  // Transparent cost-parameter migration: a legacy-default hash is re-hashed
  // with the current parameters on the first successful login. Failure to
  // persist it is not a login failure — the old hash stays valid.
  if (needsPasswordRehash(String(row.password_hash))) {
    try {
      const upgraded = await hashPassword(password, String(row.salt))
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(upgraded, Date.now(), row.id)
    } catch {
      // keep the legacy hash
    }
  }

  return toSafeUser(row)
}

export function createSession(
  db: DatabaseSync,
  userId: string,
  ttlDays = 30
): SessionRow {
  const token = `sess_${randomBytes(32).toString('hex')}`
  const now = Date.now()
  const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000

  const stmt = db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `)
  stmt.run(hashToken(token), userId, expiresAt, now)

  return {
    token,
    user_id: userId,
    expires_at: expiresAt,
    created_at: now,
  }
}

export function validateSession(
  db: DatabaseSync,
  token: string
): SafeUser | null {
  const now = Date.now()
  const stmt = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
    LIMIT 1
  `)
  const row = stmt.get(hashToken(token), now) as unknown as UserRow | undefined
  if (!row) return null

  return toSafeUser(row)
}

export function deleteSession(db: DatabaseSync, token: string): void {
  const stmt = db.prepare('DELETE FROM sessions WHERE token = ?')
  stmt.run(hashToken(token))
}

export function purgeExpiredSessions(db: DatabaseSync): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
}

export function updateUserProfile(
  db: DatabaseSync,
  userId: string,
  updates: { nickname?: string; avatar_color?: string }
): SafeUser | null {
  const now = Date.now()
  const currentStmt = db.prepare('SELECT * FROM users WHERE id = ?')
  const current = currentStmt.get(userId) as unknown as UserRow | undefined
  if (!current) return null

  const currentNickname = String(current.nickname || current.username)
  const currentAvatarColor = isAvatarColor(current.avatar_color) ? current.avatar_color : DEFAULT_AVATAR_COLOR
  // A missing or whitespace-only nickname keeps the stored value instead of
  // blanking the display name.
  const nextNickname = (updates.nickname?.trim() || currentNickname).slice(0, 32)
  // Invalid or missing colors keep the stored value instead of corrupting it.
  const nextAvatarColor = isAvatarColor(updates.avatar_color) ? updates.avatar_color : currentAvatarColor

  const updateStmt = db.prepare(`
    UPDATE users SET nickname = ?, avatar_color = ?, updated_at = ? WHERE id = ?
  `)
  updateStmt.run(nextNickname, nextAvatarColor, now, userId)

  return {
    ...toSafeUser(current),
    nickname: nextNickname,
    avatar_color: nextAvatarColor,
    updated_at: now,
  }
}
