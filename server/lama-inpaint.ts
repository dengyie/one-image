import { existsSync } from 'node:fs'
import { runMiganTiling } from './migan-inpaint'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'

// Server-side LaMa inference (Carve/LaMa-ONNX `lama_fp32.onnx`, Apache-2.0).
//
// Architecture note — why a child process: the deploy container runs under a
// 4GB cgroup next to the production API server, and loading the fp32 ONNX
// (plus ORT arenas) empirically triggered a global OOM kill when done
// in-process. All LaMa work therefore happens in a dedicated child process
// (this same bundle re-executed with ONEIMAGE_LAMA_CHILD=1): the model loads
// once there and stays resident, the parent never grows, and an OOM kill or a
// hang takes out only the child — the parent answers 5xx and respawns.

// ONNX contract, pinned against the real artifact (win32 ORT probe, identity
// with an all-zero mask is exact to 0.00):
//   image: Float32 [1,3,512,512], RGB in 0..1
//   mask:  Float32 [1,1,512,512], 1 = hole (pixels to regenerate), 0 = keep
//   output: Float32 [1,3,512,512], RGB in 0..255 (NOT 0..1 — the exporter
//   leaves the generator output unscaled; feeding 0..255 in or scaling the
//   output up both produce garbage).
// The architecture is fixed at 512×512 (FFC's irfft padding cannot be
// exported), so larger inputs are padded to 512-multiples and inferred tile
// by tile; tiles that contain no hole are never sent through the model.

const TILE = 512
export const CHILD_ENV_FLAG = 'ONEIMAGE_LAMA_CHILD'
const CHILD_TIMEOUT_MS = 180_000

export function resolveLamaModelPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.ONEIMAGE_LAMA_MODEL_PATH
  if (!raw || raw.trim().length === 0) return null
  const path = raw.trim()
  return existsSync(path) ? path : null
}

export function resolveMiganModelPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.ONEIMAGE_MIGAN_MODEL_PATH
  if (!raw || raw.trim().length === 0) return null
  const path = raw.trim()
  return existsSync(path) ? path : null
}

export interface RgbaPlane {
  width: number
  height: number
  rgba: Uint8Array
}

export interface LamaRunResult {
  rgba: Uint8Array
  /** Wall-clock ms of the whole run, tiling included. */
  ms: number
  /** 512-tiles actually sent through the model. */
  tiles: number
}

export interface SessionLike {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | Uint8Array }>>
}

export interface TensorCtor {
  Tensor: new (type: string, data: Float32Array | Uint8Array, dims: number[]) => unknown
}

