import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { initDatabase } from '../server/db'
import { registerSmartEraseRoutes } from '../server/smart-erase-route'
import { createRateLimiter } from '../server/rate-limit'
import { encodePngRgba, decodePngRgba } from '../server/png'

function solidPng(width: number, height: number, color: [number, number, number]): Buffer {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = color[0]
    rgba[i * 4 + 1] = color[1]
    rgba[i * 4 + 2] = color[2]
    rgba[i * 4 + 3] = 255
  }
  return encodePngRgba({ width, height, rgba })
}

function maskPng(width: number, height: number, holeRect?: { x: number; y: number; w: number; h: number }): Buffer {
  const rgba = new Uint8Array(width * height * 4)
  if (holeRect) {
    for (let y = holeRect.y; y < holeRect.y + holeRect.h; y++) {
      for (let x = holeRect.x; x < holeRect.x + holeRect.w; x++) {
        rgba[(y * width + x) * 4] = 255
        rgba[(y * width + x) * 4 + 1] = 255
        rgba[(y * width + x) * 4 + 2] = 255
        rgba[(y * width + x) * 4 + 3] = 255
      }
    }
  }
  return encodePngRgba({ width, height, rgba })
}

function createApp(
  options: {
    modelPath?: string | null
    runInpaint?: Parameters<typeof registerSmartEraseRoutes>[2]['runInpaint']
    dailyCap?: number
    rateLimiter?: ReturnType<typeof createRateLimiter>
  } = {},
) {
  const app = Fastify()
  const appDb = initDatabase(':memory:')
  registerSmartEraseRoutes(app, appDb.db, {
    modelPath: options.modelPath !== undefined ? options.modelPath : '/models/lama_fp32.onnx',
    rateLimiter: options.rateLimiter,
    dailyCap: options.dailyCap ?? 5,
    runInpaint: options.runInpaint,
  })
  return { app, appDb }
}

