import { Agent } from 'undici'
import type { ImagegenProviderConfig } from './imagegen-config'
import { sniffBase64Image } from './image-meta'

// - "openai-images": POST {baseUrl}/images/generations — OpenAI gpt-image-*,
//   xAI grok-2-image*, and OpenAI-compatible aggregators (new-api etc., which
//   also front Gemini/DALL-E style models). With a reference image the call
//   moves to POST {baseUrl}/images/edits (multipart).
// - "openai-chat-image": POST {baseUrl}/chat/completions — models an
//   aggregator only exposes on its chat surface and that answer with the
//   produced file inside the message (markdown/`images[]`), e.g. xAI
//   grok-imagine-* behind new-api. A reference image becomes a multimodal
//   message part.
// - "gemini": POST {baseUrl}/v1beta/models/{model}:generateContent — Google
//   Generative Language API image-out models, direct or behind a gateway. A
//   reference image becomes an `inlineData` part; the reply's image arrives as
//   an `inlineData` part (native Google) or as a markdown data:/http URL inside
//   a text part (gateway envelope), and both are accepted.
//
// Image-to-image is only offered for models an operator listed in `editModels`,
// because a model that does not accept pixels answers with a text refusal
// or a 5xx only after the upstream was paid for.

export interface GeneratedImage {
  mimeType: string
  base64: string
  // Read from the returned container, never from the requested `size`: models
  // routinely ignore it (gpt-image answered 1254×1254 for 1024×1024), and
  // reporting the request back would be a lie.
  width?: number
  height?: number
}

export interface ImageInput {
  mimeType: string
  base64: string
}

export interface ImagegenParams {
  model: string
  prompt: string
  n: number
  size?: string
  // Image-to-image reference. Only models the operator listed in `editModels`
  // ever receive one; the route rejects the rest before any upstream spend.
  image?: ImageInput
}

export interface ImagegenResult {
  images: GeneratedImage[]
  revisedPrompt?: string
  // Requested images that no fan-out call produced (already counted as spend).
  failed?: number
}

export class ImagegenUpstreamError extends Error {
  readonly status: number
  readonly upstreamStatus: number

  constructor(message: string, upstreamStatus: number, status: number) {
    super(message)
    this.name = 'ImagegenUpstreamError'
    this.upstreamStatus = upstreamStatus
    this.status = status
  }
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
// base64 inflates by 4/3, so 32 MiB of image ≈ 44 MB of characters.
const MAX_B64_JSON_LENGTH = 44_000_000

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

// The download URL comes from the upstream response body, i.e. from data an
// upstream operator does not fully control (aggregators echo model-provider
// URLs). Guard the server-side fetch: https for anything that leaves the
// operator's own host, no loopback/private hosts, and the provider key must
// never travel to a host other than the configured baseUrl.
export function assertSafeImageUrl(rawUrl: string, provider: ImagegenProviderConfig): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ImagegenUpstreamError('上游返回的图片地址无法解析', 0, 502)
  }
  const sameHost = url.host === new URL(provider.baseUrl).host
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && sameHost)) {
    throw new ImagegenUpstreamError(`上游返回了不被允许的图片地址（${url.protocol}//${url.host}）`, 0, 502)
  }
  if (isPrivateHost(url.hostname)) {
    throw new ImagegenUpstreamError('上游返回了指向内网/回环地址的图片链接，已拒绝', 0, 502)
  }
  return url
}

// WHATWG URL keeps brackets on IPv6 hostnames and normalizes mapped v4 to
// hex (https://[::ffff:127.0.0.1]/ -> "[::ffff:7f00:1]"), so the guard has to
// strip brackets and understand v6 forms instead of string-matching the
// dotted shape.
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().startsWith('[')
    ? hostname.toLowerCase().slice(1, hostname.toLowerCase().length - 1)
    : hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true
  if (host.includes(':')) return isPrivateV6(host)
  if (host === '0.0.0.0') return true
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) return isPrivateV4Octets(Number(v4[1]), Number(v4[2]))
  return false
}

function isPrivateV4Octets(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0 || a === 169 || a === 192) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return a >= 224
}

function isPrivateV6(host: string): boolean {
  if (host === '::' || host === '::1') return true
  if (host.startsWith('fe80:')) return true
  if (host.startsWith('fc') || host.startsWith('fd')) return true
  // IPv4-mapped: ::ffff:a.b.c.d or the URL-normalized hex ::ffff:7f00:1.
  if (host.startsWith('::ffff:')) {
    const tail = host.slice(7)
    if (tail.includes('.')) return isPrivateHost(tail)
    const groups = tail.split(':')
    if (groups.length === 2) {
      const hi = Number.parseInt(groups[0], 16)
      const lo = Number.parseInt(groups[1], 16)
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateV4Octets((hi >> 8) & 255, hi & 255)
      }
    }
  }
  return false
}