function isHole(mask: Uint8Array, offset: number): boolean {
  // The client sends its raw white-on-black erase mask (white = hole). Red
  // channel >= 128 reads as hole, mirroring the browser's own binarization.
  return mask[offset] >= 128
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

/**
 * Tile-and-stitch core. `image` is the RGBA crop, `mask` the white-on-black
 * hole plane; the result replaces hole pixels with the model's output and
 * leaves every non-hole pixel bit-for-bit identical (alpha preserved
 * everywhere) so the client's feathered composite blends coherently.
 */
export async function runLamaTiling(
  session: SessionLike,
  tensors: TensorCtor,
  input: { width: number; height: number; image: Uint8Array; mask: Uint8Array },
): Promise<LamaRunResult> {
  const started = performance.now()
  const { width, height, image, mask } = input
  const pixelCount = width * height
  if (image.length !== pixelCount * 4 || mask.length !== pixelCount * 4) {
    throw new Error('lama-inpaint: plane dimensions do not match buffer sizes')
  }

  // Pad to 512-multiples with edge replication so border tiles keep context.
  const paddedW = Math.ceil(width / TILE) * TILE
  const paddedH = Math.ceil(height / TILE) * TILE
  const paddedImage = new Uint8Array(paddedW * paddedH * 4)
  const paddedHole = new Uint8Array(paddedW * paddedH)
  const paddedOut = new Uint8Array(paddedW * paddedH * 4)
  for (let y = 0; y < paddedH; y++) {
    const sy = Math.min(y, height - 1)
    for (let x = 0; x < paddedW; x++) {
      const sx = Math.min(x, width - 1)
      const src = (sy * width + sx) * 4
      const dst = (y * paddedW + x) * 4
      paddedImage[dst] = image[src]
      paddedImage[dst + 1] = image[src + 1]
      paddedImage[dst + 2] = image[src + 2]
      paddedImage[dst + 3] = image[src + 3]
      paddedOut[dst] = image[src]
      paddedOut[dst + 1] = image[src + 1]
      paddedOut[dst + 2] = image[src + 2]
      paddedOut[dst + 3] = image[src + 3]
      if (isHole(mask, src)) paddedHole[y * paddedW + x] = 1
    }
  }

  let tiles = 0
  for (let ty = 0; ty < paddedH; ty += TILE) {
    for (let tx = 0; tx < paddedW; tx += TILE) {
      // Only tiles that actually contain a hole go through the model.
      let hasHole = false
      for (let y = ty; y < ty + TILE && !hasHole; y++) {
        for (let x = tx; x < tx + TILE; x++) {
          if (paddedHole[y * paddedW + x] === 1) {
            hasHole = true
            break
          }
        }
      }
      if (!hasHole) continue
      tiles += 1

      const imageData = new Float32Array(3 * TILE * TILE)
      const maskData = new Float32Array(TILE * TILE)
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const srcIdx = ((ty + y) * paddedW + (tx + x)) * 4
          const px = y * TILE + x
          imageData[px] = paddedImage[srcIdx] / 255
          imageData[TILE * TILE + px] = paddedImage[srcIdx + 1] / 255
          imageData[2 * TILE * TILE + px] = paddedImage[srcIdx + 2] / 255
          maskData[px] = paddedHole[(ty + y) * paddedW + (tx + x)]
        }
      }
      const tileFeeds: Record<string, unknown> = {
        [session.inputNames[0]]: new tensors.Tensor('float32', imageData, [1, 3, TILE, TILE]),
        [session.inputNames[1]]: new tensors.Tensor('float32', maskData, [1, 1, TILE, TILE]),
      }
      const results = await session.run(tileFeeds)
      const output = results[session.outputNames[0]].data as Float32Array
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const paddedIdx = (ty + y) * paddedW + (tx + x)
          if (paddedHole[paddedIdx] !== 1) continue
          const srcIdx = paddedIdx * 4
          const px = y * TILE + x
          // Output is RGB 0..255 already; alpha comes from the original plane.
          paddedOut[srcIdx] = clampByte(output[px])
          paddedOut[srcIdx + 1] = clampByte(output[TILE * TILE + px])
          paddedOut[srcIdx + 2] = clampByte(output[2 * TILE * TILE + px])
        }
      }
    }
  }

  const rgba = new Uint8Array(pixelCount * 4)
  rgba.set(paddedOut.subarray(0, pixelCount * 4))
  return { rgba, ms: Math.round(performance.now() - started), tiles }
}

// ---------------------------------------------------------------------------
// Parent side: a persistent child process holding the resident ORT session.
// ---------------------------------------------------------------------------

