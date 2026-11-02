import { describe, expect, it } from 'vitest'
import {
  countHolePixels,
  fillHolesClassical,
  holeBounds,
  type HoleBounds,
} from '../src/infrastructure/inpaint/classical-fill'
import type { RgbaGrid } from '../src/infrastructure/inpaint/mask-refine'

function grid(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): RgbaGrid {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 4)
  }
  return { data, width, height }
}

function holeMask(width: number, height: number, inHole: (x: number, y: number) => boolean): RgbaGrid {
  return grid(width, height, (x, y) => (inHole(x, y) ? [255, 0, 0, 255] : [0, 0, 0, 255]))
}

describe('classical fill helpers', () => {
  it('finds the hole bounding box', () => {
    const mask = holeMask(20, 20, (x, y) => x >= 4 && x <= 9 && y >= 6 && y <= 7)
    expect(holeBounds(mask)).toEqual<HoleBounds>({ x: 4, y: 6, width: 6, height: 2 })
  })

  it('returns null bounds and zero count for an empty mask', () => {
    const mask = holeMask(10, 10, () => false)
    expect(holeBounds(mask)).toBeNull()
    expect(countHolePixels(mask)).toBe(0)
  })

  it('counts masked pixels', () => {
    const mask = holeMask(10, 10, (x, y) => x < 3 && y < 2)
    expect(countHolePixels(mask)).toBe(6)
  })
})

describe('fillHolesClassical', () => {
  it('copies pixels outside the hole bit-for-bit, including alpha', () => {
    const width = 24
    const height = 24
    const image = grid(width, height, (x, y) => [x * 3, y * 5, 200, 128])
    const mask = holeMask(width, height, (x, y) => x >= 8 && x < 14 && y >= 8 && y < 14)

    const out = fillHolesClassical(image, mask, { smoothPasses: 1 })
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x >= 8 && x < 14 && y >= 8 && y < 14) continue
        const o = (y * width + x) * 4
        expect([out[o], out[o + 1], out[o + 2], out[o + 3]]).toEqual([
          image.data[o],
          image.data[o + 1],
          image.data[o + 2],
          image.data[o + 3],
        ])
      }
    }
  })

  it('fills a hole in a constant field with that same colour', () => {
    const width = 32
    const height = 32
    const image = grid(width, height, () => [40, 90, 160, 255])
    const mask = holeMask(width, height, (x, y) => x >= 10 && x < 20 && y >= 10 && y < 20)

    const out = fillHolesClassical(image, mask)
    for (let y = 12; y < 18; y++) {
      for (let x = 12; x < 18; x++) {
        const o = (y * width + x) * 4
        expect(Math.abs(out[o] - 40)).toBeLessThanOrEqual(1)
        expect(Math.abs(out[o + 1] - 90)).toBeLessThanOrEqual(1)
        expect(Math.abs(out[o + 2] - 160)).toBeLessThanOrEqual(1)
        expect(out[o + 3]).toBe(255)
      }
    }
  })

  it('blends a two-tone field across the hole without inventing colour', () => {
    const width = 40
    const height = 40
    // Left half red, right half blue.
    const image = grid(width, height, (x) => (x < 20 ? [200, 20, 20, 255] : [20, 20, 200, 255]))
    const mask = holeMask(width, height, (x, y) => x >= 18 && x < 22 && y >= 15 && y < 25)

    const out = fillHolesClassical(image, mask, { padding: 8 })
    // The seam lands around x=19/20: the fill must be a mix, not a hard jump.
    const seamIndex = (20 * width + 20) * 4
    const r = out[seamIndex]
    const b = out[seamIndex + 2]
    expect(r).toBeGreaterThan(20)
    expect(r).toBeLessThan(200)
    expect(b).toBeGreaterThan(20)
    expect(b).toBeLessThan(200)
  })

  it('returns an untouched copy when the mask is empty', () => {
    const width = 12
    const height = 12
    const image = grid(width, height, (x, y) => [x, y, 7, 255])
    const mask = holeMask(width, height, () => false)
    const out = fillHolesClassical(image, mask)
    expect([...out]).toEqual([...image.data])
  })

  it('fills a hole that touches the image border', () => {
    const width = 16
    const height = 16
    const image = grid(width, height, () => [10, 20, 30, 255])
    const mask = holeMask(width, height, (x, y) => x < 4 && y < 4)
    const out = fillHolesClassical(image, mask)
    expect(out[0]).toBe(10)
    expect(out[1]).toBe(20)
    expect(out[2]).toBe(30)
  })

  it('throws rather than allocating a working set beyond the guard', () => {
    const width = 8
    const height = 8
    const image = grid(width, height, () => [0, 0, 0, 255])
    const mask = holeMask(width, height, () => true)
    expect(() => fillHolesClassical(image, mask, { maxWorkingPixels: 4 })).toThrow(/too large/)
  })

  it('throws on mismatched dimensions', () => {
    const image = grid(8, 8, () => [0, 0, 0, 255])
    const mask = grid(4, 4, () => [0, 0, 0, 255])
    expect(() => fillHolesClassical(image, mask)).toThrow(/dimensions/)
  })
})
