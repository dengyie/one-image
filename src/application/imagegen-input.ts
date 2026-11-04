import { resolveRenderDimensions } from './editor-renderer'

// Reference-image preparation for image-to-image.
//
// Nothing large should travel as JSON base64: each 3 bytes of file become 4
// characters, and the server's bodyLimit is 16 MB. A phone photo is therefore
// shrunk to a 2048px edge and then re-encoded until it fits, trading JPEG
// quality before resolution — the model picks its own output size anyway, so a
// slightly softer 2048px reference reads better than a crisp 1024px one.
//
// This runs on the user's own file in the user's own browser, inside the
// project's local-first boundary.

export const REFERENCE_MAX_EDGE = 2048
export const REFERENCE_MAX_BYTES = 5 * 1024 * 1024

export interface ReferenceImage {
  mimeType: string
  base64: string
  width: number
  height: number
  bytes: number
}

export class ReferenceImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferenceImageError'
  }
}

async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    return {
      source: bitmap as unknown as CanvasImageSource,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }
  }
  // <img> fallback for browsers without createImageBitmap.
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

async function encodeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality: number): Promise<Uint8Array> {
  const blob = canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type, quality })
    : await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), type, quality))
  if (!blob) throw new ReferenceImageError('当前浏览器无法编码参考图')
  // A browser that cannot encode the requested type silently falls back to PNG.
  if (blob.type !== type) throw new ReferenceImageError(`当前浏览器不支持编码 ${type} 参考图`)
  return new Uint8Array(await blob.arrayBuffer())
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // String.fromCharCode(...spread) would blow the argument limit on big files.
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Decoded pixel size of an image the browser can read. */
export async function readImageSize(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new ReferenceImageError('无法解码参考图'))
      element.src = url
    })
    return { width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface ReferenceSource {
  /** Full-quality bytes; how the caller got them (canvas, file) is its business. */
  blob: Promise<Blob>
  mimeType: string
}

/**
 * Downscales and re-encodes until the result fits the server's acceptance
 * envelope: fit to `maxEdge`, encode, then step down (quality, then edge trialled
 * at 3/4 and 1/2) while oversize. Lossy formats are always re-encoded to JPEG —
 * WebP is accepted as a *source* but the editing surface takes PNG/JPEG only.
 */
export async function prepareReferenceImage(source: ReferenceSource, options: { maxEdge?: number; maxBytes?: number } = {}): Promise<ReferenceImage> {
  const maxEdge = options.maxEdge ?? REFERENCE_MAX_EDGE
  const maxBytes = options.maxBytes ?? REFERENCE_MAX_BYTES
  const blob = await source.blob
  const decoded = await decode(blob)
  try {
    const fit = resolveRenderDimensions(decoded.width, decoded.height, maxEdge)
    const candidates: { edge: number; type: 'image/png' | 'image/jpeg'; quality: number }[] = []
    // A PNG source stays PNG at its fitted size: lossless reference pixels and
    // transparency survive. Anything lossy (JPEG/WebP) is re-encoded to JPEG,
    // the format every editing surface accepts.
    if (source.mimeType === 'image/png') candidates.push({ edge: maxEdge, type: 'image/png', quality: 1 })
    candidates.push(
      { edge: maxEdge, type: 'image/jpeg', quality: 0.92 },
      { edge: maxEdge, type: 'image/jpeg', quality: 0.8 },
      { edge: maxEdge * 0.75, type: 'image/jpeg', quality: 0.8 },
      { edge: maxEdge * 0.5, type: 'image/jpeg', quality: 0.8 },
    )
    let smallest = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const dimensions = resolveRenderDimensions(decoded.width, decoded.height, candidate.edge)
      const canvas = createCanvas(dimensions.width, dimensions.height)
      const context = canvas.getContext('2d')
      if (!context) throw new ReferenceImageError('当前浏览器无法绘制参考图')
      // JPEG has no alpha: composite over white so transparent areas do not
      // turn black. PNG keeps whatever was there.
      if (candidate.type === 'image/jpeg') {
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, dimensions.width, dimensions.height)
      }
      context.drawImage(decoded.source, 0, 0, dimensions.width, dimensions.height)
      const bytes = await encodeCanvas(canvas, candidate.type, candidate.quality)
      smallest = Math.min(smallest, bytes.length)
      if (bytes.length <= maxBytes) {
        return {
          mimeType: candidate.type,
          base64: toBase64(bytes),
          width: dimensions.width,
          height: dimensions.height,
          bytes: bytes.length,
        }
      }
    }
    throw new ReferenceImageError(`参考图压缩到 ${Math.round(maxBytes / 1024 / 1024)}MB 以内仍失败（最小 ${(smallest / 1024 / 1024).toFixed(2)}MB）`)
  } finally {
    decoded.close()
  }
}