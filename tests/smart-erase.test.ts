import { describe, expect, it, vi } from 'vitest'
import { runSmartErase, type SmartEraseInput } from '../src/infrastructure/inpaint/smart-erase'

// Node has no ImageData global; the orchestrator only constructs it from the
// worker payload, so a minimal structural stand-in is enough.
class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray | number, width?: number, height?: number) {
    if (typeof data === 'number') {
      this.width = data
      this.height = width!
      this.data = new Uint8ClampedArray(this.width * this.height * 4)
    } else {
      this.data = data
      this.width = width!
      this.height = height!
    }
  }
}
vi.stubGlobal('ImageData', FakeImageData)

class FakeWorker {
  sent: SmartEraseRequestLike[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers: Record<string, ((event: any) => void)[]> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, handler: (event: any) => void): void {
    ;(this.handlers[type] ||= []).push(handler)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, handler: (event: any) => void): void {
    this.handlers[type] = (this.handlers[type] ?? []).filter((h) => h !== handler)
  }
  postMessage(message: unknown): void {
    this.sent.push(message as SmartEraseRequestLike)
  }
  emit(message: unknown): void {
    for (const handler of this.handlers.message ?? []) handler({ data: message })
  }
  terminate(): void {}
}

interface SmartEraseRequestLike {
  runId: string
  provider?: string
  image: ArrayBuffer
}

function makeInput(byte: number): SmartEraseInput {
  const data = new Uint8ClampedArray(4)
  data[0] = byte
  data[1] = byte
  data[2] = byte
  data[3] = 255
  return {
    image: { data, width: 1, height: 1 } as unknown as ImageData,
    mask: { data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData,
    composite: { data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData,
  }
}

describe('smart-erase orchestrator', () => {
  it('correlates worker responses by runId when overlapping runs receive out-of-order results', async () => {
    const fake = new FakeWorker()
    const p1 = runSmartErase(makeInput(10), () => {}, { workerFactory: () => fake })
    const p2 = runSmartErase(makeInput(20), () => {}, { workerFactory: () => fake })
    expect(fake.sent).toHaveLength(2)
    const [reqA, reqB] = fake.sent
    expect(reqA.runId).not.toBe(reqB.runId)

    // The worker answers the SECOND request first, and both listeners see both
    // messages; each caller must keep only its own result.
    fake.emit({ type: 'done', runId: reqB.runId, rgba: new Uint8ClampedArray([20, 20, 20, 255]).buffer })
    fake.emit({ type: 'done', runId: reqA.runId, rgba: new Uint8ClampedArray([10, 10, 10, 255]).buffer })

    const [outA, outB] = await Promise.all([p1, p2])
    expect(outA.data[0]).toBe(10)
    expect(outB.data[0]).toBe(20)
  })

  it('rejects only the matching caller on error and ignores messages from other runs', async () => {
    const fake = new FakeWorker()
    const stages: string[] = []
    const p1 = runSmartErase(makeInput(1), (stage) => stages.push(stage.phase), { workerFactory: () => fake })
    const p2 = runSmartErase(makeInput(2), () => {}, { workerFactory: () => fake })

    // runB fails; runA must stay pending, not consume B's failure.
    fake.emit({ type: 'error', runId: fake.sent[1].runId, message: 'boom' })
    await expect(p2).rejects.toThrow('boom')
    // runA keeps receiving its own stage updates afterwards.
    fake.emit({ type: 'stage', runId: fake.sent[0].runId, stage: 'inference' })
    fake.emit({ type: 'done', runId: fake.sent[0].runId, rgba: new Uint8ClampedArray([1, 1, 1, 255]).buffer })
    await expect(p1).resolves.toBeDefined()
    expect(stages).toContain('inference')
  })

  it('defaults the filler to MI-GAN and forwards an explicit provider', async () => {
    const fake = new FakeWorker()
    const p1 = runSmartErase(makeInput(1), () => {}, { workerFactory: () => fake })
    const p2 = runSmartErase(
      { ...makeInput(2), provider: 'classical' },
      () => {},
      { workerFactory: () => fake }
    )

    expect(fake.sent[0].provider).toBe('migan')
    expect(fake.sent[1].provider).toBe('classical')

    // Settle both so the fake worker registry does not leak into other tests.
    fake.emit({ type: 'done', runId: fake.sent[0].runId, rgba: new Uint8ClampedArray([1, 1, 1, 255]).buffer })
    fake.emit({ type: 'done', runId: fake.sent[1].runId, rgba: new Uint8ClampedArray([2, 2, 2, 255]).buffer })
    await Promise.all([p1, p2])
  })
})