async function readUpstreamError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    if (typeof parsed.error === 'string') return truncate(parsed.error, 300)
    const message = parsed.error?.message ?? parsed.message
    if (typeof message === 'string' && message.length > 0) return truncate(message, 300)
  } catch {
    // fall through to raw text
  }
  return truncate(text, 300) || `HTTP ${response.status}`
}

function clientStatusFor(upstreamStatus: number): number {
  // Upstream 4xx is normalized to 502: model-level errors (unsupported size,
  // unknown upstream model) are not something the client can fix, and the
  // operator's key/quota wording must not become a client-facing contract.
  // Only 429 propagates so clients can back off.
  if (upstreamStatus === 429) return 429
  return 502
}

// A media origin rewritten to a loopback/mesh address must be reached
// directly. The server sets a global ProxyAgent from HTTPS_PROXY for its
// public upstreams, and routing 127.0.0.1 through that proxy depends on the
// proxy's own loopback policy — so private origins get their own direct agent.
const directDispatcher = new Agent()

// Fan-out concurrency for the one-image-per-call dialects. Above this, extra
// parallel calls add upstream pressure without shortening the wall clock, and
// n itself is capped at 4 by the route.
const FANOUT_LIMIT = 3

async function fetchImageBytes(url: URL, provider: ImagegenProviderConfig, signal: AbortSignal, fetchImpl: typeof fetch): Promise<GeneratedImage> {
  // The key stays on the operator's own upstream host; third-party CDN hosts
  // and the media origin get an unauthenticated download.
  const apiKey = url.host === new URL(provider.baseUrl).host ? provider.apiKey : null
  const response = await fetchImpl(url.toString(), {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal,
    ...(isPrivateHost(url.hostname) ? { dispatcher: directDispatcher } : {}),
  } as RequestInit & { dispatcher?: Agent })
  if (!response.ok) {
    throw new ImagegenUpstreamError(`下载生成结果失败：HTTP ${response.status}`, response.status, 502)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new ImagegenUpstreamError('生成结果超过 32MB 上限', 0, 502)
  }
  return withImageMeta(Buffer.from(buffer).toString('base64'), mimeOf(response.headers.get('content-type')))
}

function mimeOf(contentType: string | null | undefined): string {
  const mime = contentType?.split(';')[0]?.trim() ?? ''
  return mime.startsWith('image/') ? mime : 'image/png'
}

// Every adapter funnels its result through here so the reported size is the
// size of the bytes we are actually handing back. The container wins over the
// declared mime as well: `b64_json` has no content-type, and a few upstreams
// label a JPEG as PNG.
function withImageMeta(base64: string, declaredMime: string): GeneratedImage {
  const meta = sniffBase64Image(base64)
  return {
    mimeType: meta?.mimeType ?? declaredMime,
    base64,
    ...(meta ? { width: meta.width, height: meta.height } : {}),
  }
}

/**
 * Runs `task` for 0..count-1 with at most `limit` in flight and never rejects.
 * A settled array keeps input order, which matters for multi-image batches.
 */
