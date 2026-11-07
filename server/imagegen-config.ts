import { readFileSync } from 'node:fs'

// Image generation providers are configured server-side only: the browser
// learns provider names and model lists from the capabilities endpoint and
// never sees a baseUrl or key, keeping the "browser never holds provider
// secrets" boundary of the project intact. Configuration arrives through
// ONEIMAGE_IMAGE_PROVIDERS (inline JSON) or ONEIMAGE_IMAGE_PROVIDERS_FILE
// (path to a JSON file, the recommended form on pxed where it can sit next
// to the 0600 .env).

// One OpenAI-compatible gateway exposes many models with *different*
// capabilities (endpoint surface, aspect control, reference-image support), so
// every capability below is declared per model and falls back to the
// provider-level fields, which keep their original meaning for string-form
// model entries. A provider `type` is the default dialect for its models;
// `openai-chat-video` exists only as a per-model dialect — video is served by
// its own route and never appears in the image capabilities.
export type ImagegenProviderType = 'openai-images' | 'openai-chat-image' | 'gemini'
export type ImagegenDialect = ImagegenProviderType | 'openai-chat-video'

export interface ImagegenModelSpec {
  id: string
  dialect: ImagegenDialect
  sizes: string[]
  // Only meaningful while `sizes` is empty: some upstreams ignore every aspect
  // request and always return one fixed ratio.
  fixedSizeNote: string | null
  edit: boolean
  editsStyle: 'multipart' | 'xai-json'
  // Upstream model name to use *for image-to-image requests only*. Some
  // backends route generation vs editing by distinct capability-named models
  // (e.g. grok2api: `grok-imagine-image` = text-to-image capability,
  // `grok-imagine-image-edit` = image-edit capability) while the picker keeps
  // a single entry. Absent: the picker model id is sent on the edit surface.
  editModelId?: string
  generationConfig?: Record<string, unknown>
  // Free-form operator hint for the picker: expected latency, quirks.
  note: string | null
  timeoutMs: number
}

export interface ImagegenProviderConfig {
  id: string
  name: string
  type: ImagegenProviderType
  baseUrl: string
  apiKey: string
  models: string[]
  // Normalized per-model capabilities: every entry of `models`, with the
  // provider-level fields folded in as fallbacks. The route, the adapters and
  // the capabilities projection all read from here.
  modelSpecs: ImagegenModelSpec[]
  // Models deliberately kept out of the public picker (no upstream channel
  // yet, or unusable latency). Stored so the config file documents the whole
  // gateway lineup; exposed nowhere in the capabilities.
  disabledModels: { id: string; reason: string }[]
  // Legacy provider-level fields. Still accepted and used as the fallback for
  // string-form model entries; derived fields (`editModels`) stay in sync with
  // the per-model `edit` flags so existing call sites keep working.
  editModels?: string[]
  editsStyle?: 'multipart' | 'xai-json'
  defaultModel?: string
  sizes?: string[]
  fixedSizeNote?: string
  timeoutMs?: number
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
const DIALECTS: ImagegenDialect[] = [...PROVIDER_TYPES, 'openai-chat-video']
const TIMEOUT_CEILING = 95_000

export const IMAGEGEN_CONFIG_ENV = 'ONEIMAGE_IMAGE_PROVIDERS'
export const IMAGEGEN_CONFIG_FILE_ENV = 'ONEIMAGE_IMAGE_PROVIDERS_FILE'

/** Raw per-model entry as written in the config file. */
interface RawModelInput {
  id: string
  dialect?: unknown
  sizes?: unknown
  fixedSizeNote?: unknown
  edit?: unknown
  editsStyle?: unknown
  editModelId?: unknown
  generationConfig?: unknown
  note?: unknown
  timeoutMs?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTimeout(raw: unknown, label: string, warnings: string[]): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'number' && raw >= 10_000 && raw <= 180_000) return raw
  warnings.push(`${label}: timeoutMs must be 10000-180000; using the 90s default`)
  return undefined
}

// The Cloudflare edge cuts HTTP around 100s regardless of the origin, so an
// upstream timeout beyond that would burn provider spend on requests the
// client can never see. Clamp here instead of trusting the file.
function clampTimeout(ms: number): number {
  return Math.min(ms, TIMEOUT_CEILING)
}

