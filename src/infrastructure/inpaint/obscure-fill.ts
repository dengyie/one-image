// Model-free cover fills for the watermark eraser: blur, pixelate and solid.
// They complete the filler family alongside fillHolesClassical: each produces a
// full-frame RGBA plane from the source image, and only the feathered alpha
// mask ever shows any of it — pixels outside the mask stay bit-for-bit the
// original because compositeRgba copies them straight from the base.
//
// The blur and pixelate effects are computed over the hole's bounding box plus
// padding (blocks snapped to a global grid), so a small watermark on a large
// photo never turns into a whole-frame pass with visible seams. Intensity is
// derived from the mask size when the caller does not pin it, so the effect
// scales with what the user actually selected.
//
// Pure typed-array math (no canvas, no DOM) so it runs and tests in Node.

import type { RgbaGrid } from './mask-refine'
import { holeBounds, type HoleBounds } from './classical-fill'

export interface ObscureFillOptions {
  /**
   * Per-strip working budget in pixels (blur only). Each strip's float buffers
   * stay under this bound regardless of the selection's size.
   */
  maxWorkingPixels?: number
}

export interface BlurFillOptions extends ObscureFillOptions {
  /** Gaussian sigma in pixels; derived from the mask bounds when omitted. */
  radius?: number
}

export interface PixelateFillOptions extends ObscureFillOptions {
  /** Mosaic block size in pixels; derived from the mask bounds when omitted. */
  block?: number
}

export interface SolidFillOptions {
  /** Fill color; defaults to opaque black (the blackout look). */
  color?: { r: number; g: number; b: number }
}

const DEFAULT_MAX_WORKING_PIXELS = 6_000_000
/** The compositor's feathered alpha reaches ~9px past the mask; stay past it. */
const FEATHER_PAD = 16

/**
 * Effect intensity scaled to the selected region: a thin text line gets a
 * gentle blur and small blocks, a large logo gets the clamped maximum.
 */
export function deriveObscureParams(bounds: HoleBounds): { blurRadius: number; pixelBlock: number } {
  const min = Math.min(bounds.width, bounds.height)
  return {
    blurRadius: clampInt(Math.round(min / 6), 8, 48),
    pixelBlock: clampInt(Math.round(min / 8), 6, 40),
  }
}

/**
 * Blurs the hole's neighbourhood and returns a full-frame plane. The blur runs
 * over the whole working crop (hole and background alike) so stroke colors melt
 * into the surrounding image exactly like an optical blur would; the compositor
 * decides how much of it is visible.
 *
 * The crop is processed in row strips: each strip carries a halo of 3σ rows —
 * the total vertical support of three box passes — so every strip's core rows
 * compute bit-identically to a whole-crop run while memory stays bounded for
 * selections of any size (a flat region with no detectable strokes can hand
 * this filler the user's whole selection).
 */
export function fillHolesBlur(image: RgbaGrid, holeMask: RgbaGrid, options: BlurFillOptions = {}): Uint8ClampedArray {
  const { width, height } = image
  if (holeMask.width !== width || holeMask.height !== height) {
    throw new Error('fillHolesBlur: image and mask dimensions must match')
  }
  const out = new Uint8ClampedArray(image.data)
  const bounds = holeBounds(holeMask)
  if (!bounds) return out

  const sigma = Math.max(1, Math.round(options.radius ?? deriveObscureParams(bounds).blurRadius))
  const pad = Math.max(FEATHER_PAD, sigma)
  const x0 = Math.max(0, bounds.x - pad)
  const y0 = Math.max(0, bounds.y - pad)
  const x1 = Math.min(width - 1, bounds.x + bounds.width - 1 + pad)
  const y1 = Math.min(height - 1, bounds.y + bounds.height - 1 + pad)
  const subW = x1 - x0 + 1

  // Each strip's buffer (core rows plus the 3σ halo on both sides) must fit
  // the budget, so the guard rejects only widths no strip shape can satisfy.
  const halo = 3 * sigma
  const stripRows = Math.floor((options.maxWorkingPixels ?? DEFAULT_MAX_WORKING_PIXELS) / subW)
  if (stripRows < 1 + 2 * halo) {
    throw new Error('fillHolesBlur: hole region too large for the blur filler')
  }
  const coreRows = stripRows - 2 * halo

  for (let coreTop = y0; coreTop <= y1; coreTop += coreRows) {
    const coreBottom = Math.min(y1, coreTop + coreRows - 1)
    const top = Math.max(y0, coreTop - halo)
    const bottom = Math.min(y1, coreBottom + halo)
    const rows = bottom - top + 1
    // Extract the strip as planar float RGB. Edge handling is clamp-to-edge at
    // both the image border and the crop border, so holes touching either blur
    // inward instead of reading undefined, and core rows near a clamped strip
    // edge clamp exactly where a whole-crop run would.
    const plane = new Float32Array(subW * rows * 3)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < subW; x++) {
        const o = ((top + y) * width + (x0 + x)) * 4
        const i = (y * subW + x) * 3
        plane[i] = image.data[o]
        plane[i + 1] = image.data[o + 1]
        plane[i + 2] = image.data[o + 2]
      }
    }
    boxBlurPlane(plane, subW, rows, sigma, 3)
    for (let y = coreTop; y <= coreBottom; y++) {
      const src = (y - top) * subW
      for (let x = 0; x < subW; x++) {
        const o = (y * width + (x0 + x)) * 4
        const i = (src + x) * 3
        out[o] = clampByte(plane[i])
        out[o + 1] = clampByte(plane[i + 1])
        out[o + 2] = clampByte(plane[i + 2])
      }
    }
  }
  return out
}

