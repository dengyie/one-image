// Tightens a coarse smart-erase mask down to the pixels that actually carry
// the overlay. The UI paints a rectangle around a watermark, but a filler only
// needs to touch the watermark itself — handing it the whole rectangle makes it
// re-synthesize flat background too, which is exactly what reads as "the image
// changed". This keeps the hole near the glyphs: a watermark stroke is a
// high local-contrast feature against its own blurred neighbourhood, while flat
// background and smooth gradients are not.
//
// Safety model: strokes are grouped into connected components and each
// component's *bounding box* is masked. Bounding boxes (never individual
// detected pixels) mean a solid or filled watermark whose interior is flat
// still gets fully covered by the box around its detected outline; only the
// empty space between strokes is dropped. If nothing is detected at all (a
// perfectly flat region), the original mask is returned unchanged.
//
// Pure typed-array math (no canvas, no DOM) so it runs and tests in Node.

export interface RgbaGrid {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface RefineMaskOptions {
  /** Local-contrast floor (0-255) for a pixel to count as a stroke. */
  threshold?: number
  /** Background-estimate radius in pixels. */
  radius?: number
  /** Grow every component box by this many pixels to cover anti-aliasing. */
  dilate?: number
  /** Components smaller than this many pixels are treated as noise. */
  minComponentPixels?: number
}

const DEFAULTS = {
  threshold: 16,
  radius: 6,
  dilate: 2,
  minComponentPixels: 2,
}

/**
 * Returns a new RGBA mask (white = erase, black = keep) covering the bounding
 * boxes of the overlay strokes found inside `mask`. The input is never mutated.
 */
export function refineMaskToStrokes(
  image: RgbaGrid,
  mask: RgbaGrid,
  options: RefineMaskOptions = {}
): Uint8ClampedArray {
  const { width, height } = image
  const size = width * height
  if (mask.width !== width || mask.height !== height) {
    throw new Error('refineMaskToStrokes: image and mask dimensions must match')
  }
  const threshold = options.threshold ?? DEFAULTS.threshold
  const radius = Math.max(1, Math.round(options.radius ?? DEFAULTS.radius))
  const dilate = Math.max(0, Math.round(options.dilate ?? DEFAULTS.dilate))
  const minComponentPixels = Math.max(1, Math.round(options.minComponentPixels ?? DEFAULTS.minComponentPixels))

  const gray = toGray(image)
  const background = boxBlur(gray, width, height, radius)

  const inMask = new Uint8Array(size)
  const stroke = new Uint8Array(size)
  let strokeCount = 0
  for (let i = 0; i < size; i++) {
    if (mask.data[i * 4] < 128) continue
    inMask[i] = 1
    if (Math.abs(gray[i] - background[i]) >= threshold) {
      stroke[i] = 1
      strokeCount++
    }
  }
  if (strokeCount === 0) return copyMask(mask)

  const boxes = componentBoxes(stroke, width, height, minComponentPixels)
  if (boxes.length === 0) return copyMask(mask)

  const out = new Uint8ClampedArray(size * 4)
  for (let i = 0; i < size; i++) out[i * 4 + 3] = 255
  for (const box of boxes) {
    const x0 = Math.max(0, box.x - dilate)
    const y0 = Math.max(0, box.y - dilate)
    const x1 = Math.min(width - 1, box.x + box.width - 1 + dilate)
    const y1 = Math.min(height - 1, box.y + box.height - 1 + dilate)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x
        // Never grow outside the coarse mask: the rectangle is still the hard
        // boundary the user drew.
        if (inMask[i]) out[i * 4] = 255
      }
    }
  }
  return out
}

export interface PixelBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Bounding boxes of 8-connected stroke components. Uses an explicit stack so a
 * large solid region cannot blow the call stack.
 */
export function componentBoxes(stroke: Uint8Array, width: number, height: number, minPixels: number): PixelBox[] {
  const visited = new Uint8Array(width * height)
  const boxes: PixelBox[] = []
  const stack: number[] = []
  for (let start = 0; start < width * height; start++) {
    if (!stroke[start] || visited[start]) continue
    visited[start] = 1
    stack.push(start)
    let count = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    while (stack.length > 0) {
      const index = stack.pop()!
      const x = index % width
      const y = (index - x) / width
      count++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const neighbour = ny * width + nx
          if (!stroke[neighbour] || visited[neighbour]) continue
          visited[neighbour] = 1
          stack.push(neighbour)
        }
      }
    }
    if (count >= minPixels) boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
  }
  return boxes
}

function copyMask(mask: RgbaGrid): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.data.length)
  out.set(mask.data)
  return out
}

