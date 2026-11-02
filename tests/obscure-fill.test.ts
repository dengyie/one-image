import { describe, expect, it } from 'vitest'
import {
  deriveObscureParams,
  fillHolesBlur,
  fillHolesPixelate,
  fillHolesSolid,
} from '../src/infrastructure/inpaint/obscure-fill'
import { compositeRgba } from '../src/infrastructure/inpaint/inpaint-core'
import type { RgbaGrid } from '../src/infrastructure/inpaint/mask-refine'

function makeImage(width: number, height: number, value: (x: number, y: number) => [number, number, number]): RgbaGrid {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const [r, g, b] = value(x, y)
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = 255
    }
  }
  return { data, width, height }
}

function maskWithRect(width: number, height: number, rect: { x: number; y: number; w: number; h: number }): RgbaGrid {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
      data[o] = inside ? 255 : 0
      data[o + 3] = 255
    }
  }
  return { data, width, height }
}

describe('deriveObscureParams', () => {
  it('clamps the derived intensity to both floors and ceilings', () => {
    expect(deriveObscureParams({ x: 0, y: 0, width: 4, height: 4 })).toEqual({ blurRadius: 8, pixelBlock: 6 })
    expect(deriveObscureParams({ x: 0, y: 0, width: 1000, height: 1000 })).toEqual({ blurRadius: 48, pixelBlock: 40 })
  })

  it('scales with the smaller mask side', () => {
    const params = deriveObscureParams({ x: 0, y: 0, width: 240, height: 60 })
    expect(params.blurRadius).toBe(10)
    expect(params.pixelBlock).toBe(8)
  })
})

describe('fillHolesBlur', () => {
  it('melts hole pixels toward the surrounding color', () => {
    const image = makeImage(200, 200, () => [220, 220, 220])
    // A black stroke through the middle of the masked box.
    for (let y = 90; y < 110; y++) {
      const o = (y * 200 + 96) * 4
      image.data[o] = 0
      image.data[o + 1] = 0
      image.data[o + 2] = 0
    }
    const mask = maskWithRect(200, 200, { x: 88, y: 88, w: 24, h: 24 })
    const out = fillHolesBlur(image, mask)
    const center = (100 * 200 + 96) * 4
    expect(out[center]).toBeGreaterThan(60)
    expect(out[center]).toBeLessThan(220)
  })

  it('leaves a constant image constant and far pixels bit-identical', () => {
    const image = makeImage(200, 200, (x, y) => [(x * 3) % 256, (y * 5) % 256, 128])
    const mask = maskWithRect(200, 200, { x: 90, y: 90, w: 20, h: 20 })
    const out = fillHolesBlur(image, mask, { radius: 8 })
    // Outside the working crop (bounds ± pad 16 → 74..125) nothing is touched.
    for (const [x, y] of [
      [10, 10],
      [10, 190],
      [190, 10],
      [190, 190],
      [60, 100],
      [140, 100],
    ]) {
      const o = (y * 200 + x) * 4
      expect([out[o], out[o + 1], out[o + 2]]).toEqual([image.data[o], image.data[o + 1], image.data[o + 2]])
    }
    const flat = makeImage(200, 200, () => [128, 128, 128])
    const flatOut = fillHolesBlur(flat, mask, { radius: 8 })
    expect(Array.from(flatOut)).toEqual(Array.from(flat.data))
  })

  it('throws on dimension mismatch and on oversized working sets', () => {
    const image = makeImage(200, 200, () => [0, 0, 0])
    const mask = maskWithRect(100, 100, { x: 0, y: 0, w: 10, h: 10 })
    expect(() => fillHolesBlur(image, mask)).toThrow(/dimensions must match/)
    const big = maskWithRect(200, 200, { x: 0, y: 0, w: 200, h: 200 })
    expect(() => fillHolesBlur(image, big, { maxWorkingPixels: 100 })).toThrow(/too large/)
  })

  it('returns a copy when the mask is empty', () => {
    const image = makeImage(50, 50, (x, y) => [x, y, 7])
    const mask = maskWithRect(50, 50, { x: 0, y: 0, w: 0, h: 0 })
    const out = fillHolesBlur(image, mask)
    expect(Array.from(out)).toEqual(Array.from(image.data))
  })
})