/**
 * Pixelates the hole's neighbourhood with blocks aligned to the global grid
 * (block edges sit at multiples of `block` in image coordinates). Block values
 * average the full block from the source, so two runs over overlapping
 * selections produce identical blocks and no stitching seams.
 */
export function fillHolesPixelate(
  image: RgbaGrid,
  holeMask: RgbaGrid,
  options: PixelateFillOptions = {}
): Uint8ClampedArray {
  const { width, height } = image
  if (holeMask.width !== width || holeMask.height !== height) {
    throw new Error('fillHolesPixelate: image and mask dimensions must match')
  }
  const out = new Uint8ClampedArray(image.data)
  const bounds = holeBounds(holeMask)
  if (!bounds) return out

  const block = Math.max(2, Math.round(options.block ?? deriveObscureParams(bounds).pixelBlock))
  const pad = block
  const x0 = Math.max(0, bounds.x - pad)
  const y0 = Math.max(0, bounds.y - pad)
  const x1 = Math.min(width - 1, bounds.x + bounds.width - 1 + pad)
  const y1 = Math.min(height - 1, bounds.y + bounds.height - 1 + pad)
  const gx0 = Math.floor(x0 / block) * block
  const gy0 = Math.floor(y0 / block) * block

  for (let by = gy0; by <= y1; by += block) {
    for (let bx = gx0; bx <= x1; bx += block) {
      const sx1 = Math.min(bx + block - 1, width - 1)
      const sy1 = Math.min(by + block - 1, height - 1)
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = by; y <= sy1; y++) {
        for (let x = bx; x <= sx1; x++) {
          const o = (y * width + x) * 4
          r += image.data[o]
          g += image.data[o + 1]
          b += image.data[o + 2]
          n++
        }
      }
      r /= n
      g /= n
      b /= n
      // Write only inside the working crop: outside it the compositor never
      // looks at this plane, and untouched bytes stay exactly as copied.
      const wx1 = Math.min(sx1, x1)
      const wy1 = Math.min(sy1, y1)
      for (let y = Math.max(by, y0); y <= wy1; y++) {
        for (let x = Math.max(bx, x0); x <= wx1; x++) {
          const o = (y * width + x) * 4
          out[o] = r
          out[o + 1] = g
          out[o + 2] = b
        }
      }
    }
  }
  return out
}

/**
 * Solid cover over the mask's bounding box (plus the feather margin). No
 * working-crop guard: the fill writes in place with no extra buffers, and the
 * blackout option must stay available at any selection size.
 */
export function fillHolesSolid(image: RgbaGrid, holeMask: RgbaGrid, options: SolidFillOptions = {}): Uint8ClampedArray {
  const { width, height } = image
  if (holeMask.width !== width || holeMask.height !== height) {
    throw new Error('fillHolesSolid: image and mask dimensions must match')
  }
  const out = new Uint8ClampedArray(image.data)
  const bounds = holeBounds(holeMask)
  if (!bounds) return out

  const { r, g, b } = options.color ?? { r: 0, g: 0, b: 0 }
  const x0 = Math.max(0, bounds.x - FEATHER_PAD)
  const y0 = Math.max(0, bounds.y - FEATHER_PAD)
  const x1 = Math.min(width - 1, bounds.x + bounds.width - 1 + FEATHER_PAD)
  const y1 = Math.min(height - 1, bounds.y + bounds.height - 1 + FEATHER_PAD)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * width + x) * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
    }
  }
  return out
}

/**
 * Three box passes of half-width b approximate a Gaussian with sigma ≈ b
 * (variance of one box pass is (w²−1)/12; three passes give σ = √(w²−1)/2).
 * Sliding-window sums keep every pass O(N); edges clamp so borders stay valid.
 */
function boxBlurPlane(plane: Float32Array, w: number, h: number, radius: number, passes: number): void {
  const tmp = new Float32Array(plane.length)
  for (let p = 0; p < passes; p++) {
    boxBlurH(plane, tmp, w, h, radius)
    boxBlurV(tmp, plane, w, h, radius)
  }
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w * 3
    for (let c = 0; c < 3; c++) {
      let sum = 0
      const right0 = Math.min(w - 1, r)
      for (let x = 0; x <= right0; x++) sum += src[row + x * 3 + c]
      dst[row + c] = sum / (right0 + 1)
      for (let x = 1; x < w; x++) {
        const add = x + r
        if (add <= w - 1) sum += src[row + add * 3 + c]
        const remove = x - r - 1
        if (remove >= 0) sum -= src[row + remove * 3 + c]
        const left = Math.max(0, x - r)
        const right = Math.min(w - 1, x + r)
        dst[row + x * 3 + c] = sum / (right - left + 1)
      }
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  for (let x = 0; x < w; x++) {
    const col = x * 3
    for (let c = 0; c < 3; c++) {
      let sum = 0
      const bottom0 = Math.min(h - 1, r)
      for (let y = 0; y <= bottom0; y++) sum += src[y * w * 3 + col + c]
      dst[col + c] = sum / (bottom0 + 1)
      for (let y = 1; y < h; y++) {
        const add = y + r
        if (add <= h - 1) sum += src[add * w * 3 + col + c]
        const remove = y - r - 1
        if (remove >= 0) sum -= src[remove * w * 3 + col + c]
        const top = Math.max(0, y - r)
        const bottom = Math.min(h - 1, y + r)
        dst[y * w * 3 + col + c] = sum / (bottom - top + 1)
      }
    }
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}