async function mapConcurrent<T>(
  count: number,
  limit: number,
  task: (index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(count)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= count) return
      try {
        results[index] = { status: 'fulfilled', value: await task(index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker))
  return results
}

/**
 * Fan-out for the dialects that produce one file per call. Parallel calls keep
 * n=4 inside the ~100s edge budget (one slow call would otherwise multiply the
 * wall clock), and allSettled keeps the successes when one call fails — the
 * operator already paid for them. `failed` is what is missing from the request,
 * not the number of rejected calls, so it reads correctly in the UI.
 */
async function collectFanOut(
  count: number,
  limit: number,
  task: (index: number) => Promise<GeneratedImage[]>,
): Promise<ImagegenResult> {
  const settled = await mapConcurrent(count, limit, task)
  const images: GeneratedImage[] = []
  let firstError: unknown
  for (const result of settled) {
    if (result.status === 'fulfilled') images.push(...result.value)
    else firstError ??= result.reason
  }
  const capped = images.slice(0, count)
  if (capped.length === 0) {
    throw firstError ?? new ImagegenUpstreamError('上游返回中没有图片数据', 0, 502)
  }
  const failed = count - capped.length
  return failed > 0 ? { images: capped, failed } : { images: capped }
}

// Aggregators that front a self-hosted backend hand back the file URL from
// that backend's point of view — "*my* localhost:8000" — which resolves to
// nothing for the caller. When the operator declared where the backend is
// actually reachable, re-point it there. Only the path and query survive: the
// origin comes from operator config, never from the response, so a bad or
// hostile upstream cannot steer the fetch to a host of its choosing.
export function resolveMediaUrl(rawUrl: string, provider: ImagegenProviderConfig): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ImagegenUpstreamError('上游返回了无法解析的图片地址', 0, 502)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImagegenUpstreamError(`上游返回了不受支持的图片地址（${url.protocol}）`, 0, 502)
  }
  if (!isPrivateHost(url.hostname)) return assertSafeImageUrl(rawUrl, provider)
  if (!provider.mediaOrigin) {
    throw new ImagegenUpstreamError('上游返回了指向内网/回环地址的图片链接，且未配置 mediaOrigin，已拒绝', 0, 502)
  }
  const origin = new URL(provider.mediaOrigin)
  // Assign path/search on a URL that already carries the operator's origin
  // instead of resolving a relative reference: a pathname like "//evil.example"
  // is protocol-relative and would otherwise swap in the upstream's host.
  const target = new URL(origin.origin)
  target.pathname = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`
  target.search = url.search
  if (target.host !== origin.host) {
    throw new ImagegenUpstreamError('上游返回的图片地址试图跳出 mediaOrigin，已拒绝', 0, 502)
  }
  return target
}

interface OpenAIImagesResponse {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[]
  error?: { message?: string }
}

async function readOpenAIImagesPayload(response: Response): Promise<OpenAIImagesResponse | null> {
  return (await response.json().catch(() => null)) as OpenAIImagesResponse | null
}

function extensionOf(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

// Both the generation and the edit surface answer with `data[]`; decoding and
// the "nothing usable" verdict are shared so the two paths cannot drift. The
// result is capped at the requested count — the quota is charged per requested
// image, so a chatty upstream returning extra entries must not hand the client
// more files than it paid for, and an under-delivering one reports `failed`
// just like the fan-out dialects do.
async function collectOpenAIImages(
  payload: OpenAIImagesResponse | null,
  provider: ImagegenProviderConfig,
  n: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<ImagegenResult> {
  const data = payload?.data
  if (!Array.isArray(data) || data.length === 0) {
    throw new ImagegenUpstreamError('上游返回中没有图片数据', 0, 502)
  }
  const images: GeneratedImage[] = []
  for (const item of data) {
    if (images.length >= n) break
    if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
      if (item.b64_json.length > MAX_B64_JSON_LENGTH) {
        throw new ImagegenUpstreamError('生成结果超过 32MB 上限', 0, 502)
      }
      images.push(withImageMeta(item.b64_json, 'image/png'))
    } else if (typeof item.url === 'string' && item.url.length > 0) {
      images.push(await fetchImageBytes(resolveMediaUrl(item.url, provider), provider, signal, fetchImpl))
    }
  }
  if (images.length === 0) {
    throw new ImagegenUpstreamError('上游返回的条目既无 b64_json 也无 url', 0, 502)
  }
  const revisedPrompt = data.find((item) => typeof item.revised_prompt === 'string')?.revised_prompt
  const failed = n - images.length
  return {
    images,
    revisedPrompt: revisedPrompt || undefined,
    ...(failed > 0 ? { failed } : {}),
  }
}

async function generateOpenAIImages(
  provider: ImagegenProviderConfig,
  params: ImagegenParams,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<ImagegenResult> {
  if (params.image) return editOpenAIImages(provider, params, params.image, signal, fetchImpl)
  const body: Record<string, unknown> = { model: params.model, prompt: params.prompt, n: params.n }
  if (params.size) body.size = params.size
  const response = await fetchImpl(`${provider.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    throw new ImagegenUpstreamError(await readUpstreamError(response), response.status, clientStatusFor(response.status))
  }
  return collectOpenAIImages(await readOpenAIImagesPayload(response), provider, params.n, signal, fetchImpl)
}

