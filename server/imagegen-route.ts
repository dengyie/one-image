import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { ImagegenProviderConfig } from './imagegen-config'
import { generateImages, ImagegenUpstreamError, type ImageInput } from './imagegen-providers'
import { sniffImage } from './image-meta'
import type { RateLimiter } from './rate-limit'
import { resolveClientKey, type ProxyHeaders } from './client-ip'

export interface ImagegenRouteOptions {
  providers: ImagegenProviderConfig[]
  // Generation spends operator money on every call, so it gets its own tight
  // per-client window on top of the durable daily cap.
  rateLimiter?: RateLimiter
  // Durable per-client daily ceiling (SQLite); the last line of defense
  // against distributed spend abuse that a per-IP window cannot stop.
  dailyCap: number
  fetchImpl?: typeof fetch
}

interface ImagegenUsageRow {
  count: number
}

const INPUT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
// The reference travels as JSON base64 inside this endpoint's body. 6 MiB of
// bytes is ~8.2 MB once encoded, comfortably under Fastify's 16 MB bodyLimit
// and nginx's 26m, so no second limit has to be kept in sync.
const MAX_INPUT_IMAGE_BYTES = 6 * 1024 * 1024

type InputImageResult = { image: ImageInput } | { reason: string }

// The reference is forwarded upstream verbatim, so it is vetted once here: a
// container we can read, dimensions within 16–8192px, and a declared type that
// agrees with the magic bytes. Decoding an 8 MB string is cheap; forwarding an
// unverified one is not.
function readInputImage(value: unknown): InputImageResult {
  if (!value || typeof value !== 'object') return { reason: '参考图格式无效' }
  const { mimeType, base64 } = value as { mimeType?: unknown; base64?: unknown }
  if (typeof mimeType !== 'string' || !INPUT_IMAGE_MIME.has(mimeType)) {
    return { reason: '参考图只支持 PNG、JPEG 或 WebP' }
  }
  if (typeof base64 !== 'string' || base64.trim().length === 0) return { reason: '参考图数据为空' }
  const clean = base64.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return { reason: '参考图不是合法的 base64 数据' }
  const bytes = Buffer.from(clean, 'base64')
  if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) return { reason: '参考图超过 6MB 上限' }
  const meta = sniffImage(bytes)
  if (!meta || meta.mimeType !== mimeType) return { reason: '参考图内容与声明的格式不一致' }
  if (meta.width < 16 || meta.height < 16 || meta.width > 8192 || meta.height > 8192) {
    return { reason: '参考图尺寸需在 16-8192 像素之间' }
  }
  return { image: { mimeType, base64: clean } }
}

