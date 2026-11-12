import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runErasePipeline, type EraseRunInput } from '../src/application/smart-erase-run'
import { createEditorState } from '../src/domain/editor-state'
import type { DecodedSource, CanvasFactory } from '../src/application/editor-renderer'

function minimalInput(annotations: EraseRunInput['state']['annotations']): EraseRunInput {
  const decodedSource: DecodedSource = { width: 64, height: 64, draw: () => {}, close: () => {} }
  const factory: CanvasFactory = {
    create: (width, height) => {
      const canvas = { width, height }
      const plane = new Uint8ClampedArray(width * height * 4)
      const target: Record<string, unknown> = {
        canvas,
        // All-zero plane: no hole pixels, so the pipeline must short-circuit
        // on the empty-selection contract before reaching any filler.
        // Node has no ImageData global; a plain shaped object satisfies the
        // pipeline (it reads .data and forwards the plane to the fillers).
        getImageData: () => ({ data: plane, width, height, colorSpace: 'srgb' } as ImageData),
        putImageData: () => {},
        convertToBlob: async () => new Blob([new Uint8Array(8)], { type: 'image/png' }),
      }
      const context = new Proxy(target, {
        get(t, prop) {
          if (typeof prop !== 'symbol' && prop in t) return t[prop]
          return () => {}
        },
        set(t, prop, value) {
          if (typeof prop === 'symbol') return true
          t[prop] = value
          return true
        },
      })
      return {
        width,
        height,
        convertToBlob: async () => new Blob([new Uint8Array(8)], { type: 'image/png' }),
        getContext: () => context as never,
      }
    },
  }
  return {
    decodedSource,
    file: new File([new Uint8Array(8)], 'test.png', { type: 'image/png' }),
    state: { ...createEditorState(64, 64), annotations },
    factory,
    eraseType: 'ai',
    eraseMode: 'auto',
    serverLamaAvailable: false,
    serverMiganAvailable: false,
    onStage: () => {},
  }
}

describe('runErasePipeline', () => {
  // Node has no createImageBitmap; the pipeline decodes the snapshot with it.
  beforeAll(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 64, height: 64, close: () => {} }))
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })
  it('reports an empty selection without invoking any filler', async () => {
    // A state with no erase-ai layers at all: the tightened mask has zero
    // hole pixels, so the pipeline must answer the discriminated
    // empty-selection outcome instead of reaching the worker.
    const outcome = await runErasePipeline(minimalInput([]))
    expect(outcome).toEqual({ ok: false, reason: 'empty-selection' })
  })

  it('reports empty selection when the erase-ai layer carries no mask pixels', async () => {
    const outcome = await runErasePipeline(
      minimalInput([
        {
          id: 'layer-1',
          type: 'erase-ai',
          rect: { x: 10, y: 10, width: 20, height: 20 },
          color: '#ffffff',
          strokeWidth: 2,
        } as never,
      ]),
    )
    // The layer has a rect but the mask is drawn from strokes; a bare rect
    // with no painted strokes refines down to nothing → empty selection.
    expect(outcome).toEqual({ ok: false, reason: 'empty-selection' })
  })
})
