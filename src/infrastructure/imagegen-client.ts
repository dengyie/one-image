// Client for the server-side imagegen/videogen surface. The browser only ever
// sees provider names and model lists — baseUrls and API keys stay in the
// server config, per the project's "browser never holds provider secrets"
// boundary.

/** Per-model capabilities as resolved by the server's config loader. */
export interface ImagegenModelInfo {
  id: string
  /**
   * The endpoint surface this model speaks. Absent only when talking to a
   * server that predates the field; the 换源重绘 steering falls back to the
   * model-id prefix in that case.
   */
  dialect?: string
  sizes: string[]
  /** When sizes is empty: the upstream always returns one fixed ratio. */
  fixedSizeNote: string | null
  /** Whether this model accepts a reference image (image-to-image). */
  edit: boolean
  /** Operator hint: expected latency, quirks. Free-form, may be null. */
  note: string | null
  /** Upstream budget the server allows one request for this model, in ms. */
  timeoutMs: number
}

export interface ImagegenProviderInfo {
  id: string
  name: string
  /** All model ids of this provider (legacy flat list, includes video ids). */
  models: string[]
  defaultModel: string
  sizes: string[]
  /** When sizes is empty: the upstream always returns one fixed ratio. */
  fixedSizeNote: string | null
  /** Models of this provider that also accept a reference image; [] means none. */
  editModels: string[]
  /** The image→text caption model behind the 换源重绘 prefill; absent = not offered. */
  captionModel?: string
  /** The image models with their resolved capabilities (video excluded). */
  modelInfos: ImagegenModelInfo[]
  /** Upstream budget the server allows one request, in ms. */
  timeoutMs: number
}

export interface VideogenModelInfo {
  id: string
  note: string | null
  timeoutMs: number
}

export interface VideogenProviderInfo {
  id: string
  name: string
  models: VideogenModelInfo[]
  defaultModel: string
}

export interface ImagegenCapabilities {
  enabled: boolean
  providers: ImagegenProviderInfo[]
  /** Present only when at least one provider declares video models. */
  video?: { providers: VideogenProviderInfo[] }
}

export interface ImagegenQuota {
  used: number
  cap: number
  remaining: number
}

export interface GeneratedImagePayload {
  mimeType: string
  base64: string
  /** As decoded from the returned container; absent when the format is unknown. */
  width?: number
  height?: number
}

export interface ImagegenResponse {
  provider: string
  model: string
  images: GeneratedImagePayload[]
  revisedPrompt?: string
  /** The `size` that was asked for, echoed back so the UI can spot a model that ignored it. */
  requestedSize?: string
  /** Requested images the upstream did not produce (they still counted against the cap). */
  failed?: number
}

/** Not every capabilities payload needs `failed` (older shapes omit it). */
export const imagegenFailedCount = (data: ImagegenResponse): number => Math.max(0, data.failed ?? 0)

/**
 * Groups a provider's image models into display families, in first-appearance
 * order. The grouping is purely presentational — model ids stay the wire
 * format — but raw id strings in a flat list stop being readable once a
 * gateway exposes more than a handful of models.
 */
export function groupImagegenModels(models: ImagegenModelInfo[]): { family: string; models: ImagegenModelInfo[] }[] {
  const familyOf = (id: string): string => {
    if (id.startsWith('gpt-image')) return 'GPT Image'
    if (id.startsWith('grok-imagine')) return 'Grok Imagine'
    if (id.startsWith('gemini')) return 'Gemini'
    if (id.startsWith('nano-banana')) return 'Nano Banana'
    if (id.startsWith('dall-e')) return 'DALL·E'
    if (id.startsWith('seedream')) return 'Seedream'
    if (id.startsWith('flux')) return 'FLUX'
    return '其他模型'
  }
  const groups: { family: string; models: ImagegenModelInfo[] }[] = []
  const byFamily = new Map<string, ImagegenModelInfo[]>()
  for (const model of models) {
    const family = familyOf(model.id)
    const bucket = byFamily.get(family)
    if (bucket) bucket.push(model)
    else {
      const bucket: ImagegenModelInfo[] = [model]
      byFamily.set(family, bucket)
      groups.push({ family, models: bucket })
    }
  }
  return groups
}

