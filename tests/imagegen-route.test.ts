import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { initDatabase } from '../server/db'
import { registerImagegenRoutes } from '../server/imagegen-route'
import { createRateLimiter } from '../server/rate-limit'
import type { ImagegenModelSpec, ImagegenProviderConfig } from '../server/imagegen-config'
import { withModelSpecs } from './helpers'

function provider(overrides: Partial<ImagegenProviderConfig> = {}): ImagegenProviderConfig {
  return withModelSpecs({
    id: 'test',
    name: 'Test Provider',
    type: 'openai-images',
    baseUrl: 'https://upstream.example/v1',
    apiKey: 'sk-test',
    models: ['img-model-1'],
    defaultModel: 'img-model-1',
    ...overrides,
  })
}

function createApp(
  providers: ImagegenProviderConfig[],
  options: { dailyCap?: number; rateLimiter?: ReturnType<typeof createRateLimiter>; fetchImpl?: typeof fetch; bodyLimit?: number } = {}
) {
  const app = Fastify(options.bodyLimit ? { bodyLimit: options.bodyLimit } : {})
  const appDb = initDatabase(':memory:')
  registerImagegenRoutes(app, appDb.db, {
    providers,
    rateLimiter: options.rateLimiter,
    dailyCap: options.dailyCap ?? 3,
    fetchImpl: options.fetchImpl,
  })
  return { app, appDb }
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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

describe('imagegen routes', () => {
  it('reports unconfigured as 503 and never leaks keys in capabilities', async () => {
    const { app, appDb } = createApp([])
    const genRes = await app.inject({ method: 'POST', url: '/api/v1/imagegen', payload: { provider: 'x', model: 'y', prompt: 'p' } })
    expect(genRes.statusCode).toBe(503)
    expect(JSON.parse(genRes.body).error).toBe('imagegen_unconfigured')

    const { app: app2, appDb: appDb2 } = createApp([provider()])
    const caps = await app2.inject({ method: 'GET', url: '/api/v1/imagegen/capabilities' })
    expect(caps.statusCode).toBe(200)
    const body = JSON.parse(caps.body)
    expect(body.enabled).toBe(true)
    expect(body.providers[0]).toEqual({
      id: 'test',
      name: 'Test Provider',
      models: ['img-model-1'],
      defaultModel: 'img-model-1',
      sizes: [],
      fixedSizeNote: null,
      editModels: [],
      modelInfos: [{ id: 'img-model-1', dialect: 'openai-images', sizes: [], fixedSizeNote: null, edit: false, note: null, timeoutMs: 90_000 }],
      timeoutMs: 90_000,
    })
    // Timeouts are advertised so the browser can give up with the server; keys
    // and URLs still never leave.
    expect(body.providers[0].baseUrl).toBeUndefined()
    expect(body.providers[0].apiKey).toBeUndefined()
    expect(caps.body).not.toContain('sk-test')
    expect(caps.body).not.toContain('sk-test')
    expect(caps.body).not.toContain('upstream.example')
    appDb.close()
    appDb2.close()
  })

  it('validates the request contract before spending money', async () => {
    const { app, appDb } = createApp([provider({ sizes: ['1024x1024'] })])
    const cases: { payload: Record<string, unknown>; error: string }[] = [
      { payload: { model: 'img-model-1', prompt: 'p' }, error: 'missing_fields' },
      { payload: { provider: 'test', model: 'img-model-1', prompt: '   ' }, error: 'invalid_prompt' },
      { payload: { provider: 'test', model: 'img-model-1', prompt: 'x'.repeat(4001) }, error: 'invalid_prompt' },
      { payload: { provider: 'nope', model: 'img-model-1', prompt: 'p' }, error: 'invalid_provider' },
      { payload: { provider: 'test', model: 'other-model', prompt: 'p' }, error: 'invalid_model' },
      { payload: { provider: 'test', model: 'img-model-1', prompt: 'p', n: 5 }, error: 'invalid_n' },
      { payload: { provider: 'test', model: 'img-model-1', prompt: 'p', size: '9999x9999' }, error: 'invalid_size' },
    ]
    for (const { payload, error } of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen', payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(JSON.parse(res.body).error).toBe(error)
    }
    appDb.close()
  })

  it('generates via an OpenAI-compatible upstream with b64_json', async () => {
    const pngBase64 = Buffer.from(PNG_BYTES).toString('base64')
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: pngBase64, revised_prompt: 'better prompt' }],
    }), { status: 200 }))
    const { app, appDb } = createApp([provider({ sizes: ['1024x1024'] })], { fetchImpl: fetchImpl as unknown as typeof fetch })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'a cat in space', n: 1, size: '1024x1024' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.provider).toBe('test')
    expect(body.model).toBe('img-model-1')
    expect(body.images).toHaveLength(1)
    expect(body.images[0].mimeType).toBe('image/png')
    expect(body.images[0].base64).toBe(pngBase64)
    expect(body.revisedPrompt).toBe('better prompt')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/images/generations')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      model: 'img-model-1',
      prompt: 'a cat in space',
      n: 1,
      size: '1024x1024',
    })
    appDb.close()
  })

  it('downloads url-style upstream results and strips size when unlisted', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/out.png' }] }), { status: 200 })
      }
      return new Response(PNG_BYTES as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const { app, appDb } = createApp([provider()], { fetchImpl: fetchImpl as unknown as typeof fetch })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'a cat' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.images).toHaveLength(1)
    expect(body.images[0].mimeType).toBe('image/png')
    // size was not in provider.sizes, so the upstream body must not carry it.
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string).size).toBeUndefined()
    appDb.close()
  })

  it('guards url-style downloads: https cross-host without auth, private hosts and http rejected', async () => {
    const seen: { url: string; auth: string | undefined }[] = []
    // Upstream generations responses in the order the five calls below arrive;
    // the route must reject the unsafe ones before any image fetch happens.
    const upstreamUrls = [
      'https://cdn.example/out.png',
      'https://upstream.example/out.png',
      'http://cdn.example/out.png',
      'https://169.254.169.254/latest/meta-data',
    ]
    let generationCall = 0
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.endsWith('/images/generations')) {
        const itemUrl = upstreamUrls[generationCall++] ?? ''
        return new Response(JSON.stringify({ data: [{ url: itemUrl }] }), { status: 200 })
      }
      seen.push({
        url: target,
        auth: init?.headers ? ((init.headers as Record<string, string>).Authorization as string | undefined) : undefined,
      })
      // A fresh Response per fetch: bodies are consumed by arrayBuffer().
      return new Response(new Uint8Array(8), { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerImagegenRoutes(app, appDb.db, {
      providers: [provider()],
      dailyCap: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/imagegen',
        payload: { provider: 'test', model: 'img-model-1', prompt: 'p' },
      })

    // https cross-host is allowed but must not carry the provider key.
    const crossHost = await call()
    expect(crossHost.statusCode).toBe(200)
    expect(seen.at(-1)).toEqual({ url: 'https://cdn.example/out.png', auth: undefined })

    // Same-host https keeps the authenticated download.
    const sameHost = await call()
    expect(sameHost.statusCode).toBe(200)
    expect(seen.at(-1)).toEqual({ url: 'https://upstream.example/out.png', auth: 'Bearer sk-test' })

    // Plain http cross-host and any private/loopback host are rejected before
    // the server fetches anything.
    const plainHttp = await call()
    expect(plainHttp.statusCode).toBe(502)
    expect(JSON.parse(plainHttp.body).message).toContain('不被允许的图片地址')
    const loopback = await call()
    expect(loopback.statusCode).toBe(502)
    expect(JSON.parse(loopback.body).message).toContain('内网/回环')
    expect(seen.filter((s) => s.url.includes('169.254'))).toHaveLength(0)
    appDb.close()
  })

  it('caps oversized b64_json payloads instead of holding unbounded upstream memory', async () => {
    const oversized = 'A'.repeat(45_000_000)
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: oversized }] }), { status: 200 }))
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerImagegenRoutes(app, appDb.db, { providers: [provider()], dailyCap: 50, fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'p' },
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).message).toContain('32MB 上限')
    appDb.close()
  })

  it('maps upstream auth/quota failures to safe client errors', async () => {

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 }))
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerImagegenRoutes(app, appDb.db, { providers: [provider()], dailyCap: 3, fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'a cat' },
    })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('upstream_error')
    expect(body.upstreamStatus).toBe(401)
    expect(body.message).toBe('Incorrect API key')
    appDb.close()
  })

  it('counts every attempt against the durable daily cap', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }))
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerImagegenRoutes(app, appDb.db, { providers: [provider()], dailyCap: 2, fetchImpl: fetchImpl as unknown as typeof fetch })
    const headers = { 'cf-connecting-ip': '203.0.113.5' }
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/imagegen', headers, payload: { provider: 'test', model: 'img-model-1', prompt: 'p' } })
      expect(res.statusCode).toBe(502)
    }
    const capped = await app.inject({ method: 'POST', url: '/api/v1/imagegen', headers, payload: { provider: 'test', model: 'img-model-1', prompt: 'p' } })
    expect(capped.statusCode).toBe(429)
    expect(JSON.parse(capped.body).error).toBe('daily_cap_exceeded')

    // Another client is unaffected.
    const other = await app.inject({ method: 'POST', url: '/api/v1/imagegen', headers: { 'cf-connecting-ip': '198.51.100.9' }, payload: { provider: 'test', model: 'img-model-1', prompt: 'p' } })
    expect(other.statusCode).toBe(502)

    // The cap is durable in SQLite.
    const rows = appDb.db.prepare('SELECT count FROM imagegen_usage').all() as unknown as { count: number }[]
    expect(rows.reduce((acc, r) => acc + r.count, 0)).toBe(3)
    appDb.close()
  })

  it('rejects rate-limited clients before the upstream call', async () => {
    const fetchImpl = vi.fn()
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerImagegenRoutes(app, appDb.db, {
      providers: [provider()],
      dailyCap: 100,
      rateLimiter: createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 2, maxTrackedClients: 100 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const headers = { 'cf-connecting-ip': '203.0.113.77' }
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/imagegen', headers, payload: { provider: 'test', model: 'img-model-1', prompt: 'p' } })
    }
    const throttled = await app.inject({ method: 'POST', url: '/api/v1/imagegen', headers, payload: { provider: 'test', model: 'img-model-1', prompt: 'p' } })
    expect(throttled.statusCode).toBe(429)
    expect(JSON.parse(throttled.body).error).toBe('rate_limited')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    appDb.close()
  })

  it('reports the pixels that arrived and echoes the requested size', async () => {
    const real = png(1254, 1254).toString('base64')
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: real }] }), { status: 200 }))
    const { app, appDb } = createApp([provider({ sizes: ['1024x1024'] })], { fetchImpl: fetchImpl as unknown as typeof fetch })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'a cat', size: '1024x1024' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // gpt-image-2.5 really answers 1254×1254 for a 1024x1024 request.
    expect(body.images[0].width).toBe(1254)
    expect(body.images[0].height).toBe(1254)
    expect(body.requestedSize).toBe('1024x1024')
    expect(body.failed).toBe(0)
    appDb.close()
  })

  it('passes a partial fan-out through instead of failing the whole batch', async () => {
    const real = png(64, 64).toString('base64')
    let call = 0
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call += 1
      if (call === 1) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: real } }] } }] }), { status: 200 })
    })
    const { app, appDb } = createApp(
      [provider({ id: 'google', type: 'gemini', baseUrl: 'https://generativelanguage.example', models: ['gemini-2.5-flash-image'] })],
      { dailyCap: 10, fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'google', model: 'gemini-2.5-flash-image', prompt: 'a cat', n: 2 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.images).toHaveLength(1)
    expect(body.failed).toBe(1)
    appDb.close()
  })

  it('charges the daily cap per image, not per request', async () => {
    const real = png(32, 32).toString('base64')
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: real }] }), { status: 200 }))
    const { app, appDb } = createApp([provider()], { dailyCap: 3, fetchImpl: fetchImpl as unknown as typeof fetch })
    const headers = { 'cf-connecting-ip': '203.0.113.61' }
    const body = (n: number) => ({ provider: 'test', model: 'img-model-1', prompt: 'p', n })

    const first = await app.inject({ method: 'POST', url: '/api/v1/imagegen', headers, payload: body(2) })
    expect(first.statusCode).toBe(200)
    // One image left in the budget, so a two-image request is refused whole.
    const tooMany = await app.inject({ method: 'POST', url: '/api/v1/imagegen', headers, payload: body(2) })
    expect(tooMany.statusCode).toBe(429)
    expect(JSON.parse(tooMany.body).message).toContain('仅剩 1 张')
    const last = await app.inject({ method: 'POST', url: '/api/v1/imagegen', headers, payload: body(1) })
    expect(last.statusCode).toBe(200)

    const rows = appDb.db.prepare('SELECT count FROM imagegen_usage').all() as unknown as { count: number }[]
    expect(rows.reduce((acc, r) => acc + r.count, 0)).toBe(3)
    appDb.close()
  })

  it('refuses a bad reference image before the upstream is called', async () => {
    const real = png(64, 64).toString('base64')
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: real }] }), { status: 200 }))
    const { app, appDb } = createApp([provider({ editModels: ['img-model-1'] })], {
      dailyCap: 10,
      bodyLimit: 16 * 1024 * 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const cases: { image: Record<string, unknown>; error: string }[] = [
      { image: { mimeType: 'image/gif', base64: reference() }, error: 'invalid_input_image' },
      // Declared PNG, but the bytes are a JPEG.
      { image: { mimeType: 'image/png', base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64') }, error: 'invalid_input_image' },
      { image: { mimeType: 'image/png', base64: 'not base64!!' }, error: 'invalid_input_image' },
      { image: { mimeType: 'image/png', base64: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') }, error: 'invalid_input_image' },
    ]
    for (const { image, error } of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imagegen',
        payload: { provider: 'test', model: 'img-model-1', prompt: 'p', image },
      })
      expect(res.statusCode, JSON.stringify(image.mimeType)).toBe(400)
      expect(JSON.parse(res.body).error).toBe(error)
    }

    // A model outside editModels never sees the reference either.
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'p', image: { mimeType: 'image/png', base64: reference() } },
    })
    expect(unsupported.statusCode).toBe(200)

    const { app: plainApp, appDb: plainDb } = createApp([provider()], { dailyCap: 10, fetchImpl: fetchImpl as unknown as typeof fetch })
    const refused = await plainApp.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'p', image: { mimeType: 'image/png', base64: reference() } },
    })
    expect(refused.statusCode).toBe(400)
    expect(JSON.parse(refused.body).error).toBe('image_input_unsupported')

    // Exactly one request reached the upstream: the accepted edit.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://upstream.example/v1/images/edits')
    appDb.close()
    plainDb.close()
  })

  it('gemini adapter parses inlineData and fans out n', async () => {
    const pngBase64 = Buffer.from(PNG_BYTES).toString('base64')
    let calls = 0
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBase64 } }] } }],
      }), { status: 200 })
    })
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerImagegenRoutes(app, appDb.db, {
      providers: [provider({
        id: 'google',
        type: 'gemini',
        baseUrl: 'https://generativelanguage.example',
        models: ['gemini-2.5-flash-image'],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      })],
      dailyCap: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'google', model: 'gemini-2.5-flash-image', prompt: 'a cat', n: 2 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.images).toHaveLength(2)
    expect(body.images[0].mimeType).toBe('image/png')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://generativelanguage.example/v1beta/models/gemini-2.5-flash-image:generateContent')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'sk-test' })
    // generationConfig contents merge verbatim into the body (Google API shape),
    // not nested under a key.
    expect(JSON.parse((init as RequestInit).body as string).responseModalities).toEqual(['TEXT', 'IMAGE'])
    appDb.close()
  })

  it('normalizes a /v1-suffixed baseUrl for the gemini surface (mixed-gateway providers)', async () => {
    const pngBase64 = Buffer.from(png(64, 64)).toString('base64')
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBase64 } }] } }],
      }), { status: 200 }))
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerImagegenRoutes(app, appDb.db, {
      // One gateway provider whose baseUrl carries the OpenAI-style /v1 the
      // image dialects need; the gemini model must not inherit that suffix.
      providers: [provider({
        id: 'mangoapi',
        type: 'gemini',
        baseUrl: 'https://api.example.com/v1',
        models: ['gemini-3.1-flash-image'],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      })],
      dailyCap: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'mangoapi', model: 'gemini-3.1-flash-image', prompt: 'a cat', n: 1 },
    })
    expect(res.statusCode).toBe(200)
    const [url] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://api.example.com/v1beta/models/gemini-3.1-flash-image:generateContent')
    appDb.close()
  })

  it('gemini adapter reads the image from a markdown data-URL text part (gateway envelope)', async () => {
    const pngBase64 = Buffer.from(png(768, 1152)).toString('base64')
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: `![image](data:image/png;base64,${pngBase64})` }] } }],
      }), { status: 200 }),
    )
    const { app, appDb } = createApp([
      provider({ id: 'google', type: 'gemini', baseUrl: 'https://generativelanguage.example', models: ['gemini-3.1-flash-image'] }),
    ], { fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'google', model: 'gemini-3.1-flash-image', prompt: '黄昏海滩', n: 1 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.images).toHaveLength(1)
    expect(body.images[0].mimeType).toBe('image/png')
    expect(body.images[0].width).toBe(768)
    expect(body.images[0].height).toBe(1152)
    // One upstream call only: the envelope carried the bytes inline.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    appDb.close()
  })

  it('gemini adapter downloads markdown http image refs from text parts', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.includes(':generateContent')) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'done: ![image](https://media.example/img/abc.jpg)' }] } }],
        }), { status: 200 })
      }
      expect(url).toBe('https://media.example/img/abc.jpg')
      return new Response(new Uint8Array(png(512, 512)), { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const { app, appDb } = createApp([
      provider({ id: 'google', type: 'gemini', baseUrl: 'https://generativelanguage.example', models: ['gemini-3.1-flash-image'] }),
    ], { fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'google', model: 'gemini-3.1-flash-image', prompt: '黄昏海滩', n: 1 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).images).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    appDb.close()
  })

  it('gemini envelope caps server-side downloads at the requested count', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: unknown) => {
      if (String(input).includes(':generateContent')) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: '![a](https://media.example/a.jpg) ![b](https://media.example/b.jpg)' }] } }],
        }), { status: 200 })
      }
      return new Response(new Uint8Array(png(512, 512)), { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const { app, appDb } = createApp([
      provider({ id: 'google', type: 'gemini', baseUrl: 'https://generativelanguage.example', models: ['gemini-3.1-flash-image'] }),
    ], { fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'google', model: 'gemini-3.1-flash-image', prompt: '黄昏海滩', n: 1 },
    })
    expect(res.statusCode).toBe(200)
    // One generateContent call plus exactly one media download: the second ref
    // in the envelope is beyond what the client paid for.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(res.body).images).toHaveLength(1)
    appDb.close()
  })

  it('gemini text-only reply names what the model said instead of a generic 502', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '抱歉，我不能生成这类内容。' }] } }],
      }), { status: 200 }),
    )
    const { app, appDb } = createApp([
      provider({ id: 'google', type: 'gemini', baseUrl: 'https://generativelanguage.example', models: ['gemini-3.1-flash-image'] }),
    ], { fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'google', model: 'gemini-3.1-flash-image', prompt: 'p', n: 1 },
    })
    expect(res.statusCode).toBe(502)
    const message = JSON.parse(res.body).message as string
    expect(message).toContain('上游返回中没有图片数据')
    expect(message).toContain('抱歉，我不能生成这类内容')
    appDb.close()
  })

  it('openai-images caps a chatty upstream at the requested count', async () => {
    const b64 = Buffer.from(png(256, 256)).toString('base64')
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: b64 }, { b64_json: b64 }] }), { status: 200 }),
    )
    const { app, appDb } = createApp([provider()], { fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'p', n: 1 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // The quota was charged for one image; a second entry from the upstream
    // must not leak through as a free extra.
    expect(body.images).toHaveLength(1)
    expect(body.failed).toBe(0)
    appDb.close()
  })

  it('openai-images reports an under-delivering upstream as failed', async () => {
    const b64 = Buffer.from(png(256, 256)).toString('base64')
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 }),
    )
    const { app, appDb } = createApp([provider()], { fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'p', n: 2 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.images).toHaveLength(1)
    expect(body.failed).toBe(1)
    appDb.close()
  })
})

