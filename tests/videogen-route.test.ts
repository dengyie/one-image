import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { initDatabase } from '../server/db'
import { registerVideogenRoutes } from '../server/videogen-route'
import { createRateLimiter } from '../server/rate-limit'
import type { ImagegenProviderConfig, ImagegenModelSpec } from '../server/imagegen-config'

// A minimal mp4: the ftyp box at offset 4 is what the mime sniffing keys on.
const MP4_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(24, 7)])

const videoSpec = (overrides: Partial<ImagegenModelSpec> = {}): ImagegenModelSpec => ({
  id: 'grok-imagine-video',
  dialect: 'openai-chat-video',
  sizes: [],
  fixedSizeNote: null,
  edit: false,
  editsStyle: 'multipart',
  note: '约 40-50s',
  timeoutMs: 90_000,
  ...overrides,
})

function provider(overrides: Partial<ImagegenProviderConfig> = {}, specs: ImagegenModelSpec[] = [videoSpec()]): ImagegenProviderConfig {
  return {
    id: 'mangoapi',
    name: 'MangoApi',
    type: 'openai-images',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    models: specs.map((m) => m.id),
    modelSpecs: specs,
    disabledModels: [],
    defaultModel: specs[0]?.id,
    mediaOrigin: 'http://127.0.0.1:18000',
    timeoutMs: 90_000,
    ...overrides,
  }
}

function createApp(
  providers: ImagegenProviderConfig[],
  options: { dailyCap?: number; rateLimiter?: ReturnType<typeof createRateLimiter>; fetchImpl?: typeof fetch } = {}
) {
  const app = Fastify()
  const appDb = initDatabase(':memory:')
  registerVideogenRoutes(app, appDb.db, {
    providers,
    rateLimiter: options.rateLimiter,
    dailyCap: options.dailyCap ?? 2,
    fetchImpl: options.fetchImpl,
  })
  return { app, appDb }
}

/** Chat reply pointing at the gateway's own loopback media address, as observed in production. */
function videoReply(url = 'http://127.0.0.1:18000/v1/media/videos/vid_abc') {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: `[video](${url})` } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function upstreamFetch(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/chat/completions')) return videoReply()
    return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } })
  }) as unknown as typeof fetch
}

describe('videogen routes', () => {
  it('reports unconfigured as 503 when no provider declares video models', async () => {
    const { app } = createApp([provider({}, [])])
    const res = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toBe('videogen_unconfigured')

    const quota = await app.inject({ method: 'GET', url: '/api/v1/videogen/quota' })
    expect(quota.statusCode).toBe(503)
  })

  it('returns the clip as raw bytes with honest headers, and the media URL is re-pointed', async () => {
    const fetchImpl = upstreamFetch()
    const { app } = createApp([provider()], { fetchImpl })
    const res = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: '一只猫' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-video-model']).toBe('grok-imagine-video')
    expect(res.headers['x-video-mime']).toBe('video/mp4')
    expect(res.headers['x-video-bytes']).toBe(String(MP4_BYTES.byteLength))
    expect(Buffer.from(res.rawPayload!).equals(MP4_BYTES)).toBe(true)

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
    // First call: the chat POST; second: the media download on the operator
    // origin — the loopback URL from the reply must have been rewritten there.
    expect(String(calls[0]![0])).toContain('/chat/completions')
    expect(String(calls[1]![0])).toBe('http://127.0.0.1:18000/v1/media/videos/vid_abc')
    // The provider key never leaves the configured upstream host.
    expect((calls[1]![1] as RequestInit).headers).toEqual({})
  })

  it('accounts usage in the durable ledger and exposes it on the quota endpoint', async () => {
    const { app, appDb } = createApp([provider()], { fetchImpl: upstreamFetch(), dailyCap: 2 })
    await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    const quota = await app.inject({ method: 'GET', url: '/api/v1/videogen/quota' })
    expect(quota.statusCode).toBe(200)
    expect(JSON.parse(quota.body)).toEqual({ used: 1, cap: 2, remaining: 1 })
    expect(appDb.db.prepare('SELECT count FROM videogen_usage').all()).toHaveLength(1)
  })

  it('rejects the request before any spend once the daily cap is reached', async () => {
    const fetchImpl = upstreamFetch()
    const { app } = createApp([provider()], { fetchImpl, dailyCap: 1 })
    const headers = { 'cf-connecting-ip': '203.0.113.5' }
    const first = await app.inject({ method: 'POST', url: '/api/v1/videogen', headers, payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    expect(first.statusCode).toBe(200)
    const capped = await app.inject({ method: 'POST', url: '/api/v1/videogen', headers, payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    expect(capped.statusCode).toBe(429)
    expect(JSON.parse(capped.body).error).toBe('daily_cap_exceeded')
    // Another client is unaffected.
    const other = await app.inject({ method: 'POST', url: '/api/v1/videogen', headers: { 'cf-connecting-ip': '198.51.100.9' }, payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    expect(other.statusCode).toBe(200)
    // Exactly the two successful generations hit the upstream.
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls
    expect(calls).toHaveLength(4) // 2 × (chat POST + media download)
  })

  it('rate limits bursts per client', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 1, maxTrackedClients: 100 })
    const { app } = createApp([provider()], { fetchImpl: upstreamFetch(), rateLimiter: limiter })
    const first = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    const second = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(429)
    expect(JSON.parse(second.body).error).toBe('rate_limited')
  })

  it('turns a text-only chat reply into a 502 that quotes the model', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '我不能生成视频' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('ignored', { status: 200 })
    }) as unknown as typeof fetch
    const { app } = createApp([provider()], { fetchImpl })
    const res = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.message).toContain('上游返回中没有视频数据')
    expect(body.message).toContain('我不能生成视频')
  })

  it('maps an upstream failure to 502 and keeps the status opaque', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: '该令牌额度不足' } }), { status: 401 })) as unknown as typeof fetch
    const { app } = createApp([provider()], { fetchImpl })
    const res = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: 'p' } })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('upstream_error')
    // Same contract as the image surface: the message passes through so the
    // operator can diagnose, while the *status* never mirrors upstream auth.
    expect(body.message).toBe('该令牌额度不足')
  })

  it('validates input before touching the quota or the upstream', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { app, appDb } = createApp([provider()], { fetchImpl })
    const missing = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi' } })
    expect(missing.statusCode).toBe(400)
    expect(JSON.parse(missing.body).error).toBe('missing_fields')

    const emptyPrompt = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'grok-imagine-video', prompt: '   ' } })
    expect(emptyPrompt.statusCode).toBe(400)

    const unknownModel = await app.inject({ method: 'POST', url: '/api/v1/videogen', payload: { provider: 'mangoapi', model: 'gpt-image-2', prompt: 'p' } })
    expect(unknownModel.statusCode).toBe(400)
    expect(JSON.parse(unknownModel.body).error).toBe('invalid_model')

    expect(appDb.db.prepare('SELECT COUNT(*) AS n FROM videogen_usage').get()).toEqual({ n: 0 })
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('serves the quota endpoint zeroed for a fresh client', async () => {
    const { app } = createApp([provider()], { fetchImpl: upstreamFetch() })
    const quota = await app.inject({ method: 'GET', url: '/api/v1/videogen/quota' })
    expect(quota.statusCode).toBe(200)
    expect(JSON.parse(quota.body)).toEqual({ used: 0, cap: 2, remaining: 2 })
  })
})
