import type Fastify from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { VerificationMailer } from '../server/onemail'
import type { ImagegenProviderConfig } from '../server/imagegen-config'

// Test factories build provider configs the way old string-form config files
// did; the server now reads per-model specs. This derives them exactly the way
// the config loader does for string entries, unless the test provided specs.
type ProviderInput = Omit<ImagegenProviderConfig, 'modelSpecs' | 'disabledModels'> &
  Partial<Pick<ImagegenProviderConfig, 'modelSpecs' | 'disabledModels'>>

export function withModelSpecs(provider: ProviderInput): ImagegenProviderConfig {
  if (provider.modelSpecs) return provider as ImagegenProviderConfig
  const specs = provider.models.map((id) => ({
    id,
    dialect: provider.type,
    sizes: provider.sizes ?? [],
    fixedSizeNote: (provider.sizes ?? []).length > 0 ? null : provider.fixedSizeNote ?? null,
    edit: (provider.editModels ?? []).includes(id),
    editsStyle: provider.type === 'openai-images' ? provider.editsStyle ?? 'multipart' : 'multipart',
    ...(provider.type === 'gemini' && provider.generationConfig ? { generationConfig: provider.generationConfig } : {}),
    note: null,
    timeoutMs: provider.timeoutMs ?? 90_000,
  }))
  return {
    ...provider,
    modelSpecs: specs,
    disabledModels: provider.disabledModels ?? [],
    editModels: provider.editModels,
  }
}

export interface FakeMailer extends VerificationMailer {
  outbox: { to: string; code: string }[]
}

export function createFakeMailer(): FakeMailer {
  const outbox: { to: string; code: string }[] = []
  return {
    outbox,
    async sendVerificationCode(to: string, code: string): Promise<void> {
      outbox.push({ to, code })
    },
  }
}

// Full registration flow through the verification endpoint: request a code,
// read it from the fake mailer outbox, then register. Returns the raw response
// of the register call.
export async function registerViaEmailCode(
  app: ReturnType<typeof Fastify>,
  db: DatabaseSync,
  mailer: FakeMailer,
  params: { username: string; email: string; password: string; nickname?: string; emailCode?: string }
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  if (params.emailCode === undefined) {
    const sendRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-code',
      payload: { email: params.email },
    })
    if (sendRes.statusCode !== 200) return sendRes
  }
  const sent = mailer.outbox.filter((entry) => entry.to === params.email.trim().toLowerCase()).at(-1)
  const code = params.emailCode ?? sent?.code
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      username: params.username,
      email: params.email,
      password: params.password,
      nickname: params.nickname,
      email_code: code,
    },
  })
}

// Register/login no longer echo the session token in the JSON body; the token
// rides the HttpOnly cookie only. Tests read it back from the response cookie.
export function sessionTokenFrom(res: { cookies: { name: string; value: string }[] }): string {
  const cookie = res.cookies.find((entry) => entry.name === 'oneimage_session')
  if (!cookie) throw new Error('no oneimage_session cookie on response')
  return cookie.value
}
