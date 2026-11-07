import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { initDatabase } from '../server/db'
import { registerImagegenRoutes } from '../server/imagegen-route'
import { createRateLimiter } from '../server/rate-limit'
import type { ImagegenProviderConfig } from '../server/imagegen-config'
import { withModelSpecs } from './helpers'

function provider(overrides: Partial<ImagegenProviderConfig> = {}): ImagegenProviderConfig {
  return withModelSpecs({
    id: 'google-direct',
    name: 'Google Direct',
    type: 'gemini',
    baseUrl: 'https://upstream.example/v1',
    apiKey: 'sk-test',
    models: ['gemini-3.1-flash-image'],
    defaultModel: 'gemini-3.1-flash-image',
    captionModel: 'gemini-3.1-flash-image',
    ...overrides,
  })
}

function createApp(
  providers: ImagegenProviderConfig[],
  options: { dailyCap?: number; rateLimiter?: ReturnType<typeof createRateLimiter>; fetchImpl?: typeof fetch } = {}
) {
  const app = Fastify()
  const appDb = initDatabase(':memory:')
  registerImagegenRoutes(app, appDb.db, {
    providers,
    rateLimiter: options.rateLimiter,
    dailyCap: options.dailyCap ?? 3,
    fetchImpl: options.fetchImpl,
  })
  return { app, appDb }
}

