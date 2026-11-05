import type { ProvenanceResult } from './openai-provenance-adapter'
import { SUPPORTED_IMAGE_MIME } from '../domain/image-input'

export interface ProvenanceClientError extends Error {
  code: 'invalid-input' | 'unauthorized' | 'rate-limit' | 'provider-auth' | 'provider-timeout' | 'server-unavailable' | 'provider-error' | 'request-aborted'
  retryable: boolean
  status: number
}

export interface PublicCapabilities {
  provenance: { enabled: boolean; provider: string | null; maxInputBytes: number }
}

/** Enrichments the route adds on top of the upstream result. */
export interface ProvenanceRouteResponse {
  /** 'local' means the upstream check never ran (disabled or failed) — evidence is metadata-only. */
  source: 'openai' | 'local'
  checkedAt: string
  evidence: ProvenanceResult['evidence']
  /** Real container dimensions, independent of whatever the pipeline requested. */
  actualSize: { width: number; height: number } | null
  /** Provenance metadata segments still present in the uploaded file (C2PA/EXIF/XMP). */
  localSignals: { kind: 'C2PA' | 'EXIF' | 'XMP'; location: string; bytes: number }[]
}

export async function checkProvenance(file: File, fetcher: typeof fetch = fetch): Promise<ProvenanceRouteResponse> {
  if (!isProvenanceMimeSupported(file.type)) throw createClientError('invalid-input', false, 400, 'JPEG, PNG, or WebP input required')
  const form = new FormData()
  form.append('file', file, file.name)
  const response = await fetcher('/api/v1/provenance/openai', { method: 'POST', body: form })
  if (!response.ok) throw await normalizeClientError(response)
  return await response.json() as ProvenanceRouteResponse
}

export function createProvenanceInput(blob: Blob, filename: string): File {
  return new File([blob], filename, { type: blob.type || 'application/octet-stream' })
}

export function isProvenanceMimeSupported(mime: string): boolean {
  return (SUPPORTED_IMAGE_MIME as readonly string[]).includes(mime)
}

/**
 * Builds the human-facing summary shown under the compress toolbar.
 *
 * Two evidence chains with different strength: local metadata signals (a hit
 * is meaningful, a miss proves nothing) and the OpenAI upstream check (C2PA +
 * SynthID, authoritative when source === 'openai'). When the caller checked a
 * re-encoded canvas export instead of the original file, pass
 * `reencoded: true` so the note cannot mislead: export strips metadata, so a
 * clean result says nothing about the original file.
 */
export function describeProvenanceResult(result: ProvenanceRouteResponse, options: { reencoded?: boolean } = {}): string {
  const parts: string[] = []
  const c2pa = result.localSignals.find((s) => s.kind === 'C2PA')
  const others = result.localSignals.filter((s) => s.kind !== 'C2PA')
  if (result.localSignals.length > 0) {
    parts.push(`文件内元数据：${c2pa ? 'C2PA/来源清单' : others.map((s) => s.kind).join('、')}`)
  }
  if (result.source === 'openai') {
    for (const e of result.evidence) {
      parts.push(`${e.signal.toUpperCase()}官方检测：${e.outcome === 'detected' ? '已检出' : '未检出'}${e.issuer ? ` (${e.issuer})` : ''}`)
    }
  } else {
    parts.push('OpenAI 官方检测不可用，以上仅为元数据信号（不代表无隐形水印）')
  }
  if (result.actualSize) parts.push(`实际 ${result.actualSize.width}×${result.actualSize.height}`)
  if (options.reencoded) parts.push('注意：检测的是画布导出件，元数据已在导出时剥离，不代表原文件')
  if (parts.length === 0) {
    // No metadata, no upstream verdict (or an evidence-less 200): name the limit
    // and the authoritative escape hatch instead of implying "not AI".
    return result.source === 'openai' && result.evidence.length > 0
      ? '未检出嵌入式 AI 来源信号'
      : '未检出元数据信号；像素级隐形水印需官方检测（synthid.com）'
  }
  return parts.join(' · ')
}

export async function getPublicCapabilities(fetcher: typeof fetch = fetch): Promise<PublicCapabilities> {
  const response = await fetcher('/api/v1/capabilities')
  if (!response.ok) throw await normalizeClientError(response)
  return await response.json() as PublicCapabilities
}

async function normalizeClientError(response: Response): Promise<ProvenanceClientError> {
  const fallback = `provenance request failed with HTTP ${response.status}`
  const rawBody = await response.text()
  let message = fallback
  let providerCode: string | undefined
  if (rawBody) {
    try {
      const payload = JSON.parse(rawBody) as { error?: { code?: string; message?: string } }
      providerCode = payload.error?.code
      message = payload.error?.message ?? fallback
    } catch { message = fallback }
  }
  const code = providerCode === 'provider-auth' ? 'provider-auth' : providerCode === 'provider-timeout' ? 'provider-timeout' : response.status === 400 ? 'invalid-input' : response.status === 401 ? 'unauthorized' : response.status === 429 ? 'rate-limit' : response.status >= 500 ? 'server-unavailable' : 'provider-error'
  const retryable = code === 'rate-limit' || code === 'provider-timeout' || code === 'server-unavailable'
  return createClientError(code, retryable, response.status, message)
}

function createClientError(code: ProvenanceClientError['code'], retryable: boolean, status: number, message: string): ProvenanceClientError {
  const error = new Error(message) as ProvenanceClientError
  error.name = 'ProvenanceClientError'
  error.code = code
  error.retryable = retryable
  error.status = status
  return error
}