describe('fillHolesPixelate', () => {
  it('produces uniform blocks aligned to the global grid', () => {
    const image = makeImage(32, 32, (x, y) => [(x * 7 + y * 13) % 256, (x * 11) % 256, (y * 3) % 256])
    const mask = maskWithRect(32, 32, { x: 8, y: 8, w: 16, h: 16 })
    const out = fillHolesPixelate(image, mask, { block: 4 })

    // Two mask pixels inside the same global block share one value.
    const at = (x: number, y: number) => (y * 32 + x) * 4
    expect([out[at(8, 8)], out[at(11, 8)], out[at(8, 11)], out[at(11, 11)]]).toEqual([
      out[at(8, 8)],
      out[at(8, 8)],
      out[at(8, 8)],
      out[at(8, 8)],
    ])

    // That value is the average of the full 4×4 source block.
    let r = 0
    let g = 0
    let b = 0
    for (let y = 8; y < 12; y++) {
      for (let x = 8; x < 12; x++) {
        const o = at(x, y)
        r += image.data[o]
        g += image.data[o + 1]
        b += image.data[o + 2]
      }
    }
    const n = 16
    // Uint8ClampedArray assignment rounds half-to-even, so allow the ±0.5
    // rounding window instead of an exact match on the .5 average.
    expect(Math.abs(out[at(9, 9)] - r / n)).toBeLessThanOrEqual(0.51)
    expect(Math.abs(out[at(9, 9) + 1] - g / n)).toBeLessThanOrEqual(0.51)
    expect(Math.abs(out[at(9, 9) + 2] - b / n)).toBeLessThanOrEqual(0.51)

    // Blocks are aligned to multiples of 4 in image coordinates: the fill
    // starts at the block containing the crop edge, so the block left of it is
    // never touched at all.
    expect(out[at(3, 9)]).toBe(image.data[at(3, 9)])
  })

  it('keeps pixels outside the working crop byte-identical', () => {
    const image = makeImage(64, 64, (x, y) => [(x * 5) % 256, y, 99])
    const mask = maskWithRect(64, 64, { x: 20, y: 20, w: 12, h: 12 })
    const out = fillHolesPixelate(image, mask, { block: 4 })
    // Crop = bounds ± one block → 16..35; visibility beyond the mask is the
    // compositor's job, so the fill plane only promises the crop boundary.
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (x >= 16 && x <= 35 && y >= 16 && y <= 35) continue
        const o = (y * 64 + x) * 4
        expect([out[o], out[o + 1], out[o + 2]]).toEqual([image.data[o], image.data[o + 1], image.data[o + 2]])
      }
    }
  })

  it('throws on dimension mismatch', () => {
    const image = makeImage(64, 64, () => [0, 0, 0])
    const mask = maskWithRect(32, 32, { x: 0, y: 0, w: 4, h: 4 })
    expect(() => fillHolesPixelate(image, mask)).toThrow(/dimensions must match/)
  })
})

describe('fillHolesSolid', () => {
  it('covers the mask with the exact color and keeps the rest original', () => {
    const image = makeImage(100, 100, (x, y) => [x % 256, y % 256, 42])
    const mask = maskWithRect(100, 100, { x: 40, y: 40, w: 10, h: 10 })
    const out = fillHolesSolid(image, mask, { color: { r: 10, g: 20, b: 30 } })
    const inside = (50 * 100 + 45) * 4
    expect([out[inside], out[inside + 1], out[inside + 2]]).toEqual([10, 20, 30])
    const far = (10 * 100 + 10) * 4
    expect([out[far], out[far + 1], out[far + 2]]).toEqual([image.data[far], image.data[far + 1], image.data[far + 2]])
  })

  it('defaults to black and no-ops on an empty mask', () => {
    const image = makeImage(50, 50, (x, y) => [x, y, 1])
    const empty = maskWithRect(50, 50, { x: 10, y: 10, w: 0, h: 0 })
    expect(Array.from(fillHolesSolid(image, empty))).toEqual(Array.from(image.data))
    const mask = maskWithRect(50, 50, { x: 20, y: 20, w: 5, h: 5 })
    const out = fillHolesSolid(image, mask)
    const inside = (22 * 50 + 22) * 4
    expect([out[inside], out[inside + 1], out[inside + 2]]).toEqual([0, 0, 0])
  })
})

