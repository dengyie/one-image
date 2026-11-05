// Client for the server-side imagegen surface. The browser only ever sees
// provider names and model lists — baseUrls and API keys stay in the server
// config, per the project's "browser never holds provider secrets" boundary.

export interface ImagegenProviderInfo {
  id: string
  name: string
  models: string[]
  defaultModel: string
  sizes: string[]
  /** When sizes is empty: the upstream always returns one fixed ratio. */
  fixedSizeNote: string | null
  /** Models of this provider that also accept a reference image; [] means none. */
  editModels: string[]
  /** Upstream budget the server allows one request, in ms. */
  timeoutMs: number
}

export interface ImagegenCapabilities {
  enabled: boolean
  providers: ImagegenProviderInfo[]
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
 * Resolves the provider/model pair a reopened modal should start from. Both
 * halves are validated against the *resolved* provider: a model name that
 * survived a config change but no longer belongs to the provider it would be
 * sent with would otherwise turn every generation into a 400 until the page is
 * reloaded.
 */
export function resolveImagegenSelection(
  providers: ImagegenProviderInfo[],
  prevProviderId: string,
  prevModel: string,
): { providerId: string; model: string } | null {
  const first = providers[0]
  if (!first) return null
  const provider = providers.find((p) => p.id === prevProviderId) ?? first
  const model = provider.models.includes(prevModel) ? prevModel : (provider.defaultModel ?? provider.models[0])
  return { providerId: provider.id, model }
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

export interface GenerateImageParams {
  provider: string
  model: string
  prompt: string
  size?: string
  n?: number
  /** Image-to-image reference; only sent for models the server lists in editModels. */
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

export function base64ToFile(image: GeneratedImagePayload, index: number): File {
  const bytes = Uint8Array.from(atob(image.base64), (ch) => ch.charCodeAt(0))
  const ext = image.mimeType.split('/')[1] ?? 'png'
  return new File([bytes], `ai-generated-${Date.now()}-${index + 1}.${ext}`, { type: image.mimeType })
}