// The edit surface answers with the same { data: [...] } envelope as
// generations. The OpenAI form takes the reference as multipart/form-data:
// the boundary comes from FormData itself, and a hand-written Content-Type
// would drop it so the upstream would see a single unparseable field. The
// xAI upstream instead wants a JSON body with the reference as an embedded
// data URL, and a gateway (new-api) that fronts it answers the multipart form
// with "no channel for this model" — so the dialect comes from config.
async function editOpenAIImages(
  provider: ImagegenProviderConfig,
  params: ImagegenParams,
  image: ImageInput,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<ImagegenResult> {
  let body: BodyInit
  let contentType: string | undefined
  const endpoint = `${provider.baseUrl}/images/edits`
  if (provider.editsStyle === 'xai-json') {
    body = JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      n: params.n,
      ...(params.size ? { size: params.size } : {}),
      image: {
        url: `data:${image.mimeType};base64,${image.base64}`,
        type: 'image_url',
      },
    })
    contentType = 'application/json'
  } else {
    const form = new FormData()
    form.set('model', params.model)
    form.set('prompt', params.prompt)
    form.set('n', String(params.n))
    if (params.size) form.set('size', params.size)
    const bytes = new Uint8Array(Buffer.from(image.base64, 'base64'))
    form.set('image', new Blob([bytes], { type: image.mimeType }), `reference.${extensionOf(image.mimeType)}`)
    // Only the key is set by hand: fetch writes the multipart boundary itself.
    body = form
  }
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body,
    signal,
  })
  if (!response.ok) {
    throw new ImagegenUpstreamError(await readUpstreamError(response), response.status, clientStatusFor(response.status))
  }
  return collectOpenAIImages(await readOpenAIImagesPayload(response), provider, params.n, signal, fetchImpl)
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[]
    }
  }[]
  error?: { message?: string }
}

