import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { registerProvenanceRoute, type ProvenanceRouteSecurity } from '../server/provenance-route'
import { SUPPORTED_IMAGE_MIME } from '../src/domain/image-input'

const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
}

function multipartImage(mimetype: string, bytes: number[], filename: string): { boundary: string; body: Buffer } {
  const boundary = '----oneimage-test'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { boundary, body }
}

describe('provenance HTTP route', () => {
  it('accepts an image multipart upload and returns normalized evidence', async () => {
    const app = Fastify()
    await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } })
    const check = vi.fn().mockResolvedValue({ source: 'openai', checkedAt: '2026-10-09T00:00:00.000Z', evidence: [{ source: 'openai', signal: 'synthid', outcome: 'detected', checkedAt: '2026-10-09T00:00:00.000Z' }] })
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })

    const boundary = '----oneimage-test'
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)])
    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ source: 'openai', evidence: [{ signal: 'synthid', outcome: 'detected' }] })
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png', size: 8 }), 'sample.png', expect.any(AbortSignal))
    await app.close()
  })

  it('returns a typed input error when the uploaded file is not an image', async () => {
    const app = Fastify()
    await app.register(multipart)
    const check = vi.fn()
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })
    const boundary = '----oneimage-test'
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`)

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid-input', retryable: false } })
    expect(check).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a file whose bytes do not match the declared image MIME', async () => {
    const app = Fastify()
    await app.register(multipart)
    const check = vi.fn()
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })
    const boundary = '----oneimage-test'
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fake.png"\r\nContent-Type: image/png\r\n\r\nnot-a-png\r\n--${boundary}--\r\n`)

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid-input', retryable: false } })
    expect(check).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps multipart file limits to a payload-too-large response', async () => {
    const app = Fastify()
    await app.register(multipart, { limits: { fileSize: 4 } })
    registerProvenanceRoute(app, vi.fn())
    const boundary = '----oneimage-test'
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n123456789\r\n--${boundary}--\r\n`)

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ error: { code: 'payload-too-large', retryable: false } })
    await app.close()
  })

  it('requires the configured server token before consuming a multipart body', async () => {
    const app = Fastify()
    await app.register(multipart)
    const security: ProvenanceRouteSecurity = {
      authorize: (request) => request.headers['x-oneimage-token'] === 'server-token',
      allow: () => true,
    }
    registerProvenanceRoute(app, vi.fn(), security)

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'unauthorized', retryable: false } })
    await app.close()
  })

  it('returns rate-limit after the security port denies a request', async () => {
    const app = Fastify()
    await app.register(multipart)
    registerProvenanceRoute(app, vi.fn(), { authorize: () => true, allow: () => false })

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai' })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({ error: { code: 'rate-limit', retryable: true } })
    await app.close()
  })

  it('allows an explicitly same-origin request when no server token is configured', async () => {
    const app = Fastify()
    await app.register(multipart)
    const check = vi.fn().mockResolvedValue({ source: 'openai', checkedAt: '2026-10-09T00:00:00.000Z', evidence: [] })
    registerProvenanceRoute(app, check, {
      authorize: (request) => request.headers.origin === `http://${request.headers.host}`,
      allow: () => true,
    })
    const boundary = '----oneimage-test'
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)])

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('maps a missing multipart content type to invalid-input', async () => {
    const app = Fastify()
    await app.register(multipart)
    registerProvenanceRoute(app, vi.fn(), { authorize: () => true, allow: () => true })

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', payload: 'not multipart' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid-input', retryable: false } })
    await app.close()
  })

  it('maps a non-multipart content type to invalid-input', async () => {
    const app = Fastify()
    await app.register(multipart)
    registerProvenanceRoute(app, vi.fn(), { authorize: () => true, allow: () => true })

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': 'text/plain' }, payload: 'not multipart' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid-input', retryable: false } })
    await app.close()
  })

  it('keeps provenance error mapping scoped away from sibling routes', async () => {
    const app = Fastify()
    await app.register(multipart)
    registerProvenanceRoute(app, vi.fn(), { authorize: () => true, allow: () => true })
    app.get('/api/v1/other', async () => { throw new Error('unrelated failure') })

    const response = await app.inject({ method: 'GET', url: '/api/v1/other' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).not.toHaveProperty('error.code', 'provider-error')
    await app.close()
  })

  it('returns a local-signal fallback (200) when the upstream check fails with a transient error', async () => {
    const app = Fastify()
    await app.register(multipart)
    const check = vi.fn().mockRejectedValue(Object.assign(new Error('upstream failed'), { code: 'provider-unavailable', retryable: true }))
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })
    // PNG with a caBX C2PA chunk (length 9, data 'manifest\0', CRC placeholder).
    const png = Buffer.from([...MAGIC_BYTES['image/png'], 0x00, 0x00, 0x00, 0x09, 0x63, 0x61, 0x42, 0x58, 0x6d, 0x61, 0x6e, 0x69, 0x66, 0x65, 0x73, 0x74, 0x00, 0x00, 0x00, 0x00, 0x00])
    const { boundary, body } = multipartImage('image/png', [...png], 'sample.png')

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(payload).toMatchObject({ source: 'local', evidence: [], localSignals: [{ kind: 'C2PA', location: 'png:caBX' }] })
    expect(payload.checkedAt).toBeTruthy()
    await app.close()
  })

  it('still fails with provider-auth (key not configured) instead of a misleading local fallback', async () => {
    const app = Fastify()
    await app.register(multipart)
    const check = vi.fn().mockRejectedValue(Object.assign(new Error('missing key'), { code: 'provider-auth', retryable: false, status: 503 }))
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })
    const { boundary, body } = multipartImage('image/png', MAGIC_BYTES['image/png'], 'sample.png')

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ error: { code: 'provider-auth' } })
    await app.close()
  })

  it('enriches a successful upstream response with actualSize and localSignals', async () => {
    const app = Fastify()
    await app.register(multipart)
    const check = vi.fn().mockResolvedValue({ source: 'openai', checkedAt: '2026-11-06T00:00:00.000Z', evidence: [] })
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })
    // Minimal IHDR PNG 3x2.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x02])
    const { boundary, body } = multipartImage('image/png', [...png], 'sample.png')

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(payload).toMatchObject({ source: 'openai', actualSize: { width: 3, height: 2 }, localSignals: [] })
    await app.close()
  })

  it('aborts provider work when the client disconnects after uploading the full body', async () => {
    const app = Fastify()
    await app.register(multipart)
    let providerSignal: AbortSignal | undefined
    let onProviderStarted: (() => void) | undefined
    const providerStarted = new Promise<void>((resolve) => { onProviderStarted = resolve })
    const check = vi.fn((_file: Blob, _filename: string, signal?: AbortSignal) => {
      providerSignal = signal
      onProviderStarted?.()
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const { boundary, body } = multipartImage('image/png', MAGIC_BYTES['image/png'], 'sample.png')
    const responseController = new AbortController()
    const response = fetch(`${address}/api/v1/provenance/openai`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: responseController.signal,
    })
    await providerStarted

    responseController.abort()
    await expect(response).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true))
    await app.close()
  })

  it.each(SUPPORTED_IMAGE_MIME)('accepts a valid %s upload through the shared input policy', async (mime) => {
    const app = Fastify()
    await app.register(multipart)
    const check = vi.fn().mockResolvedValue({ source: 'openai', checkedAt: '2026-10-09T00:00:00.000Z', evidence: [] })
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })
    const { boundary, body } = multipartImage(mime, MAGIC_BYTES[mime], `sample.${mime.split('/')[1]}`)

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(200)
    expect(check).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('rejects AVIF input because the provenance endpoint does not accept it', async () => {
    const app = Fastify()
    await app.register(multipart)
    const check = vi.fn()
    registerProvenanceRoute(app, check, { authorize: () => true, allow: () => true })
    const avif = [...Buffer.from([0, 0, 0, 0x20]), ...Buffer.from('ftypavif')]
    const { boundary, body } = multipartImage('image/avif', avif, 'sample.avif')

    const response = await app.inject({ method: 'POST', url: '/api/v1/provenance/openai', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid-input', retryable: false } })
    expect(check).not.toHaveBeenCalled()
    await app.close()
  })
})
