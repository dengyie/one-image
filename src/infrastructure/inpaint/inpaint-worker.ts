/// <reference lib="webworker" />
// Dedicated worker for the MI-GAN smart eraser: keeps onnxruntime and the
// 26.8 MB model off the main thread. ORT is NOT bundled here — it is imported
// at runtime from the self-hosted /models/ort/ bundle, so the ORT JS glue and
// its WASM pair ship exactly once (in public/models/ort/, served same-origin).
// One session is created lazily and reused for every subsequent run.

import { ensureMiganModel } from './model-cache'
import { ORT_VERSION } from './ort-version'
import {
  compositeFromChw,
  compositeRgba,
  maskToBinary,
  rgbaToRgbChw,
  type RgbaPlane,
} from './inpaint-core'
import { fillHolesClassical } from './classical-fill'
import { fillHolesBlur, fillHolesPixelate, fillHolesSolid } from './obscure-fill'
import type { FillProvider } from './auto-route'

// Minimal structural contract for the runtime-loaded ORT bundle. Kept local
// (instead of importing onnxruntime-web types) so the worker's types do not
// track a specific ORT version; the runtime source is the self-hosted bundle.
interface OrtSession {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Uint8Array }>>
}

interface OrtNamespace {
  env: { wasm: { numThreads: number; wasmPaths: string } }
  InferenceSession: {
    create(model: ArrayBuffer, options?: { executionProviders?: string[] }): Promise<OrtSession>
  }
  Tensor: new (type: string, data: Uint8Array, dims: number[]) => unknown
}

const ORT_BASE = `/models/ort/${ORT_VERSION}`
const ORT_BUNDLE_URL = `${ORT_BASE}/ort.bundle.min.mjs`

export interface SmartEraseRequest {
  type: 'run'
  runId: string
  width: number
  height: number
  /** Which filler to run for this hole (chosen by the router on the UI side). */
  provider: FillProvider
  /** RGBA of the current full-resolution snapshot. */
  image: ArrayBuffer
  /** RGBA mask canvas: white = region to inpaint (crisp, drives the model). */
  mask: ArrayBuffer
  /** RGBA feathered alpha used only for the final composite. */
  composite: ArrayBuffer
}

export type SmartEraseResponse =
  | { type: 'progress'; runId: string; phase: 'model'; loadedBytes: number; totalBytes: number | null }
  | { type: 'stage'; runId: string; stage: 'session' | 'inference' }
  | { type: 'done'; runId: string; rgba: ArrayBuffer }
  | { type: 'error'; runId: string; message: string }

let ortPromise: Promise<OrtNamespace> | null = null
let session: OrtSession | null = null
let sessionCreation: Promise<OrtSession> | null = null
// True while the live session was created with WebGPU attempted; only such
// sessions are worth rebuilding on WASM after a run-time failure.
let usedWebgpu = false

function loadOrt(): Promise<OrtNamespace> {
  if (!ortPromise) {
    ortPromise = import(/* @vite-ignore */ ORT_BUNDLE_URL) as Promise<OrtNamespace>
  }
  return ortPromise
}

async function createSession(runId: string, forceWasm = false): Promise<OrtSession> {
  const ort = await loadOrt()
  // Threads need cross-origin isolation; without COOP/COEP keep single-thread
  // SIMD so ORT does not stall on a missing SharedArrayBuffer.
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  ort.env.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1
  ort.env.wasm.wasmPaths = `${ORT_BASE}/`

  // Model download only ever happens on the run that created the session, so
  // its progress messages can carry that run's id.
  const model = await ensureMiganModel((progress) => {
    scope.postMessage({
      type: 'progress',
      runId,
      phase: 'model',
      loadedBytes: progress.loadedBytes,
      totalBytes: progress.totalBytes,
    } satisfies SmartEraseResponse)
  })
  const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  usedWebgpu = gpu && !forceWasm
  try {
    return await ort.InferenceSession.create(model, {
      executionProviders: usedWebgpu ? ['webgpu', 'wasm'] : ['wasm'],
    })
  } catch (err) {
    if (usedWebgpu) {
      // WebGPU present but the model/adapter rejected it (driver, OOM,
      // unsupported ops): fall back to WASM instead of failing the run.
      usedWebgpu = false
      return ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
    }
    throw err
  }
}

async function getSession(runId: string, forceWasm = false): Promise<OrtSession> {
  if (session) return session
  if (!sessionCreation) {
    sessionCreation = createSession(runId, forceWasm)
      .then((created) => {
        session = created
        return created
      })
      .catch((err) => {
        sessionCreation = null
        throw err
      })
  }
  return sessionCreation
}

