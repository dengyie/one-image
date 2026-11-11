// Main-thread orchestrator for the MI-GAN smart eraser. Owns the worker
// lifecycle, canvas plumbing and progress reporting so UI code stays
// declarative. All heavy tensor work happens inside the worker. Requests are
// correlated by runId so concurrent runs can never consume each other's
// result, even if a caller overlaps them.

import type { SmartEraseRequest, SmartEraseResponse } from './inpaint-worker'
import type { FillProvider } from './auto-route'

export const SMART_ERASE_MAX_EDGE = 6144

export interface SmartEraseInput {
  /** Full-resolution RGBA snapshot of the current editor state. */
  image: ImageData
  /** Crisp binary mask (white = erase), same dimensions as the image. */
  mask: ImageData
  /** Feathered alpha mask used only for blending the result back in. */
  composite: ImageData
  /** Which filler the caller routed this hole to. Defaults to MI-GAN. */
  provider?: FillProvider
}

export type SmartEraseStage =
  | { phase: 'model'; loadedBytes: number; totalBytes: number | null }
  | { phase: 'session' }
  | { phase: 'inference'; provider?: FillProvider }
  // Server-side LaMa tier only: the crop is being uploaded for inference.
  | { phase: 'upload' }

// Minimal structural contract so tests can inject a fake worker; a real
// Worker satisfies it as-is. Handlers are EventListener-typed because the DOM
// and worker lib overload sets disagree on the event parameter.
export interface WorkerLike {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
}

function createWorker(): Worker {
  return new Worker(new URL('./inpaint-worker.ts', import.meta.url), { type: 'module' })
}

// crypto.randomUUID is secure-context-only; the fallback keeps LAN/plain-http
// deployments working.
function makeRunId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

let worker: WorkerLike | null = null

function getWorker(): WorkerLike {
  if (!worker) worker = createWorker()
  return worker
}

/**
 * Terminates the worker (and with it the cached ORT session / GPU context).
 * Used on hard failures so the next attempt starts clean.
 */
export function disposeSmartEraseWorker(): void {
  worker?.terminate()
  worker = null
}

export function runSmartErase(
  input: SmartEraseInput,
  onStage: (stage: SmartEraseStage) => void,
  options: { workerFactory?: () => WorkerLike } = {}
): Promise<ImageData> {
  const { width, height } = input.image
  const runId = makeRunId()
  const transfers: ArrayBuffer[] = [input.image.data.buffer, input.mask.data.buffer, input.composite.data.buffer]

  return new Promise<ImageData>((resolve, reject) => {
    const active = options.workerFactory ? options.workerFactory() : getWorker()
    const onMessage = (event: MessageEvent<SmartEraseResponse & { runId?: string }>) => {
      const message = event.data
      if (message.runId !== runId) return
      if (message.type === 'progress') {
        onStage({ phase: 'model', loadedBytes: message.loadedBytes, totalBytes: message.totalBytes })
        return
      }
      if (message.type === 'stage') {
        onStage(
          message.stage === 'inference'
            ? { phase: 'inference', provider: message.provider }
            : { phase: 'session' }
        )
        return
      }
      if (message.type === 'done') {
        cleanup()
        resolve(new ImageData(new Uint8ClampedArray(message.rgba), width, height))
        return
      }
      cleanup()
      if (!options.workerFactory) disposeSmartEraseWorker()
      reject(new Error(message.message))
    }
    const onError = (event: ErrorEvent) => {
      cleanup()
      if (!options.workerFactory) disposeSmartEraseWorker()
      reject(new Error(event.message || '智能修复 Worker 崩溃'))
    }

    const cleanup = () => {
      active.removeEventListener('message', onMessage as unknown as EventListener)
      active.removeEventListener('error', onError as unknown as EventListener)
    }

    active.addEventListener('message', onMessage as unknown as EventListener)
    active.addEventListener('error', onError as unknown as EventListener)
    active.postMessage(
      {
        type: 'run',
        runId,
        width,
        height,
        provider: input.provider ?? 'migan',
        image: input.image.data.buffer,
        mask: input.mask.data.buffer,
        composite: input.composite.data.buffer,
      } satisfies SmartEraseRequest,
      transfers
    )
  })
}
