import { describe, expect, it, vi } from 'vitest'
import { LamaProcessPool, maintainInpaintWarm, nextInpaintMaintenanceDelayMs, type ChildLike, type ForkFn } from '../server/lama-inpaint'

// Behavior-driven fake child: replies are wired to the messages the pool
// sends (ping/warm/run), so tests assert observable behavior instead of
// choreographing microtask timing. The pool must be exercised through the
// same IPC shapes the real fork produces, because the success path — the
// child's 'result' reply resolving its pending request — has no other
// observable.
interface ChildBehavior {
  ready?: boolean
  warmed?: boolean
  result?: boolean
  resultError?: string
  /** Fire after 'warm' is sent, before any reply (mid-warm death). */
  exitOnWarm?: boolean
  /** Make send() throw after exit, like a closed IPC channel. */
  failSendAfterExit?: boolean
}

class FakeChild implements ChildLike {
  exited = false
  behavior: ChildBehavior
  sent: Array<Record<string, unknown>> = []
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  constructor(behavior: ChildBehavior) {
    this.behavior = behavior
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return this
  }

  off(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  send(message: unknown): boolean {
    if (this.exited && this.behavior.failSendAfterExit) throw new Error('channel closed')
    const msg = message as Record<string, unknown>
    this.sent.push(msg)
    if (msg.type === 'ping' && this.behavior.ready) {
      setTimeout(() => this.emit('message', { type: 'ready' }), 0)
    } else if (msg.type === 'warm') {
      if (this.behavior.exitOnWarm) setTimeout(() => this.exit(137), 0)
      else if (this.behavior.warmed) setTimeout(() => this.emit('message', { type: 'warmed' }), 0)
      else if (this.behavior.resultError) setTimeout(() => this.emit('message', { type: 'warm_failed', error: this.behavior.resultError }), 0)
    } else if (msg.type === 'run') {
      if (this.behavior.result) setTimeout(() => this.emit('message', { type: 'result', id: msg.id, rgba: new Uint8Array([9, 8, 7, 255]), ms: 5, tiles: 1 }), 0)
      else if (this.behavior.resultError) setTimeout(() => this.emit('message', { type: 'result', id: msg.id, error: this.behavior.resultError }), 0)
    }
    return true
  }

  kill(): void {
    this.exit(1)
  }

  exit(code = 1): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code)
  }
}

function makePool(initial: ChildBehavior = {}) {
  const spawned: FakeChild[] = []
  const behavior: ChildBehavior = initial
  const forkFn: ForkFn = () => {
    // Live-read `behavior` so tests flip it between phases; each spawn
    // snapshots the current settings for that child.
    const child = new FakeChild({ ...behavior })
    spawned.push(child)
    return child
  }
  const pool = new LamaProcessPool('/models/lama.onnx', '/bundle/index.cjs', forkFn)
  return { pool, spawned, behavior }
}

const INPUT = { width: 512, height: 512, image: new Uint8Array(4), mask: new Uint8Array(4) }

