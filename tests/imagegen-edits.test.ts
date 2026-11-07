import { describe, expect, it, vi } from 'vitest'
import { generateImages } from '../server/imagegen-providers'
import type { ImagegenProviderConfig } from '../server/imagegen-config'
import { withModelSpecs } from './helpers'

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

const REFERENCE = png(64, 48)

function editFetch(captured: { form?: FormData; headers?: Record<string, string>; url?: string }) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input)
    captured.headers = (init?.headers ?? {}) as Record<string, string>
    captured.form = init?.body as FormData
    return new Response(JSON.stringify({ data: [{ b64_json: png(1254, 1254).toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('openai-images image editing', () => {
  it('sends the reference as multipart to /images/edits and lets fetch write the boundary', async () => {
    const captured: { form?: FormData; headers?: Record<string, string>; url?: string } = {}
    const result = await generateImages(
      provider({ editModels: ['gpt-image-2.5'] }),
      {
        model: 'gpt-image-2.5',
        prompt: 'make it blue',
        n: 1,
        size: '1024x1024',
        image: { mimeType: 'image/png', base64: REFERENCE.toString('base64') },
      },
      AbortSignal.timeout(5000),
      editFetch(captured)
    )

    expect(captured.url).toBe('https://api.example.com/v1/images/edits')
    expect(captured.form).toBeInstanceOf(FormData)
    const form = captured.form as FormData
    expect(form.get('model')).toBe('gpt-image-2.5')
    expect(form.get('prompt')).toBe('make it blue')
    expect(form.get('n')).toBe('1')
    expect(form.get('size')).toBe('1024x1024')
    const file = form.get('image') as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.type).toBe('image/png')
    expect(file.name).toBe('reference.png')
    // A hand-written Content-Type would drop the boundary the body needs.
    expect(captured.headers?.['Content-Type']).toBeUndefined()
    expect(captured.headers?.Authorization).toBe('Bearer sk-secret')

    // The response carries the real pixels, not the requested size.
    expect(result.images).toHaveLength(1)
    expect(result.images[0].width).toBe(1254)
    expect(result.images[0].height).toBe(1254)
  })

  it('omits size when none was requested', async () => {
    const captured: { form?: FormData } = {}
    await generateImages(
      provider({ editModels: ['gpt-image-2.5'] }),
      {
        model: 'gpt-image-2.5',
        prompt: 'p',
        n: 2,
        image: { mimeType: 'image/png', base64: REFERENCE.toString('base64') },
      },
      AbortSignal.timeout(5000),
      editFetch(captured)
    )
    expect((captured.form as FormData).has('size')).toBe(false)
    expect((captured.form as FormData).get('n')).toBe('2')
  })

  it('refuses a reference for a model that is not configured for edits', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      generateImages(
        provider(),
        { model: 'gpt-image-2.5', prompt: 'p', n: 1, image: { mimeType: 'image/png', base64: REFERENCE.toString('base64') } },
        AbortSignal.timeout(5000),
        fetchImpl
      )
    ).rejects.toThrow(/不接受参考图/)
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('sends the xai-json dialect when configured: JSON body with an embedded data URL', async () => {
    const calls: { body: unknown; headers: Record<string, string> }[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: init?.body,
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      // The first call is the edit POST; the second is downloading the URL it
      // answered with, so only the first one describes the request dialect.
      return new Response(JSON.stringify({ data: [{ url: 'https://imgen.example/x.jpeg' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response
    }) as unknown as typeof fetch

    await generateImages(
      provider({
        models: ['grok-imagine-image'],
        defaultModel: 'grok-imagine-image',
        editModels: ['grok-imagine-image'],
        editsStyle: 'xai-json',
      }),
      {
        model: 'grok-imagine-image',
        prompt: 'keep the subject, repaint it',
        n: 1,
        size: '1024x1024',
        image: { mimeType: 'image/png', base64: REFERENCE.toString('base64') },
      },
      AbortSignal.timeout(5000),
      fetchImpl
    )

    const editCall = calls[0]
    expect(editCall.headers['Content-Type']).toBe('application/json')
    const parsed = JSON.parse(String(editCall.body)) as {
      model: string
      prompt: string
      n: number
      size: string
      image: { url: string; type: string }
    }
    expect(parsed.model).toBe('grok-imagine-image')
    expect(parsed.prompt).toBe('keep the subject, repaint it')
    expect(parsed.n).toBe(1)
    expect(parsed.size).toBe('1024x1024')
    expect(parsed.image.type).toBe('image_url')
    expect(parsed.image.url).toBe(`data:image/png;base64,${REFERENCE.toString('base64')}`)
  })
})
