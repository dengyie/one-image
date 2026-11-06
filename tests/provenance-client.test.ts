import { describe, expect, it, vi } from 'vitest'
import { checkProvenance, createProvenanceInput, describeProvenanceResult, getPublicCapabilities, isProvenanceMimeSupported, type ProvenanceRouteResponse } from '../src/infrastructure/provenance-client'

function routeResponse(overrides: Partial<ProvenanceRouteResponse> = {}): ProvenanceRouteResponse {
  return {
    source: 'openai',
    checkedAt: '2026-11-06T00:00:00.000Z',
    evidence: [],
    actualSize: null,
    localSignals: [],
    selfDeclared: [],
    ...overrides,
  }
}

describe('describeProvenanceResult', () => {
  it('reports a C2PA metadata hit with size, plus the upstream verdicts', () => {
    const note = describeProvenanceResult(routeResponse({
      evidence: [{ source: 'openai', signal: 'synthid', outcome: 'detected', checkedAt: '2026-11-06T00:00:00.000Z' }],
      actualSize: { width: 1024, height: 1024 },
      localSignals: [{ kind: 'C2PA', location: 'jpeg:APP11', bytes: 6074 }],
    }))
    expect(note).toContain('文件内元数据：C2PA/来源清单')
    expect(note).toContain('SYNTHID官方检测：已检出')
    expect(note).toContain('实际 1024×1024')
  })

  it('labels a local fallback as metadata-only instead of implying the image is clean', () => {
    const note = describeProvenanceResult(routeResponse({ source: 'local', localSignals: [] }))
    expect(note).toContain('OpenAI 官方检测不可用')
    expect(note).toContain('不代表无隐形水印')
  })

  it('warns that a re-encoded canvas export cannot speak for the original file', () => {
    const note = describeProvenanceResult(routeResponse({ source: 'local' }), { reencoded: true })
    expect(note).toContain('画布导出件')
    expect(note).toContain('不代表原文件')
  })

  it('points at the authoritative portal when everything is clean', () => {
    const upstreamClean = describeProvenanceResult(routeResponse({
      evidence: [{ source: 'openai', signal: 'c2pa', outcome: 'not_detected', checkedAt: '2026-11-06T00:00:00.000Z' }],
    }))
    expect(upstreamClean).toContain('C2PA官方检测：未检出')
  })

  it('surfaces the producer self-declaration for SynthID and AI-generated assertions', () => {
    const note = describeProvenanceResult(routeResponse({
      localSignals: [{ kind: 'C2PA', location: 'jpeg:APP11', bytes: 6074 }],
      selfDeclared: [
        { statement: 'Created by Google Generative AI.', location: 'jpeg:APP11' },
        { statement: 'Applied imperceptible SynthID watermark.', location: 'jpeg:APP11' },
      ],
    }))
    expect(note).toContain('制作方自我声明：已应用 SynthID 隐形水印，AI 生成内容')
  })

  it('recognizes a trainedAlgorithmicMedia assertion without a SynthID string', () => {
    const note = describeProvenanceResult(routeResponse({
      localSignals: [{ kind: 'C2PA', location: 'jpeg:APP11', bytes: 13460 }],
      selfDeclared: [{ statement: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia', location: 'jpeg:APP11' }],
    }))
    expect(note).toContain('制作方自我声明：AI 生成内容')
    expect(note).not.toContain('SynthID')
  })
})

describe('browser provenance client', () => {
  it('wraps the current edited blob as the file sent for provenance checks', () => {
    const input = createProvenanceInput(new Blob(['edited'], { type: 'image/png' }), 'edited.png')
    expect(input.name).toBe('edited.png')
    expect(input.type).toBe('image/png')
  })
  it('posts the selected image to the same-origin route and preserves evidence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      source: 'openai',
      checkedAt: '2026-10-09T00:00:00.000Z',
      evidence: [{ source: 'openai', signal: 'c2pa', outcome: 'detected', validationState: 'trusted', checkedAt: '2026-10-09T00:00:00.000Z' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await checkProvenance(new File(['image'], 'sample.png', { type: 'image/png' }), fetcher)

    expect(result.evidence[0]).toMatchObject({ signal: 'c2pa', outcome: 'detected' })
    expect(fetcher).toHaveBeenCalledWith('/api/v1/provenance/openai', expect.objectContaining({ method: 'POST', body: expect.any(FormData) }))
  })

  it('returns a typed unavailable error for unauthorized or unavailable server routes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'unauthorized', retryable: false, message: 'server authentication required' } }), { status: 401 }))

    await expect(checkProvenance(new File(['image'], 'sample.png', { type: 'image/png' }), fetcher)).rejects.toMatchObject({ code: 'unauthorized', retryable: false })
  })

  it('preserves non-retryable provider-auth errors from the server contract', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'provider-auth', retryable: false, message: 'provider rejected credentials' } }), { status: 502 }))

    await expect(checkProvenance(new File(['image'], 'sample.png', { type: 'image/png' }), fetcher)).rejects.toMatchObject({ code: 'provider-auth', retryable: false, status: 502 })
  })

  it('loads public provider capabilities and validates provenance input formats', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ provenance: { enabled: true, provider: 'openai', maxInputBytes: 25 * 1024 * 1024 } }), { status: 200 }))

    await expect(getPublicCapabilities(fetcher)).resolves.toEqual({ provenance: { enabled: true, provider: 'openai', maxInputBytes: 25 * 1024 * 1024 } })
    expect(isProvenanceMimeSupported('image/png')).toBe(true)
    expect(isProvenanceMimeSupported('image/avif')).toBe(false)
  })

  it('rejects a format outside the shared provenance policy before network access', async () => {
    const fetcher = vi.fn<typeof fetch>()

    await expect(checkProvenance(new File(['image'], 'sample.avif', { type: 'image/avif' }), fetcher)).rejects.toMatchObject({ code: 'invalid-input', status: 400 })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
