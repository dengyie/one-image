import { Agent } from 'undici'
import type { ImagegenProviderConfig } from './imagegen-config'

// Provider adapters for text-to-image. Three upstream dialects cover the
// requested model families:
// - "openai-images": POST {baseUrl}/images/generations — OpenAI gpt-image-*,
//   xAI grok-2-image*, and OpenAI-compatible aggregators (new-api etc., which
//   also front Gemini/DALL-E style models).
// - "openai-chat-image": POST {baseUrl}/chat/completions — models an
//   aggregator only exposes on its chat surface and that answer with the
//   produced file inside the message (markdown/`images[]`), e.g. xAI
//   grok-imagine-* behind new-api.
// - "gemini": POST {baseUrl}/v1beta/models/{model}:generateContent — direct
//   Google Generative Language API image-out models (gemini-2.5-flash-image).

export interface GeneratedImage {
  mimeType: string
  base64: string
}

export interface ImagegenResult {
  images: GeneratedImage[]
  revisedPrompt?: string
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
  return { mimeType: mimeOf(response.headers.get('content-type')), base64: Buffer.from(buffer).toString('base64') }
}

function mimeOf(contentType: string | null | undefined): string {
  const mime = contentType?.split(';')[0]?.trim() ?? ''
  return mime.startsWith('image/') ? mime : 'image/png'
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

async function generateOpenAIImages(
  provider: ImagegenProviderConfig,
  params: { model: string; prompt: string; n: number; size?: string },
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<ImagegenResult> {
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
  const payload = (await response.json().catch(() => null)) as OpenAIImagesResponse | null
  const data = payload?.data
  if (!Array.isArray(data) || data.length === 0) {
    throw new ImagegenUpstreamError('上游返回中没有图片数据', 0, 502)
  }
  const images: GeneratedImage[] = []
  for (const item of data) {
    if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
      if (item.b64_json.length > MAX_B64_JSON_LENGTH) {
        throw new ImagegenUpstreamError('生成结果超过 32MB 上限', 0, 502)
      }
      images.push({ mimeType: 'image/png', base64: item.b64_json })
    } else if (typeof item.url === 'string' && item.url.length > 0) {
      images.push(await fetchImageBytes(resolveMediaUrl(item.url, provider), provider, signal, fetchImpl))
    }
  }
  if (images.length === 0) {
    throw new ImagegenUpstreamError('上游返回的条目既无 b64_json 也无 url', 0, 502)
  }
  const revisedPrompt = data.find((item) => typeof item.revised_prompt === 'string')?.revised_prompt
  return { images, revisedPrompt: revisedPrompt || undefined }
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
  params: { model: string; prompt: string; n: number; size?: string },
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<ImagegenResult> {
  const images: GeneratedImage[] = []
  let revisedText: string | undefined
  // generateContent has no per-request image count; n>1 fans out into
  // sequential calls so the daily cap stays the single spend control.
  for (let i = 0; i < params.n; i++) {
    const response = await fetchImpl(`${provider.baseUrl}/v1beta/models/${encodeURIComponent(params.model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': provider.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
        ...(provider.generationConfig ?? {}),
      }),
      signal,
    })
    if (!response.ok) {
      throw new ImagegenUpstreamError(await readUpstreamError(response), response.status, clientStatusFor(response.status))
    }
    const payload = (await response.json().catch(() => null)) as GeminiResponse | null
    const parts = payload?.candidates?.[0]?.content?.parts ?? []
    let found = false
    for (const part of parts) {
      if (part.inlineData?.data) {
        images.push({
          mimeType: part.inlineData.mimeType ?? 'image/png',
          base64: part.inlineData.data,
        })
        found = true
      } else if (typeof part.text === 'string' && part.text.length > 0 && !revisedText) {
        revisedText = part.text
      }
    }
    if (!found) {
      throw new ImagegenUpstreamError('上游返回中没有图片数据（可能被安全策略拦截或模型不支持生图）', 0, 502)
    }
  }
  return { images, revisedPrompt: revisedText }
}

// Aggregators expose some image models only on the chat surface: the request
// is an ordinary completion and the produced file comes back inside the
// message, either as markdown/`<img>` in the text or as an `images[]` entry.
// There is no per-request count and no size parameter, so n>1 fans out
// sequentially the same way the gemini dialect does.
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
  return { mimeType, base64 }
}

async function generateOpenAIChatImage(
  provider: ImagegenProviderConfig,
  params: { model: string; prompt: string; n: number },
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<ImagegenResult> {
  const images: GeneratedImage[] = []
  for (let i = 0; i < params.n; i++) {
    const response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: 'user', content: params.prompt }],
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
    const refs = message ? extractChatImageRefs(message) : []
    if (refs.length === 0) {
      throw new ImagegenUpstreamError('上游返回中没有图片数据（模型可能只回了文字）', 0, 502)
    }
    for (const ref of refs) {
      images.push(ref.startsWith('data:')
        ? decodeDataUrl(ref)
        : await fetchImageBytes(resolveMediaUrl(ref, provider), provider, signal, fetchImpl))
    }
  }
  return { images }
}

export function generateImages(
  provider: ImagegenProviderConfig,
  params: { model: string; prompt: string; n: number; size?: string },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<ImagegenResult> {
  if (!provider.models.includes(params.model)) {
    return Promise.reject(new ImagegenUpstreamError(`模型 ${params.model} 不在该服务的可用列表中`, 0, 400))
  }
  if (provider.type === 'gemini') {
    return generateGemini(provider, params, signal, fetchImpl)
  }
  if (provider.type === 'openai-chat-image') {
    return generateOpenAIChatImage(provider, params, signal, fetchImpl)
  }
  return generateOpenAIImages(provider, params, signal, fetchImpl)
}
