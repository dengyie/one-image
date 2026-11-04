import { describe, expect, it, vi } from 'vitest'
import {
  extractChatImageRefs,
  generateImages,
  resolveMediaUrl,
  ImagegenUpstreamError,
} from '../server/imagegen-providers'
import { loadImagegenConfig } from '../server/imagegen-config'
import type { ImagegenProviderConfig } from '../server/imagegen-config'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

function provider(overrides: Partial<ImagegenProviderConfig> = {}): ImagegenProviderConfig {
  return {
    id: 'grok',
    name: 'Grok',
    type: 'openai-chat-image',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    models: ['grok-imagine-image'],
    defaultModel: 'grok-imagine-image',
    timeoutMs: 90_000,
    ...overrides,
  }
}

describe('chat-surface image providers', () => {
  it('finds images in markdown, html and images[] payloads', () => {
    expect(extractChatImageRefs({ content: 'here: ![image](https://cdn.example/a.png) done' })).toEqual(['https://cdn.example/a.png'])
    expect(extractChatImageRefs({ content: '<img src="https://cdn.example/b.jpg" />' })).toEqual(['https://cdn.example/b.jpg'])
    expect(extractChatImageRefs({ content: '![x](<https://cdn.example/c.png>)' })).toEqual(['https://cdn.example/c.png'])
    expect(extractChatImageRefs({ images: [{ image_url: { url: 'https://cdn.example/d.png' } }] })).toEqual(['https://cdn.example/d.png'])
    expect(extractChatImageRefs({ images: [{ b64_json: 'AAAA' }] })).toEqual(['data:image/png;base64,AAAA'])
    expect(extractChatImageRefs({ content: 'no image here' })).toEqual([])
  })

  it('re-points a backend-local media URL at the declared origin', () => {
    const p = provider({ mediaOrigin: 'http://10.0.0.5:18000' })
    const url = resolveMediaUrl('http://127.0.0.1:8000/v1/media/images/img_1', p)
    expect(url.toString()).toBe('http://10.0.0.5:18000/v1/media/images/img_1')
    // Query strings survive; the origin is replaced wholesale.
    expect(resolveMediaUrl('http://localhost:8000/a.png?x=1', p).toString()).toBe('http://10.0.0.5:18000/a.png?x=1')
  })

  it('refuses a loopback media URL when no origin is configured', () => {
    expect(() => resolveMediaUrl('http://127.0.0.1:8000/v1/media/images/img_1', provider())).toThrow(ImagegenUpstreamError)
    expect(() => resolveMediaUrl('http://127.0.0.1:8000/x', provider())).toThrow(/mediaOrigin/)
  })

  it('never lets the upstream path escape the configured origin', () => {
    const p = provider({ mediaOrigin: 'http://10.0.0.5:18000' })
    // "//host" is protocol-relative and would otherwise swap in the host.
    expect(resolveMediaUrl('http://127.0.0.1:8000//evil.example/x.png', p).host).toBe('10.0.0.5:18000')
    expect(resolveMediaUrl('http://127.0.0.1:8000/a/../../b.png', p).toString()).toBe('http://10.0.0.5:18000/b.png')
  })

  it('reports an unparseable media URL as an upstream error', () => {
    expect(() => resolveMediaUrl('http://[not-a-host', provider())).toThrow(ImagegenUpstreamError)
    expect(() => resolveMediaUrl('http://[not-a-host', provider())).toThrow(/无法解析/)
  })

  it('still rejects non-http media URLs', () => {
    expect(() => resolveMediaUrl('file:///etc/passwd', provider())).toThrow(/不受支持/)
  })

  it('generates from a chat reply whose image lives behind a rewritten origin', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '![image](http://127.0.0.1:8000/v1/media/images/img_9)' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'http://10.0.0.5:18000/v1/media/images/img_9') {
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    const result = await generateImages(
      provider({ mediaOrigin: 'http://10.0.0.5:18000' }),
      { model: 'grok-imagine-image', prompt: 'a red square', n: 1 },
      AbortSignal.timeout(5000),
      fetchImpl
    )
    expect(result.images).toHaveLength(1)
    expect(result.images[0].mimeType).toBe('image/jpeg')
    expect(Buffer.from(result.images[0].base64, 'base64').equals(PNG_BYTES)).toBe(true)
    // The provider key never travels to the media origin.
    const mediaCall = (fetchImpl as unknown as { mock: { calls: [string, { headers?: Record<string, string> }][] } }).mock.calls[1]
    expect(mediaCall[1].headers?.Authorization).toBeUndefined()
    // A private media origin bypasses the global outbound proxy.
    expect((mediaCall[1] as { dispatcher?: unknown }).dispatcher).toBeDefined()
  })

  it('leaves a public media origin on the normal dispatcher', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: '![image](http://127.0.0.1:8000/a.png)' } }],
        }), { status: 200 })
      }
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    await generateImages(
      provider({ mediaOrigin: 'https://cdn.example.com' }),
      { model: 'grok-imagine-image', prompt: 'p', n: 1 },
      AbortSignal.timeout(5000),
      fetchImpl
    )
    const mediaCall = (fetchImpl as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[1]
    expect(mediaCall[0]).toBe('https://cdn.example.com/a.png')
    expect(mediaCall[1].dispatcher).toBeUndefined()
  })

  it('decodes inline data: images without any network fetch', async () => {
    const b64 = PNG_BYTES.toString('base64')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: `![image](data:image/png;base64,${b64})` } }],
    }), { status: 200 })) as unknown as typeof fetch
    const result = await generateImages(provider(), { model: 'grok-imagine-image', prompt: 'p', n: 1 }, AbortSignal.timeout(5000), fetchImpl)
    expect(result.images[0].base64).toBe(b64)
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('reports a text-only reply as an upstream failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'I cannot draw that.' } }],
    }), { status: 200 })) as unknown as typeof fetch
    await expect(generateImages(provider(), { model: 'grok-imagine-image', prompt: 'p', n: 1 }, AbortSignal.timeout(5000), fetchImpl))
      .rejects.toThrow(/没有图片数据/)
  })
})

describe('chat provider configuration', () => {
  it('accepts the new type plus mediaOrigin and keeps them server-side', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{
          id: 'grok',
          name: 'Grok',
          type: 'openai-chat-image',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-secret',
          models: ['grok-imagine-image', 'grok-imagine-image-2.0'],
          defaultModel: 'grok-imagine-image-2.0',
          mediaOrigin: 'http://10.144.144.100:8000/',
        }],
      }),
    })
    expect(result.warnings).toEqual([])
    expect(result.providers[0].type).toBe('openai-chat-image')
    expect(result.providers[0].mediaOrigin).toBe('http://10.144.144.100:8000')
    expect(result.providers[0].defaultModel).toBe('grok-imagine-image-2.0')
  })

  it('drops a malformed mediaOrigin with a warning instead of failing the provider', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{
          id: 'grok',
          type: 'openai-chat-image',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-secret',
          models: ['m'],
          mediaOrigin: 'ftp://nope',
        }],
      }),
    })
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].mediaOrigin).toBeUndefined()
    expect(result.warnings.join('\n')).toMatch(/mediaOrigin/)
  })
})
