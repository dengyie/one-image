import { readFileSync } from 'node:fs'

// Image generation providers are configured server-side only: the browser
// learns provider names and model lists from the capabilities endpoint and
// never sees a baseUrl or key, keeping the "browser never holds provider
// secrets" boundary of the project intact. Configuration arrives through
// ONEIMAGE_IMAGE_PROVIDERS (inline JSON) or ONEIMAGE_IMAGE_PROVIDERS_FILE
// (path to a JSON file, the recommended form on pxed where it can sit next
// to the 0600 .env).

export type ImagegenProviderType = 'openai-images' | 'openai-chat-image' | 'gemini'

export interface ImagegenProviderConfig {
  id: string
  name: string
  type: ImagegenProviderType
  baseUrl: string
  apiKey: string
  models: string[]
  defaultModel?: string
  sizes?: string[]
  timeoutMs?: number
  // Gemini only: merged verbatim into the generateContent body, e.g.
  // { responseModalities: ["TEXT", "IMAGE"] } for preview models that
  // require it.
  generationConfig?: Record<string, unknown>
  // Aggregators that front a self-hosted image backend often return the
  // produced file as a URL built from *that backend's* own view of itself —
  // typically a loopback address that is meaningless to anyone else. The
  // operator declares the origin they can actually reach it on, and the
  // adapter re-points such URLs there (path and query preserved, origin
  // replaced wholesale, so this can never redirect a fetch elsewhere).
  mediaOrigin?: string
}

export interface ImagegenConfigResult {
  providers: ImagegenProviderConfig[]
  warnings: string[]
}

const PROVIDER_TYPES: ImagegenProviderType[] = ['openai-images', 'openai-chat-image', 'gemini']

export const IMAGEGEN_CONFIG_ENV = 'ONEIMAGE_IMAGE_PROVIDERS'
export const IMAGEGEN_CONFIG_FILE_ENV = 'ONEIMAGE_IMAGE_PROVIDERS_FILE'

function parseConfigText(text: string, source: string, warnings: string[]): ImagegenProviderConfig[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    warnings.push(`imagegen config ${source} is not valid JSON; image generation stays disabled`)
    return []
  }
  return validateProviders(raw, source, warnings)
}

