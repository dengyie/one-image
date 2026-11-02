import { describe, expect, it } from 'vitest'
import { clampZoom, computeCursorAnchoredPan, computeFitScale, createCropGesture, isNearActualSize, isViewportOffFit, mapSourceRectToViewport, mapPointerToSource, pickCompareSource, updateCropGesture, MAX_FIT_SCALE, MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from '../src/components/image-editor-model'

describe('image editor interaction model', () => {
  it('converts a pointer drag into a bounded crop move', () => {
    const gesture = createCropGesture('move', { x: 100, y: 100 }, { x: 0, y: 0, width: 400, height: 300 }, { x: 0, y: 0, width: 800, height: 600 })
    expect(updateCropGesture(gesture, { x: 700, y: 500 })).toEqual({ x: 400, y: 300, width: 400, height: 300 })
  })

  it('shrinks a full-image selection before moving it within the source', () => {
    const bounds = { x: 0, y: 0, width: 800, height: 600 }
    const reduced = { x: 72, y: 54, width: 656, height: 492 }
    const gesture = createCropGesture('move', { x: 200, y: 200 }, reduced, bounds)

    expect(updateCropGesture(gesture, { x: 260, y: 230 })).toEqual({ x: 132, y: 84, width: 656, height: 492 })
  })

  it('resizes from the east edge without crossing the image boundary', () => {
    const gesture = createCropGesture('e', { x: 100, y: 100 }, { x: 0, y: 0, width: 400, height: 300 }, { x: 0, y: 0, width: 800, height: 600 })
    expect(updateCropGesture(gesture, { x: 300, y: 100 })).toEqual({ x: 0, y: 0, width: 600, height: 300 })
  })

  it('keeps the selected aspect ratio while resizing', () => {
    const gesture = createCropGesture('e', { x: 100, y: 100 }, { x: 0, y: 0, width: 300, height: 300 }, { x: 0, y: 0, width: 800, height: 600 }, 1)
    expect(updateCropGesture(gesture, { x: 250, y: 100 })).toEqual({ x: 0, y: 0, width: 450, height: 450 })
  })

  it('maps a rotated viewport pointer back into source coordinates', () => {
    expect(mapPointerToSource({ x: 150, y: 50 }, { width: 200, height: 300 }, 90, false, false)).toEqual({ x: 50, y: 150 })
  })

  it('moves a local adjustment region without leaving the source bounds', () => {
    const gesture = createCropGesture('move', { x: 100, y: 100 }, { x: 100, y: 100, width: 200, height: 120 }, { x: 0, y: 0, width: 400, height: 300 })
    expect(updateCropGesture(gesture, { x: 500, y: 500 })).toEqual({ x: 200, y: 180, width: 200, height: 120 })
  })

  it('projects a source rectangle into the rotated viewport bounds', () => {
    const result = mapSourceRectToViewport({ x: 0, y: 0, width: 100, height: 50 }, { width: 100, height: 50 }, 90, false, false)
    expect(result.x).toBeCloseTo(0)
    expect(result.y).toBeCloseTo(0)
    expect(result.width).toBeCloseTo(50)
    expect(result.height).toBeCloseTo(100)
  })

  it('keeps the element point under the cursor fixed across a wheel zoom', () => {
    // Transform model: translate(pan) scale(s) with origin at the element
    // center, which flex-centers at the container center (1920x1080 here).
    const W = 1920, H = 1080
    const cx = W / 2, cy = H / 2
    const pan = { x: -130, y: 46 }
    const prevScale = 1.4
    const nextScale = 1.4 * 1.15
    const mouse = { x: 300, y: 800 }

    const next = computeCursorAnchoredPan(mouse.x, mouse.y, cx, cy, pan, prevScale, nextScale)

    // Element point under the cursor before the zoom...
    const qx = (mouse.x - cx - pan.x) / prevScale
    const qy = (mouse.y - cy - pan.y) / prevScale
    // ...must render at the same screen point after the zoom.
    expect(cx + next.x + qx * nextScale).toBeCloseTo(mouse.x, 6)
    expect(cy + next.y + qy * nextScale).toBeCloseTo(mouse.y, 6)
  })

  it('does not drift across consecutive wheel ticks at a fixed cursor', () => {
    const W = 1440, H = 900
    const cx = W / 2, cy = H / 2
    const mouse = { x: 220, y: 690 }
    let pan = { x: 0, y: 0 }
    let scale = 0.6

    // The tracked element point under the cursor at the start...
    const qx = (mouse.x - cx - pan.x) / scale
    const qy = (mouse.y - cy - pan.y) / scale

    for (let i = 0; i < 20; i++) {
      const nextScale = Math.min(32, scale * 1.15)
      pan = computeCursorAnchoredPan(mouse.x, mouse.y, cx, cy, pan, scale, nextScale)
      scale = nextScale
      // ...must remain exactly under the cursor after every tick.
      expect(cx + pan.x + qx * scale).toBeCloseTo(mouse.x, 6)
      expect(cy + pan.y + qy * scale).toBeCloseTo(mouse.y, 6)
    }
  })

  it('drifts on the corner-anchored model it replaces (regression documentation)', () => {
    // The previous formula assumed transform-origin at the container's
    // top-left; with the real center-origin transform the anchored point
    // moves by about center*(ratio-1) per tick. Guard the fix by showing the
    // new pan differs from that broken model at an off-center cursor.
    const W = 1920, H = 1080
    const cx = W / 2, cy = H / 2
    const pan = { x: 0, y: 0 }
    const prevScale = 1, nextScale = 1.15
    const mouse = { x: 300, y: 800 }

    const fixed = computeCursorAnchoredPan(mouse.x, mouse.y, cx, cy, pan, prevScale, nextScale)
    const brokenX = mouse.x - (mouse.x - pan.x) * (nextScale / prevScale)
    const brokenY = mouse.y - (mouse.y - pan.y) * (nextScale / prevScale)

    expect(fixed.x).not.toBeCloseTo(brokenX, 0)
    expect(fixed.y).not.toBeCloseTo(brokenY, 0)
    // The broken model's per-tick drift equals center*(ratio-1).
    expect(fixed.x - brokenX).toBeCloseTo(cx * (nextScale / prevScale - 1), 6)
    expect(fixed.y - brokenY).toBeCloseTo(cy * (nextScale / prevScale - 1), 6)
  })

  it('returns the pan untouched for degenerate scales', () => {
    const pan = { x: 12, y: -8 }
    expect(computeCursorAnchoredPan(100, 100, 960, 540, pan, 0, 2)).toEqual(pan)
    expect(computeCursorAnchoredPan(100, 100, 960, 540, pan, 1, Number.NaN)).toEqual(pan)
  })
})

describe('fit framing used when a document opens or is reverted', () => {
  it('fits a large document inside the viewport with the standard margin', () => {
    // 2000x1000 in a 1400x900 window, 120px margin: width wins -> 1280/2000.
    expect(computeFitScale({ width: 2000, height: 1000 }, { width: 1400, height: 900 })).toBe(0.64)
  })

  it('never upscales a small document past 100%', () => {
    expect(computeFitScale({ width: 120, height: 80 }, { width: 1600, height: 1000 })).toBe(1)
  })

  it('still frames a window narrower than the margin instead of snapping to the floor', () => {
    // 520x360 usable: height wins -> 0.09, inside the 0.05..32 zoom domain.
    expect(computeFitScale({ width: 4000, height: 4000 }, { width: 640, height: 480 })).toBe(0.09)
  })

  it('lands exactly on the minimum zoom for documents too large to fit at all', () => {
    // 0.0036 rounds to 0 and must clamp to the wheel/button floor, not stay at 0.
    expect(computeFitScale({ width: 100000, height: 100000 }, { width: 640, height: 480 })).toBe(0.05)
  })

  it('falls back to 1 for a degenerate document size instead of returning NaN', () => {
    expect(computeFitScale({ width: 0, height: 0 }, { width: 1200, height: 800 })).toBe(1)
  })

  it('keeps fit inside the same zoom domain the wheel and buttons enforce', () => {
    const fit = computeFitScale({ width: 100000, height: 100000 }, { width: 640, height: 480 })
    expect(fit).toBeGreaterThanOrEqual(MIN_ZOOM_SCALE)
    expect(fit).toBeLessThanOrEqual(MAX_ZOOM_SCALE)
  })
})

describe('shared zoom domain', () => {
  it('clamps both ends and passes normal values through', () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM_SCALE)
    expect(clampZoom(100)).toBe(MAX_ZOOM_SCALE)
    expect(clampZoom(1.5)).toBe(1.5)
  })

  it('recovers from non-finite input instead of poisoning the transform', () => {
    expect(clampZoom(Number.NaN)).toBe(MAX_FIT_SCALE)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MAX_FIT_SCALE)
  })

  it('treats a view within tolerance of 1:1 as actual size', () => {
    expect(isNearActualSize(1)).toBe(true)
    expect(isNearActualSize(0.95)).toBe(true)
    expect(isNearActualSize(0.8)).toBe(false)
    expect(isNearActualSize(1.2)).toBe(false)
  })
})

