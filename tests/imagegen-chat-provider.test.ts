import { describe, expect, it, vi } from 'vitest'
import {
  buildChatUserMessage,
  extractChatImageRefs,
  generateImages,
  generateVideo,
  resolveMediaUrl,
  ImagegenUpstreamError,
} from '../server/imagegen-providers'
import { loadImagegenConfig } from '../server/imagegen-config'
import type { ImagegenModelSpec, ImagegenProviderConfig } from '../server/imagegen-config'
import { withModelSpecs } from './helpers'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

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

const chatReply = (content: string) => new Response(
  JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } }
)

function provider(overrides: Partial<ImagegenProviderConfig> = {}): ImagegenProviderConfig {
  return withModelSpecs({
    id: 'grok',
    name: 'Grok',
    type: 'openai-chat-image',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    models: ['grok-imagine-image'],
    defaultModel: 'grok-imagine-image',
    timeoutMs: 90_000,
    ...overrides,
  })
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

describe('chat fan-out and partial success', () => {
  const inline = (bytes: Buffer) => `![image](data:image/png;base64,${bytes.toString('base64')})`

  it('issues n chat calls concurrently instead of one after another', async () => {
    let inFlight = 0
    let peak = 0
    const releases: (() => void)[] = []
    const fetchImpl = vi.fn(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => releases.push(resolve))
      inFlight -= 1
      return chatReply(inline(png(64, 64)))
    }) as unknown as typeof fetch

    const pending = generateImages(provider(), { model: 'grok-imagine-image', prompt: 'p', n: 3 }, AbortSignal.timeout(5000), fetchImpl)
    // Every request reaches the barrier before any of them may resolve:
    // a sequential loop could only ever park one call here.
    await vi.waitFor(() => expect(releases).toHaveLength(3))
    expect(peak).toBe(3)
    for (const release of releases) release()
    const result = await pending
    expect(result.images).toHaveLength(3)
  })

  it('keeps the images that succeeded and reports how many failed', async () => {
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call += 1
      if (call === 1) return new Response('upstream exploded', { status: 500 })
      return chatReply(inline(png(64, 64)))
    }) as unknown as typeof fetch
    const result = await generateImages(provider(), { model: 'grok-imagine-image', prompt: 'p', n: 3 }, AbortSignal.timeout(5000), fetchImpl)
    expect(result.images).toHaveLength(2)
    expect(result.failed).toBe(1)
  })

  it('rejects only when every call failed', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream exploded', { status: 500 })) as unknown as typeof fetch
    await expect(generateImages(provider(), { model: 'grok-imagine-image', prompt: 'p', n: 3 }, AbortSignal.timeout(5000), fetchImpl))
      .rejects.toThrow(/upstream exploded/)
  })

  it('truncates a chatty reply to the requested count', async () => {
    const two = `${inline(png(32, 32))}\n${inline(png(48, 48))}`
    const fetchImpl = vi.fn(async () => chatReply(two)) as unknown as typeof fetch
    const result = await generateImages(provider(), { model: 'grok-imagine-image', prompt: 'p', n: 1 }, AbortSignal.timeout(5000), fetchImpl)
    expect(result.images).toHaveLength(1)
    expect(result.failed).toBeUndefined()
  })

  it('reports the pixels the model actually produced', async () => {
    const fetchImpl = vi.fn(async () => chatReply(inline(png(768, 1152)))) as unknown as typeof fetch
    const result = await generateImages(provider(), { model: 'grok-imagine-image', prompt: 'p', n: 1 }, AbortSignal.timeout(5000), fetchImpl)
    expect(result.images[0].width).toBe(768)
    expect(result.images[0].height).toBe(1152)
  })
})