describe('smart-erase route', () => {
  const fakeRun = (filledColor: [number, number, number] = [255, 255, 0]) =>
    vi.fn(async (input: { width: number; height: number; image: Uint8Array; mask: Uint8Array }) => {
      const out = new Uint8Array(input.image)
      for (let i = 0; i < input.width * input.height; i++) {
        if (input.mask[i * 4] >= 128) {
          out[i * 4] = filledColor[0]
          out[i * 4 + 1] = filledColor[1]
          out[i * 4 + 2] = filledColor[2]
        }
      }
      return { rgba: out, ms: 5, tiles: 1 }
    })

  it('degrades to 503 when the host has no model deployed', async () => {
    const { app } = createApp({ modelPath: null })
    const res = await app.inject({ method: 'POST', url: '/api/v1/smart-erase', payload: { image: { base64: 'x' }, mask: { base64: 'x' } } })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toBe('smart_erase_unconfigured')
  })

  it('fills hole pixels server-side and preserves the rest bit-for-bit', async () => {
    const runInpaint = fakeRun([255, 255, 0])
    const { app } = createApp({ runInpaint })
    const width = 256
    const height = 128
    const imageBytes = solidPng(width, height, [10, 20, 30])
    const maskBytes = maskPng(width, height, { x: 100, y: 40, w: 40, h: 30 })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/smart-erase',
      payload: { image: { base64: imageBytes.toString('base64') }, mask: { base64: maskBytes.toString('base64') } },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.image.mimeType).toBe('image/png')
    const decoded = decodePngRgba(Buffer.from(body.image.base64, 'base64'))
    expect(decoded?.width).toBe(width)
    expect(decoded?.height).toBe(height)
    const source = decodePngRgba(imageBytes)!
    const maskDecoded = decodePngRgba(maskBytes)!
    let holePixels = 0
    for (let i = 0; i < width * height; i++) {
      const isHole = maskDecoded.rgba[i * 4] >= 128
      if (isHole) {
        holePixels += 1
        expect(decoded!.rgba[i * 4]).toBe(255)
        expect(decoded!.rgba[i * 4 + 1]).toBe(255)
        expect(decoded!.rgba[i * 4 + 2]).toBe(0)
      } else {
        expect(decoded!.rgba[i * 4]).toBe(source.rgba[i * 4])
        expect(decoded!.rgba[i * 4 + 1]).toBe(source.rgba[i * 4 + 1])
        expect(decoded!.rgba[i * 4 + 2]).toBe(source.rgba[i * 4 + 2])
      }
    }
    expect(holePixels).toBe(40 * 30)
    expect(runInpaint).toHaveBeenCalledTimes(1)
  })

  it('validates the contract before any spend', async () => {
    const runInpaint = fakeRun()
    const { app, appDb } = createApp({ runInpaint })
    const imageBytes = solidPng(256, 128, [10, 20, 30])
    const payload = (image: unknown, mask: unknown) => ({ image, mask })
    const cases = [
      { payload: payload(undefined, undefined), error: 'invalid_input_image' },
      { payload: payload({ base64: '!!!' }, { base64: imageBytes.toString('base64') }), error: 'invalid_input_image' },
      { payload: payload({ base64: imageBytes.toString('base64') }, { base64: '!!!' }), error: 'invalid_input_image' },
      // Dimension mismatch: mask must align with the image.
      { payload: payload({ base64: imageBytes.toString('base64') }, { base64: maskPng(128, 256).toString('base64') }), error: 'invalid_input_image' },
      // Oversize edge.
      { payload: payload({ base64: solidPng(4096, 64, [1, 2, 3]).toString('base64') }, { base64: maskPng(4096, 64).toString('base64') }), error: 'invalid_input_image' },
    ]
    for (const { payload, error } of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/smart-erase', payload })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe(error)
    }
    expect((runInpaint as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
    expect(appDb.db.prepare('SELECT COUNT(*) AS n FROM smarterase_usage').get()).toEqual({ n: 0 })
  })

  it('counts usage before the run and caps per client per day', async () => {
    const runInpaint = fakeRun()
    const { app, appDb } = createApp({ runInpaint, dailyCap: 2 })
    const headers = { 'cf-connecting-ip': '203.0.113.5' }
    const imageBytes = solidPng(256, 128, [1, 2, 3]).toString('base64')
    const maskBytes = maskPng(256, 128, { x: 0, y: 0, w: 16, h: 16 }).toString('base64')
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/smart-erase',
        headers,
        payload: { image: { base64: imageBytes }, mask: { base64: maskBytes } },
      })
      expect(res.statusCode).toBe(200)
    }
    const capped = await app.inject({
      method: 'POST',
      url: '/api/v1/smart-erase',
      headers,
      payload: { image: { base64: imageBytes }, mask: { base64: maskBytes } },
    })
    expect(capped.statusCode).toBe(429)
    expect(JSON.parse(capped.body).error).toBe('daily_cap_exceeded')
    // Another client is unaffected.
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/smart-erase',
      headers: { 'cf-connecting-ip': '198.51.100.9' },
      payload: { image: { base64: imageBytes }, mask: { base64: maskBytes } },
    })
    expect(other.statusCode).toBe(200)
    expect((runInpaint as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(3)
    appDb.close()
  })

  it('rate limits bursts per client', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 1, maxTrackedClients: 100 })
    const runInpaint = fakeRun()
    const { app } = createApp({ runInpaint, rateLimiter: limiter })
    const payload = {
      image: { base64: solidPng(256, 128, [1, 2, 3]).toString('base64') },
      mask: { base64: maskPng(256, 128, { x: 0, y: 0, w: 16, h: 16 }).toString('base64') },
    }
    const first = await app.inject({ method: 'POST', url: '/api/v1/smart-erase', payload })
    const second = await app.inject({ method: 'POST', url: '/api/v1/smart-erase', payload })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(429)
    expect(JSON.parse(second.body).error).toBe('rate_limited')
  })

  it('maps an inference failure to a 500 inference_error (still billed)', async () => {
    const runInpaint = vi.fn(async () => {
      throw new Error('ort blew up')
    })
    const { app, appDb } = createApp({ runInpaint })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/smart-erase',
      payload: {
        image: { base64: solidPng(256, 128, [1, 2, 3]).toString('base64') },
        mask: { base64: maskPng(256, 128, { x: 0, y: 0, w: 16, h: 16 }).toString('base64') },
      },
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toBe('inference_error')
    expect(appDb.db.prepare('SELECT COUNT(*) AS n FROM smarterase_usage').get()).toEqual({ n: 1 })
    appDb.close()
  })
})