describe('imagegen url host guard (IPv6 and false positives)', () => {
  const png = () => new Response(new Uint8Array(8), { status: 200, headers: { 'content-type': 'image/png' } })

  function makeApp(upstreamUrls: string[]) {
    let generationCall = 0
    const seen: { url: string; auth: string | undefined }[] = []
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.endsWith('/images/generations')) {
        const itemUrl = upstreamUrls[generationCall++] ?? ''
        return new Response(JSON.stringify({ data: [{ url: itemUrl }] }), { status: 200 })
      }
      seen.push({
        url: target,
        auth: init?.headers ? ((init.headers as Record<string, string>).Authorization as string | undefined) : undefined,
      })
      return png()
    })
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerImagegenRoutes(app, appDb.db, {
      providers: [provider({ baseUrl: 'https://fcdn.example/v1' })],
      dailyCap: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    return { app, appDb, seen }
  }

  it('rejects IPv6 private literals (bracketed + URL-normalized hex mapped v4)', async () => {
    const { app, appDb, seen } = makeApp([
      'https://[::1]/x.png',
      'https://[::ffff:127.0.0.1]/x.png',
      'https://[::ffff:7f00:1]/x.png',
    ])
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imagegen',
        payload: { provider: 'test', model: 'img-model-1', prompt: 'p' },
      })
      expect(res.statusCode, `case ${i}`).toBe(502)
      expect(JSON.parse(res.body).message).toContain('内网/回环')
    }
    // None of the private hosts may actually be fetched.
    expect(seen.filter((s) => s.url.includes('['))).toHaveLength(0)
    appDb.close()
  })

  it('does not flag public domains that merely start with fc/fd, and keeps same-host auth', async () => {
    const { app, appDb, seen } = makeApp(['https://fcdn.example/out.png'])
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'img-model-1', prompt: 'p' },
    })
    expect(res.statusCode).toBe(200)
    expect(seen).toEqual([{ url: 'https://fcdn.example/out.png', auth: 'Bearer sk-test' }])
    appDb.close()
  })
})