// A WebGPU session can create cleanly yet still fail at run time (device
// loss, driver quirks, per-tile OOM). Rebuild once on WASM and retry.
async function rebuildSessionOnWasm(runId: string): Promise<OrtSession> {
  session = null
  sessionCreation = null
  return getSession(runId, true)
}

// Omit over a union collapses to the shared keys, so distribute manually to
// keep per-variant required fields intact.
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type SmartEraseReport = DistributedOmit<SmartEraseResponse, 'runId'>

// self.postMessage resolves to the Window overload set under the DOM lib; the
// worker-scope transfer-list form needs an explicit cast.
const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void }

async function run(req: SmartEraseRequest): Promise<ArrayBuffer> {
  const report = (response: SmartEraseReport, transfer?: ArrayBuffer): void => {
    scope.postMessage({ ...response, runId: req.runId } satisfies SmartEraseResponse, transfer ? [transfer] : undefined)
  }
  const imagePlane: RgbaPlane = { data: new Uint8ClampedArray(req.image), width: req.width, height: req.height }
  const maskPlane: RgbaPlane = { data: new Uint8ClampedArray(req.mask), width: req.width, height: req.height }
  const alphaPlane: RgbaPlane = { data: new Uint8ClampedArray(req.composite), width: req.width, height: req.height }

  if (req.provider !== 'migan') {
    // Model-free fillers: no session, no download, no resampling. Each produces
    // a full-frame RGBA plane that only the feathered alpha ever shows, so the
    // "nothing outside the mask changes" guarantee comes from compositeRgba.
    report({ type: 'stage', stage: 'inference' })
    let generated: Uint8ClampedArray
    switch (req.provider) {
      case 'classical':
        generated = fillHolesClassical(imagePlane, maskPlane)
        break
      case 'blur':
        generated = fillHolesBlur(imagePlane, maskPlane)
        break
      case 'pixel':
        generated = fillHolesPixelate(imagePlane, maskPlane)
        break
      case 'solid':
        generated = fillHolesSolid(imagePlane, maskPlane)
        break
      default: {
        // Exhaustiveness anchor: a new FillProvider must add its own case.
        const unhandled: never = req.provider
        throw new Error(`inpaint worker: unknown filler ${String(unhandled)}`)
      }
    }
    const blended = compositeRgba(imagePlane, { data: generated, width: req.width, height: req.height }, alphaPlane)
    return blended.buffer as ArrayBuffer
  }

  report({ type: 'stage', stage: 'session' })
  let inferenceSession = await getSession(req.runId)
  const ort = await loadOrt()

  report({ type: 'stage', stage: 'inference' })
  const imageTensor = new ort.Tensor('uint8', rgbaToRgbChw(imagePlane), [1, 3, req.height, req.width])
  const maskTensor = new ort.Tensor('uint8', maskToBinary(maskPlane), [1, 1, req.height, req.width])
  const feeds: Record<string, InstanceType<OrtNamespace['Tensor']>> = {
    [inferenceSession.inputNames[0]]: imageTensor,
    [inferenceSession.inputNames[1]]: maskTensor,
  }

  let results: Record<string, { data: Uint8Array }>
  try {
    results = await inferenceSession.run(feeds)
  } catch (err) {
    if (!usedWebgpu) throw err
    // WebGPU sessions can create cleanly yet fail at run time (device loss,
    // driver quirks, per-tile OOM). Rebuild once on WASM and retry; if the
    // rebuild itself or the retry fails, surface that error.
    report({ type: 'stage', stage: 'session' })
    inferenceSession = await rebuildSessionOnWasm(req.runId)
    results = await inferenceSession.run(feeds)
  }
  const output = results[inferenceSession.outputNames[0]]
  // Single fused pass: convert CHW -> RGBA and blend through the feathered
  // alpha in one allocation.
  const blended = compositeFromChw(output.data as Uint8Array, imagePlane, alphaPlane)
  // compositeFromChw allocates a fresh ArrayBuffer (never SharedArrayBuffer),
  // so the cast is sound and no defensive copy is needed before transferring.
  return blended.buffer as ArrayBuffer
}

self.onmessage = (event: MessageEvent<SmartEraseRequest>) => {
  if (event.data?.type !== 'run') return
  const req = event.data
  run(req)
    .then((rgba) => {
      scope.postMessage({ type: 'done', runId: req.runId, rgba } satisfies SmartEraseResponse, [rgba])
    })
    .catch((err: unknown) => {
      scope.postMessage({
        type: 'error',
        runId: req.runId,
        message: err instanceof Error ? err.message : String(err),
      } satisfies SmartEraseResponse)
    })
}
