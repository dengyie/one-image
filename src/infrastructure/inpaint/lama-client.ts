import type { RgbaGrid } from './mask-refine'

// Client side of the server-tier smart-erase (LaMa on the VPS, model
// pre-deployed — the browser never downloads a model for this tier). The
// Cloudflare tunnel's upload leg is slow (~60-90KB/s), so the full frame is
// never sent: only the mask's bounding neighborhood, cropped and capped, goes
// up as PNG; the server fills the hole and returns the same crop with every
// non-hole pixel bit-for-bit identical, which the caller blends through its
// existing feathered-alpha composite.

/** Upload guard: crops larger than this edge are downscaled before sending. */
export const LAMA_CROP_MAX_EDGE = 2048
/** Context margin around the mask bbox, as a share of the bbox size. */
export const LAMA_CROP_MARGIN_SHARE = 0.25
const MIN_MARGIN = 16
const MAX_MARGIN = 256

export interface LamaCropRect {
  x: number
  y: number
  /** Crop size in ORIGINAL image pixels (pre-scale). */
  width: number
  height: number
  /** ≤ 1: the crop is downscaled by this factor for upload and the returned
   * fill must be scaled back up by 1/scale when compositing. */
  scale: number
}

/**
 * Picks the crop window around the mask's bounding box: bbox + margin on every
 * side (clamped to the image), then downscaled if the window exceeds the
 * upload edge. Returns null when the mask holds no hole pixels.
 */
export function computeLamaCropRect(mask: RgbaGrid): LamaCropRect | null {
  const { data, width, height } = mask
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] >= 128) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  const bboxW = maxX - minX + 1
  const bboxH = maxY - minY + 1
  const margin = Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, Math.round(Math.max(bboxW, bboxH) * LAMA_CROP_MARGIN_SHARE)))
  const x = Math.max(0, minX - margin)
  const y = Math.max(0, minY - margin)
  const cropWidth = Math.min(width, maxX + 1 + margin) - x
  const cropHeight = Math.min(height, maxY + 1 + margin) - y
  const scale = Math.min(1, LAMA_CROP_MAX_EDGE / Math.max(cropWidth, cropHeight))
  return { x, y, width: cropWidth, height: cropHeight, scale }
}

export interface CanvasFactoryLike {
  create(width: number, height: number): {
    getContext(type: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  }
}

type BlobCanvas = {
  convertToBlob?: (options?: { type: string }) => Promise<Blob>
  toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void
}

/** Encodes a crop region of `source` as a PNG blob, downscaled by rect.scale. */
export async function encodeLamaCrop(
  source: CanvasImageSource,
  rect: LamaCropRect,
  canvasFactory: CanvasFactoryLike,
  createBlob: (canvas: unknown) => Promise<Blob>,
): Promise<Blob> {
  const encodedWidth = Math.max(1, Math.round(rect.width * rect.scale))
  const encodedHeight = Math.max(1, Math.round(rect.height * rect.scale))
  const canvas = canvasFactory.create(encodedWidth, encodedHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('裁剪编码失败：无法创建画布上下文')
  ctx.imageSmoothingEnabled = rect.scale < 1
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, encodedWidth, encodedHeight)
  return createBlob(canvas)
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export interface ServerLamaResponse {
  image: { mimeType: string; base64: string }
}

/**
 * POSTs the crop pair to /api/v1/smart-erase. Error mapping mirrors
 * generateImage: caller-abort → 已取消, deadline → 生成超时 wording adapted to
 * the tier, everything else surfaces the server's Chinese message.
 */
export async function postServerLama(
  payload: { imageBase64: string; maskBase64: string },
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; data?: ServerLamaResponse; message?: string }> {
  const signals = [options.signal, typeof options.timeoutMs === 'number' ? AbortSignal.timeout(options.timeoutMs) : undefined].filter(
    (s): s is AbortSignal => !!s,
  )
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  try {
    const res = await fetch('/api/v1/smart-erase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ image: { base64: payload.imageBase64 }, mask: { base64: payload.maskBase64 } }),
      signal,
    })
    const data = (await res.json().catch(() => null)) as { message?: string; image?: { mimeType: string; base64: string } } | null
    if (!res.ok || !data?.image) {
      return { ok: false, message: data?.message || `服务端修复失败（HTTP ${res.status}）` }
    }
    return { ok: true, data: { image: data.image } }
  } catch (err: unknown) {
    if (options.signal?.aborted) return { ok: false, message: '已取消修复' }
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, message: timedOut ? '服务端修复超时，请稍后重试' : '网络连接失败' }
  }
}

export { blobToBase64 }