describe('chat image-to-image', () => {
  const REFERENCE = png(96, 64)

  it('sends the reference as a multimodal content array', async () => {
    expect(buildChatUserMessage({ model: 'm', prompt: 'paint it red', n: 1 })).toEqual({ role: 'user', content: 'paint it red' })
    expect(buildChatUserMessage({
      model: 'm',
      prompt: 'paint it red',
      n: 1,
      image: { mimeType: 'image/png', base64: 'AAAA' },
    })).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'paint it red' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    })
  })

  it('carries the declared reference into the request body', async () => {
    const bodies: string[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return chatReply(`![image](data:image/png;base64,${png(512, 512).toString('base64')})`)
    }) as unknown as typeof fetch
    const result = await generateImages(
      provider({ editModels: ['grok-imagine-image'] }),
      {
        model: 'grok-imagine-image',
        prompt: 'paint it red',
        n: 1,
        image: { mimeType: 'image/png', base64: REFERENCE.toString('base64') },
      },
      AbortSignal.timeout(5000),
      fetchImpl
    )
    const body = JSON.parse(bodies[0]) as { messages: { content: unknown }[] }
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'paint it red' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${REFERENCE.toString('base64')}` } },
    ])
    expect(result.images[0].width).toBe(512)
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

describe('openai-chat-video dialect', () => {
  const videoSpec = (): ImagegenModelSpec => ({
    id: 'grok-imagine-video',
    dialect: 'openai-chat-video',
    sizes: [],
    fixedSizeNote: null,
    edit: false,
    editsStyle: 'multipart',
    note: '约 40-50s',
    timeoutMs: 90_000,
  })

  it('extracts bare markdown links and <video src> only in video mode', () => {
    const content = 'here: [video](http://127.0.0.1:18000/v1/media/videos/vid_1) done'
    // Image mode ignores plain markdown links — the bang is what makes an image.
    expect(extractChatImageRefs({ content })).toEqual([])
    expect(extractChatImageRefs({ content }, { video: true })).toEqual(['http://127.0.0.1:18000/v1/media/videos/vid_1'])
    expect(
      extractChatImageRefs({ content: '<video src="http://127.0.0.1:18000/v1/media/videos/vid_2"></video>' }, { video: true }),
    ).toEqual(['http://127.0.0.1:18000/v1/media/videos/vid_2'])
  })

  it('still honours image markdown and images[] URLs in video mode', () => {
    expect(extractChatImageRefs({ content: '![x](https://cdn.example/a.png)' }, { video: true })).toEqual(['https://cdn.example/a.png'])
    expect(extractChatImageRefs({ images: [{ url: 'https://cdn.example/b.mp4' }] }, { video: true })).toEqual(['https://cdn.example/b.mp4'])
  })

  it('generateVideo re-points the media URL and sniffs the container mime', async () => {
    const p = provider({ mediaOrigin: 'http://10.0.0.5:18000', modelSpecs: [videoSpec()] })
    const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8, 1)])
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      if (String(input).includes('/chat/completions')) {
        return chatReply('[video](http://127.0.0.1:8000/v1/media/videos/vid_1)')
      }
      // A gateway labelling the clip octet-stream must not fool the mime.
      return new Response(mp4, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }) as unknown as typeof fetch

    const result = await generateVideo(p, { model: 'grok-imagine-video', prompt: '一只猫' }, AbortSignal.timeout(5000), fetchImpl)
    expect(result.mimeType).toBe('video/mp4')
    expect(result.bytes.equals(mp4)).toBe(true)
    // The loopback URL from the reply was rewritten to the declared origin.
    expect(calls[1]!.url).toBe('http://10.0.0.5:18000/v1/media/videos/vid_1')
    // The media origin is private → direct dispatcher, and it never sees the key.
    expect((calls[1]!.init as { dispatcher?: unknown }).dispatcher).toBeDefined()
    expect(calls[1]!.init?.headers).toEqual({})
  })

  it('rejects a text-only reply quoting the model, and a non-video spec', async () => {
    const p = provider({ mediaOrigin: 'http://10.0.0.5:18000', modelSpecs: [videoSpec()] })
    const textOnly: typeof fetch = vi.fn(async () => chatReply('我不能生成视频')) as unknown as typeof fetch
    await expect(
      generateVideo(p, { model: 'grok-imagine-video', prompt: 'p' }, AbortSignal.timeout(5000), textOnly),
    ).rejects.toThrow(/没有视频数据.*我不能生成视频/)

    await expect(
      generateVideo(p, { model: 'grok-imagine-image', prompt: 'p' }, AbortSignal.timeout(5000), textOnly),
    ).rejects.toThrow(/不是该服务的视频模型/)
  })

  it('keeps video models off the image surface', async () => {
    const p = provider({
      models: ['grok-imagine-image', 'grok-imagine-video'],
      modelSpecs: [
        {
          id: 'grok-imagine-image',
          dialect: 'openai-images',
          sizes: [],
          fixedSizeNote: null,
          edit: false,
          editsStyle: 'multipart',
          note: null,
          timeoutMs: 90_000,
        },
        videoSpec(),
      ],
    })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      generateImages(p, { model: 'grok-imagine-video', prompt: 'p', n: 1 }, AbortSignal.timeout(5000), fetchImpl),
    ).rejects.toThrow(/视频模型/)
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })
})

describe('openai-chat-video product validation', () => {
  const videoSpec = (): ImagegenModelSpec => ({
    id: 'grok-imagine-video',
    dialect: 'openai-chat-video',
    sizes: [],
    fixedSizeNote: null,
    edit: false,
    editsStyle: 'multipart',
    note: null,
    timeoutMs: 90_000,
  })

  const mp4Bytes = () => Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8, 3)])

  it('rejects an inline image masquerading as the clip instead of wrapping it as video/mp4', async () => {
    const p = provider({ mediaOrigin: 'http://10.0.0.5:18000', modelSpecs: [videoSpec()] })
    const fetchImpl = vi.fn(async () => chatReply('[video](data:image/png;base64,AAAA)')) as unknown as typeof fetch
    await expect(
      generateVideo(p, { model: 'grok-imagine-video', prompt: 'p' }, AbortSignal.timeout(5000), fetchImpl),
    ).rejects.toThrow(/没有视频数据/)
  })

  it('rejects an image download where the clip should be, with a clear message', async () => {
    const p = provider({ mediaOrigin: 'http://10.0.0.5:18000', modelSpecs: [videoSpec()] })
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/chat/completions')) {
        // A chatty reply whose FIRST ref is an image (plain markdown link form).
        return chatReply('see ![logo](https://cdn.example/logo.png) — [video](https://cdn.example/clip.mp4)')
      }
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    await expect(
      generateVideo(p, { model: 'grok-imagine-video', prompt: 'p' }, AbortSignal.timeout(5000), fetchImpl),
    ).rejects.toThrow(/不是视频而是图片/)
  })

  it('still accepts an inline data:video URL', async () => {
    const p = provider({ modelSpecs: [videoSpec()] })
    const b64 = mp4Bytes().toString('base64')
    const fetchImpl = vi.fn(async () => chatReply(`[video](data:video/mp4;base64,${b64})`)) as unknown as typeof fetch
    const result = await generateVideo(p, { model: 'grok-imagine-video', prompt: 'p' }, AbortSignal.timeout(5000), fetchImpl)
    expect(result.mimeType).toBe('video/mp4')
    expect(result.bytes.equals(mp4Bytes())).toBe(true)
  })

  it('refuses to download when the declared content-length already exceeds the cap', async () => {
    const p = provider({ mediaOrigin: 'http://10.0.0.5:18000', modelSpecs: [videoSpec()] })
    let bodyRead = false
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/chat/completions')) {
        return chatReply('[video](http://10.0.0.5:18000/v1/media/videos/vid_big)')
      }
      // A lying tiny body with a huge declared length: the pre-check must fire
      // before the body is read.
      const stream = new ReadableStream({
        pull(controller) {
          bodyRead = true
          controller.enqueue(new Uint8Array(4))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(65 * 1024 * 1024) },
      }) as unknown as Response
    }) as unknown as typeof fetch
    // The body is tiny while the declared length is huge, so the post-download
    // check cannot have fired — this error can only come from the pre-check.
    await expect(
      generateVideo(p, { model: 'grok-imagine-video', prompt: 'p' }, AbortSignal.timeout(5000), fetchImpl),
    ).rejects.toThrow(/64MB 上限/)
    expect(bodyRead).toBeDefined()
  })
})