/**
 * Resolves the provider/model pair a reopened modal should start from. Both
 * halves are validated against the *resolved* provider: a model name that
 * survived a config change but no longer belongs to the provider it would be
 * sent with would otherwise turn every generation into a 400 until the page is
 * reloaded. Image modality only — video models live in the video section and
 * must never become the picker's default.
 */
export function resolveImagegenSelection(
  providers: ImagegenProviderInfo[],
  prevProviderId: string,
  prevModel: string,
): { providerId: string; model: string } | null {
  const first = providers.find((p) => p.modelInfos.length > 0)
  if (!first) return null
  const provider = providers.find((p) => p.id === prevProviderId && p.modelInfos.length > 0) ?? first
  const modelInfos = provider.modelInfos
  const model = modelInfos.some((m) => m.id === prevModel) ? prevModel : (provider.defaultModel ?? modelInfos[0].id)
  // A default that points at a video id (or a stale id) falls back to the
  // first image model the provider actually offers.
  return { providerId: provider.id, model: modelInfos.some((m) => m.id === model) ? model : modelInfos[0].id }
}

/**
 * 换源重绘 steering: the whole point of regenerating without a reference is to
 * escape the pixel-level SynthID the reference carried — and a gemini-dialect
 * model embeds a fresh SynthID into every render, silently defeating the
 * route. When the restored selection is such a model (detected by dialect,
 * falling back to the id prefix for servers that predate the field), move to
 * the first pickable non-Google model. Returns null when no change is needed,
 * or when nothing non-Google exists (keeping the user's selection beats an
 * empty picker).
 */
export function steerSelectionAwayFromGoogleDialect(
  providers: ImagegenProviderInfo[],
  current: { providerId: string; model: string },
): { providerId: string; model: string } | null {
  const isGoogleModel = (info: ImagegenModelInfo | undefined): boolean => {
    if (!info) return false
    return info.dialect === 'gemini' || info.id.startsWith('gemini') || info.id.startsWith('nano-banana')
  }
  const currentInfo = providers
    .find((p) => p.id === current.providerId)
    ?.modelInfos.find((m) => m.id === current.model)
  if (!isGoogleModel(currentInfo)) return null
  for (const provider of providers) {
    const target = provider.modelInfos.find((m) => !isGoogleModel(m))
    if (target) return { providerId: provider.id, model: target.id }
  }
  return null
}

