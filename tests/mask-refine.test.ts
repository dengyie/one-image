import { describe, expect, it } from 'vitest'
import { componentBoxes, refineMaskToStrokes, type RgbaGrid } from '../src/infrastructure/inpaint/mask-refine'

function grid(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): RgbaGrid {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 4)
  }
  return { data, width, height }
}

function masked(mask: RgbaGrid): number {
  let count = 0
  for (let i = 0; i < mask.width * mask.height; i++) if (mask.data[i * 4] >= 128) count++
  return count
}

function isMasked(data: Uint8ClampedArray, width: number, x: number, y: number): boolean {
  return data[(y * width + x) * 4] >= 128
}

/** White horizontal bar on a flat grey field. */
function barImage(width: number, height: number, barY: number, barThickness: number): RgbaGrid {
  return grid(width, height, (_x, y) => {
    const value = y >= barY && y < barY + barThickness ? 255 : 128
    return [value, value, value, 255]
  })
}

describe('componentBoxes', () => {
  it('groups 8-connected pixels and returns their bounding box', () => {
    // 5x5 with an L shape.
    const width = 5
    const height = 5
    const stroke = new Uint8Array(width * height)
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [1, 3]] as const) stroke[y * width + x] = 1
    const boxes = componentBoxes(stroke, width, height, 1)
    expect(boxes).toEqual([{ x: 1, y: 1, width: 2, height: 3 }])
  })

  it('separates two components and drops specks below the pixel floor', () => {
    const width = 6
    const height = 3
    const stroke = new Uint8Array(width * height)
    stroke[0] = 1 // isolated speck
    stroke[1 * width + 4] = 1
    stroke[1 * width + 5] = 1
    const boxes = componentBoxes(stroke, width, height, 2)
    expect(boxes).toEqual([{ x: 4, y: 1, width: 2, height: 1 }])
  })
})

describe('refineMaskToStrokes', () => {
  it('shrinks a full-frame mask down to the detected bar', () => {
    const width = 64
    const height = 64
    const image = barImage(width, height, 30, 3)
    const mask = grid(width, height, () => [255, 0, 0, 255])

    const refined = refineMaskToStrokes(image, mask, { radius: 4, dilate: 1 })
    const kept = masked({ data: refined, width, height })

    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(width * height * 0.25)
    // The kept block hugs the bar (a small blur-bleed and 1px dilation either
    // side are expected); it must never stretch across the flat frame.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!isMasked(refined, width, x, y)) continue
        expect(y).toBeGreaterThanOrEqual(30 - 5)
        expect(y).toBeLessThanOrEqual(30 + 3 + 5)
      }
    }
  })

  it('covers the interior of a solid watermark from its detected outline', () => {
    const width = 48
    const height = 48
    // A solid bright square (a filled logo) on a mid-grey field: only its
    // outline has local contrast, but the box must cover the whole square.
    const image = grid(width, height, (x, y) => {
      const inside = x >= 8 && x < 24 && y >= 8 && y < 24
      const value = inside ? 240 : 110
      return [value, value, value, 255]
    })
    const mask = grid(width, height, () => [255, 0, 0, 255])

    const refined = refineMaskToStrokes(image, mask, { radius: 3, dilate: 1 })
    // Centre of the solid square must be masked even though it is flat.
    expect(isMasked(refined, width, 16, 16)).toBe(true)
    // Deep background far from the square must not be.
    expect(isMasked(refined, width, 40, 40)).toBe(false)
  })

  it('never grows outside the coarse mask', () => {
    const width = 32
    const height = 32
    const image = barImage(width, height, 10, 2)
    // Only the top-left quadrant is masked; the bar crosses the whole width.
    const mask = grid(width, height, (x, y) => (x < 16 && y < 16 ? [255, 0, 0, 255] : [0, 0, 0, 255]))

    const refined = refineMaskToStrokes(image, mask, { radius: 3, dilate: 3 })
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!isMasked(refined, width, x, y)) continue
        expect(x).toBeLessThan(16)
        expect(y).toBeLessThan(16)
      }
    }
  })

  it('returns the original mask when the region is flat (nothing detected)', () => {
    const width = 40
    const height = 40
    const image = grid(width, height, () => [100, 100, 100, 255])
    const mask = grid(width, height, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? [255, 0, 0, 255] : [0, 0, 0, 255]))
    const before = masked(mask)

    const refined = refineMaskToStrokes(image, mask)
    expect(masked({ data: refined, width, height })).toBe(before)
  })

  it('does not mutate the input mask', () => {
    const width = 24
    const height = 24
    const image = barImage(width, height, 8, 2)
    const mask = grid(width, height, () => [255, 0, 0, 255])
    const snapshot = new Uint8ClampedArray(mask.data)

    refineMaskToStrokes(image, mask)
    expect([...mask.data]).toEqual([...snapshot])
  })

  it('throws on mismatched dimensions', () => {
    const image = grid(8, 8, () => [0, 0, 0, 255])
    const mask = grid(4, 4, () => [0, 0, 0, 255])
    expect(() => refineMaskToStrokes(image, mask)).toThrow(/dimensions/)
  })

  it('sets alpha to 255 on every output pixel so the mask stays an opaque binary', () => {
    const width = 16
    const height = 16
    const image = barImage(width, height, 5, 2)
    const mask = grid(width, height, () => [255, 0, 0, 255])
    const refined = refineMaskToStrokes(image, mask)
    for (let i = 0; i < width * height; i++) expect(refined[i * 4 + 3]).toBe(255)
  })
})