describe('per-model route semantics', () => {
  const spec = (overrides: Record<string, unknown> = {}): ImagegenModelSpec => ({
    id: 'm',
    dialect: 'openai-images',
    sizes: [] as string[],
    fixedSizeNote: null as string | null,
    edit: false,
    editsStyle: 'multipart' as const,
    note: null as string | null,
    timeoutMs: 90_000,
    ...overrides,
  })

  const videoOnlyProvider = () => provider({
    models: ['grok-imagine-video'],
    modelSpecs: [spec({ id: 'grok-imagine-video', dialect: 'openai-chat-video' })],
  })

  it('treats a video-only provider as an unconfigured image surface', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { app, appDb } = createApp([videoOnlyProvider()], { fetchImpl })
    const caps = await app.inject({ method: 'GET', url: '/api/v1/imagegen/capabilities' })
    expect(caps.statusCode).toBe(503)
    expect(JSON.parse(caps.body).error).toBe('imagegen_unconfigured')

    const post = await app.inject({ method: 'POST', url: '/api/v1/imagegen', payload: { provider: 'test', model: 'grok-imagine-video', prompt: 'p' } })
    expect(post.statusCode).toBe(503)
    expect(JSON.parse(post.body).error).toBe('imagegen_unconfigured')

    const quota = await app.inject({ method: 'GET', url: '/api/v1/imagegen/quota' })
    expect(quota.statusCode).toBe(503)
    appDb.close()
  })

  it('validates size against the selected model, not the provider fallback', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png(64, 64)).toString('base64') }] }), { status: 200 }))
    const { app } = createApp([provider({
      models: ['model-a', 'model-b'],
      modelSpecs: [
        spec({ id: 'model-a', sizes: ['1024x1024'] }),
        spec({ id: 'model-b' }),
      ],
    })], { fetchImpl: fetchImpl as unknown as typeof fetch })

    const okForA = await app.inject({ method: 'POST', url: '/api/v1/imagegen', payload: { provider: 'test', model: 'model-a', prompt: 'p', size: '1024x1024' } })
    expect(okForA.statusCode).toBe(200)

    const refusedForB = await app.inject({ method: 'POST', url: '/api/v1/imagegen', payload: { provider: 'test', model: 'model-b', prompt: 'p', size: '1024x1024' } })
    expect(refusedForB.statusCode).toBe(400)
    expect(JSON.parse(refusedForB.body).error).toBe('invalid_size')
  })

  it('lets an explicit per-model edit:false win over the legacy editModels list', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { app } = createApp([provider({
      models: ['model-a', 'model-b'],
      editModels: ['model-b'],
      modelSpecs: [
        spec({ id: 'model-a', edit: true }),
        spec({ id: 'model-b', edit: false }),
      ],
    })], { fetchImpl })

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'model-b', prompt: 'p', image: { mimeType: 'image/png', base64: png(64, 64).toString('base64') } },
    })
    expect(refused.statusCode).toBe(400)
    expect(JSON.parse(refused.body).error).toBe('image_input_unsupported')

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/imagegen',
      payload: { provider: 'test', model: 'model-a', prompt: 'p', image: { mimeType: 'image/png', base64: png(64, 64).toString('base64') } },
    })
    expect(allowed.statusCode).toBe(502) // reaches the (failing) mocked upstream
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('projects defaultModel within the image models when the config default is a video id', async () => {
    const { app } = createApp([provider({
      models: ['img-model-1', 'grok-imagine-video'],
      defaultModel: 'grok-imagine-video',
      modelSpecs: [
        spec({ id: 'img-model-1' }),
        spec({ id: 'grok-imagine-video', dialect: 'openai-chat-video' }),
      ],
    })])
    const caps = await app.inject({ method: 'GET', url: '/api/v1/imagegen/capabilities' })
    expect(caps.statusCode).toBe(200)
    const body = JSON.parse(caps.body)
    expect(body.providers[0].defaultModel).toBe('img-model-1')
    expect(body.video.providers[0].defaultModel).toBe('grok-imagine-video')
  })
})
