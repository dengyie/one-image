// Classical (model-free) hole fill: a push-pull pyramid diffusion. Every pixel
// outside the hole is copied from the input byte-for-byte; hole pixels get a
// colour pulled in from the surrounding known area at successively coarser
// scales. The result is a smooth, well-matched fill — no invented texture, but
// also no resolution loss, no model download and no whole-image resampling, so
// it is the right tool for small holes such as thin watermark strokes.
//
// Pure typed-array math (no canvas, no DOM) so it runs and tests in Node.

import type { RgbaGrid } from './mask-refine'

export interface ClassicalFillOptions {
  /** Post-fill relaxation passes inside the hole; smooths pyramid blocks. */
  smoothPasses?: number
  /**
   * Work is bounded to the hole's bounding box plus this padding, so a small
   * stroke on a 6000px photo never allocates a full-frame float buffer.
   */
  padding?: number
  /** Refuse to build a working set larger than this (memory guard). */
  maxWorkingPixels?: number
}

const MAX_LEVELS = 14

/**
 * Fills the white (`>= 128` in the red channel) region of `holeMask` with
 * diffused surrounding colour. Returns a full-frame RGBA buffer; pixels outside
 * the hole are bit-identical to the input.
 */
export function fillHolesClassical(
  image: RgbaGrid,
  holeMask: RgbaGrid,
  options: ClassicalFillOptions = {}
): Uint8ClampedArray {
  const { width, height } = image
  if (holeMask.width !== width || holeMask.height !== height) {
    throw new Error('fillHolesClassical: image and mask dimensions must match')
  }
  const out = new Uint8ClampedArray(image.data)
  const bounds = holeBounds(holeMask)
  if (!bounds) return out

  const padding = Math.max(1, Math.round(options.padding ?? 48))
  const x0 = Math.max(0, bounds.x - padding)
  const y0 = Math.max(0, bounds.y - padding)
  const x1 = Math.min(width - 1, bounds.x + bounds.width - 1 + padding)
  const y1 = Math.min(height - 1, bounds.y + bounds.height - 1 + padding)
  const subW = x1 - x0 + 1
  const subH = y1 - y0 + 1
  const maxPixels = options.maxWorkingPixels ?? 6_000_000
  if (subW * subH > maxPixels) {
    throw new Error('fillHolesClassical: hole region too large for the classical filler')
  }

  // Level 0 over the working crop: known pixels carry the source colour and
  // weight 1; hole pixels carry weight 0 so they cannot contribute.
  let level: Level = { w: subW, h: subH, rgb: new Float32Array(subW * subH * 3), wgt: new Float32Array(subW * subH) }
  for (let y = 0; y < subH; y++) {
    for (let x = 0; x < subW; x++) {
      const sx = x0 + x
      const sy = y0 + y
      const i = y * subW + x
      if (isHole(holeMask, sx, sy)) continue
      const o = (sy * width + sx) * 4
      level.rgb[i * 3] = image.data[o]
      level.rgb[i * 3 + 1] = image.data[o + 1]
      level.rgb[i * 3 + 2] = image.data[o + 2]
      level.wgt[i] = 1
    }
  }

  const globalMean = meanKnown(level)
  const pyramid: Level[] = [level]
  while (pyramid[pyramid.length - 1].w > 1 || pyramid[pyramid.length - 1].h > 1) {
    if (pyramid.length >= MAX_LEVELS) break
    if (pyramid[pyramid.length - 1].w * pyramid[pyramid.length - 1].h <= 4) break
    pyramid.push(downsample(pyramid[pyramid.length - 1]))
  }

  // A fully opaque hole leaves the coarsest level empty; seed it with the mean
  // of the known pixels so every direction has something to pull from.
  const coarsest = pyramid[pyramid.length - 1]
  for (let i = 0; i < coarsest.w * coarsest.h; i++) {
    if (coarsest.wgt[i] > 0) continue
    coarsest.rgb[i * 3] = globalMean[0]
    coarsest.rgb[i * 3 + 1] = globalMean[1]
    coarsest.rgb[i * 3 + 2] = globalMean[2]
    coarsest.wgt[i] = 0.5
  }

  for (let index = pyramid.length - 2; index >= 0; index--) {
    pyramid[index] = combine(pyramid[index], pyramid[index + 1])
  }

  const smoothPasses = Math.max(0, Math.round(options.smoothPasses ?? 2))
  const filled = smoothPasses > 0 ? relax(pyramid[0], holeMask, x0, y0, width, smoothPasses) : pyramid[0]

  for (let y = 0; y < subH; y++) {
    for (let x = 0; x < subW; x++) {
      const sx = x0 + x
      const sy = y0 + y
      if (!isHole(holeMask, sx, sy)) continue
      const i = y * subW + x
      const o = (sy * width + sx) * 4
      out[o] = clampByte(filled.rgb[i * 3])
      out[o + 1] = clampByte(filled.rgb[i * 3 + 1])
      out[o + 2] = clampByte(filled.rgb[i * 3 + 2])
      // Alpha is the source's own; the filler speaks RGB only.
    }
  }
  return out
}

interface Level {
  w: number
  h: number
  /** RGB triples, row-major. */
  rgb: Float32Array
  /** Per-pixel knownness in [0, 1]. */
  wgt: Float32Array
}

function isHole(mask: RgbaGrid, x: number, y: number): boolean {
  return mask.data[(y * mask.width + x) * 4] >= 128
}

