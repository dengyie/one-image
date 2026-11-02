import { clampCrop, rotatedDimensions, type Rect } from '../domain/editor-state'

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface CropGesture {
  handle: CropHandle
  startPointer: { x: number; y: number }
  startCrop: Rect
  bounds: Rect
  aspectRatio: number | null
}

export function mapPointerToSource(pointer: { x: number; y: number }, source: { width: number; height: number }, rotation: number, flipX: boolean, flipY: boolean): { x: number; y: number } {
  const normalizedRotation = ((rotation % 360) + 360) % 360
  const viewport = rotatedDimensions(source.width, source.height, normalizedRotation)
  const viewportWidth = viewport.width
  const viewportHeight = viewport.height
  let x = pointer.x - viewportWidth / 2
  let y = pointer.y - viewportHeight / 2
  const radians = -normalizedRotation * Math.PI / 180
  const rotatedX = x * Math.cos(radians) - y * Math.sin(radians)
  const rotatedY = x * Math.sin(radians) + y * Math.cos(radians)
  x = flipX ? -rotatedX : rotatedX
  y = flipY ? -rotatedY : rotatedY
  return { x: x + source.width / 2, y: y + source.height / 2 }
}

export function mapSourceRectToViewport(rect: Rect, source: { width: number; height: number }, rotation: number, flipX: boolean, flipY: boolean): Rect {
  const viewport = rotatedDimensions(source.width, source.height, rotation)
  const radians = ((rotation % 360) + 360) % 360 * Math.PI / 180
  const points = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ].map((point) => {
    let x = (point.x - source.width / 2) * (flipX ? -1 : 1)
    let y = (point.y - source.height / 2) * (flipY ? -1 : 1)
    return { x: viewport.width / 2 + x * Math.cos(radians) - y * Math.sin(radians), y: viewport.height / 2 + x * Math.sin(radians) + y * Math.cos(radians) }
  })
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

export function createCropGesture(handle: CropHandle, startPointer: { x: number; y: number }, startCrop: Rect, bounds: Rect, aspectRatio: number | null = null): CropGesture {
  return { handle, startPointer, startCrop, bounds, aspectRatio }
}

export function updateCropGesture(gesture: CropGesture, pointer: { x: number; y: number }): Rect {
  const deltaX = pointer.x - gesture.startPointer.x
  const deltaY = pointer.y - gesture.startPointer.y
  const crop = { ...gesture.startCrop }
  if (gesture.handle === 'move') return clampCrop({ ...crop, x: crop.x + deltaX, y: crop.y + deltaY }, gesture.bounds)
  if (gesture.handle.includes('e')) crop.width += deltaX
  if (gesture.handle.includes('s')) crop.height += deltaY
  if (gesture.handle.includes('w')) { crop.x += deltaX; crop.width -= deltaX }
  if (gesture.handle.includes('n')) { crop.y += deltaY; crop.height -= deltaY }
  if (gesture.aspectRatio !== null) {
    const horizontal = gesture.handle.includes('e') || gesture.handle.includes('w')
    const vertical = gesture.handle.includes('n') || gesture.handle.includes('s')
    if (horizontal && !vertical) crop.height = crop.width / gesture.aspectRatio
    else if (vertical && !horizontal) crop.width = crop.height * gesture.aspectRatio
    else if (horizontal && vertical) {
      const widthFromHeight = crop.height * gesture.aspectRatio
      const heightFromWidth = crop.width / gesture.aspectRatio
      if (Math.abs(deltaX) >= Math.abs(deltaY)) crop.height = heightFromWidth
      else crop.width = widthFromHeight
    }
  }
  return clampCrop(crop, gesture.bounds, gesture.aspectRatio)
}

export interface PanOffset {
  x: number
  y: number
}

export const VIEWPORT_FIT_MARGIN = 120
/** Zoom domain shared by the wheel, the zoom buttons and the fit calculation. */
export const MIN_ZOOM_SCALE = 0.05
export const MAX_ZOOM_SCALE = 32
/** Fitting never upscales a document past its natural size. */
export const MAX_FIT_SCALE = 1
/** A toggle-zoom affordance treats anything this close to 1:1 as actual size. */
export const ZOOM_TOGGLE_TOLERANCE = 0.1

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return MAX_FIT_SCALE
  return Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale))
}

export function isNearActualSize(scale: number): boolean {
  return Math.abs(scale - 1) < ZOOM_TOGGLE_TOLERANCE
}

/**
 * The framing a document opens in: fit inside the window minus a margin, never
 * upscaled past 100%. Every path that frames a document — opening it, reverting
 * it, the zoom button and double-click — goes through here, so they cannot
 * disagree about what "fit" means.
 */
export function computeFitScale(
  document: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = VIEWPORT_FIT_MARGIN
): number {
  const scale = Math.min(
    MAX_FIT_SCALE,
    (viewport.width - margin) / document.width,
    (viewport.height - margin) / document.height
  )
  // A zero-sized document or window would otherwise poison the transform with
  // Infinity/NaN, which leaves the canvas unmountable.
  if (!Number.isFinite(scale)) return MAX_FIT_SCALE
  return clampZoom(Number(scale.toFixed(2)))
}

/**
 * Whether the viewport sits anywhere other than the fitted origin. Panning and
 * zooming live outside the session tree, so a pan-only document has no undo
 * steps and no draft — without this check the reset button would stay disabled
 * and a moved image could never be brought back to its origin.
 */
export function isViewportOffFit(
  panOffset: { x: number; y: number },
  zoomScale: number,
  fitScale: number
): boolean {
  return panOffset.x !== 0 || panOffset.y !== 0 || zoomScale !== fitScale
}

// Cursor-anchored wheel zoom for the spatial viewport transform
// `translate(pan) scale(s)` with transform-origin at the element center (the
// element is flex-centered in the container). The element point under the
// cursor q = (mouse - center - pan) / s must stay under the cursor after the
// zoom: center + pan' + q * s' = mouse, hence the pan update below. Solving
// around the container's top-left corner instead — the model that matches a
// `transform-origin: 0 0` layout — made the image drift by roughly
// center * (ratio - 1) on every wheel tick, compounding into the reported
// "image flies away" behavior.
export function computeCursorAnchoredPan(
  mouseX: number,
  mouseY: number,
  centerX: number,
  centerY: number,
  pan: PanOffset,
  prevScale: number,
  nextScale: number
): PanOffset {
  if (!Number.isFinite(prevScale) || prevScale <= 0 || !Number.isFinite(nextScale) || nextScale <= 0) {
    return { ...pan }
  }
  const ratio = nextScale / prevScale
  const offsetX = mouseX - centerX
  const offsetY = mouseY - centerY
  return {
    x: offsetX - (offsetX - pan.x) * ratio,
    y: offsetY - (offsetY - pan.y) * ratio,
  }
}