describe('LamaProcessPool lifecycle', () => {
  it('resolves run() when the child replies with a result (success path)', async () => {
    const { pool, spawned } = makePool({ ready: true, result: true })
    const result: LamaRunResultLike = await pool.run(INPUT)
    expect(result.rgba).toEqual(new Uint8Array([9, 8, 7, 255]))
    expect(result.ms).toBe(5)
    expect(result.tiles).toBe(1)
    expect(spawned).toHaveLength(1)
    // No modelPath field rides along: the child resolves the model from env.
    const run = spawned[0].sent.find((m) => m.type === 'run')
    expect(run && 'modelPath' in run).toBe(false)
  })

  it('retries once when the child dies mid-run, then succeeds', async () => {
    // Child #1 never answers the run: the request is deterministically
    // in-flight when the OOM kill lands (an auto-reply would race the kill).
    const { pool, spawned, behavior } = makePool({ ready: true, result: false })
    const pending = pool.run(INPUT)
    await new Promise((resolve) => setTimeout(resolve, 5))
    spawned[0].exit(137)
    behavior.result = true
    const result = await pending
    expect(result.tiles).toBe(1)
    // The retry went through a fresh child with its own run message.
    expect(spawned).toHaveLength(2)
    expect(spawned[1].sent.filter((m) => m.type === 'run')).toHaveLength(1)
  })

  it('does not retry on model-level inference errors', async () => {
    const { pool, spawned } = makePool({ ready: true, resultError: 'ort blew up' })
    await expect(pool.run(INPUT)).rejects.toThrow('ort blew up')
    expect(spawned).toHaveLength(1)
  })

  it('recovers when the child dies between handshake and send', async () => {
    // First child: completes the handshake, then dies with a closed channel.
    const { pool, spawned, behavior } = makePool({ ready: true, failSendAfterExit: true })
    const pending = pool.run(INPUT)
    spawned[0].exit(137)
    behavior.failSendAfterExit = false
    behavior.result = true
    const result = await pending
    expect(result.tiles).toBe(1)
    expect(spawned).toHaveLength(2)
  })

  it('prewarm survives a child dying mid-warm and lands on retry', async () => {
    const { pool, spawned, behavior } = makePool({ ready: true, exitOnWarm: true })
    const pending = pool.prewarm(2, 1)
    // The retry child completes the full handshake + warm.
    behavior.ready = true
    behavior.exitOnWarm = false
    behavior.warmed = true
    await expect(pending).resolves.toBe(true)
    expect(spawned).toHaveLength(2)
  })

  it('concurrent runs share one spawn and both settle', async () => {
    const { pool, spawned } = makePool({ ready: true, result: true })
    const [a, b] = await Promise.all([pool.run(INPUT), pool.run(INPUT)])
    expect(a.tiles).toBe(1)
    expect(b.tiles).toBe(1)
    // One child, two run messages (the child serializes them internally).
    expect(spawned).toHaveLength(1)
    expect(spawned[0].sent.filter((m) => m.type === 'run')).toHaveLength(2)
  })

  it('tracks warm state across prewarm, serving, and child death', async () => {
    const { pool, spawned, behavior } = makePool({ ready: true })
    expect(pool.isWarm()).toBe(false)
    // A completed run proves the session can serve: child #1 dies mid-run
    // (deterministically silent), the bounded retry lands on child #2.
    const pending = pool.run(INPUT)
    await new Promise((resolve) => setTimeout(resolve, 5))
    behavior.result = true
    spawned[0].exit(137)
    await pending
    expect(pool.isWarm()).toBe(true)
    // The child dying takes the tier away again.
    spawned[1].exit(137)
    expect(pool.isWarm()).toBe(false)
  })

  it('prewarm flips warm state only on a real warm handshake', async () => {
    const { pool, spawned, behavior } = makePool({ ready: true, resultError: 'warm probe failed' })
    const flips: boolean[] = []
    pool.onWarmChange((warmed) => flips.push(warmed))
    await expect(pool.prewarm(1, 1)).resolves.toBe(false)
    expect(pool.isWarm()).toBe(false)
    expect(flips).toEqual([])
    // A fresh child (the failed one is gone) warms properly.
    spawned[0].exit(1)
    behavior.resultError = undefined
    behavior.warmed = true
    await expect(pool.prewarm(1, 1)).resolves.toBe(true)
    expect(pool.isWarm()).toBe(true)
    expect(flips).toEqual([true])
  })
})

describe('inpaint maintenance backoff', () => {
  it('escapes the base interval on consecutive failures and caps at 16×', () => {
    const base = 15 * 60_000
    expect(nextInpaintMaintenanceDelayMs(0, base)).toBe(base)
    expect(nextInpaintMaintenanceDelayMs(1, base)).toBe(2 * base)
    expect(nextInpaintMaintenanceDelayMs(2, base)).toBe(4 * base)
    expect(nextInpaintMaintenanceDelayMs(3, base)).toBe(8 * base)
    expect(nextInpaintMaintenanceDelayMs(4, base)).toBe(16 * base)
    // Clamped — a long storm never grows past 16× the base (4h).
    expect(nextInpaintMaintenanceDelayMs(9, base)).toBe(16 * base)
    expect(nextInpaintMaintenanceDelayMs(50, base)).toBe(16 * base)
  })

  it('widens the re-arm interval after each failed attempt and resets on warm', async () => {
    vi.useFakeTimers()
    try {
      let warmed = false
      let attempts = 0
      const logged: Array<Record<string, unknown>> = []
      const fakePool = {
        isWarm: () => warmed,
        prewarm: async () => {
          attempts += 1
          // Fail the first two maintenance attempts, then warm.
          return warmed = attempts > 2
        },
      }
      maintainInpaintWarm(
        { modelPath: '/models/lama.onnx', kind: 'lama' },
        { log: (fields, msg) => logged.push({ ...fields, msg }) },
        60_000,
        fakePool,
      )
      // Tick 1 at the base interval (60s here): fails → re-arm at 2×.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(attempts).toBe(1)
      // Ticks now come every 2× — advancing just under that fires nothing.
      await vi.advanceTimersByTimeAsync(119_999)
      expect(attempts).toBe(1)
      // The second failure fires at exactly 3× base cumulative (60 + 120) —
      // and re-arms at 4×.
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(2)
      // The warm lands at the 4× interval: the log line fires and the
      // counter resets.
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      expect(attempts).toBe(3)
      expect(logged.some((l) => l.msg === 'inpaint tier warmed by maintenance prewarm')).toBe(true)
      expect(warmed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

type LamaRunResultLike = Awaited<ReturnType<LamaProcessPool['run']>>