export interface HoleBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Bounding box of the masked area, or null when nothing is masked. */
export function holeBounds(mask: RgbaGrid): HoleBounds | null {
  const { width, height } = mask
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask.data[(y * width + x) * 4] < 128) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** Count of masked pixels. */
export function countHolePixels(mask: RgbaGrid): number {
  let count = 0
  for (let i = 0; i < mask.width * mask.height; i++) if (mask.data[i * 4] >= 128) count++
  return count
}

function meanKnown(level: Level): [number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  let w = 0
  for (let i = 0; i < level.wgt.length; i++) {
    const weight = level.wgt[i]
    if (weight <= 0) continue
    r += level.rgb[i * 3] * weight
    g += level.rgb[i * 3 + 1] * weight
    b += level.rgb[i * 3 + 2] * weight
    w += weight
  }
  if (w === 0) return [0, 0, 0]
  return [r / w, g / w, b / w]
}

function downsample(source: Level): Level {
  const w = Math.max(1, Math.ceil(source.w / 2))
  const h = Math.max(1, Math.ceil(source.h / 2))
  const rgb = new Float32Array(w * h * 3)
  const wgt = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      let weight = 0
      for (let dy = 0; dy < 2; dy++) {
        const sy = y * 2 + dy
        if (sy >= source.h) continue
        for (let dx = 0; dx < 2; dx++) {
          const sx = x * 2 + dx
          if (sx >= source.w) continue
          const si = sy * source.w + sx
          const sw = source.wgt[si]
          if (sw <= 0) continue
          r += source.rgb[si * 3] * sw
          g += source.rgb[si * 3 + 1] * sw
          b += source.rgb[si * 3 + 2] * sw
          weight += sw
        }
      }
      const target = y * w + x
      if (weight > 0) {
        rgb[target * 3] = r / weight
        rgb[target * 3 + 1] = g / weight
        rgb[target * 3 + 2] = b / weight
      }
      wgt[target] = weight / 4
    }
  }
  return { w, h, rgb, wgt }
}

function combine(fine: Level, coarse: Level): Level {
  const rgb = new Float32Array(fine.w * fine.h * 3)
  const wgt = new Float32Array(fine.w * fine.h)
  for (let y = 0; y < fine.h; y++) {
    for (let x = 0; x < fine.w; x++) {
      const i = y * fine.w + x
      const fw = fine.wgt[i]
      const [cr, cg, cb, cw] = bilinear(coarse, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5)
      const total = fw + cw
      if (total <= 0) {
        wgt[i] = 0
        continue
      }
      rgb[i * 3] = (fine.rgb[i * 3] * fw + cr * cw) / total
      rgb[i * 3 + 1] = (fine.rgb[i * 3 + 1] * fw + cg * cw) / total
      rgb[i * 3 + 2] = (fine.rgb[i * 3 + 2] * fw + cb * cw) / total
      wgt[i] = Math.min(1, total)
    }
  }
  return { w: fine.w, h: fine.h, rgb, wgt }
}

function bilinear(level: Level, x: number, y: number): [number, number, number, number] {
  const cx = Math.max(0, Math.min(level.w - 1, x))
  const cy = Math.max(0, Math.min(level.h - 1, y))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(level.w - 1, x0 + 1)
  const y1 = Math.min(level.h - 1, y0 + 1)
  const fx = cx - x0
  const fy = cy - y0
  const sample = (sx: number, sy: number): [number, number, number, number] => {
    const i = sy * level.w + sx
    return [level.rgb[i * 3], level.rgb[i * 3 + 1], level.rgb[i * 3 + 2], level.wgt[i]]
  }
  const a = sample(x0, y0)
  const b = sample(x1, y0)
  const c = sample(x0, y1)
  const d = sample(x1, y1)
  const lerp = (p: number, q: number, t: number) => p + (q - p) * t
  return [
    lerp(lerp(a[0], b[0], fx), lerp(c[0], d[0], fx), fy),
    lerp(lerp(a[1], b[1], fx), lerp(c[1], d[1], fx), fy),
    lerp(lerp(a[2], b[2], fx), lerp(c[2], d[2], fx), fy),
    lerp(lerp(a[3], b[3], fx), lerp(c[3], d[3], fx), fy),
  ]
}

// 3x3 box relaxation, applied only to hole pixels so surrounding detail is
// never touched.
function relax(level: Level, mask: RgbaGrid, ox: number, oy: number, maskWidth: number, passes: number): Level {
  let current = level
  for (let pass = 0; pass < passes; pass++) {
    const next: Level = { w: current.w, h: current.h, rgb: new Float32Array(current.rgb), wgt: current.wgt }
    for (let y = 0; y < current.h; y++) {
      for (let x = 0; x < current.w; x++) {
        if (!isHole(mask, ox + x, oy + y)) continue
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const sy = y + dy
          if (sy < 0 || sy >= current.h) continue
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx
            if (sx < 0 || sx >= current.w) continue
            const i = sy * current.w + sx
            r += current.rgb[i * 3]
            g += current.rgb[i * 3 + 1]
            b += current.rgb[i * 3 + 2]
            n++
          }
        }
        if (n === 0) continue
        const o = (y * current.w + x) * 3
        next.rgb[o] = r / n
        next.rgb[o + 1] = g / n
        next.rgb[o + 2] = b / n
      }
    }
    current = next
  }
  return current
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}
