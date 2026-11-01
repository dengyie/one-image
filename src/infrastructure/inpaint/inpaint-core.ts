// Pure tensor/mask math for the MI-GAN smart eraser, kept free of canvas and
// ORT imports so it runs (and tests) in Node.

export interface RgbaPlane {
  data: Uint8ClampedArray
  width: number
  height: number
}

/**
 * RGBA (HWC) → packed RGB (CHW), the MI-GAN pipeline input layout.
 * Alpha is dropped: inpainting runs on the RGB image and the compositor
 * restores the original alpha relationship.
 */
export function rgbaToRgbChw(plane: RgbaPlane): Uint8Array {
  const { data, width, height } = plane
  const size = width * height
  const out = new Uint8Array(size * 3)
  for (let i = 0, p = 0; i < size; i++, p++) {
    out[p] = data[i * 4]
    out[size + p] = data[i * 4 + 1]
    out[size * 2 + p] = data[i * 4 + 2]
  }
  return out
}

/**
 * White-on-black mask canvas → uint8 model mask. The MI-GAN pipeline treats
 * 0 as the inpaint hole and 255 as keep (verified against the real model:
 * pixels under mask=255 survive, everything else is synthesized), so the
 * drawn white regions map to 0 and the background to 255.
 */
export function maskToBinary(plane: RgbaPlane): Uint8Array {
  const size = plane.width * plane.height
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    out[i] = plane.data[i * 4] >= 128 ? 0 : 255
  }
  return out
}

/**
 * Fuses model-output conversion and masking into a single pass: blends the
 * uint8 CHW result into the base frame using a feathered alpha mask
 * (255 = fully generated, 0 = untouched). Pixels where alpha is exactly 0 are
 * copied bit-for-bit from the base — the hard "nothing outside the mask
 * changes" guarantee of the smart eraser — and the base alpha channel is
 * always preserved (the model speaks RGB only).
 */
export function compositeFromChw(chw: Uint8Array, base: RgbaPlane, alpha: RgbaPlane): Uint8ClampedArray {
  const size = base.width * base.height
  const out = new Uint8ClampedArray(size * 4)
  for (let i = 0; i < size; i++) {
    const o = i * 4
    const a = alpha.data[o] / 255
    if (a === 0) {
      out[o] = base.data[o]
      out[o + 1] = base.data[o + 1]
      out[o + 2] = base.data[o + 2]
      out[o + 3] = base.data[o + 3]
      continue
    }
    const r = clampByte(chw[i])
    const g = clampByte(chw[size + i])
    const b = clampByte(chw[size * 2 + i])
    if (a === 1) {
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
    } else {
      out[o] = Math.round(base.data[o] * (1 - a) + r * a)
      out[o + 1] = Math.round(base.data[o + 1] * (1 - a) + g * a)
      out[o + 2] = Math.round(base.data[o + 2] * (1 - a) + b * a)
    }
    out[o + 3] = base.data[o + 3]
  }
  return out
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/**
 * Same blending contract as compositeFromChw, but for a filler that already
 * speaks RGBA (the classical diffusion filler). Pixels where alpha is 0 are
 * copied bit-for-bit from the base, so "nothing outside the mask changes"
 * holds for both providers.
 */
export function compositeRgba(base: RgbaPlane, generated: RgbaPlane, alpha: RgbaPlane): Uint8ClampedArray {
  const size = base.width * base.height
  const out = new Uint8ClampedArray(size * 4)
  for (let i = 0; i < size; i++) {
    const o = i * 4
    const a = alpha.data[o] / 255
    if (a === 0) {
      out[o] = base.data[o]
      out[o + 1] = base.data[o + 1]
      out[o + 2] = base.data[o + 2]
      out[o + 3] = base.data[o + 3]
      continue
    }
    const r = generated.data[o]
    const g = generated.data[o + 1]
    const b = generated.data[o + 2]
    if (a === 1) {
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
    } else {
      out[o] = Math.round(base.data[o] * (1 - a) + r * a)
      out[o + 1] = Math.round(base.data[o + 1] * (1 - a) + g * a)
      out[o + 2] = Math.round(base.data[o + 2] * (1 - a) + b * a)
    }
    out[o + 3] = base.data[o + 3]
  }
  return out
}