function toGray(image: RgbaGrid): Float32Array {
  const size = image.width * image.height
  const gray = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const o = i * 4
    gray[i] = 0.299 * image.data[o] + 0.587 * image.data[o + 1] + 0.114 * image.data[o + 2]
  }
  return gray
}

export interface DetectStrokeOptions {
  /** Local-contrast floor (0-255) for a pixel to count as a stroke. */
  threshold?: number
  /** Background-estimate radius in pixels. */
  radius?: number
  /** Grow every accepted box by this many pixels to cover anti-aliasing. */
  dilate?: number
  /** Components smaller than this many pixels are noise. */
  minComponentPixels?: number
  /**
   * Boxes whose stroke pixels exceed this share are solid photo content (a
   * filled sun disk measures π/4 ≈ 0.785, photo edges and textures higher);
   * they are dropped. Bold watermark glyphs measure around 0.6-0.7, so the
   * gate sits just above them.
   */
  maxDensity?: number
  /**
   * Boxes whose stroke pixels fall below this share are chains: one connected
   * band snaking across distant photo features (a mountain ridge, a shoreline)
   * whose bounding box swallows mostly untouched background. Text letters keep
   * their box density above ~0.3, so the gate only drops these chains.
   */
  minDensity?: number
  /**
   * Boxes larger than this share of the frame are photo structures, not
   * watermark glyphs; they are dropped regardless of density.
   */
  maxBoxAreaFraction?: number

  /** Hard cap on returned boxes, largest first. */
  maxRegions?: number
}

/**
 * Whole-image stroke scan for the one-click watermark cleanup: finds the
 * bounding boxes of high-local-contrast components anywhere in the frame,
 * with guards against destroying ordinary photos. The density window drops
 * solid blobs above `maxDensity` (a filled sun disk) and chained outline
 * boxes below `minDensity` (a ridge line snaking across the frame); the area
 * cap drops any single box big enough to be photo structure. What survives is
 * the profile of text: sparse, mid-density, small boxes. Callers additionally
 * gate on total coverage before filling. Conservative defaults: a higher
 * threshold and a larger minimum component than the in-mask refiner, because
 * there is no user mask to lean on.
 */
export function detectStrokeRegions(image: RgbaGrid, options: DetectStrokeOptions = {}): PixelBox[] {
  const { width, height } = image
  const threshold = options.threshold ?? 20
  // A broad background estimate matters more here than in the in-mask refiner:
  // with a tight radius a high-contrast stroke raises its own background enough
  // to flag the rows around it as strokes too, inflating every component box
  // until the density gate rejects the real watermark.
  const radius = Math.max(1, Math.round(options.radius ?? 12))
  const dilate = Math.max(0, Math.round(options.dilate ?? 2))
  const minComponentPixels = Math.max(1, Math.round(options.minComponentPixels ?? 24))
  const maxDensity = Math.min(1, Math.max(0, options.maxDensity ?? 0.75))
  const minDensity = Math.min(maxDensity, Math.max(0, options.minDensity ?? 0.12))
  const frameArea = Math.max(1, width * height)
  const maxBoxPixels = frameArea * Math.min(1, Math.max(0, options.maxBoxAreaFraction ?? 0.03))
  const maxRegions = Math.max(1, Math.round(options.maxRegions ?? 300))

  const gray = toGray(image)
  const background = boxBlur(gray, width, height, radius)
  const stroke = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    if (Math.abs(gray[i] - background[i]) >= threshold) stroke[i] = 1
  }

  const accepted: PixelBox[] = []
  for (const raw of componentBoxes(stroke, width, height, minComponentPixels)) {
    const x0 = Math.max(0, raw.x - dilate)
    const y0 = Math.max(0, raw.y - dilate)
    const x1 = Math.min(width - 1, raw.x + raw.width - 1 + dilate)
    const y1 = Math.min(height - 1, raw.y + raw.height - 1 + dilate)
    let strokePixels = 0
    let total = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        total++
        if (stroke[y * width + x]) strokePixels++
      }
    }
    const density = strokePixels / total
    if (density > maxDensity) continue
    if (density < minDensity) continue
    if (total > maxBoxPixels) continue
    accepted.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
  }
  accepted.sort((a, b) => b.width * b.height - a.width * a.height)
  return accepted.slice(0, maxRegions)
}

/** Separable box blur via a summed-area table; radius is inclusive. */
function boxBlur(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const integral = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    for (let x = 0; x < width; x++) {
      rowSum += source[y * width + x]
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum
    }
  }
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(height - 1, y + radius)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      const sum =
        integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
        integral[y0 * (width + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0]
      out[y * width + x] = sum / area
    }
  }
  return out
}
