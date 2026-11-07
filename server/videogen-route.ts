import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { ImagegenProviderConfig, ImagegenModelSpec } from './imagegen-config'
import { generateVideo, ImagegenUpstreamError } from './imagegen-providers'
import type { RateLimiter } from './rate-limit'
import { addUsage, readUsage, resolveUsageClientKey, todayKey } from './usage-ledger'

export interface VideogenRouteOptions {
  providers: ImagegenProviderConfig[]
  // Video spends more per call than an image and produces a heavier reply, so
  // it gets an even tighter burst window than the image surface.
  rateLimiter?: RateLimiter
  // Durable per-client daily ceiling in *clips*; separate ledger from images
  // so enabling video cannot starve (or be hidden by) the image budget.
  dailyCap: number
  fetchImpl?: typeof fetch
}

// Video is served as raw bytes: a clip is far bigger than an image, and
// base64-in-JSON would inflate it past the 16MB body limit for no benefit.
// The client learns model/mime/size from response headers, which stay free of
// any upstream-controlled data (model ids are config-validated slugs, the mime
// comes from our own container sniffing).
function videoHeaders(reply: FastifyReply, model: string, mimeType: string, bytes: number): FastifyReply {
  return reply
    .header('X-Video-Model', model)
    .header('X-Video-Mime', mimeType)
    .header('X-Video-Bytes', String(bytes))
    .header('Cache-Control', 'no-store')
}

export function registerVideogenRoutes(app: FastifyInstance, db: DatabaseSync, options: VideogenRouteOptions): void {
  const providers = options.providers
  const rateLimiter = options.rateLimiter
  const fetchImpl = options.fetchImpl ?? fetch

  const videoSpecOf = (providerId: string, model: string): { provider: ImagegenProviderConfig; spec: ImagegenModelSpec } | null => {
    const provider = providers.find((p) => p.id === providerId)
    const spec = provider?.modelSpecs.find((m) => m.id === model)
    if (!provider || !spec || spec.dialect !== 'openai-chat-video') return null
    return { provider, spec }
  }

  const hasVideoModels = providers.some((p) => p.modelSpecs.some((m) => m.dialect === 'openai-chat-video'))

  app.post('/api/v1/videogen', async (request: FastifyRequest<{
    Body: { provider?: string; model?: string; prompt?: string }
  }>, reply: FastifyReply) => {
    if (!hasVideoModels) {
      return reply.status(503).send({ error: 'videogen_unconfigured', message: '视频生成服务未配置' })
    }
    if (rateLimiter && !rateLimiter.allow(request)) {
      return reply.header('Retry-After', '60').status(429).send({
        error: 'rate_limited',
        message: '请求过于频繁，请稍后再试',
      })
    }

    const body = request.body || {}
    const { provider: providerId, model, prompt } = body
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
    const found = videoSpecOf(providerId, model)
    if (!found) {
      return reply.status(400).send({ error: 'invalid_model', message: '该服务下没有这个视频模型' })
    }
    const { provider, spec } = found

    // One clip per request; the durable ledger keeps the same shape as the
    // image one so the quota endpoint and the cap checks stay symmetrical.
    const clientKey = resolveUsageClientKey(request)
    const day = todayKey(new Date())
    const used = readUsage(db, 'videogen_usage', clientKey, day)
    if (used >= options.dailyCap) {
      return reply.status(429).send({
        error: 'daily_cap_exceeded',
        message: `今日视频生成次数已达上限（${options.dailyCap} 段），请明天再来`,
      })
    }
    addUsage(db, 'videogen_usage', clientKey, day, 1)

    try {
      const startedAt = performance.now()
      const result = await generateVideo(
        provider,
        { model, prompt: cleanPrompt },
        AbortSignal.timeout(spec.timeoutMs),
        fetchImpl,
      )
      // No prompt or key ever goes in here — same discipline as imagegen.
      request.log.info({
        provider: provider.id,
        model,
        ms: Math.round(performance.now() - startedAt),
        bytes: result.bytes.byteLength,
        mime: result.mimeType,
      }, 'videogen completed')
      return videoHeaders(reply, model, result.mimeType, result.bytes.byteLength).status(200).send(result.bytes)
    } catch (err: unknown) {
      request.log.warn({ err }, 'videogen upstream call failed')
      if (err instanceof ImagegenUpstreamError) {
        return reply.status(err.status).send({
          error: 'upstream_error',
          upstreamStatus: err.upstreamStatus || undefined,
          message: err.message,
        })
      }
      if (err instanceof Error && err.name === 'TimeoutError') {
        return reply.status(504).send({ error: 'upstream_timeout', message: '视频生成超时，请稍后重试' })
      }
      return reply.status(502).send({ error: 'upstream_error', message: '视频生成请求失败，请稍后重试' })
    }
  })

  app.get('/api/v1/videogen/quota', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasVideoModels) {
      return reply.status(503).send({ error: 'videogen_unconfigured', message: '视频生成服务未配置' })
    }
    const clientKey = resolveUsageClientKey(request)
    const day = todayKey(new Date())
    const used = readUsage(db, 'videogen_usage', clientKey, day)
    return reply.status(200).send({ used, cap: options.dailyCap, remaining: Math.max(0, options.dailyCap - used) })
  })
}