export interface ChildLike {
  send(message: unknown): boolean
  kill(signal?: number | string): void
  exited: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

interface PendingRequest {
  resolve: (result: LamaRunResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type ForkFn = (modulePath: string, options: Record<string, unknown>) => ChildLike

function defaultFork(modulePath: string, options: Record<string, unknown>): ChildLike {
  const child = fork(modulePath, [], options as Parameters<typeof fork>[2])
  return {
    send: (message) => child.send(message as never),
    kill: (signal) => child.kill(signal as never),
    get exited() {
      return child.exitCode !== null
    },
    on: (event, listener) => child.on(event, listener as never),
    off: (event, listener) => child.off(event, listener as never),
  }
}

export class LamaProcessPool {
  private child: ChildLike | null = null
  private spawning: Promise<ChildLike> | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private warmed = false
  private warmListeners = new Set<(warmed: boolean) => void>()

  constructor(
    private modelPath: string,
    private entryPath: string,
    private forkFn: ForkFn = defaultFork,
    private kind: 'lama' | 'migan' = 'lama',
  ) {}

  /** Whether a proven session is resident right now. */
  isWarm(): boolean {
    return this.warmed && this.child !== null && !this.child.exited
  }

  /** Subscribe to warm-state flips (capabilities honesty gate). */
  onWarmChange(listener: (warmed: boolean) => void): void {
    this.warmListeners.add(listener)
  }

  private setWarm(warmed: boolean): void {
    if (this.warmed === warmed) return
    this.warmed = warmed
    for (const listener of this.warmListeners) listener(warmed)
  }

  /** Test hook: forget the child so the next request respawns. */
  dispose(): void {
    this.child?.kill()
    this.child = null
  }

  /**
   * Loads the model into the resident child ahead of any request. Under host
   * memory pressure the load itself can be OOM-killed; retries with backoff
   * keep trying in the background without blocking boot or requests (a
   * request that arrives mid-load simply triggers/awaits the same load).
   */
  async prewarm(attempts = 6, backoffMs = 30_000): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const child = await this.ensureChild()
        await new Promise<void>((resolve, reject) => {
          // The child can die mid-warm (the OOM kill during session create is
          // the common failure on the memory-starved host), so the wait must
          // settle on exit too — otherwise this loop hangs forever exactly
          // when it should be retrying.
          const onWarm = (message: unknown) => {
            const type = (message as { type?: string })?.type
            if (type === 'warmed') {
              child.off('exit', onExit)
              resolve()
            } else if (type === 'warm_failed') {
              child.off('exit', onExit)
              reject(new Error(String((message as { error?: string })?.error ?? 'warm failed')))
            }
          }
          const onExit = () => reject(new Error('lama child exited during warm'))
          child.on('message', onWarm)
          child.on('exit', onExit)
          child.send({ type: 'warm' })
        })
        this.setWarm(true)
        return true
      } catch (err) {
        // Warm failures were invisible for days (silent catch); the reason
        // is the only way to distinguish OOM windows from config drift.
        process.stderr.write(`[inpaint-pool] warm attempt ${attempt}/${attempts} failed: ${err instanceof Error ? err.message : String(err)}
`)
        if (attempt < attempts) {
          // After three fast failures the window is structurally too tight —
          // escalate the spacing so a doomed retry loop stops re-bombing the
          // host (and collateral-killing sibling pools' children) every 30s.
          const spacing = attempt <= 3 ? backoffMs * attempt : backoffMs * attempt * 20
          await new Promise((resolve) => setTimeout(resolve, spacing))
        }
      }
    }
    return false
  }

