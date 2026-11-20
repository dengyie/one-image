import { describe, expect, it, vi } from 'vitest'
import { generateImages, ImagegenUpstreamError } from '../server/imagegen-providers'
import type { ImagegenProviderConfig } from '../server/imagegen-config'
import { withModelSpecs } from './helpers'

// Contract fixtures for the openai-images dialect's *generation* surface
// (`POST /images/generations`). The edit surface (multipart / xai-json) is
// covered by imagegen-edits.test.ts; this file pins the plain generations
// envelope: b64_json vs url entries, revised_prompt propagation, the n
// truncation rule, and the error mapping.

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

function provider(overrides: Partial<ImagegenProviderConfig> = {}): ImagegenProviderConfig {
  return withModelSpecs({
    id: 'mangoapi',
    name: 'Mango',
    type: 'openai-images',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    models: ['gpt-image-2.5'],
    defaultModel: 'gpt-image-2.5',
    timeoutMs: 90_000,
    ...overrides,
  })
}

const PNG_1254 = png(1254, 1254)
const B64 = PNG_1254.toString('base64')

function jsonFetch(body: unknown, status = 200, capture?: { url?: string; body?: string; headers?: Record<string, string> }) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(input)
      capture.body = typeof init?.body === 'string' ? init.body : undefined
      capture.headers = Object.fromEntries(new Headers(init?.headers).entries())
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('openai-images generations contract', () => {
  it('posts prompt+size+Bearer to /images/generations and decodes b64_json with real dimensions', async () => {
    const captured: { url?: string; body?: string; headers?: Record<string, string> } = {}
    const result = await generateImages(
      provider(),
      { model: 'gpt-image-2.5', prompt: 'a mango', n: 1, size: '1024x1024' },
      AbortSignal.timeout(5000),
      jsonFetch({ data: [{ b64_json: B64 }] }, 200, captured)
    )
    expect(captured.url).toBe('https://api.example.com/v1/images/generations')
    expect(captured.headers?.authorization).toBe('Bearer sk-secret')
    const sent = JSON.parse(captured.body ?? '{}') as { model: string; prompt: string; n: number; size: string }
    expect(sent).toEqual({ model: 'gpt-image-2.5', prompt: 'a mango', n: 1, size: '1024x1024' })
    expect(result.images).toHaveLength(1)
    expect(result.images[0].width).toBe(1254)
    expect(result.revisedPrompt).toBeUndefined()
  })

  it('downloads a url entry instead of b64_json and preserves byte identity', async () => {
    const bytes = png(64, 48)
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://cdn.example.com/out.png') {
        return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/out.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const result = await generateImages(
      provider(),
      { model: 'gpt-image-2.5', prompt: 'p', n: 1 },
      AbortSignal.timeout(5000),
      fetchImpl
    )
    expect(result.images).toHaveLength(1)
    expect(result.images[0].mimeType).toBe('image/png')
    expect(result.images[0].width).toBe(64)
    expect(Buffer.from(result.images[0].base64, 'base64').equals(bytes)).toBe(true)
  })

  it('propagates revised_prompt when the upstream returns one', async () => {
    const result = await generateImages(
      provider(),
      { model: 'gpt-image-2.5', prompt: 'p', n: 1 },
      AbortSignal.timeout(5000),
      jsonFetch({ data: [{ b64_json: B64, revised_prompt: 'a ripe mango on a plate' }] })
    )
    expect(result.revisedPrompt).toBe('a ripe mango on a plate')
  })

  it('truncates a chatty upstream to the requested count and reports failed', async () => {
    const result = await generateImages(
      provider(),
      { model: 'gpt-image-2.5', prompt: 'p', n: 2 },
      AbortSignal.timeout(5000),
      jsonFetch({ data: [{ b64_json: B64 }, { b64_json: B64 }, { b64_json: B64 }] })
    )
    expect(result.images).toHaveLength(2)
    expect(result.failed).toBeUndefined()
  })

  it('reports failed when the upstream returns fewer entries than requested', async () => {
    const result = await generateImages(
      provider(),
      { model: 'gpt-image-2.5', prompt: 'p', n: 3 },
      AbortSignal.timeout(5000),
      jsonFetch({ data: [{ b64_json: B64 }] })
    )
    expect(result.images).toHaveLength(1)
    expect(result.failed).toBe(2)
  })

  it('rejects an empty envelope and an entry with neither b64_json nor url as 502', async () => {
    await expect(
      generateImages(provider(), { model: 'gpt-image-2.5', prompt: 'p', n: 1 }, AbortSignal.timeout(5000), jsonFetch({ data: [] }))
    ).rejects.toThrow('没有图片数据')
    await expect(
      generateImages(provider(), { model: 'gpt-image-2.5', prompt: 'p', n: 1 }, AbortSignal.timeout(5000), jsonFetch({ data: [{ id: 'x' }] }))
    ).rejects.toThrow('既无 b64_json 也无 url')
  })

  it('rejects an unknown model and a video spec on the image surface without any fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      generateImages(provider(), { model: 'nope', prompt: 'p', n: 1 }, AbortSignal.timeout(5000), fetchImpl)
    ).rejects.toThrow('不在该服务的可用列表中')
    await expect(
      generateImages(
        provider({ modelSpecs: [{ id: 'vid', dialect: 'openai-chat-video', sizes: [], fixedSizeNote: null, edit: false, editsStyle: 'multipart', note: null, timeoutMs: 1000 }] }),
        { model: 'vid', prompt: 'p', n: 1 },
        AbortSignal.timeout(5000),
        fetchImpl
      )
    ).rejects.toThrow('视频生成入口')
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('refuses to send a reference image to a spec declared without edit capability', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      generateImages(
        provider(),
        { model: 'gpt-image-2.5', prompt: 'p', n: 1, image: { mimeType: 'image/png', base64: B64 } },
        AbortSignal.timeout(5000),
        fetchImpl
      )
    ).rejects.toThrow('不接受参考图')
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })
})
