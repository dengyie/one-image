import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { OpenAIProvenanceAdapter } from '../src/infrastructure/openai-provenance-adapter'
import { MAX_INPUT_BYTES } from '../src/domain/image-input'
import { registerProvenanceRoute } from './provenance-route'
import { registerCapabilitiesRoute } from './capabilities-route'
import { authorizeProvenanceRequest } from './security'
import { registerHealthRoute } from './health-route'
import { configureOutboundProxy } from './proxy'
import { createRateLimiter } from './rate-limit'
import { registerSameOriginGuard } from './origin'
import { initDatabase } from './db'
import { registerAuthRoutes } from './auth-routes'
import { registerProjectRoutes } from './project-routes'
import { createOneMailMailer } from './onemail'
import { loadImagegenConfig } from './imagegen-config'
import { registerImagegenRoutes } from './imagegen-route'
import { registerVideogenRoutes } from './videogen-route'
import { registerSmartEraseRoutes, resolveLamaModelPath } from './smart-erase-route'
import { CHILD_ENV_FLAG, prewarmLama, runLamaWorkerLoop } from './lama-inpaint'

async function main(): Promise<void> {
  // Child mode: this same bundle re-executed by the LaMa process pool runs a
  // resident inference worker instead of the HTTP server, so a model-load OOM
  // can never take the production API down with it.
  if (process.env[CHILD_ENV_FLAG] === '1') {
    await runLamaWorkerLoop(() => resolveLamaModelPath())
    return
  }
  // state_json carries the full serialized editor state (stroke point arrays
  // included); the default 1MiB body limit would reject legitimately heavy
  // annotation sessions, so the limit matches the 25MB input philosophy.
  const app = Fastify({ logger: true, bodyLimit: 16 * 1024 * 1024 })
  const maxInputBytes = MAX_INPUT_BYTES
  await app.register(multipart, { limits: { fileSize: maxInputBytes, files: 1, parts: 1 } })
  const serverToken = process.env.ONEIMAGE_SERVER_TOKEN ?? ''
  configureOutboundProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy)
  const rateLimiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 30, maxTrackedClients: 10_000 })
  // register/login burn one scrypt per request; project routes accept
  // unbounded writes. Both are public or session-keyed surfaces.
  const authRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 10, maxTrackedClients: 10_000 })
  const projectsRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 60, maxTrackedClients: 10_000 })
  const allowDevelopmentOrigin = process.env.NODE_ENV === 'development'

  // Image generation providers (baseUrl + key stay server-side; the browser
  // only ever sees names and model lists). Unconfigured or invalid config
  // degrades to a 503 imagegen surface instead of blocking startup.
  const imagegenConfig = loadImagegenConfig()
  for (const warning of imagegenConfig.warnings) {
    app.log.warn(warning)
  }

  // Initialize SQLite Database
  const appDb = initDatabase()

  // Registration verification-code delivery via the one-mail external API.
  // Without ONEMAIL_SEND_TOKEN the email-code endpoint degrades to 503 while
  // the rest of the auth surface keeps working.
  const onemailToken = process.env.ONEMAIL_SEND_TOKEN ?? ''
  const verificationMailer = onemailToken
    ? createOneMailMailer({
        apiBase: process.env.ONEMAIL_API_BASE ?? 'https://mail-api.mangoqwq.com',
        token: onemailToken,
        fromName: process.env.ONEMAIL_FROM_NAME ?? 'OneImage',
      })
    : undefined

  registerHealthRoute(app, { providerConfigured: Boolean(process.env.OPENAI_API_KEY) })
  // Server-side smart-erase (LaMa): resolved from env + existsSync at boot —
  // null degrades the surface to a 503 and hides the browser tier without
  // blocking startup or touching the deploy health budget.
  const lamaModelPath = resolveLamaModelPath()
  registerCapabilitiesRoute(app, {
    provenance: { enabled: Boolean(process.env.OPENAI_API_KEY), provider: process.env.OPENAI_API_KEY ? 'openai' : null, maxInputBytes },
    smartErase: { lamaAvailable: lamaModelPath !== null },
  })
  registerSameOriginGuard(app)
  registerAuthRoutes(app, appDb.db, { rateLimiter: authRateLimiter, mailer: verificationMailer })
  registerProjectRoutes(app, appDb.db, { rateLimiter: projectsRateLimiter })
  // Generation is the most expensive public surface on the site: a tight
  // per-client window plus the durable daily cap inside the route.
  const rawDailyCap = Number(process.env.ONEIMAGE_IMAGEGEN_DAILY_CAP ?? 20)
  const imagegenRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 6, maxTrackedClients: 10_000 })
  registerImagegenRoutes(app, appDb.db, {
    providers: imagegenConfig.providers,
    rateLimiter: imagegenRateLimiter,
    dailyCap: Number.isFinite(rawDailyCap) && rawDailyCap >= 1 ? Math.floor(rawDailyCap) : 20,
  })
  // Video rides the same provider config (per-model `openai-chat-video`
  // dialect) but bills and times out on its own: clips cost more than images
  // and the reply is orders of magnitude heavier.
  const rawVideoCap = Number(process.env.ONEIMAGE_VIDEOGEN_DAILY_CAP ?? 5)
  const videogenRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 3, maxTrackedClients: 10_000 })
  registerVideogenRoutes(app, appDb.db, {
    providers: imagegenConfig.providers,
    rateLimiter: videogenRateLimiter,
    dailyCap: Number.isFinite(rawVideoCap) && rawVideoCap >= 1 ? Math.floor(rawVideoCap) : 5,
  })
  registerProvenanceRoute(
    app,
    (file, filename, signal) => new OpenAIProvenanceAdapter({ apiKey: process.env.OPENAI_API_KEY ?? '' }).check(file, filename, signal),
    {
      authorize: (request) => authorizeProvenanceRequest(request.headers, serverToken, allowDevelopmentOrigin),
      allow: (request) => rateLimiter.allow(request),
    },
  )
  // Server-side LaMa inpainting burns shared CPU on the container, so it gets
  // its own tight window and its own durable daily ledger inside the route.
  const rawSmartEraseCap = Number(process.env.ONEIMAGE_SMARTERASE_DAILY_CAP ?? 30)
  const smartEraseRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 3, maxTrackedClients: 10_000 })
  registerSmartEraseRoutes(app, appDb.db, {
    modelPath: lamaModelPath,
    rateLimiter: smartEraseRateLimiter,
    dailyCap: Number.isFinite(rawSmartEraseCap) && rawSmartEraseCap >= 1 ? Math.floor(rawSmartEraseCap) : 30,
  })

  const port = Number(process.env.PORT ?? 8787)
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'shutting down OneImage server')
    try {
      await app.close()
      appDb.close()
    } catch (error) {
      app.log.error({ err: error }, 'OneImage server shutdown failed')
      process.exitCode = 1
    }
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  await app.listen({ port, host: '127.0.0.1' })
  // Warm the resident LaMa child in the background: loading the 198MB model
  // at boot-time idle beats loading it under request pressure on a host that
  // has already OOM-killed exactly that load once. Failures retry with
  // backoff and never affect the server's availability.
  if (lamaModelPath) {
    void prewarmLama({ modelPath: lamaModelPath }).then((warmed) => {
      app.log.info({ warmed }, 'lama prewarm finished')
    })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`OneImage server failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