function validateProviders(raw: unknown, source: string, warnings: string[]): ImagegenProviderConfig[] {
  const providersRaw = (raw as { providers?: unknown })?.providers
  if (!Array.isArray(providersRaw)) {
    warnings.push(`imagegen config ${source} must be {"providers":[...]}; image generation stays disabled`)
    return []
  }

  const valid: ImagegenProviderConfig[] = []
  const seenIds = new Set<string>()
  providersRaw.forEach((entry, index) => {
    const label = `${source} providers[${index}]`
    const p = entry as Partial<ImagegenProviderConfig>
    if (typeof p.id !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(p.id)) {
      warnings.push(`${label}: id must be a short alphanumeric slug; skipped`)
      return
    }
    if (seenIds.has(p.id)) {
      warnings.push(`${label}: duplicate id "${p.id}"; skipped`)
      return
    }
    if (!PROVIDER_TYPES.includes(p.type as ImagegenProviderType)) {
      warnings.push(`${label} (${p.id}): type must be one of ${PROVIDER_TYPES.join('|')}; skipped`)
      return
    }
    if (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl)) {
      warnings.push(`${label} (${p.id}): baseUrl must be an http(s) URL; skipped`)
      return
    }
    if (typeof p.apiKey !== 'string' || p.apiKey.trim().length === 0) {
      warnings.push(`${label} (${p.id}): apiKey is required; skipped`)
      return
    }
    if (!Array.isArray(p.models) || p.models.length === 0 || p.models.some((m) => typeof m !== 'string' || m.trim().length === 0)) {
      warnings.push(`${label} (${p.id}): models must be a non-empty string array; skipped`)
      return
    }
    const models = p.models.map((m) => m.trim()).filter((m) => m.length > 0)
    let defaultModel: string | undefined
    if (p.defaultModel !== undefined) {
      if (typeof p.defaultModel === 'string' && models.includes(p.defaultModel)) {
        defaultModel = p.defaultModel
      } else {
        warnings.push(`${label} (${p.id}): defaultModel not in models; falling back to the first model`)
      }
    }
    let sizes: string[] | undefined
    if (p.sizes !== undefined) {
      if (Array.isArray(p.sizes) && p.sizes.every((s) => typeof s === 'string' && s.trim().length > 0)) {
        sizes = p.sizes.map((s) => s.trim())
      } else {
        warnings.push(`${label} (${p.id}): sizes must be a string array; ignoring`)
      }
    }
    let timeoutMs: number | undefined
    if (p.timeoutMs !== undefined) {
      if (typeof p.timeoutMs === 'number' && p.timeoutMs >= 10_000 && p.timeoutMs <= 180_000) {
        timeoutMs = p.timeoutMs
      } else {
        warnings.push(`${label} (${p.id}): timeoutMs must be 10000-180000; using the 90s default`)
      }
    }
    // The Cloudflare edge cuts HTTP around 100s regardless of the origin, so
    // an upstream timeout beyond that would burn provider spend on requests
    // the client can never see. Clamp here instead of trusting the file.
    const effectiveTimeout = Math.min(timeoutMs ?? 90_000, 95_000)

    let generationConfig: Record<string, unknown> | undefined
    if (p.generationConfig !== undefined) {
      if (p.type !== 'gemini') {
        // The passthrough only feeds the gemini generateContent body; keeping
        // it on other types would silently do nothing.
        warnings.push(`${label} (${p.id}): generationConfig 只对 gemini 类型生效，已忽略`)
      } else if (p.generationConfig && typeof p.generationConfig === 'object' && !Array.isArray(p.generationConfig)) {
        generationConfig = p.generationConfig as Record<string, unknown>
      } else {
        warnings.push(`${label} (${p.id}): generationConfig must be an object; ignoring`)
      }
    }

    let mediaOrigin: string | undefined
    if (p.mediaOrigin !== undefined) {
      if (typeof p.mediaOrigin === 'string' && /^https?:\/\/[^\s]+$/.test(p.mediaOrigin.trim())) {
        mediaOrigin = p.mediaOrigin.trim().replace(/\/+$/, '')
      } else {
        warnings.push(`${label} (${p.id}): mediaOrigin must be an http(s) URL; ignoring`)
      }
    }
    seenIds.add(p.id)
    valid.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name.trim().length > 0 ? p.name.trim().slice(0, 64) : p.id,
      type: p.type as ImagegenProviderType,
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      apiKey: p.apiKey.trim(),
      models,
      defaultModel: defaultModel ?? models[0],
      sizes,
      timeoutMs: effectiveTimeout,
      generationConfig,
      mediaOrigin,
    })
  })
  return valid
}

export function loadImagegenConfig(env: NodeJS.ProcessEnv = process.env): ImagegenConfigResult {
  const warnings: string[] = []
  const filePath = env[IMAGEGEN_CONFIG_FILE_ENV]
  const inline = env[IMAGEGEN_CONFIG_ENV]
  if (filePath) {
    if (inline) {
      warnings.push(`both ${IMAGEGEN_CONFIG_FILE_ENV} and ${IMAGEGEN_CONFIG_ENV} are set; the file wins`)
    }
    try {
      const text = readFileSync(filePath, 'utf8')
      return { providers: parseConfigText(text, `file ${filePath}`, warnings), warnings }
    } catch (err: unknown) {
      warnings.push(`imagegen config file ${filePath} could not be read (${err instanceof Error ? err.message : String(err)}); image generation stays disabled`)
      return { providers: [], warnings }
    }
  }
  if (inline) {
    return { providers: parseConfigText(inline, `env ${IMAGEGEN_CONFIG_ENV}`, warnings), warnings }
  }
  return { providers: [], warnings }
}
