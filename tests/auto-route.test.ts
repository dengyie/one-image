import { describe, expect, it } from 'vitest'
import {
  AUTO_CLASSICAL_MAX_COVERAGE,
  AUTO_CLASSICAL_MAX_PIXELS,
  resolveEraseProvider,
  routeFill,
} from '../src/infrastructure/inpaint/auto-route'
import type { RgbaGrid } from '../src/infrastructure/inpaint/mask-refine'

function mask(width: number, height: number, covered: number): RgbaGrid {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < covered; i++) {
    data[i * 4] = 255
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

describe('routeFill', () => {
  it('honours an explicit classical choice regardless of hole size', () => {
    const decision = routeFill({ mode: 'classical', mask: mask(100, 100, 100 * 100), imageWidth: 100, imageHeight: 100 })
    expect(decision.provider).toBe('classical')
    expect(decision.coverage).toBe(1)
  })

  it('honours an explicit migan choice even for a tiny hole', () => {
    const decision = routeFill({ mode: 'migan', mask: mask(100, 100, 4), imageWidth: 100, imageHeight: 100 })
    expect(decision.provider).toBe('migan')
    expect(decision.holePixels).toBe(4)
  })

  it('auto routes a small hole to the classical filler', () => {
    const decision = routeFill({
      mode: 'auto',
      mask: mask(1000, 1000, AUTO_CLASSICAL_MAX_PIXELS - 1),
      imageWidth: 1000,
      imageHeight: 1000,
    })
    expect(decision.provider).toBe('classical')
    expect(decision.reason).toContain('扩散填充')
  })

  it('auto routes a large hole to the Gaussian frost filler, never MI-GAN', () => {
    const decision = routeFill({ mode: 'auto', mask: mask(200, 200, 200 * 200), imageWidth: 200, imageHeight: 200 })
    expect(decision.provider).toBe('blur')
    expect(decision.provider).not.toBe('migan')
    expect(decision.reason).toContain('高斯磨砂')
  })

  it('treats a low-coverage hole on a huge frame as classical', () => {
    // 5000 hole pixels would normally exceed the pixel cap, but coverage is
    // tiny on a 60MP frame; diffusion is still the safe choice.
    const width = 8000
    const height = 8000
    const decision = routeFill({
      mode: 'auto',
      mask: mask(width, height, 5000),
      imageWidth: width,
      imageHeight: height,
    })
    expect(decision.holePixels).toBe(5000)
    expect(decision.coverage).toBeLessThan(AUTO_CLASSICAL_MAX_COVERAGE)
    expect(decision.provider).toBe('classical')
  })

  it('never divides by zero on an empty frame', () => {
    const decision = routeFill({ mode: 'auto', mask: mask(0, 0, 0), imageWidth: 0, imageHeight: 0 })
    expect(decision.coverage).toBe(0)
    expect(decision.provider).toBe('classical')
  })
})

describe('resolveEraseProvider', () => {
  it('maps blackout to solid and passes blur/pixel through verbatim', () => {
    expect(resolveEraseProvider('blackout')).toBe('solid')
    expect(resolveEraseProvider('blur')).toBe('blur')
    expect(resolveEraseProvider('pixel')).toBe('pixel')
  })
})
