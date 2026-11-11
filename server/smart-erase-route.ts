import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { decodePngRgba, encodePngRgba } from './png'
import { runLamaInpaint, resolveLamaModelPath } from './lama-inpaint'
export { resolveLamaModelPath }
import type { RateLimiter } from './rate-limit'
import { addUsage, readUsage, resolveUsageClientKey, todayKey } from './usage-ledger'

export interface SmartEraseRouteOptions {
  // Resolved at registration (env + existsSync); null means the surface
  // answers 503 and the browser hides the tier — degrade, never block boot.
  modelPath: string | null
  // Server-side inference spends shared CPU, so it gets its own tight window
  // and its own durable daily ledger, separate from the generation surfaces.
  rateLimiter?: RateLimiter
  dailyCap: number
  // Live warm gate: false while no proven session is resident (503, never a
  // misleading 500). Optional for tests; the pool-backed default is wired in
  // server/index.ts.
  isWarm?: () => boolean
  // Test injection: swap the real ORT run for a fake.
  runInpaint?: typeof runLamaInpaint
}

// The client always speaks PNG here (canvas.toBlob): the server owns a
// zero-dependency PNG codec and refuses everything else — a JPEG decoder on
// the server would be a new dependency for no fidelity gain, since the crop is
// regenerated pixel-wise anyway and the browser re-encodes losslessly.
const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024
// The 2048-edge crop is canvas-encoded binary strokes; 4MB absorbs the
// worst-case noisy mask that a 2MB cap would reject with a confusing 400.
const MAX_MASK_BYTES = 4 * 1024 * 1024
const MAX_EDGE = 2048
const MIN_EDGE = 16

type PlaneResult = { image: { width: number; height: number; rgba: Uint8Array } } | { reason: string }

function readPngPlane(
  value: unknown,
  { label, maxBytes }: { label: string; maxBytes: number },
): PlaneResult {
  if (!value || typeof value !== 'object') return { reason: `${label}格式无效` }
  const { base64 } = value as { base64?: unknown }
  if (typeof base64 !== 'string' || base64.trim().length === 0) return { reason: `${label}数据为空` }
  const clean = base64.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return { reason: `${label}不是合法的 base64 数据` }
  const bytes = Buffer.from(clean, 'base64')
  if (bytes.byteLength > maxBytes) return { reason: `${label}超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限` }
  const decoded = decodePngRgba(bytes, { maxEdge: MAX_EDGE })
  if (!decoded) return { reason: `${label}不是可读的 PNG 图片` }
  if (decoded.width < MIN_EDGE || decoded.height < MIN_EDGE || decoded.width > MAX_EDGE || decoded.height > MAX_EDGE) {
    return { reason: `${label}尺寸需在 ${MIN_EDGE}-${MAX_EDGE} 像素之间` }
  }
  return { image: decoded }
}

export function registerSmartEraseRoutes(app: FastifyInstance, db: DatabaseSync, options: SmartEraseRouteOptions): void {
  const rateLimiter = options.rateLimiter
  const runInpaint = options.runInpaint ?? runLamaInpaint

  app.post('/api/v1/smart-erase', async (request: FastifyRequest<{
    Body: { image?: { base64?: string }; mask?: { base64?: string } }
  }>, reply: FastifyReply) => {
    if (!options.modelPath) {
      return reply.status(503).send({ error: 'smart_erase_unconfigured', message: '服务端修复模型未配置' })
    }
    // The warm gate: without a proven resident session a run would almost
    // certainly OOM mid-flight on the memory-starved host. Answer 503 (the
    // capabilities flag hides the tier for browsers; this catches stale UIs
    // and direct callers) instead of burning a billed attempt on a 500.
    if (options.isWarm && !options.isWarm()) {
      return reply.status(503).send({ error: 'smart_erase_warming', message: '服务端修复引擎预热中，请稍后再试' })
    }
    if (rateLimiter && !rateLimiter.allow(request)) {
      return reply.header('Retry-After', '60').status(429).send({
        error: 'rate_limited',
        message: '请求过于频繁，请稍后再试',
      })
    }

    const body = request.body || {}
    const imageResult = readPngPlane(body.image, { label: '图片', maxBytes: MAX_INPUT_IMAGE_BYTES })
    if ('reason' in imageResult) {
      return reply.status(400).send({ error: 'invalid_input_image', message: imageResult.reason })
    }
    const maskResult = readPngPlane(body.mask, { label: '掩膜', maxBytes: MAX_MASK_BYTES })
    if ('reason' in maskResult) {
      return reply.status(400).send({ error: 'invalid_input_image', message: maskResult.reason })
    }
    // The mask must align with the image pixel-for-pixel: the server replaces
    // hole pixels and guarantees the rest bit-for-bit, which only means
    // something when the two planes share dimensions.
    if (imageResult.image.width !== maskResult.image.width || imageResult.image.height !== maskResult.image.height) {
      return reply.status(400).send({ error: 'invalid_input_image', message: '掩膜与图片尺寸不一致' })
    }

    // Billed before the run, like every other spend surface: inference burns
    // shared CPU, and a failed or slow run must not be cheaper than abuse.
    const clientKey = resolveUsageClientKey(request)
    const day = todayKey(new Date())
    const used = readUsage(db, 'smarterase_usage', clientKey, day)
    if (used >= options.dailyCap) {
      return reply.status(429).send({
        error: 'daily_cap_exceeded',
        message: `今日服务端修复次数已达上限（${options.dailyCap} 次），请明天再来`,
      })
    }
    addUsage(db, 'smarterase_usage', clientKey, day, 1)

    try {
      const started = performance.now()
      const result = await runInpaint({
        width: imageResult.image.width,
        height: imageResult.image.height,
        image: imageResult.image.rgba,
        mask: maskResult.image.rgba,
      }, { modelPath: options.modelPath })
      request.log.info({
        ms: Math.round(performance.now() - started),
        engineMs: result.ms,
        tiles: result.tiles,
        width: imageResult.image.width,
        height: imageResult.image.height,
      }, 'smart-erase completed')
      const png = encodePngRgba({ width: imageResult.image.width, height: imageResult.image.height, rgba: result.rgba })
      return reply.status(200).send({
        image: { mimeType: 'image/png', base64: png.toString('base64') },
      })
    } catch (err: unknown) {
      request.log.warn({ err }, 'smart-erase inference failed')
      return reply.status(500).send({ error: 'inference_error', message: '服务端修复失败，请稍后重试' })
    }
  })
}