describe('isViewportOffFit', () => {
  const fit = 0.64
  it('is false only at the fitted origin', () => {
    expect(isViewportOffFit({ x: 0, y: 0 }, fit, fit)).toBe(false)
  })
  it('flags pan on either axis even at fit zoom', () => {
    expect(isViewportOffFit({ x: 12, y: 0 }, fit, fit)).toBe(true)
    expect(isViewportOffFit({ x: 0, y: -3 }, fit, fit)).toBe(true)
  })
  it('flags a zoom that drifted from fit with zero pan', () => {
    expect(isViewportOffFit({ x: 0, y: 0 }, 1, fit)).toBe(true)
    expect(isViewportOffFit({ x: 0, y: 0 }, fit + 0.01, fit)).toBe(true)
  })
})

describe('pickCompareSource', () => {
  it('falls back to the root image when the current document is derived from it', () => {
    const root = { id: 'root' }
    const derived = { id: 'erased' }
    expect(pickCompareSource(derived, root)).toBe(root)
  })

  it('keeps the current document when it already is the root', () => {
    const root = { id: 'root' }
    expect(pickCompareSource(root, root)).toBeNull()
  })

  it('keeps the current document when no root was tracked', () => {
    const current = { id: 'current' }
    expect(pickCompareSource(current, null)).toBeNull()
  })
})