function todayKey(now: Date): string {
  // Day bucket in the server's local timezone; a calendar day is the natural
  // spend-budget unit for a single-operator site.
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function registerImagegenRoutes(app: FastifyInstance, db: DatabaseSync, options: ImagegenRouteOptions): void {
  const providers = options.providers
  const rateLimiter = options.rateLimiter
  const fetchImpl = options.fetchImpl ?? fetch

  const publicProvider = (provider: ImagegenProviderConfig) => ({
    id: provider.id,
    name: provider.name,
    models: provider.models,
    defaultModel: provider.defaultModel ?? provider.models[0],
    // Sizes stay server-side knowledge of what the upstream accepts; the
    // picker only needs the list of choices.
    sizes: provider.sizes ?? [],
    // Which of this provider's models can also take a reference image. Absent
    // means the picker shows no image-to-image affordance at all.
    editModels: provider.editModels ?? [],
    // Lets the browser give up at the same time the server does instead of
    // waiting on the edge.
    timeoutMs: provider.timeoutMs ?? 90_000,
  })

  app.get('/api/v1/imagegen/capabilities', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (providers.length === 0) {
      return reply.status(503).send({ error: 'imagegen_unconfigured', message: '生图服务未配置' })
    }
    return reply.status(200).send({ enabled: true, providers: providers.map(publicProvider) })
  })

  app.post('/api/v1/imagegen', async (request: FastifyRequest<{
    Body: {
      provider?: string
      model?: string
      prompt?: string
      size?: string
      n?: number
      image?: { mimeType?: string; base64?: string }
    }
  }>, reply: FastifyReply) => {
    if (providers.length === 0) {
      return reply.status(503).send({ error: 'imagegen_unconfigured', message: '生图服务未配置' })
    }
    if (rateLimiter && !rateLimiter.allow(request)) {
      return reply.header('Retry-After', '60').status(429).send({
        error: 'rate_limited',
        message: '请求过于频繁，请稍后再试',
      })
    }

    const body = request.body || {}
    const { provider: providerId, model, prompt, size, n } = body
    if (typeof providerId !== 'string' || typeof model !== 'string' || typeof prompt !== 'string') {
      return reply.status(400).send({ error: 'missing_fields', message: '服务、模型与提示词为必填项' })
    }
    const cleanPrompt = prompt.trim()
    if (cleanPrompt.length === 0) {
      return reply.status(400).send({ error: 'invalid_prompt', message: '提示词不能为空' })
    }
    if (cleanPrompt.length > 4000) {
      return reply.status(400).send({ error: 'invalid_prompt', message: '提示词不能超过 4000 字符' })
    }
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) {
      return reply.status(400).send({ error: 'invalid_provider', message: '未知的生图服务' })
    }
    if (!provider.models.includes(model)) {
      return reply.status(400).send({ error: 'invalid_model', message: '该服务下没有这个模型' })
    }
    const count = Math.floor(Number(n ?? 1))
    if (!Number.isFinite(count) || count < 1 || count > 4) {
      return reply.status(400).send({ error: 'invalid_n', message: '生成张数需在 1-4 之间' })
    }
    let cleanSize: string | undefined
    if (typeof size === 'string' && size.trim().length > 0) {
      if (!provider.sizes?.includes(size.trim())) {
        return reply.status(400).send({ error: 'invalid_size', message: '该服务不支持这个尺寸' })
      }
      cleanSize = size.trim()
    }
    const inputImage = body.image === undefined || body.image === null ? null : readInputImage(body.image)
    if (inputImage && 'reason' in inputImage) {
      return reply.status(400).send({ error: 'invalid_input_image', message: inputImage.reason })
    }
    const image = inputImage?.image
    if (image && !provider.editModels?.includes(model)) {
      return reply.status(400).send({ error: 'image_input_unsupported', message: '该模型不接受参考图' })
    }

    // Durable daily cap keyed on the resolved client address, counted in
    // *images* rather than requests: n=4 spends four upstream generations and
    // is billed as four, so one 4-image request must not cost a single unit.
    // Counted before the upstream call so a slow or failing upstream cannot be
    // used to race the budget; a failed generation still counts, which keeps
    // the failure path from being cheaper than the abuse path. The
    // read-check-increment runs without an await in between, so on this
    // single-writer SQLite it is atomic per event-loop turn.
    const clientKey = resolveClientKey(request.headers as ProxyHeaders, request.raw.socket.remoteAddress)
    const day = todayKey(new Date())
    const used = (db.prepare('SELECT count FROM imagegen_usage WHERE client_key = ? AND day = ?').get(clientKey, day) as unknown as ImagegenUsageRow | undefined)?.count ?? 0
    if (used >= options.dailyCap) {
      return reply.status(429).send({
        error: 'daily_cap_exceeded',
        message: `今日生成张数已达上限（${options.dailyCap} 张），请明天再来`,
      })
    }
    if (used + count > options.dailyCap) {
      return reply.status(429).send({
        error: 'daily_cap_exceeded',
        message: `今日仅剩 ${options.dailyCap - used} 张生成额度，请减少张数后重试`,
      })
    }
    db.prepare(
      'INSERT INTO imagegen_usage (client_key, day, count) VALUES (?, ?, ?) ON CONFLICT(client_key, day) DO UPDATE SET count = count + excluded.count'
    ).run(clientKey, day, count)
    // Housekeeping: yesterday's buckets are dead weight once the day rolled.
    db.prepare('DELETE FROM imagegen_usage WHERE day < ?').run(day)

    try {
      const startedAt = performance.now()
      const result = await generateImages(
        provider,
        { model, prompt: cleanPrompt, n: count, size: cleanSize, image },
        AbortSignal.timeout(provider.timeoutMs ?? 90_000),
        fetchImpl
      )
      // Latency per request is what tells the operator whether the edge budget
      // is holding; no prompt or key ever goes in here.
      request.log.info({
        provider: provider.id,
        model,
        n: count,
        mode: image ? 'image-to-image' : 'text-to-image',
        ms: Math.round(performance.now() - startedAt),
        images: result.images.length,
        failed: result.failed ?? 0,
        sizes: result.images.map((img) => (img.width && img.height ? `${img.width}x${img.height}` : img.mimeType)),
      }, 'imagegen completed')
      return reply.status(200).send({
        provider: provider.id,
        model,
        images: result.images,
        revisedPrompt: result.revisedPrompt,
        requestedSize: cleanSize,
        failed: result.failed ?? 0,
      })
    } catch (err: unknown) {
      request.log.warn({ err }, 'imagegen upstream call failed')
      if (err instanceof ImagegenUpstreamError) {
        return reply.status(err.status).send({
          error: 'upstream_error',
          upstreamStatus: err.upstreamStatus || undefined,
          message: err.message,
        })
      }
      if (err instanceof Error && err.name === 'TimeoutError') {
        return reply.status(504).send({ error: 'upstream_timeout', message: '生成超时，请稍后重试' })
      }
      return reply.status(502).send({ error: 'upstream_error', message: '生成请求失败，请稍后重试' })
    }
  })
}
