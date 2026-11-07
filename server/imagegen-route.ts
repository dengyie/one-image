import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { ImagegenProviderConfig, ImagegenModelSpec } from './imagegen-config'
import { captionImage, generateImages, ImagegenUpstreamError, type ImageInput } from './imagegen-providers'
import { sniffImage } from './image-meta'
import type { RateLimiter } from './rate-limit'
import { addUsage, readUsage, resolveUsageClientKey, todayKey } from './usage-ledger'

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

export function registerImagegenRoutes(app: FastifyInstance, db: DatabaseSync, options: ImagegenRouteOptions): void {
  const providers = options.providers
  const rateLimiter = options.rateLimiter
  const fetchImpl = options.fetchImpl ?? fetch

  const publicModelInfo = (spec: ImagegenModelSpec) => ({
    id: spec.id,
    // The endpoint surface is not a secret and the client needs it for one
    // decision the server cannot make: 换源重绘 must steer away from
    // gemini-dialect models, whose output carries SynthID by construction.
    dialect: spec.dialect,
    sizes: spec.sizes,
    fixedSizeNote: spec.fixedSizeNote,
    edit: spec.edit,
    note: spec.note,
    timeoutMs: spec.timeoutMs,
  })

  // The image surface exists only where at least one model is an *pickable*
  // image dialect. A provider carrying exclusively video (or caption-only)
  // models must not light up the image picker (the capabilities would
  // advertise a picker that renders empty and every generation would 400).
  const imageProviders = () =>
    providers.filter((p) => p.modelSpecs.some((m) => m.dialect !== 'openai-chat-video' && !m.captionOnly))

  const publicProvider = (provider: ImagegenProviderConfig) => {
    // Caption-only models are picker-invisible: they answer text, so a user
    // selecting one for generation would only buy a guaranteed 400. They stay
    // in modelSpecs (the caption route reads them) but out of every projection.
    const imageSpecs = provider.modelSpecs.filter((m) => m.dialect !== 'openai-chat-video' && !m.captionOnly)
    const captionOnlyIds = new Set(provider.modelSpecs.filter((m) => m.captionOnly).map((m) => m.id))
    return {
      id: provider.id,
      name: provider.name,
      models: provider.models.filter((id) => !captionOnlyIds.has(id)),
      // The default must resolve within the image models: a config default
      // pointing at a video id would otherwise leak into the picker contract.
      defaultModel: imageSpecs.some((m) => m.id === provider.defaultModel)
        ? provider.defaultModel!
        : imageSpecs[0]?.id ?? provider.defaultModel ?? provider.models[0],
      // Sizes stay server-side knowledge of what the upstream accepts; the
      // picker only needs the list of choices.
      sizes: provider.sizes ?? [],
      // When the upstream ignores every aspect request (some self-hosted
      // backends always return one fixed ratio), say so instead of showing a
      // picker that lies.
      fixedSizeNote: provider.fixedSizeNote ?? null,
      // Which of this provider's models can also take a reference image. Absent
      // means the picker shows no image-to-image affordance at all.
      editModels: provider.editModels ?? [],
      // The image→text caption model behind the 换源重绘 prefill. Absent means
      // the client hides that affordance; no key or URL travels with it.
      captionModel: provider.captionModel,
      // Per-model capabilities: the image models of this provider with the
      // provider-level fallbacks resolved. Video models are excluded — they are
      // served by the videogen surface below, never by the image picker.
      modelInfos: imageSpecs.map(publicModelInfo),
      // Lets the browser give up at the same time the server does instead of
      // waiting on the edge.
      timeoutMs: provider.timeoutMs ?? 90_000,
    }
  }

  const videoProviders = () =>
    providers
      .map((provider) => {
        const models = provider.modelSpecs.filter((m) => m.dialect === 'openai-chat-video')
        if (models.length === 0) return null
        return {
          id: provider.id,
          name: provider.name,
          models: models.map((m) => ({ id: m.id, note: m.note, timeoutMs: m.timeoutMs })),
          defaultModel: provider.defaultModel && models.some((m) => m.id === provider.defaultModel)
            ? provider.defaultModel
            : models[0].id,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  app.get('/api/v1/imagegen/capabilities', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (imageProviders().length === 0) {
      return reply.status(503).send({ error: 'imagegen_unconfigured', message: '生图服务未配置' })
    }
    const video = videoProviders()
    return reply.status(200).send({
      enabled: true,
      providers: providers.map(publicProvider),
      ...(video.length > 0 ? { video: { providers: video } } : {}),
    })
  })

  // The usage ledger is otherwise write-only from the browser's point of view;
  // exposing the remaining budget lets the picker say "今日剩余 N 张" instead
  // of teaching the quota through a 429. A plain read, no rate limiter needed.
  app.get('/api/v1/imagegen/quota', async (request: FastifyRequest, reply: FastifyReply) => {
    if (imageProviders().length === 0) {
      return reply.status(503).send({ error: 'imagegen_unconfigured', message: '生图服务未配置' })
    }
    const clientKey = resolveUsageClientKey(request)
    const day = todayKey(new Date())
    const used = readUsage(db, 'imagegen_usage', clientKey, day)
    return reply.status(200).send({ used, cap: options.dailyCap, remaining: Math.max(0, options.dailyCap - used) })
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
    if (imageProviders().length === 0) {
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
    const spec = provider.modelSpecs.find((m) => m.id === model)
    if (!spec) {
      return reply.status(400).send({ error: 'invalid_model', message: '该服务下没有这个模型' })
    }
    // Video models live on their own surface; the image route must not accept
    // them even though they are declared under the same provider.
    if (spec.dialect === 'openai-chat-video') {
      return reply.status(400).send({ error: 'invalid_model', message: '该模型不支持图片生成' })
    }
    // Caption-only models answer text; they serve the 换源重绘 prefill and are
    // hidden from the picker, so a direct generation attempt is a stale client.
    if (spec.captionOnly) {
      return reply.status(400).send({ error: 'invalid_model', message: '该模型仅用于图片描述，不支持生成' })
    }
    const count = Math.floor(Number(n ?? 1))
    if (!Number.isFinite(count) || count < 1 || count > 4) {
      return reply.status(400).send({ error: 'invalid_n', message: '生成张数需在 1-4 之间' })
    }
    let cleanSize: string | undefined
    if (typeof size === 'string' && size.trim().length > 0) {
      if (!spec.sizes.includes(size.trim())) {
        return reply.status(400).send({ error: 'invalid_size', message: '该模型不支持这个尺寸' })
      }
      cleanSize = size.trim()
    }
    const inputImage = body.image === undefined || body.image === null ? null : readInputImage(body.image)
    if (inputImage && 'reason' in inputImage) {
      return reply.status(400).send({ error: 'invalid_input_image', message: inputImage.reason })
    }
    const image = inputImage?.image
    if (image && !spec.edit) {
      return reply.status(400).send({ error: 'image_input_unsupported', message: '该模型不接受参考图' })
    }

    // Durable daily cap keyed on the resolved client address, counted in
    // *images* rather than requests: n=4 spends four upstream generations and
    // is billed as four, so one 4-image request must not cost a single unit.
    const clientKey = resolveUsageClientKey(request)
    const day = todayKey(new Date())
    const used = readUsage(db, 'imagegen_usage', clientKey, day)
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
    addUsage(db, 'imagegen_usage', clientKey, day, count)

    try {
      const startedAt = performance.now()
      const result = await generateImages(
        provider,
        { model, prompt: cleanPrompt, n: count, size: cleanSize, image },
        AbortSignal.timeout(spec.timeoutMs),
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

  // Image → text caption for the 换源重绘 prefill. Deliberately *not* charged
  // against the imagegen daily cap: it is a cheap text reply, and billing it
  // as an image would make the prefill feel like a spend decision. The shared
  // per-minute limiter is the spend guard.
  app.post('/api/v1/imagegen/caption', async (request: FastifyRequest<{
    Body: { mimeType?: string; base64?: string }
  }>, reply: FastifyReply) => {
    const captionProviders = providers.filter((p) => p.captionModel)
    if (captionProviders.length === 0) {
      return reply.status(503).send({ error: 'caption_unconfigured', message: '图片描述服务未配置' })
    }
    if (rateLimiter && !rateLimiter.allow(request)) {
      return reply.header('Retry-After', '60').status(429).send({
        error: 'rate_limited',
        message: '请求过于频繁，请稍后再试',
      })
    }
    const body = request.body || {}
    const inputImage = readInputImage(body)
    if ('reason' in inputImage) {
      return reply.status(400).send({ error: 'invalid_input_image', message: inputImage.reason })
    }
    const provider = captionProviders[0]
    const spec = provider.modelSpecs.find((m) => m.id === provider.captionModel)
    try {
      const startedAt = performance.now()
      const caption = await captionImage(provider, inputImage.image, AbortSignal.timeout(spec?.timeoutMs ?? 30_000), fetchImpl)
      request.log.info({ provider: provider.id, model: provider.captionModel, ms: Math.round(performance.now() - startedAt), chars: caption.length }, 'imagegen caption completed')
      return reply.status(200).send({ provider: provider.id, model: provider.captionModel, caption })
    } catch (err: unknown) {
      request.log.warn({ err }, 'imagegen caption upstream call failed')
      if (err instanceof ImagegenUpstreamError) {
        return reply.status(err.status).send({
          error: 'upstream_error',
          upstreamStatus: err.upstreamStatus || undefined,
          message: err.message,
        })
      }
      if (err instanceof Error && err.name === 'TimeoutError') {
        return reply.status(504).send({ error: 'upstream_timeout', message: '描述超时，请稍后重试' })
      }
      return reply.status(502).send({ error: 'upstream_error', message: '描述请求失败，请稍后重试' })
    }
  })
}