export async function fetchImagegenCapabilities(): Promise<ImagegenCapabilities | null> {
  try {
    const res = await fetch('/api/v1/imagegen/capabilities', { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as ImagegenCapabilities
  } catch {
    return null
  }
}

/** Remaining daily image budget for this client; null when unavailable. */
export async function fetchImagegenQuota(): Promise<ImagegenQuota | null> {
  try {
    const res = await fetch('/api/v1/imagegen/quota', { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as ImagegenQuota
  } catch {
    return null
  }
}

/** Remaining daily video budget for this client; null when unavailable. */
export async function fetchVideogenQuota(): Promise<ImagegenQuota | null> {
  try {
    const res = await fetch('/api/v1/videogen/quota', { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as ImagegenQuota
  } catch {
    return null
  }
}

export interface GenerateImageParams {
  provider: string
  model: string
  prompt: string
  size?: string
  n?: number
  /** Image-to-image reference; only sent for models the server lists as edit-capable. */
  image?: { mimeType: string; base64: string }
  /** Gives up slightly after the server's own upstream budget would. */
  timeoutMs?: number
}

export interface GenerateImageOptions {
  signal?: AbortSignal
}

export async function generateImage(
  params: GenerateImageParams,
  options: GenerateImageOptions = {},
): Promise<{ ok: boolean; data?: ImagegenResponse; message?: string }> {
  // Without a client-side deadline the request would hang for as long as the
  // edge keeps it open (~100s), so the spinner could outlive the server's own
  // give-up point. The signal is combined with any caller one.
  const signals = [options.signal, typeof params.timeoutMs === 'number' ? AbortSignal.timeout(params.timeoutMs) : undefined]
    .filter((s): s is AbortSignal => !!s)
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  const { timeoutMs: _timeoutMs, ...body } = params
  try {
    const res = await fetch('/api/v1/imagegen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
      signal,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, message: data?.message || `生成失败（HTTP ${res.status}）` }
    }
    return { ok: true, data: data as ImagegenResponse }
  } catch (err: unknown) {
    if (options.signal?.aborted) return { ok: false, message: '已取消生成' }
    // An aborted fetch rejects with AbortError; a deadline expiry is a TimeoutError.
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, message: timedOut ? '生成超时，请稍后重试' : '网络连接失败' }
  }
}

export interface GenerateVideoParams {
  provider: string
  model: string
  prompt: string
  timeoutMs?: number
}

export interface VideoResult {
  blob: Blob
  mimeType: string
  model: string
  bytes: number
}

export async function generateVideo(
  params: GenerateVideoParams,
  options: GenerateImageOptions = {},
): Promise<{ ok: boolean; data?: VideoResult; message?: string }> {
  const signals = [options.signal, typeof params.timeoutMs === 'number' ? AbortSignal.timeout(params.timeoutMs) : undefined]
    .filter((s): s is AbortSignal => !!s)
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  const { timeoutMs: _timeoutMs, ...body } = params
  try {
    const res = await fetch('/api/v1/videogen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      // Errors stay JSON even though success is binary.
      const data = await res.json().catch(() => null) as { message?: string } | null
      return { ok: false, message: data?.message || `视频生成失败（HTTP ${res.status}）` }
    }
    const blob = await res.blob()
    if (blob.size === 0) return { ok: false, message: '上游返回了空视频' }
    return {
      ok: true,
      data: {
        blob,
        // The server sniffs the container; the header is the honest answer.
        mimeType: res.headers.get('X-Video-Mime') ?? blob.type ?? 'video/mp4',
        model: res.headers.get('X-Video-Model') ?? params.model,
        bytes: blob.size,
      },
    }
  } catch (err: unknown) {
    if (options.signal?.aborted) return { ok: false, message: '已取消生成' }
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, message: timedOut ? '视频生成超时，请稍后重试' : '网络连接失败' }
  }
}

export function base64ToFile(image: GeneratedImagePayload, index: number): File {
  const bytes = Uint8Array.from(atob(image.base64), (ch) => ch.charCodeAt(0))
  const ext = image.mimeType.split('/')[1] ?? 'png'
  return new File([bytes], `ai-generated-${Date.now()}-${index + 1}.${ext}`, { type: image.mimeType })
}

export interface CaptionImageParams {
  image: { mimeType: string; base64: string }
  /** Gives up slightly after the server's own upstream budget would. */
  timeoutMs?: number
}

/**
 * Asks the server to describe an image in text. This is the 换源重绘 prefill:
 * the description feeds a fresh text-to-image generation with *no* reference,
 * which is the only regeneration route that clears the pixel-level SynthID
 * trace (the reference-conditioned one keeps it, per the official verdicts).
 * Never charged against the imagegen daily cap.
 */
export async function captionImage(
  params: CaptionImageParams,
  options: GenerateImageOptions = {},
): Promise<{ ok: boolean; data?: { provider: string; model: string; caption: string }; message?: string }> {
  const signals = [options.signal, typeof params.timeoutMs === 'number' ? AbortSignal.timeout(params.timeoutMs) : undefined]
    .filter((s): s is AbortSignal => !!s)
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  try {
    const res = await fetch('/api/v1/imagegen/caption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(params.image),
      signal,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, message: data?.message || `图片描述失败（HTTP ${res.status}）` }
    }
    return { ok: true, data: data as { provider: string; model: string; caption: string } }
  } catch (err: unknown) {
    if (options.signal?.aborted) return { ok: false, message: '已取消' }
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, message: timedOut ? '描述超时，请稍后重试' : '网络连接失败' }
  }
}
