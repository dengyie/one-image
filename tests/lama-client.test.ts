import { describe, expect, it } from 'vitest'
import { computeLamaCropRect, LAMA_CROP_MAX_EDGE } from '../src/infrastructure/inpaint/lama-client'

function grid(width: number, height: number, hole?: { x: number; y: number; w: number; h: number }) {
  const data = new Uint8ClampedArray(width * height * 4)
  if (hole) {
    for (let y = hole.y; y < hole.y + hole.h; y++) {
      for (let x = hole.x; x < hole.x + hole.w; x++) {
        data[(y * width + x) * 4] = 255
      }
    }
  }
  return { data, width, height }
}

describe('computeLamaCropRect', () => {
  it('returns null for an empty mask', () => {
    expect(computeLamaCropRect(grid(512, 512))).toBeNull()
  })

  it('crops the bbox with a margin clamped to the image bounds', () => {
    // 100×100 hole centered in 1024×1024: margin = 25 (min 16 floor).
    const rect = computeLamaCropRect(grid(1024, 1024, { x: 462, y: 462, w: 100, h: 100 }))
    expect(rect).not.toBeNull()
    expect(rect!.scale).toBe(1)
    expect(rect!.width).toBe(150)
    expect(rect!.height).toBe(150)
    expect(rect!.x).toBeLessThanOrEqual(462)
    expect(rect!.x + rect!.width).toBeGreaterThanOrEqual(562)
  })

  it('clamps the crop to the image bounds when the hole touches an edge', () => {
    const rect = computeLamaCropRect(grid(512, 512, { x: 0, y: 0, w: 40, h: 40 }))
    expect(rect!.x).toBe(0)
    expect(rect!.y).toBe(0)
    // margin = max(16, round(40*0.25)=10) = 16 (the floor wins on small holes)
    expect(rect!.width).toBe(40 + 16)
    expect(rect!.height).toBe(40 + 16)
  })

  it('downscales oversized crops to the upload edge', () => {
    // A 3000×3000 hole in a 4096×4096 frame: the crop exceeds 2048 → scale < 1.
    const rect = computeLamaCropRect(grid(4096, 4096, { x: 500, y: 500, w: 3000, h: 3000 }))
    expect(rect!.scale).toBeLessThan(1)
    expect(Math.round(rect!.width * rect!.scale)).toBeLessThanOrEqual(LAMA_CROP_MAX_EDGE)
    expect(Math.round(rect!.height * rect!.scale)).toBeLessThanOrEqual(LAMA_CROP_MAX_EDGE)
    // The crop still covers the whole hole.
    expect(rect!.x).toBeLessThanOrEqual(500)
    expect(rect!.y).toBeLessThanOrEqual(500)
    expect(rect!.x + rect!.width).toBeGreaterThanOrEqual(3500)
    expect(rect!.y + rect!.height).toBeGreaterThanOrEqual(3500)
  })
})