describe('obscure fills through the compositor', () => {
  it('preserves every pixel outside the mask bit-for-bit', () => {
    const image = makeImage(120, 120, (x, y) => [(x * 9) % 256, (y * 17) % 256, (x + y) % 256])
    const mask = maskWithRect(120, 120, { x: 40, y: 40, w: 30, h: 20 })
    const alpha = mask
    for (const generated of [
      fillHolesBlur(image, mask),
      fillHolesPixelate(image, mask),
      fillHolesSolid(image, mask),
    ]) {
      const blended = compositeRgba(image, { data: generated, width: 120, height: 120 }, alpha)
      for (let i = 0; i < 120 * 120; i++) {
        const o = i * 4
        const inside = mask.data[o] >= 128
        if (!inside) {
          expect([blended[o], blended[o + 1], blended[o + 2], blended[o + 3]]).toEqual([
            image.data[o],
            image.data[o + 1],
            image.data[o + 2],
            image.data[o + 3],
          ])
        } else {
          expect([blended[o], blended[o + 1], blended[o + 2]]).toEqual([generated[o], generated[o + 1], generated[o + 2]])
        }
      }
    }
  })
})

describe('fillHolesBlur strip processing', () => {
  const pattern = (x: number, y: number): [number, number, number] => [
    (x * 13 + y * 7) % 256,
    (x * 3 + y * 29) % 256,
    (x ^ y) & 255,
  ]

  it('is bit-identical whether the crop runs in one strip or many', () => {
    const image = makeImage(80, 60, pattern)
    const mask = maskWithRect(80, 60, { x: 20, y: 15, w: 40, h: 30 })
    // Crop = 72×60 rows; radius 4 → halo 12. Budget 72×30 → 30-row strips with
    // 6 core rows each, i.e. ten strips against one whole-crop strip.
    const whole = fillHolesBlur(image, mask, { radius: 4 })
    const striped = fillHolesBlur(image, mask, { radius: 4, maxWorkingPixels: 72 * 30 })
    expect(Array.from(striped)).toEqual(Array.from(whole))
  })

  it('keeps the exact strip-shape boundary working and rejects only unsatisfiable widths', () => {
    const image = makeImage(80, 60, pattern)
    const mask = maskWithRect(80, 60, { x: 20, y: 15, w: 40, h: 30 })
    const whole = fillHolesBlur(image, mask, { radius: 4 })
    // 72×25 rows is exactly one core row per strip (25 = 1 + 2×12 halo).
    const tight = fillHolesBlur(image, mask, { radius: 4, maxWorkingPixels: 72 * 25 })
    expect(Array.from(tight)).toEqual(Array.from(whole))
    expect(() => fillHolesBlur(image, mask, { radius: 4, maxWorkingPixels: 72 * 25 - 1 })).toThrow(/too large/)
  })

  it('no longer throws for selections whose whole crop exceeds the budget', () => {
    const image = makeImage(300, 300, pattern)
    const mask = maskWithRect(300, 300, { x: 0, y: 0, w: 300, h: 300 })
    // Whole crop 324×324 ≈ 105k px; a 30k budget forces many strips.
    const out = fillHolesBlur(image, mask, { radius: 4, maxWorkingPixels: 30_000 })
    const whole = fillHolesBlur(image, mask, { radius: 4 })
    expect(Array.from(out)).toEqual(Array.from(whole))
  })

  it('blurs a mask anchored at the image corner with clamp-to-edge', () => {
    const flat = makeImage(60, 60, () => [90, 90, 90])
    const mask = maskWithRect(60, 60, { x: 0, y: 0, w: 12, h: 12 })
    // Any out-of-bounds read would break the constant image.
    const out = fillHolesBlur(flat, mask, { radius: 3 })
    expect(Array.from(out)).toEqual(Array.from(flat.data))
    const varied = makeImage(60, 60, pattern)
    expect(() => fillHolesBlur(varied, mask, { radius: 3 })).not.toThrow()
  })
})

describe('fillHolesPixelate block clamping', () => {
  it('clamps edge blocks when the grid does not divide the image', () => {
    const image = makeImage(30, 30, (x, y) => [(x * 8) % 256, (y * 4) % 256, 3])
    const mask = maskWithRect(30, 30, { x: 24, y: 24, w: 6, h: 6 })
    const out = fillHolesPixelate(image, mask, { block: 4 })
    const at = (x: number, y: number) => (y * 30 + x) * 4
    // The block holding (29,29) is clamped to x 28..29, y 28..29.
    let r = 0
    let g = 0
    let b = 0
    for (let y = 28; y < 30; y++) {
      for (let x = 28; x < 30; x++) {
        const o = at(x, y)
        r += image.data[o]
        g += image.data[o + 1]
        b += image.data[o + 2]
      }
    }
    expect(Math.abs(out[at(29, 29)] - r / 4)).toBeLessThanOrEqual(0.51)
    expect(Math.abs(out[at(29, 29) + 1] - g / 4)).toBeLessThanOrEqual(0.51)
    expect(Math.abs(out[at(29, 29) + 2] - b / 4)).toBeLessThanOrEqual(0.51)
  })
})
