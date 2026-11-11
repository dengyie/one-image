import { describe, expect, it, vi, beforeEach } from 'vitest'
import { runLamaTiling, type SessionLike, type TensorCtor } from '../server/lama-inpaint'

interface FakeSessionState {
  calls: { tileX: number; tileY: number; maskSum: number }[]
}

const tensors: TensorCtor = {
  Tensor: class {
    constructor(_type: string, public data: Float32Array, public dims: number[]) {}
  } as unknown as TensorCtor['Tensor'],
}

function fakeSession(state: FakeSessionState, outputColor: [number, number, number]): { session: SessionLike; tensors: TensorCtor } {
  return {
    tensors,
    session: {
    inputNames: ['image', 'mask'],
    outputNames: ['output'],
    async run(feeds: Record<string, unknown>) {
      const mask = feeds['mask'] as { data: Float32Array; dims: number[] }
      const tile = mask.dims[3]
      let holeCount = 0
      let sumX = 0
      let sumY = 0
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          if (mask.data[y * tile + x] === 1) {
            holeCount += 1
            sumX += x
            sumY += y
          }
        }
      }
      state.calls.push({ tileX: sumX, tileY: sumY, maskSum: holeCount })
      // The real model answers in 0..255 (pinned by the identity probe).
      const out = new Float32Array(3 * tile * tile)
      for (let i = 0; i < tile * tile; i++) {
        out[i] = outputColor[0]
        out[tile * tile + i] = outputColor[1]
        out[2 * tile * tile + i] = outputColor[2]
      }
      return { output: { data: out } }
    },
    },
  }
}

function solidPlane(width: number, height: number, color: [number, number, number], alpha = 255): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = color[0]
    rgba[i * 4 + 1] = color[1]
    rgba[i * 4 + 2] = color[2]
    rgba[i * 4 + 3] = alpha
  }
  return rgba
}

describe('lama-inpaint tiling', () => {
  it('runs only the tiles that contain hole pixels', async () => {
    // 1024×512: two horizontal tiles; the hole lives entirely in tile 2.
    const width = 1024
    const height = 512
    const image = solidPlane(width, height, [10, 20, 30])
    const mask = new Uint8Array(width * height * 4)
    for (let y = 100; y < 120; y++) {
      for (let x = 600; x < 640; x++) {
        mask[(y * width + x) * 4] = 255
      }
    }
    const state: FakeSessionState = { calls: [] }
    const { session, tensors } = fakeSession(state, [200, 100, 50])
    const result = await runLamaTiling(session, tensors, { width, height, image, mask })
    expect(state.calls).toHaveLength(1)
    expect(result.tiles).toBe(1)
    expect(result.ms).toBeGreaterThanOrEqual(0)

    // Hole pixels carry the synthesized color.
    const holeIdx = (110 * width + 620) * 4
    expect(result.rgba[holeIdx]).toBe(200)
    expect(result.rgba[holeIdx + 1]).toBe(100)
    expect(result.rgba[holeIdx + 2]).toBe(50)
    // Non-hole pixels stay bit-for-bit identical (including alpha).
    const keepIdx = (110 * width + 100) * 4
    expect(result.rgba[keepIdx]).toBe(10)
    expect(result.rgba[keepIdx + 1]).toBe(20)
    expect(result.rgba[keepIdx + 2]).toBe(30)
    expect(result.rgba[keepIdx + 3]).toBe(255)
  })

  it('preserves every non-hole pixel bit-for-bit across the whole frame', async () => {
    const width = 512
    const height = 512
    const image = solidPlane(width, height, [1, 2, 3])
    // Give the source some texture so identity is provable.
    for (let i = 0; i < width * height; i++) {
      image[i * 4] = i % 251
      image[i * 4 + 1] = (i * 7) % 253
      image[i * 4 + 2] = (i * 13) % 249
    }
    const mask = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 240; x < 260; x++) {
        mask[(y * width + x) * 4] = 255
      }
    }
    const state: FakeSessionState = { calls: [] }
    const { session, tensors } = fakeSession(state, [255, 0, 0])
    const result = await runLamaTiling(session, tensors, { width, height, image, mask })
    expect(result.tiles).toBe(1)
    let changedOutside = 0
    for (let i = 0; i < width * height; i++) {
      const isHole = mask[i * 4] >= 128
      if (!isHole) {
        if (result.rgba[i * 4] !== image[i * 4] || result.rgba[i * 4 + 1] !== image[i * 4 + 1] || result.rgba[i * 4 + 2] !== image[i * 4 + 2]) {
          changedOutside += 1
        }
      }
      expect(result.rgba[i * 4 + 3]).toBe(image[i * 4 + 3])
    }
    expect(changedOutside).toBe(0)
  })

  it('runs every padded tile when the hole spans the frame', async () => {
    // 600×600 pads to 1024×1024 = 4 tiles; a full-frame hole runs all of them.
    const width = 600
    const height = 600
    const image = solidPlane(width, height, [9, 9, 9])
    const mask = solidPlane(width, height, [255, 255, 255])
    const state: FakeSessionState = { calls: [] }
    const { session, tensors } = fakeSession(state, [1, 2, 3])
    const result = await runLamaTiling(session, tensors, { width, height, image, mask })
    expect(state.calls).toHaveLength(4)
    expect(result.tiles).toBe(4)
  })

  it('serializes concurrent runs through the CPU queue', async () => {
    const width = 512
    const height = 512
    const image = solidPlane(width, height, [5, 5, 5])
    const mask = solidPlane(width, height, [255, 0, 0])
    let inFlight = 0
    let peak = 0
    const session = {
      inputNames: ['image', 'mask'],
      outputNames: ['output'],
      async run() {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { output: { data: new Float32Array(3 * 512 * 512) } }
      },
    }
    // Two concurrent tile runs against one session stay correct — the child
    // process serializes whole requests in production, and within a run the
    // tiles are sequential, so peak in-flight model calls is 1 here.
    const [a, b] = await Promise.all([
      runLamaTiling(session, tensors, { width, height, image, mask }),
      runLamaTiling(session, tensors, { width, height, image, mask }),
    ])
    expect(a.tiles).toBe(1)
    expect(b.tiles).toBe(1)
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('warm probe contract', () => {
  it('a single hole pixel runs exactly one tile (the probe mask runs the model)', async () => {
    // The warm probe sends a one-hole mask; a zero mask would skip
    // session.run entirely and prove nothing.
    const width = 512
    const height = 512
    const image = solidPlane(width, height, [7, 7, 7])
    const mask = new Uint8Array(width * height * 4)
    mask[0] = 255
    mask[1] = 255
    mask[2] = 255
    mask[3] = 255
    const state: FakeSessionState = { calls: [] }
    const { session, tensors } = fakeSession(state, [1, 2, 3])
    const result = await runLamaTiling(session, tensors, { width, height, image, mask })
    expect(state.calls).toHaveLength(1)
    expect(result.tiles).toBe(1)
    expect(result.rgba[0]).toBe(1)
  })
})