function parseStringList(raw: unknown, label: string, warnings: string[]): string[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw) && raw.every((s) => typeof s === 'string' && s.trim().length > 0)) {
    return raw.map((s) => (s as string).trim())
  }
  warnings.push(`${label}: must be a string array; ignoring`)
  return undefined
}

function parseNote(raw: unknown, label: string, warnings: string[]): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim().slice(0, 80)
  warnings.push(`${label}: must be a non-empty string; ignoring`)
  return undefined
}

function parseFixedSizeNote(raw: unknown, label: string, warnings: string[]): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim().slice(0, 80)
  warnings.push(`${label}: fixedSizeNote must be a non-empty string; ignoring`)
  return undefined
}

// fixedSizeNote only replaces the picker when `sizes` is empty; with a picker
// present it can never be shown, so carrying it would be a silent no-op.
function resolveFixedSizeNote(own: string | undefined, sizes: string[]): string | null {
  if (sizes.length > 0) return null
  return own ?? null
}

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
    const p = entry as Partial<ImagegenProviderConfig> & Record<string, unknown>
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
    if (!Array.isArray(p.models) || p.models.length === 0) {
      warnings.push(`${label} (${p.id}): models must be a non-empty array; skipped`)
      return
    }

    // Provider-level fallbacks keep their original meaning for string-form
    // model entries.
    const providerSizes = parseStringList(p.sizes, `${label} (${p.id}) sizes`, warnings)
    const providerNote = parseNote(p.fixedSizeNote, `${label} (${p.id}) fixedSizeNote`, warnings)
    let providerEditsStyle = p.editsStyle === 'multipart' || p.editsStyle === 'xai-json' ? p.editsStyle : undefined
    if (p.editsStyle !== undefined && providerEditsStyle === undefined) {
      warnings.push(`${label} (${p.id}): editsStyle must be "multipart" or "xai-json"; ignoring`)
    } else if (providerEditsStyle !== undefined && p.type !== 'openai-images') {
      // The edits dialect only feeds the openai-images /images/edits branch;
      // on other types it would silently do nothing. A mixed provider that
      // needs the JSON dialect on one model declares it on that model.
      warnings.push(`${label} (${p.id}): editsStyle 只对 openai-images 类型生效，已忽略`)
      providerEditsStyle = undefined
    }
    let providerGenerationConfig = isRecord(p.generationConfig) ? (p.generationConfig as Record<string, unknown>) : undefined
    if (p.generationConfig !== undefined && providerGenerationConfig === undefined) {
      warnings.push(`${label} (${p.id}): generationConfig must be an object; ignoring`)
    } else if (providerGenerationConfig !== undefined && p.type !== 'gemini') {
      // Same reasoning: the passthrough only feeds the gemini generateContent
      // body. Per-model entries win for mixed providers.
      warnings.push(`${label} (${p.id}): generationConfig 只对 gemini 类型生效，已忽略`)
      providerGenerationConfig = undefined
    }
    const providerTimeoutRaw = parseTimeout(p.timeoutMs, `${label} (${p.id})`, warnings)

    const models: string[] = []
    const modelSpecs: ImagegenModelSpec[] = []
    const seenModelIds = new Set<string>()

    const pushSpec = (spec: ImagegenModelSpec, entryLabel: string) => {
      if (seenModelIds.has(spec.id)) {
        warnings.push(`${entryLabel}: duplicate model id "${spec.id}"; skipped`)
        return
      }
      seenModelIds.add(spec.id)
      models.push(spec.id)
      modelSpecs.push(spec)
    }

    p.models.forEach((entry, modelIndex) => {
      const modelLabel = `${label} (${p.id}) models[${modelIndex}]`
      if (typeof entry === 'string') {
        const id = entry.trim()
        if (id.length === 0) {
          warnings.push(`${modelLabel}: model id must not be empty; skipped`)
          return
        }
        pushSpec(
          {
            id,
            dialect: p.type as ImagegenProviderType,
            sizes: providerSizes ?? [],
            fixedSizeNote: resolveFixedSizeNote(providerNote, providerSizes ?? []),
            edit: Array.isArray(p.editModels) && p.editModels.some((e) => typeof e === 'string' && e.trim() === id),
            editsStyle: (p.type as ImagegenProviderType) === 'openai-images' ? providerEditsStyle ?? 'multipart' : 'multipart',
            ...(p.type === 'gemini' && providerGenerationConfig ? { generationConfig: providerGenerationConfig } : {}),
            note: null,
            timeoutMs: clampTimeout(providerTimeoutRaw ?? 90_000),
          },
          modelLabel,
        )
        return
      }
      if (!isRecord(entry)) {
        warnings.push(`${modelLabel}: must be a string or an object; skipped`)
        return
      }
      const m = entry as unknown as RawModelInput
      const id = typeof m.id === 'string' ? m.id.trim() : ''
      if (!/^[A-Za-z0-9._-]{1,96}$/.test(id)) {
        warnings.push(`${modelLabel}: model id must be a non-empty slug (letters/digits/._-); skipped`)
        return
      }
      const dialect = m.dialect === undefined ? (p.type as ImagegenProviderType) : m.dialect
      if (!DIALECTS.includes(dialect as ImagegenDialect)) {
        warnings.push(`${modelLabel} (${id}): dialect must be one of ${DIALECTS.join('|')}; skipped`)
        return
      }
      const isVideo = dialect === 'openai-chat-video'

      let sizes = parseStringList(m.sizes, `${modelLabel} (${id}) sizes`, warnings)
      if (sizes === undefined) sizes = isVideo ? [] : providerSizes ?? []
      if (isVideo && m.sizes !== undefined) {
        warnings.push(`${modelLabel} (${id}): video models take no sizes; ignoring`)
        sizes = []
      }

      // `note` is a per-model declaration only: the provider-level
      // fixedSizeNote already lands in fixedSizeNote for string entries, and
      // leaking it into the model hint would render the same sentence twice.
      const note = parseNote(m.note, `${modelLabel} (${id}) note`, warnings)

      const ownNote = parseFixedSizeNote(m.fixedSizeNote, `${modelLabel} (${id}) fixedSizeNote`, warnings)
      let fixedSizeNote = ownNote
      if (fixedSizeNote === undefined && !isVideo) fixedSizeNote = providerNote
      if (fixedSizeNote !== undefined && sizes.length > 0) {
        // Only a model's own declaration can be a config mistake; an
        // inherited provider-level note is just an unreachable fallback.
        if (ownNote !== undefined) {
          warnings.push(`${modelLabel} (${id}): fixedSizeNote is unused because sizes is set; dropping it`)
        }
        fixedSizeNote = undefined
      }

      let edit = m.edit === undefined ? undefined : m.edit === true
      if (m.edit !== undefined && typeof m.edit !== 'boolean') {
        warnings.push(`${modelLabel} (${id}): edit must be a boolean; ignoring`)
        edit = undefined
      }
      if (isVideo) {
        if (edit === true) warnings.push(`${modelLabel} (${id}): video models take no reference image; ignoring edit`)
        edit = false
      }
      if (edit === undefined) edit = Array.isArray(p.editModels) && p.editModels.some((e) => typeof e === 'string' && e.trim() === id)

      let editsStyle: 'multipart' | 'xai-json' = 'multipart'
      if (!isVideo) {
        const ownStyle = m.editsStyle === 'multipart' || m.editsStyle === 'xai-json' ? m.editsStyle : undefined
        if (m.editsStyle !== undefined && ownStyle === undefined) {
          warnings.push(`${modelLabel} (${id}): editsStyle must be "multipart" or "xai-json"; ignoring`)
        }
        if (dialect === 'openai-images') {
          editsStyle = ownStyle ?? providerEditsStyle ?? 'multipart'
        } else if (ownStyle !== undefined) {
          warnings.push(`${modelLabel} (${id}): editsStyle 只对 openai-images 方言生效，已忽略`)
        }
      } else if (m.editsStyle !== undefined) {
        warnings.push(`${modelLabel} (${id}): video models take no editsStyle; ignoring`)
      }

      // The edit-surface model name is a per-model declaration; only its
      // shape is validated here, and only the openai-images edits branch
      // consumes it.
      let editModelId: string | undefined
      if (m.editModelId !== undefined) {
        if (typeof m.editModelId === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(m.editModelId.trim())) {
          editModelId = m.editModelId.trim()
        } else {
          warnings.push(`${modelLabel} (${id}): editModelId must be a non-empty slug; ignoring`)
        }
      }

      let generationConfig: Record<string, unknown> | undefined
      if (isVideo) {
        if (m.generationConfig !== undefined) warnings.push(`${modelLabel} (${id}): video models take no generationConfig; ignoring`)
      } else if (dialect === 'gemini') {
        const own = isRecord(m.generationConfig) ? (m.generationConfig as Record<string, unknown>) : undefined
        if (m.generationConfig !== undefined && own === undefined) {
          warnings.push(`${modelLabel} (${id}): generationConfig must be an object; ignoring`)
        }
        generationConfig = own ?? providerGenerationConfig
      } else if (m.generationConfig !== undefined) {
        warnings.push(`${modelLabel} (${id}): generationConfig 只对 gemini 方言生效，已忽略`)
      }

      const timeoutRaw = parseTimeout(m.timeoutMs, `${modelLabel} (${id})`, warnings)
      pushSpec(
        {
          id,
          dialect: dialect as ImagegenDialect,
          sizes,
          fixedSizeNote: resolveFixedSizeNote(fixedSizeNote, sizes),
          edit,
          editsStyle,
          ...(editModelId ? { editModelId } : {}),
          ...(generationConfig ? { generationConfig } : {}),
          note: note ?? null,
          timeoutMs: clampTimeout(timeoutRaw ?? providerTimeoutRaw ?? 90_000),
        },
        modelLabel,
      )
    })

    if (models.length === 0) {
      warnings.push(`${label} (${p.id}): no valid model entries; skipped`)
      return
    }

    // A non-matching editModels entry used to widen the edit surface; now the
    // surface is derived from the specs and can never be widened, but the
    // typo diagnostic is still worth its warning line.
    if (p.editModels !== undefined) {
      if (!Array.isArray(p.editModels)) {
        warnings.push(`${label} (${p.id}): editModels must be a string array; ignoring`)
      } else {
        for (const entry of p.editModels) {
          if (typeof entry !== 'string' || !seenModelIds.has(entry.trim())) {
            warnings.push(`${label} (${p.id}): editModels entry ${JSON.stringify(entry)} is not in models; ignored`)
          }
        }
      }
    }

    let defaultModel: string | undefined
    if (p.defaultModel !== undefined) {
      if (typeof p.defaultModel === 'string' && models.includes(p.defaultModel)) {
        defaultModel = p.defaultModel
      } else {
        warnings.push(`${label} (${p.id}): defaultModel not in models; falling back to the first model`)
      }
    }

    // `editModels` stays derived so legacy call sites (and configs that still
    // declare it) keep working: an explicit entry, or any model with edit:true.
    const editModels = [...new Set(modelSpecs.filter((m) => m.edit).map((m) => m.id))]

    // Deliberately-offline models: documented in the config, exposed nowhere.
    const disabledModels: { id: string; reason: string }[] = []
    if (p.disabledModels !== undefined) {
      if (Array.isArray(p.disabledModels)) {
        const rawEntries = p.disabledModels as unknown[]
        for (const [i, raw] of rawEntries.entries()) {
          const entryLabel = `${label} (${p.id}) disabledModels[${i}]`
          let id = ''
          let reason = '上游暂无可用渠道'
          if (typeof raw === 'string') {
            id = raw.trim()
          } else if (isRecord(raw) && typeof raw.id === 'string') {
            id = raw.id.trim()
            if (typeof raw.reason === 'string' && raw.reason.trim().length > 0) reason = raw.reason.trim().slice(0, 120)
          }
          if (!id) {
            warnings.push(`${entryLabel}: id must be a non-empty string; ignored`)
            continue
          }
          if (seenModelIds.has(id) || disabledModels.some((d) => d.id === id)) {
            warnings.push(`${entryLabel}: "${id}" is already listed; ignored`)
            continue
          }
          disabledModels.push({ id, reason })
        }
      } else {
        warnings.push(`${label} (${p.id}): disabledModels must be an array; ignoring`)
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
      modelSpecs,
      disabledModels,
      editModels: editModels.length > 0 ? editModels : undefined,
      editsStyle: providerEditsStyle,
      defaultModel: defaultModel ?? models[0],
      sizes: providerSizes,
      fixedSizeNote: providerNote,
      timeoutMs: clampTimeout(providerTimeoutRaw ?? 90_000),
      generationConfig: providerGenerationConfig,
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