/** Minimal PNG header, enough for the server to read the declared pixels. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(8 + 8 + 13 + 4)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  header[24] = 8
  header[25] = 6
  return header
}

const reference = () => png(512, 512).toString('base64')

const geminiTextReply = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
})

describe('imagegen caption route', () => {
  it('reports caption_unconfigured as 503 when no provider declares captionModel', async () => {
    const { app } = createApp([provider({ captionModel: undefined })])
    const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: reference() } })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toBe('caption_unconfigured')
  })

  it('exposes captionModel in capabilities only when configured, and never leaks keys', async () => {
    const withCaption = createApp([provider()])
    const caps = await withCaption.app.inject({ method: 'GET', url: '/api/v1/imagegen/capabilities' })
    const body = JSON.parse(caps.body)
    expect(body.providers[0].captionModel).toBe('gemini-3.1-flash-image')
    expect(body.providers[0].baseUrl).toBeUndefined()
    expect(body.providers[0].apiKey).toBeUndefined()

    const without = createApp([provider({ captionModel: undefined })])
    const caps2 = await without.app.inject({ method: 'GET', url: '/api/v1/imagegen/capabilities' })
    const body2 = JSON.parse(caps2.body)
    expect(body2.providers[0].captionModel).toBeUndefined()
    expect('captionModel' in body2.providers[0] && body2.providers[0].captionModel !== undefined).toBe(false)
  })

  it('rejects an invalid image before any upstream call', async () => {
    const fetchImpl = vi.fn()
    const { app } = createApp([provider()], { fetchImpl: fetchImpl as unknown as typeof fetch })
    const badMime = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/gif', base64: reference() } })
    expect(badMime.statusCode).toBe(400)
    const badMagic = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: Buffer.from('not a png').toString('base64') } })
    expect(badMagic.statusCode).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends a text-only gemini generateContent with the reference as inlineData and returns the caption', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(geminiTextReply('一位女士在韩式餐厅用餐，暖色调')), { status: 200 })
    }) as unknown as typeof fetch
    const { app } = createApp([provider()], { fetchImpl })
    const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: reference() } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.provider).toBe('google-direct')
    expect(body.model).toBe('gemini-3.1-flash-image')
    expect(body.caption).toBe('一位女士在韩式餐厅用餐，暖色调')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://upstream.example/v1beta/models/gemini-3.1-flash-image:generateContent')
    const payload = JSON.parse(String(calls[0].init.body))
    expect(payload.generationConfig).toEqual({ responseModalities: ['TEXT'] })
    expect(payload.contents[0].parts[0].text).toContain('文生图模型')
    expect(payload.contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/png', data: reference() })
  })

  it('maps an upstream failure to the shared error envelope', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })) as unknown as typeof fetch
    const { app } = createApp([provider()], { fetchImpl })
    const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: reference() } })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('upstream_error')
    expect(body.message).toContain('boom')
  })

  it('errors with a hint when a 200 carries no text parts at all', async () => {
    // An image-only or empty reply has nothing to prefill with; quote-less 502
    // is the honest answer (the caption IS the text, so any text part wins).
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }] }), { status: 200 })) as unknown as typeof fetch
    const { app } = createApp([provider()], { fetchImpl })
    const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: reference() } })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).message).toContain('没有图片描述')
  })

  it('does not charge the imagegen daily cap', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(geminiTextReply('描述')), { status: 200 })) as unknown as typeof fetch
    const { app } = createApp([provider()], { fetchImpl, dailyCap: 3 })
    const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: reference() } })
    expect(res.statusCode).toBe(200)
    const quota = await app.inject({ method: 'GET', url: '/api/v1/imagegen/quota' })
    expect(JSON.parse(quota.body)).toEqual({ used: 0, cap: 3, remaining: 3 })
  })

  it('still answers the same daily cap after captions, so generations are unaffected', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(geminiTextReply('描述')), { status: 200 })) as unknown as typeof fetch
    const { app } = createApp([provider()], { fetchImpl, dailyCap: 3 })
    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: reference() } })
    }
    const quota = await app.inject({ method: 'GET', url: '/api/v1/imagegen/quota' })
    expect(JSON.parse(quota.body).used).toBe(0)
  })

  it('describes over the chat surface when the caption model is not a gemini dialect', async () => {
    const chatProvider = withModelSpecs({
      id: 'mangoapi',
      name: 'MangoApi 聚合',
      type: 'openai-images',
      baseUrl: 'https://upstream.example/v1',
      apiKey: 'sk-test',
      models: ['img-model-1', 'vlm-model'],
      defaultModel: 'img-model-1',
      captionModel: 'vlm-model',
      modelSpecs: [
        { id: 'img-model-1', dialect: 'openai-images', sizes: [], fixedSizeNote: null, edit: false, editsStyle: 'multipart', captionOnly: false, note: null, timeoutMs: 90_000 },
        { id: 'vlm-model', dialect: 'openai-chat-image', sizes: [], fixedSizeNote: null, edit: false, editsStyle: 'multipart', captionOnly: true, note: null, timeoutMs: 90_000 },
      ],
    })
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '一位女士在韩式餐厅用餐' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const { app } = createApp([chatProvider], { fetchImpl })
    const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: reference() } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).caption).toBe('一位女士在韩式餐厅用餐')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://upstream.example/v1/chat/completions')
    const payload = JSON.parse(String(calls[0].init.body))
    expect(payload.model).toBe('vlm-model')
    expect(payload.messages[0].content[0].text).toContain('文生图模型')
    expect(payload.messages[0].content[1].image_url.url).toContain('data:image/png;base64,')
  })

  it('accepts chat content arrays whose text parts omit the type discriminator', async () => {
    const chatProvider = withModelSpecs({
      id: 'mangoapi',
      name: 'MangoApi 聚合',
      type: 'openai-images',
      baseUrl: 'https://upstream.example/v1',
      apiKey: 'sk-test',
      models: ['img-model-1', 'vlm-model'],
      defaultModel: 'img-model-1',
      captionModel: 'vlm-model',
      modelSpecs: [
        { id: 'img-model-1', dialect: 'openai-images', sizes: [], fixedSizeNote: null, edit: false, editsStyle: 'multipart', captionOnly: false, note: null, timeoutMs: 90_000 },
        { id: 'vlm-model', dialect: 'openai-chat-image', sizes: [], fixedSizeNote: null, edit: false, editsStyle: 'multipart', captionOnly: true, note: null, timeoutMs: 90_000 },
      ],
    })
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: [{ text: '一张描述' }, { image_url: { url: 'https://x/y.png' } }] } }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const { app } = createApp([chatProvider], { fetchImpl })
    const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen/caption', payload: { mimeType: 'image/png', base64: reference() } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).caption).toBe('一张描述')
  })

  it('hides caption-only models from capabilities and refuses to generate with them', async () => {
    const chatProvider = withModelSpecs({
      id: 'mangoapi',
      name: 'MangoApi 聚合',
      type: 'openai-images',
      baseUrl: 'https://upstream.example/v1',
      apiKey: 'sk-test',
      models: ['img-model-1', 'vlm-model'],
      defaultModel: 'img-model-1',
      modelSpecs: [
        { id: 'img-model-1', dialect: 'openai-images', sizes: [], fixedSizeNote: null, edit: false, editsStyle: 'multipart', captionOnly: false, note: null, timeoutMs: 90_000 },
        { id: 'vlm-model', dialect: 'openai-chat-image', sizes: [], fixedSizeNote: null, edit: false, editsStyle: 'multipart', captionOnly: true, note: null, timeoutMs: 90_000 },
      ],
    })
    const { app } = createApp([chatProvider])
    const caps = await app.inject({ method: 'GET', url: '/api/v1/imagegen/capabilities' })
    const body = JSON.parse(caps.body)
    expect(body.providers[0].models).toEqual(['img-model-1'])
    expect(body.providers[0].modelInfos.map((m: { id: string }) => m.id)).toEqual(['img-model-1'])

    const gen = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'mangoapi', model: 'vlm-model', prompt: 'test' },
    })
    expect(gen.statusCode).toBe(400)
    expect(JSON.parse(gen.body).message).toContain('仅用于图片描述')
  })
})