describe('smart-erase warm gate', () => {
  it('answers 503 warming (no billing, no rate spend) while no session is proven', async () => {
    const runInpaint = vi.fn(async (input: { width: number; height: number; image: Uint8Array; mask: Uint8Array }) => ({
      rgba: new Uint8Array(input.width * input.height * 4),
      ms: 1,
      tiles: 1,
    }))
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 1, maxTrackedClients: 100 })
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerSmartEraseRoutes(app, appDb.db, {
      modelPath: '/models/lama_fp32.onnx',
      isWarm: () => false,
      rateLimiter: limiter,
      dailyCap: 5,
      runInpaint,
    })
    const payload = {
      image: { base64: solidPng(256, 128, [1, 2, 3]).toString('base64') },
      mask: { base64: maskPng(256, 128, { x: 0, y: 0, w: 16, h: 16 }).toString('base64') },
    }
    const res = await app.inject({ method: 'POST', url: '/api/v1/smart-erase', payload })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toBe('smart_erase_warming')
    expect(runInpaint).not.toHaveBeenCalled()
    // The warm gate sits before the spend surfaces: the window is untouched.
    const warmApp = Fastify()
    registerSmartEraseRoutes(warmApp, appDb.db, {
      modelPath: '/models/lama_fp32.onnx',
      isWarm: () => true,
      rateLimiter: limiter,
      dailyCap: 5,
      runInpaint,
    })
    const ok = await warmApp.inject({ method: 'POST', url: '/api/v1/smart-erase', payload })
    expect(ok.statusCode).toBe(200)
    appDb.close()
  })
})

describe('smart-erase engine selection', () => {
  const payload = () => ({
    image: { base64: solidPng(256, 128, [1, 2, 3]).toString('base64') },
    mask: { base64: maskPng(256, 128, { x: 0, y: 0, w: 16, h: 16 }).toString('base64') },
    engine: 'migan',
  })
  const sizedRun = vi.fn(async (input: { width: number; height: number }) => ({
    rgba: new Uint8Array(input.width * input.height * 4),
    ms: 2,
    tiles: 1,
  }))
  const buildApp = (options: {
    miganModelPath?: string | null
    miganIsWarm?: () => boolean
    runMiganInpaint?: unknown
  }) => {
    const runInpaint = vi.fn(async (input: { width: number; height: number }) => ({
      rgba: new Uint8Array(input.width * input.height * 4),
      ms: 1,
      tiles: 1,
    }))
    const app = Fastify()
    const appDb = initDatabase(':memory:')
    registerSmartEraseRoutes(app, appDb.db, {
      modelPath: '/models/lama.onnx',
      isWarm: () => true,
      miganModelPath: options.miganModelPath ?? null,
      miganIsWarm: options.miganIsWarm,
      dailyCap: 5,
      runInpaint,
      runMiganInpaint: options.runMiganInpaint as never,
    })
    return { app, appDb, runInpaint }
  }

  it('routes engine=migan through the migan runner when warm', async () => {
    const runMiganInpaint = vi.fn(sizedRun)
    const { app, appDb } = buildApp({
      miganModelPath: '/models/migan.onnx',
      miganIsWarm: () => true,
      runMiganInpaint,
    })
    const res = await app.inject({ method: 'POST', url: '/api/v1/smart-erase', payload: payload() })
    expect(res.statusCode).toBe(200)
    expect(runMiganInpaint).toHaveBeenCalledTimes(1)
    appDb.close()
  })

  it('answers 503 warming for engine=migan while the migan tier is cold', async () => {
    const runMiganInpaint = vi.fn(sizedRun)
    const { app } = buildApp({
      miganModelPath: '/models/migan.onnx',
      miganIsWarm: () => false,
      runMiganInpaint,
    })
    const res = await app.inject({ method: 'POST', url: '/api/v1/smart-erase', payload: payload() })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toBe('smart_erase_warming')
    expect(runMiganInpaint).not.toHaveBeenCalled()
  })

  it('answers 503 warming for engine=migan when no migan model is deployed', async () => {
    const runMiganInpaint = vi.fn(sizedRun)
    const { app } = buildApp({ miganModelPath: null, runMiganInpaint })
    const res = await app.inject({ method: 'POST', url: '/api/v1/smart-erase', payload: payload() })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toBe('smart_erase_warming')
    expect(runMiganInpaint).not.toHaveBeenCalled()
  })

  it('degrades an unknown engine value to lama', async () => {
    const { app, runInpaint } = buildApp({ miganModelPath: null, runMiganInpaint: vi.fn(sizedRun) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/smart-erase',
      payload: { ...payload(), engine: 'nonsense' },
    })
    expect(res.statusCode).toBe(200)
    expect((runInpaint as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })
})