  async run(input: { width: number; height: number; image: Uint8Array; mask: Uint8Array }): Promise<LamaRunResult> {
    // The resident child is the biggest anon process on the host, so a global
    // OOM anywhere can kill it — mid-run, mid-handshake, or between the two.
    // One bounded rebuild-and-retry keeps that recovery invisible to the
    // caller; a second failure surfaces. Timeouts are a hung child, not a
    // death, and stay un-retried.
    try {
      return await this.runOnce(input)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.startsWith('lama child exited')) throw err
      return this.runOnce(input)
    }
  }

  private async runOnce(input: { width: number; height: number; image: Uint8Array; mask: Uint8Array }): Promise<LamaRunResult> {
    const child = await this.ensureChild()
    const id = this.nextId++
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = new Promise<LamaRunResult>((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id)
        // A hung child poisons every later request; kill it so the next
        // request gets a fresh process.
        child.kill()
        if (this.child === child) this.child = null
        reject(new Error('lama child timed out'))
      }, CHILD_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      child.send({ type: 'run', id, ...input })
    } catch {
      // The child died between ensureChild and send: settle the request with
      // the retryable death message instead of leaking the pending entry
      // until the timeout fires.
      this.pending.delete(id)
      if (timer) clearTimeout(timer)
      throw new Error('lama child exited during inference')
    }
    // A completed run is itself proof the session can serve (the prewarm
    // probe proves it too) — used by the capabilities honesty gate.
    return result.then((r) => {
      this.setWarm(true)
      return r
    })
  }

  private async ensureChild(): Promise<ChildLike> {
    if (this.child && !this.child.exited) return this.child
    if (this.spawning) return this.spawning
    this.spawning = (async () => {
      const child = this.forkFn(this.entryPath, {
        serialization: 'advanced',
        env: { ...process.env, [CHILD_ENV_FLAG]: '1', ONEIMAGE_INPAINT_CHILD_KIND: this.kind },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      let exited = false
      const wrapped: ChildLike = {
        send: (message) => child.send(message),
        kill: (signal) => child.kill(signal),
        get exited() {
          return exited
        },
        on: (event, listener) => child.on(event, listener as never),
        off: (event, listener) => child.off(event, listener as never),
      }
      child.on('exit', () => {
        exited = true
        this.setWarm(false)
        // Fail everything in flight; the next request respawns a fresh child.
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error('lama child exited during inference'))
          this.pending.delete(id)
        }
        this.pending.clear()
        if (this.child === wrapped) this.child = null
      })
      // Route the child's replies to their waiters: the handshake, warm
      // acknowledgements (consumed by prewarm's own listener) and — the
      // success path — inference results, without which every run would sit
      // until its timeout fired.
      wrapped.on('message', (message: unknown) => {
        const msg = message as { type?: string; id?: number; error?: string; rgba?: Uint8Array; ms?: number; tiles?: number }
        if (msg?.type !== 'result' || typeof msg.id !== 'number') return
        const pending = this.pending.get(msg.id)
        if (!pending) return
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(new Error(msg.error))
        else pending.resolve({ rgba: msg.rgba as Uint8Array, ms: msg.ms ?? 0, tiles: msg.tiles ?? 0 })
      })
      // Wait for the handshake: the child answers once its event loop is up.
      await new Promise<void>((resolve, reject) => {
        const onReady = (message: unknown) => {
          if ((message as { type?: string })?.type === 'ready') {
            wrapped.off('message', onReady)
            resolve()
          }
        }
        wrapped.on('message', onReady)
        wrapped.on('exit', (code: unknown) => reject(new Error(`lama child exited on start (code ${String(code)})`)))
        wrapped.send({ type: 'ping' })
      })
      this.child = wrapped
      return wrapped
    })()
    try {
      return await this.spawning
    } finally {
      this.spawning = null
    }
  }
}

const pools = new Map<string, LamaProcessPool>()

/**
 * The route-facing entry: routes the crop through the child process pool.
 * `entryPath` is this bundle itself, re-executed in child mode.
 */
export function runLamaInpaint(
  input: { width: number; height: number; image: Uint8Array; mask: Uint8Array },
  options: { modelPath: string; entryPath?: string },
): Promise<LamaRunResult> {
  return poolFor(options).run(input)
}

export function prewarmLama(options: { modelPath: string; entryPath?: string }, attempts?: number): Promise<boolean> {
  return poolFor(options).prewarm(attempts)
}

/** Whether a proven (create + full tile run) session is resident. */
export function isLamaWarm(options: { modelPath: string; entryPath?: string }): boolean {
  return poolFor(options).isWarm()
}

/** Subscribe to warm-state flips so surfaces can gate honestly. */
export function onLamaWarmChange(
  options: { modelPath: string; entryPath?: string },
  listener: (warmed: boolean) => void,
): void {
  poolFor(options).onWarmChange(listener)
}

