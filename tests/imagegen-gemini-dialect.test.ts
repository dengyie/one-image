import { describe, expect, it, vi } from 'vitest'
import { generateImages, ImagegenUpstreamError } from '../server/imagegen-providers'
import type { ImagegenProviderConfig } from '../server/imagegen-config'
import { withModelSpecs } from './helpers'

// Contract fixtures for the gemini dialect (`generateContent` surface). Every
// byte is produced locally: the "generated PNG" is the same minimal IHDR
// buffer the other provider tests use, base64-encoded, so the sniffing path
// (withImageMeta) reports real width/height without any network.

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
    type: 'gemini',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'gk-secret',
    models: ['gemini-test-image'],
    defaultModel: 'gemini-test-image',
    timeoutMs: 90_000,
    ...overrides,
  })
}

const PNG_1254 = png(1254, 1254)
const INLINE_OK = {
  candidates: [
    {
      content: {
        parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1254.toString('base64') } }],
      },
    },
  ],
}

function jsonFetch(body: unknown, status = 200, capture?: { url?: string; headers?: Record<string, string> }) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(input)
      capture.headers = Object.fromEntries(new Headers(init?.headers).entries())
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('gemini dialect contract', () => {
  it('posts to /v1beta generateContent with x-goog-api-key and normalizes the /v1 baseUrl away', async () => {
    const captured: { url?: string; headers?: Record<string, string> } = {}
    const result = await generateImages(
      provider(),
      { model: 'gemini-test-image', prompt: 'a mango', n: 1 },
      AbortSignal.timeout(5000),
      jsonFetch(INLINE_OK, 200, captured)
    )
    // /v1 (OpenAI-style prefix) must not leak into the gemini surface.
    expect(captured.url).toBe('https://api.example.com/v1beta/models/gemini-test-image:generateContent')
    expect(captured.headers?.['x-goog-api-key']).toBe('gk-secret')
    expect(captured.headers?.['content-type']).toBe('application/json')
    expect(result.images).toHaveLength(1)
    expect(result.images[0].mimeType).toBe('image/png')
    expect(result.images[0].width).toBe(1254)
  })

  it('carries the reference image as inlineData alongside the prompt for edits', async () => {
    let sentBody = ''
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body)
      return new Response(JSON.stringify(INLINE_OK), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await generateImages(
      provider({
        modelSpecs: [
          { id: 'gemini-test-image', dialect: 'gemini', sizes: [], fixedSizeNote: null, edit: true, editsStyle: 'multipart', note: null, timeoutMs: 90_000 },
        ],
      }),
      {
        model: 'gemini-test-image',
        prompt: 'recolor to blue',
        n: 1,
        image: { mimeType: 'image/jpeg', base64: png(64, 48).toString('base64') },
      },
      AbortSignal.timeout(5000),
      fetchImpl,
    )
    const body = JSON.parse(sentBody) as {
      contents: { role: string; parts: Record<string, unknown>[] }[]
    }
    expect(body.contents[0].role).toBe('user')
    expect(body.contents[0].parts[0]).toEqual({ text: 'recolor to blue' })
    expect(body.contents[0].parts[1].inlineData).toMatchObject({ mimeType: 'image/jpeg' })
  })

  it('unwraps a markdown image reference from a chatty text part (gateway unwrapping)', async () => {
    const reply = {
      candidates: [
        {
          content: {
            parts: [
              { text: `Here is your image: ![](data:image/png;base64,${PNG_1254.toString('base64')})` },
            ],
          },
        },
      ],
    }
    const result = await generateImages(
      provider(),
      { model: 'gemini-test-image', prompt: 'p', n: 1 },
      AbortSignal.timeout(5000),
      jsonFetch(reply)
    )
    expect(result.images).toHaveLength(1)
    expect(result.images[0].width).toBe(1254)
  })

  it('surfaces a text-only 200 reply as an upstream failure quoting the revised text', async () => {
    const reply = {
      candidates: [
        { content: { parts: [{ text: 'I cannot generate that image.' }] } },
      ],
    }
    const promise = generateImages(
      provider(),
      { model: 'gemini-test-image', prompt: 'p', n: 1 },
      AbortSignal.timeout(5000),
      jsonFetch(reply)
    )
    await expect(promise).rejects.toBeInstanceOf(ImagegenUpstreamError)
    await promise.catch((error: ImagegenUpstreamError) => {
      expect(error.status).toBe(502)
      expect(error.message).toContain('模型回复')
      expect(error.message).toContain('I cannot generate that image.')
    })
  })

  it('maps an upstream auth failure to the declared client status', async () => {
    const promise = generateImages(
      provider(),
      { model: 'gemini-test-image', prompt: 'p', n: 1 },
      AbortSignal.timeout(5000),
      jsonFetch({ error: { message: 'bad key' } }, 401)
    )
    await expect(promise).rejects.toBeInstanceOf(ImagegenUpstreamError)
    await promise.catch((error: ImagegenUpstreamError) => {
      // Upstream 4xx is intentionally normalized to 502 (only 429 propagates):
      // the operator's key/quota wording must not become client-facing contract.
      expect(error.status).toBe(502)
      expect(error.upstreamStatus).toBe(401)
      expect(error.message).toContain('bad key')
    })
  })

  it('propagates upstream 429 so clients can back off', async () => {
    const promise = generateImages(
      provider(),
      { model: 'gemini-test-image', prompt: 'p', n: 1 },
      AbortSignal.timeout(5000),
      jsonFetch({ error: { message: 'quota exceeded' } }, 429)
    )
    await expect(promise).rejects.toBeInstanceOf(ImagegenUpstreamError)
    await promise.catch((error: ImagegenUpstreamError) => {
      expect(error.status).toBe(429)
    })
  })

  it('keeps partial fan-out successes when one concurrent call fails (n=2)', async () => {
    const first = JSON.parse(JSON.stringify(INLINE_OK)) as typeof INLINE_OK
    const failing = { error: { message: 'quota exceeded' } }
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call += 1
      const body = call % 2 === 1 ? first : failing
      return new Response(JSON.stringify(body), {
        status: call % 2 === 1 ? 200 : 429,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const result = await generateImages(
      provider(),
      { model: 'gemini-test-image', prompt: 'p', n: 2 },
      AbortSignal.timeout(5000),
      fetchImpl
    )
    expect(result.images).toHaveLength(1)
    expect(result.failed).toBe(1)
  })

  it('rejects a video-model spec on the image surface before any fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      generateImages(
        provider({ modelSpecs: [{ id: 'vid', dialect: 'openai-chat-video', sizes: [], fixedSizeNote: null, edit: false, editsStyle: 'multipart', note: null, timeoutMs: 1000 }] }),
        { model: 'vid', prompt: 'p', n: 1 },
        AbortSignal.timeout(5000),
        fetchImpl
      )
    ).rejects.toThrow('视频生成入口')
  })

  it('propagates generationConfig from the spec into the request body', async () => {
    let sentBody = ''
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body)
      return new Response(JSON.stringify(INLINE_OK), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await generateImages(
      provider({ generationConfig: { responseModalities: ['IMAGE'] } }),
      { model: 'gemini-test-image', prompt: 'p', n: 1 },
      AbortSignal.timeout(5000),
      fetchImpl
    )
    const body = JSON.parse(sentBody) as { responseModalities?: string[] }
    expect(body.responseModalities).toEqual(['IMAGE'])
  })
})