async function generateGemini(
  provider: ImagegenProviderConfig,
  params: ImagegenParams,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<ImagegenResult> {
  let revisedText: string | undefined
  // generateContent has no per-request image count; n>1 fans out into
  // parallel calls (bounded by the pool) so n stays inside the edge timeout.
  const generateOnce = async (): Promise<GeneratedImage[]> => {
    const parts: Record<string, unknown>[] = [{ text: params.prompt }]
    if (params.image) parts.push({ inlineData: { mimeType: params.image.mimeType, data: params.image.base64 } })
    const response = await fetchImpl(`${provider.baseUrl}/v1beta/models/${encodeURIComponent(params.model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': provider.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        ...(provider.generationConfig ?? {}),
      }),
      signal,
    })
    if (!response.ok) {
      throw new ImagegenUpstreamError(await readUpstreamError(response), response.status, clientStatusFor(response.status))
    }
    const payload = (await response.json().catch(() => null)) as GeminiResponse | null
    const out = payload?.candidates?.[0]?.content?.parts ?? []
    let found = false
    const produced: GeneratedImage[] = []
    // Gateways in front of Gemini often unwrap the returned image into a text
    // part as markdown/HTML around a data: or http(s) URL instead of an
    // `inlineData` part; collect those refs and resolve them the same way the
    // chat surface does.
    const refs: string[] = []
    for (const part of out) {
      if (part.inlineData?.data) {
        produced.push(withImageMeta(part.inlineData.data, part.inlineData.mimeType ?? 'image/png'))
        found = true
      } else if (typeof part.text === 'string' && part.text.length > 0) {
        const refsInText = extractChatImageRefs({ content: part.text })
        if (refsInText.length > 0) refs.push(...refsInText)
        else if (!revisedText) revisedText = part.text
      }
    }
    if (!found && refs.length > 0) {
      // The quota is charged per requested image, so a prompt-injected or
      // chatty envelope listing more refs than asked for must not turn into
      // that many server-side downloads.
      for (const ref of refs.slice(0, params.n)) {
        produced.push(
          ref.startsWith('data:')
            ? decodeDataUrl(ref)
            : await fetchImageBytes(resolveMediaUrl(ref, provider), provider, signal, fetchImpl),
        )
      }
      found = produced.length > 0
    }
    if (!found) {
      // Say what the model actually replied: a 200 with text-only parts is how
      // a missing `responseModalities` config, a safety refusal and an
      // image-incapable model all look from here.
      const hint = revisedText ? `：模型回复「${truncate(revisedText, 120)}」` : '（可能被安全策略拦截、缺少 responseModalities 配置或模型不支持生图）'
      throw new ImagegenUpstreamError(`上游返回中没有图片数据${hint}`, 0, 502)
    }
    return produced
  }
  const result = await collectFanOut(params.n, FANOUT_LIMIT, generateOnce)
  return { ...result, revisedPrompt: revisedText }
}

// Aggregators expose some image models only on the chat surface: the request
// is an ordinary completion and the produced file comes back inside the
// message, either as markdown/`<img>` in the text or as an `images[]` entry.
// There is no per-request count and no size parameter, and an editing request
// sends the reference alongside the prompt as a multimodal message, which the
// same surface accepts.
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi

interface ChatMessage {
  content?: unknown
  images?: unknown
}

export function extractChatImageRefs(message: ChatMessage): string[] {
  const refs: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    if (/^(https?:\/\/|data:image\/)/i.test(trimmed) && !refs.includes(trimmed)) refs.push(trimmed)
  }
  const content = message.content
  if (typeof content === 'string') {
    for (const match of content.matchAll(MARKDOWN_IMAGE)) add(match[1])
    for (const match of content.matchAll(HTML_IMAGE)) add(match[1])
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object') {
        const typed = part as { type?: unknown; image_url?: unknown; text?: unknown }
        if (typed.type === 'image_url') {
          const url = typed.image_url
          add(typeof url === 'string' ? url : (url as { url?: unknown })?.url)
        }
      }
    }
  }
  if (Array.isArray(message.images)) {
    for (const entry of message.images) {
      if (typeof entry === 'string') add(entry)
      else if (entry && typeof entry === 'object') {
        const item = entry as { url?: unknown; image_url?: unknown; b64_json?: unknown }
        if (typeof item.b64_json === 'string' && item.b64_json.length > 0) add(`data:image/png;base64,${item.b64_json}`)
        else if (typeof item.image_url === 'string') add(item.image_url)
        else if (item.image_url && typeof item.image_url === 'object') add((item.image_url as { url?: unknown }).url)
        else add(item.url)
      }
    }
  }
  return refs
}

function decodeDataUrl(ref: string): GeneratedImage {
  const match = ref.match(/^data:([^;,]+)?(;base64)?,(.*)$/is)
  if (!match || !match[2]) {
    throw new ImagegenUpstreamError('上游返回了无法解码的内联图片', 0, 502)
  }
  const mimeType = match[1] && match[1].startsWith('image/') ? match[1] : 'image/png'
  const base64 = match[3].replace(/\s+/g, '')
  if (base64.length > MAX_B64_JSON_LENGTH) {
    throw new ImagegenUpstreamError('生成结果超过 32MB 上限', 0, 502)
  }
  return withImageMeta(base64, mimeType)
}

export function buildChatUserMessage(params: ImagegenParams): { role: 'user'; content: unknown } {
  const image = params.image
  if (!image) return { role: 'user', content: params.prompt }
  return {
    role: 'user',
    content: [
      { type: 'text', text: params.prompt },
      { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
    ],
  }
}

async function generateOpenAIChatImage(
  provider: ImagegenProviderConfig,
  params: ImagegenParams,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<ImagegenResult> {
  const generateOnce = async (): Promise<GeneratedImage[]> => {
    const response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: [buildChatUserMessage(params)],
        stream: false,
      }),
      signal,
    })
    if (!response.ok) {
      throw new ImagegenUpstreamError(await readUpstreamError(response), response.status, clientStatusFor(response.status))
    }
    const payload = (await response.json().catch(() => null)) as
      | { choices?: { message?: ChatMessage }[]; error?: { message?: string } }
      | null
    const message = payload?.choices?.[0]?.message
    const refs = (message ? extractChatImageRefs(message) : []).slice(0, params.n)
    if (refs.length === 0) {
      throw new ImagegenUpstreamError('上游返回中没有图片数据（模型可能只回了文字或拒绝了参考图）', 0, 502)
    }
    const produced: GeneratedImage[] = []
    for (const ref of refs) {
      produced.push(ref.startsWith('data:')
        ? decodeDataUrl(ref)
        : await fetchImageBytes(resolveMediaUrl(ref, provider), provider, signal, fetchImpl))
    }
    return produced
  }
  return collectFanOut(params.n, FANOUT_LIMIT, generateOnce)
}

export function generateImages(
  provider: ImagegenProviderConfig,
  params: ImagegenParams,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<ImagegenResult> {
  if (!provider.models.includes(params.model)) {
    return Promise.reject(new ImagegenUpstreamError(`模型 ${params.model} 不在该服务的可用列表中`, 0, 400))
  }
  // Defence in depth: the route refuses image input for models outside
  // `editModels`, but an adapter must never quietly send the reference to a
  // model that was not declared able to accept it.
  if (params.image && !provider.editModels?.includes(params.model)) {
    return Promise.reject(new ImagegenUpstreamError(`模型 ${params.model} 不接受参考图`, 0, 400))
  }
  if (provider.type === 'gemini') {
    return generateGemini(provider, params, signal, fetchImpl)
  }
  if (provider.type === 'openai-chat-image') {
    return generateOpenAIChatImage(provider, params, signal, fetchImpl)
  }
  return generateOpenAIImages(provider, params, signal, fetchImpl)
}
