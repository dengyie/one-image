import type { FastifyInstance } from 'fastify'
import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ProvenanceResult } from '../src/infrastructure/openai-provenance-adapter'
import { matchesImageSignature } from '../src/application/file-policy'
import { MAX_INPUT_BYTES, SUPPORTED_IMAGE_MIME } from '../src/domain/image-input'
import { sniffImage } from './image-meta'
import { scanMetadataSignals, type MetadataSignal, type SelfDeclaredSignal } from './image-signals'

type ProvenanceCheck = (file: Blob, filename: string, signal?: AbortSignal) => Promise<ProvenanceResult>

/** Response body: the upstream result, enriched with what the raw bytes reveal locally. */
export interface ProvenanceRouteResponse {
  /** 'local' means the upstream check never ran (disabled or failed) — evidence is metadata-only. */
  source: 'openai' | 'local'
  checkedAt: string
  evidence: ProvenanceResult['evidence']
  /** Real container dimensions, independent of whatever the pipeline requested. */
  actualSize: { width: number; height: number } | null
  /** Provenance metadata segments still present in the uploaded file (C2PA/EXIF/XMP). */
  localSignals: MetadataSignal[]
  /** Producer's own written assertions read from C2PA payloads, when present. */
  selfDeclared: SelfDeclaredSignal[]
}

export interface ProvenanceRouteSecurity {
  authorize(request: { headers: Record<string, string | string[] | undefined> }): boolean | Promise<boolean>
  allow(request: { ip?: string; headers: Record<string, string | string[] | undefined>; raw: { socket: { remoteAddress?: string } } }): boolean | Promise<boolean>
}

const ACCEPTED_MIME = new Set<string>(SUPPORTED_IMAGE_MIME)
const OVERSIZE_MESSAGE = `image exceeds the ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)} MB limit`

export function registerProvenanceRoute(app: FastifyInstance, check: ProvenanceCheck, security: ProvenanceRouteSecurity = { authorize: () => true, allow: () => true }): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error, request, reply) => {
      const routeError = error as { code?: string }
      if (routeError.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || routeError.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
        return reply.code(400).send({ error: { code: 'invalid-input', retryable: false, message: 'multipart image input is required' } })
      }
      if (routeError.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: { code: 'payload-too-large', retryable: false, message: OVERSIZE_MESSAGE } })
      }
      request.log.error({ err: error }, 'unhandled provenance route error')
      return reply.send(error)
    })

    scope.post('/api/v1/provenance/openai', async (request, reply) => {
      try {
        if (!await security.authorize(request)) return reply.code(401).send({ error: { code: 'unauthorized', retryable: false, message: 'server authentication required' } })
        if (!await security.allow(request)) return reply.code(429).send({ error: { code: 'rate-limit', retryable: true, message: 'too many requests' } })
        const part = await request.file()
        if (!part) return reply.code(400).send({ error: { code: 'invalid-input', retryable: false, message: 'image file is required' } })
        if (!ACCEPTED_MIME.has(part.mimetype)) {
          await drainMultipartFile(part.file)
          return reply.code(400).send({ error: { code: 'invalid-input', retryable: false, message: 'JPEG, PNG, or WebP input required' } })
        }
        const directory = await mkdtemp(join(tmpdir(), 'oneimage-provenance-'))
        const uploadPath = join(directory, basename(part.filename) || 'upload.bin')
        try {
          await pipeline(part.file, createWriteStream(uploadPath, { flags: 'wx', mode: 0o600 }))
          if (part.file.truncated) return reply.code(413).send({ error: { code: 'payload-too-large', retryable: false, message: OVERSIZE_MESSAGE } })
          const signature = Buffer.allocUnsafe(16)
          const handle = await open(uploadPath, 'r')
          try {
            const { bytesRead } = await handle.read(signature, 0, signature.length, 0)
            if (!matchesImageSignature(signature.subarray(0, bytesRead), part.mimetype)) {
              return reply.code(400).send({ error: { code: 'invalid-input', retryable: false, message: 'file signature does not match its MIME type' } })
            }
          } finally {
            await handle.close()
          }
          const file = await openAsBlob(uploadPath, { type: part.mimetype })
          const requestAbort = new AbortController()
          const onRequestAborted = () => requestAbort.abort(new DOMException('request aborted', 'AbortError'))
          const onResponseClosed = () => {
            if (!reply.raw.writableEnded) requestAbort.abort(new DOMException('response closed', 'AbortError'))
          }
          request.raw.once('aborted', onRequestAborted)
          reply.raw.once('close', onResponseClosed)
          try {
            const bytes = await readFile(uploadPath)
            const meta = sniffImage(bytes)
            const scan = scanMetadataSignals(bytes)
            const localSignals = scan?.signals ?? []
            const selfDeclared = scan?.selfDeclared ?? []
            try {
              const result = await check(file, part.filename, requestAbort.signal)
              return reply.code(200).send({ ...result, actualSize: meta ? { width: meta.width, height: meta.height } : null, localSignals, selfDeclared, source: 'openai' } satisfies ProvenanceRouteResponse)
            } catch (upstreamError) {
              // The authoritative check is unavailable; the local metadata scan
              // still answers a weaker question, so hand that over instead of a
              // bare error. It cannot prove absence of a watermark (SynthID is
              // pixel-level), which the client is expected to convey.
              const error = upstreamError as { code?: string; status?: number }
              if (error.code === 'request-aborted' || request.raw.aborted || request.raw.destroyed) throw upstreamError
              if (error.code === 'provider-auth' || error.status === 503) throw upstreamError
              request.log.warn({ err: upstreamError, code: error.code ?? 'provider-error' }, 'provenance upstream failed; returning local-signal fallback')
              return reply.code(200).send({
                source: 'local',
                checkedAt: new Date().toISOString(),
                evidence: [],
                actualSize: meta ? { width: meta.width, height: meta.height } : null,
                localSignals,
                selfDeclared,
              } satisfies ProvenanceRouteResponse)
            }
          } finally {
            request.raw.off('aborted', onRequestAborted)
            reply.raw.off('close', onResponseClosed)
          }
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      } catch (cause) {
        const error = cause as { code?: string; retryable?: boolean; status?: number; message?: string }
        if (error.code === 'request-aborted' || request.raw.aborted || request.raw.destroyed) {
          request.log.info({ code: error.code ?? 'request-aborted' }, 'provenance request abandoned by client')
          return reply
        }
        const code = error.code === 'FST_REQ_FILE_TOO_LARGE' ? 'payload-too-large' : error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || error.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' ? 'invalid-input' : error.code ?? 'provider-error'
        const status = code === 'provider-auth' ? 502 : code === 'provider-rate-limit' ? 429 : code === 'provider-unavailable' ? 503 : code === 'provider-timeout' ? 504 : code === 'payload-too-large' ? 413 : code === 'invalid-input' ? 400 : code === 'request-aborted' ? 499 : 502
        request.log.error({ err: cause, code }, 'provenance request failed')
        return reply.code(status).send({ error: { code, retryable: error.retryable ?? false, message: code === 'payload-too-large' ? OVERSIZE_MESSAGE : error.message ?? 'provenance check failed' } })
      }
    })
  })
}

async function drainMultipartFile(file: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of file) {
    // Consume rejected uploads so busboy can finish the request cleanly.
  }
}