/**
 * Kills every resident child and drops the pool map: called on shutdown so
 * the forked workers' IPC channels stop keeping the event loop alive (the
 * graceful path otherwise hangs until the orchestrator's SIGKILL).
 */
export function disposeLamaPools(): void {
  for (const pool of pools.values()) pool.dispose()
  pools.clear()
}

function poolFor(options: { modelPath: string; entryPath?: string; kind?: 'lama' | 'migan' }): LamaProcessPool {
  const kind = options.kind ?? 'lama'
  const key = `${kind}:${options.modelPath}`
  let target = pools.get(key)
  if (!target) {
    target = new LamaProcessPool(options.modelPath, options.entryPath ?? __filename, defaultFork, kind)
    pools.set(key, target)
  }
  return target
}

export function runMiganInpaint(
  input: { width: number; height: number; image: Uint8Array; mask: Uint8Array },
  options: { modelPath: string; entryPath?: string },
): Promise<LamaRunResult> {
  return poolFor({ ...options, kind: 'migan' }).run(input)
}

export function prewarmMigan(options: { modelPath: string; entryPath?: string }, attempts?: number): Promise<boolean> {
  return poolFor({ ...options, kind: 'migan' }).prewarm(attempts)
}

export function isMiganWarm(options: { modelPath: string; entryPath?: string }): boolean {
  return poolFor({ ...options, kind: 'migan' }).isWarm()
}

export function onMiganWarmChange(
  options: { modelPath: string; entryPath?: string },
  listener: (warmed: boolean) => void,
): void {
  poolFor({ ...options, kind: 'migan' }).onWarmChange(listener)
}

/**
 * After the boot-time prewarm cycle gives up, keep trying gently forever:
 * one single attempt per interval (never concurrent with the initial cycle —
 * maintenance starts only after it finished). On a storm-prone host the warm
 * lands whenever a calm window comes, lighting the tier up with zero user
 * interaction. The timer is unref'd so shutdown never waits on it.
 */
export function maintainInpaintWarm(
  options: { modelPath: string; entryPath?: string; kind?: 'lama' | 'migan' },
  hooks: { log: (fields: Record<string, unknown>, msg: string) => void },
  intervalMs = 15 * 60_000,
): void {
  const pool = poolFor(options)
  const kind = options.kind ?? 'lama'
  const tick = () => {
    if (pool.isWarm()) return
    void pool.prewarm(1, 0).then((warmed) => {
      if (warmed) hooks.log({ modelPath: options.modelPath, kind }, 'inpaint tier warmed by maintenance prewarm')
    })
  }
  setInterval(tick, intervalMs).unref()
}

// ---------------------------------------------------------------------------
// Child side: resident ORT session answering IPC requests.
// ---------------------------------------------------------------------------

export async function runLamaWorkerLoop(getModelPath: () => string | null): Promise<void> {
  const childKind = (process.env.ONEIMAGE_INPAINT_CHILD_KIND ?? 'lama') as 'lama' | 'migan'
  // The caller's resolver is wired for the lama env; a migan child must read
  // its own env key or its warm fails with a null path (silently, retrying
  // forever).
  const effectiveGetModelPath = childKind === 'migan'
    ? () => resolveMiganModelPath()
    : getModelPath
  process.stderr.write('[lama-child] loop registered, loading ort...')
  const requireOrt = createRequire(__filename)
  const ort = requireOrt('onnxruntime-node') as unknown as {
    InferenceSession: { create(path: string, options?: unknown): Promise<SessionLike> }
    Tensor: new (type: string, data: Float32Array | Uint8Array, dims: number[]) => unknown
  }
  process.stderr.write('[lama-child] ort loaded')
  let session: SessionLike | null = null
  let sessionPath: string | null = null
  let sessionLoading: Promise<SessionLike> | null = null
  // Tail of the serialized run chain; every 'run' message appends to it.
  let childRunQueue: Promise<void> = Promise.resolve()

  const ensureSession = async (modelPath: string): Promise<SessionLike> => {
    if (session && sessionPath === modelPath) return session
    if (sessionLoading) return sessionLoading
    process.stderr.write(`[lama-child] creating session from ${modelPath}...`)
    // The migan tier runs on hosts where the resident footprint decides
    // survival: ORT's BFC arena retains its high-water mark forever, so a
    // single run would pin the peak (~80MB) as permanent resident. With the
    // arena off, activations go through malloc and are returned after each
    // run — the child shrinks back between requests.
    const sessionOptions = childKind === 'migan' ? { enableCpuMemArena: false } : undefined
    sessionLoading = ort.InferenceSession.create(modelPath, sessionOptions).then((created) => {
      process.stderr.write('[lama-child] session created')
      session = created
      sessionPath = modelPath
      return created
    })
    try {
      return await sessionLoading
    } finally {
      sessionLoading = null
    }
  }

  process.on('message', (message: { type?: string; id?: number } & Record<string, unknown>) => {
    void (async () => {
      if (message?.type === 'ping') {
        process.send?.({ type: 'ready' })
        return
      }
      if (message?.type === 'warm') {
        void (async () => {
          try {
            const modelPath = effectiveGetModelPath()
            if (!modelPath) throw new Error('model path missing in child')
            const workerSession = await ensureSession(modelPath)
            // Probe the full inference path, not just session creation: on
            // the memory-starved host the first run's arena burst has its
            // own OOM window, and a create-only warm would hand that death
            // to the first real request as a 500. The mask carries one real
            // hole pixel — a zero mask would skip session.run entirely
            // (holes-only tiling) and the probe would prove nothing. The
            // output is discarded; only "one tile went through end to end"
            // matters.
            // The probe's own transient activation peak decides whether the
            // child survives warm on the storm-prone host: a 512 probe costs
            // ~80MB transient, a 256 probe ~20MB (the migan model is
            // dynamic-shaped). Real requests at bigger dims that still OOM
            // are covered by the frontend's browser-worker fallback.
            const probeSize = childKind === 'migan' ? 256 : TILE
            const probeMask = new Uint8Array(probeSize * probeSize * 4)
            probeMask[0] = 255
            probeMask[1] = 255
            probeMask[2] = 255
            probeMask[3] = 255
            const probePlanes = {
              width: probeSize,
              height: probeSize,
              image: new Uint8Array(probeSize * probeSize * 4).fill(128),
              mask: probeMask,
            }
            const probe = childKind === 'migan'
              ? await runMiganTiling(workerSession, ort, probePlanes)
              : await runLamaTiling(workerSession, ort, probePlanes)
            if (probe.tiles !== 1) throw new Error(`warm probe ran ${probe.tiles} tiles`)
            process.send?.({ type: 'warmed' })
          } catch (err) {
            process.send?.({ type: 'warm_failed', error: err instanceof Error ? err.message : String(err) })
          }
        })()
        return
      }
      if (message?.type !== 'run') return
      const { id } = message
      // Serialize whole requests: overlapping runs would double the tile
      // tensors and arena footprint on a host that OOMs at ~170MB, and the
      // semaphore-free design relies on the child being the queue.
      const run = async () => {
        try {
          const modelPath = effectiveGetModelPath()
          if (!modelPath) throw new Error('model path missing in child')
          const workerSession = await ensureSession(modelPath)
          const planes = {
            width: Number(message.width),
            height: Number(message.height),
            image: message.image as Uint8Array,
            mask: message.mask as Uint8Array,
          }
          const result = childKind === 'migan'
            ? await runMiganTiling(workerSession, ort, planes)
            : await runLamaTiling(workerSession, ort, planes)
          process.send?.({ type: 'result', id, rgba: result.rgba, ms: result.ms, tiles: result.tiles })
        } catch (err) {
          process.send?.({ type: 'result', id, error: err instanceof Error ? err.message : String(err) })
        }
      }
      childRunQueue = childRunQueue.then(run, run)
    })()
  })
}
