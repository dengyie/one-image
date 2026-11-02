import { describe, expect, it, vi } from 'vitest'
import { PREVIEW_MAX_EDGE, exportEditor, planRenderDimensions, renderEditor, resolveRenderDimensions, schedulePreview, type CanvasFactory, type DecodedSource, type RenderCanvas } from '../src/application/editor-renderer'
import { createEditorState } from '../src/domain/editor-state'

describe('editor renderer', () => {
  it('keeps preview bounded while export keeps source dimensions', () => {
    expect(resolveRenderDimensions(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(resolveRenderDimensions(4000, 3000, Number.POSITIVE_INFINITY)).toEqual({ width: 4000, height: 3000 })
  })

  it('cancels a pending animation frame when replaced', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const cancel = schedulePreview(async () => { calls.push('render') })
    cancel()
    vi.runAllTimers()
    expect(calls).toEqual([])
    vi.useRealTimers()
  })

  it('applies a local adjustment on top of the already globally adjusted image', () => {
    let sourceDraws = 0
    let imageDraws = 0
    const filters: string[] = []
    const createCanvas = (width: number, height: number): RenderCanvas => {
      const canvas = { width, height }
      const context = {
        canvas,
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        rect: () => {},
        moveTo: () => {},
        lineTo: () => {},
        closePath: () => {},
        clip: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        drawImage: () => { imageDraws += 1 },
        set filter(value: string) { filters.push(value) },
      }
      return { width, height, getContext: () => context as never }
    }
    const factory: CanvasFactory = { create: createCanvas }
    const source: DecodedSource = {
      width: 100,
      height: 100,
      draw: () => { sourceDraws += 1 },
      close: () => {},
    }
    const state = createEditorState(100, 100)
    state.adjustments.brightness = 20
    state.localAdjustments = [{ id: 'local', rect: { x: 10, y: 10, width: 40, height: 40 }, adjustments: { ...state.adjustments, brightness: 0 } }]

    renderEditor(source, state, factory, { maxEdge: 100, showFullSource: true })

    expect(sourceDraws).toBe(1)
    expect(imageDraws).toBe(2)
    expect(filters).toEqual([
      'brightness(1.2) contrast(1) saturate(1) blur(0px)',
      'brightness(1) contrast(1) saturate(1) blur(0px)',
    ])
  })

  it('creates a block-sized mosaic layer only for the selected local region', () => {
    const created: Array<{ width: number; height: number }> = []
    const paths: Array<Array<{ x: number; y: number }>> = []
    let currentPath: Array<{ x: number; y: number }> = []
    let smoothingStates: boolean[] = []
    const factory: CanvasFactory = {
      create(width, height) {
        created.push({ width, height })
        const canvas = { width, height }
        const context = {
          canvas,
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          beginPath: () => { currentPath = []; paths.push(currentPath) },
          rect: () => {},
          moveTo: (x: number, y: number) => { currentPath.push({ x, y }) },
          lineTo: (x: number, y: number) => { currentPath.push({ x, y }) },
          closePath: () => {},
          clip: () => {},
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          drawImage: () => {},
          set filter(_value: string) {},
          set imageSmoothingEnabled(value: boolean) { smoothingStates.push(value) },
        }
        return { width, height, getContext: () => context as never }
      },
    }
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    const state = createEditorState(100, 100)
    state.localAdjustments = [{
      id: 'mosaic',
      rect: { x: 20, y: 30, width: 40, height: 30 },
      adjustments: { ...state.adjustments },
      mosaicBlockSize: 10,
    } as typeof state.localAdjustments[number]]

    renderEditor(source, state, factory, { maxEdge: 100, showFullSource: true })

    expect(created).toEqual([{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 4, height: 3 }])
    expect(smoothingStates).toContain(false)
    expect(paths[0]).toEqual([{ x: 20, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 60 }, { x: 20, y: 60 }])
    expect(paths[1]).toEqual(paths[0])
  })

  it('allocates bounded scratch canvas for blur mosaic rather than full-frame', () => {
    const created: Array<{ width: number; height: number }> = []
    const factory: CanvasFactory = {
      create(width, height) {
        created.push({ width, height })
        const canvas = { width, height }
        const context = {
          canvas,
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          rect: () => {},
          moveTo: () => {},
          lineTo: () => {},
          closePath: () => {},
          clip: () => {},
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          drawImage: () => {},
          set filter(_value: string) {},
        }
        return { width, height, getContext: () => context as never }
      },
    }
    const source: DecodedSource = { width: 1000, height: 1000, draw: () => {}, close: () => {} }
    const state = createEditorState(1000, 1000)
    // 100x100 blur region inside 1000x1000 canvas
    state.annotations = [
      {
        id: 'blur-1',
        type: 'mosaic',
        mosaicType: 'blur',
        color: '#000000',
        strokeWidth: 0,
        rect: { x: 200, y: 200, width: 100, height: 100 },
      },
    ]

    renderEditor(source, state, factory, { maxEdge: 1000, showFullSource: true })

    // Expect the main canvas (1000x1000), then the blur scratch canvas bounded to ~148x148 (not 1000x1000)
    expect(created[0]).toEqual({ width: 1000, height: 1000 })
    expect(created[1].width).toBeLessThan(200)
    expect(created[1].height).toBeLessThan(200)
    expect(created[1].width).toBeGreaterThanOrEqual(100)
    expect(created[1].height).toBeGreaterThanOrEqual(100)
  })

  it('renders vector annotations across all supported primitives without throwing', () => {
    const renderedPrimitives: string[] = []
    const factory: CanvasFactory = {
      create(width, height) {
        const canvas = { width, height }
        const context = {
          canvas,
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          rect: () => {},
          moveTo: () => {},
          lineTo: () => {},
          quadraticCurveTo: () => { renderedPrimitives.push('quadraticCurve') },
          arc: () => { renderedPrimitives.push('arc') },
          ellipse: () => { renderedPrimitives.push('ellipse') },
          closePath: () => {},
          clip: () => {},
          stroke: () => { renderedPrimitives.push('stroke') },
          fill: () => { renderedPrimitives.push('fill') },
          fillText: () => { renderedPrimitives.push('fillText') },
          measureText: () => ({ width: 60 }),
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          drawImage: () => {},
          set filter(_value: string) {},
          set strokeStyle(_value: string) {},
          set fillStyle(_value: string) {},
          set lineWidth(_value: number) {},
        }
        return { width, height, getContext: () => context as never }
      },
    }
    const source: DecodedSource = { width: 500, height: 500, draw: () => {}, close: () => {} }
    const state = createEditorState(500, 500)
    state.annotations = [
      { id: '1', type: 'brush', color: '#ef4444', strokeWidth: 4, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 15 }] },
      { id: '2', type: 'arrow', color: '#ef4444', strokeWidth: 4, points: [{ x: 50, y: 50 }, { x: 100, y: 100 }] },
      { id: '3', type: 'rect', color: '#ef4444', strokeWidth: 4, rect: { x: 50, y: 50, width: 80, height: 60 } },
      { id: '4', type: 'ellipse', color: '#ef4444', strokeWidth: 4, rect: { x: 150, y: 150, width: 80, height: 60 } },
      { id: '5', type: 'text', color: '#ef4444', strokeWidth: 4, text: 'Hello', rect: { x: 200, y: 200, width: 60, height: 30 }, textBgStyle: 'solid' },
    ]

    renderEditor(source, state, factory, { maxEdge: 500, showFullSource: true })

    expect(renderedPrimitives).toContain('quadraticCurve')
    expect(renderedPrimitives).toContain('stroke')
    expect(renderedPrimitives).toContain('fill')
    expect(renderedPrimitives).toContain('ellipse')
    expect(renderedPrimitives).toContain('fillText')
  })

  it('renders watermark layers for both tile and corner styles', () => {
    const textFills: Array<{ text: string; x: number; y: number }> = []
    let rotateCalls = 0
    let translateCalls = 0
    const factory: CanvasFactory = {
      create(width, height) {
        const canvas = { width, height }
        const context = {
          canvas,
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          rect: () => {},
          moveTo: () => {},
          lineTo: () => {},
          closePath: () => {},
          clip: () => {},
          stroke: () => {},
          fill: () => {},
          fillText: (text: string, x: number, y: number) => { textFills.push({ text, x, y }) },
          measureText: () => ({ width: 80 }),
          translate: () => { translateCalls += 1 },
          rotate: () => { rotateCalls += 1 },
          scale: () => {},
          drawImage: () => {},
          set filter(_value: string) {},
          set strokeStyle(_value: string) {},
          set fillStyle(_value: string) {},
          set lineWidth(_value: number) {},
          set globalAlpha(_value: number) {},
          set font(_value: string) {},
          set shadowColor(_value: string) {},
          set shadowBlur(_value: number) {},
          set textBaseline(_value: string) {},
        }
        return { width, height, getContext: () => context as never }
      },
    }
    const source: DecodedSource = { width: 400, height: 400, draw: () => {}, close: () => {} }
    const state = createEditorState(400, 400)
    state.annotations = [
      {
        id: 'wm-tile',
        type: 'watermark',
        color: '#ffffff',
        strokeWidth: 0,
        text: 'CONFIDENTIAL',
        watermarkStyle: 'tile',
        opacity: 0.2,
      },
      {
        id: 'wm-corner',
        type: 'watermark',
        color: '#ffffff',
        strokeWidth: 0,
        text: '© OneImage',
        watermarkStyle: 'corner',
        opacity: 0.8,
      },
    ]

    renderEditor(source, state, factory, { maxEdge: 400, showFullSource: true })

    expect(rotateCalls).toBeGreaterThan(0)
    expect(translateCalls).toBeGreaterThan(0)
    // Tiling emits multiple fillText calls across the diagonal matrix
    const tileFills = textFills.filter((f) => f.text === 'CONFIDENTIAL')
    expect(tileFills.length).toBeGreaterThan(5)

    // Corner emits 1 fillText call positioned near bottom-right
    const cornerFills = textFills.filter((f) => f.text === '© OneImage')
    expect(cornerFills.length).toBe(1)
    expect(cornerFills[0].x).toBeGreaterThan(200)
    expect(cornerFills[0].y).toBeGreaterThan(200)
  })
})

describe('render plan', () => {
  const stubFactory = (): CanvasFactory => ({
    create: (width, height) => ({
      width,
      height,
      getContext: () =>
        new Proxy(
          { canvas: { width, height } },
          {
            get: (target, prop) =>
              prop in target
                ? (target as Record<string, unknown>)[prop as string]
                : prop === 'measureText'
                  ? () => ({ width: 10 })
                  : prop === 'createLinearGradient' || prop === 'createRadialGradient'
                    ? () => ({ addColorStop: () => {} })
                    : () => {},
          }
        ) as never,
    }),
  })

  it('derives the preview size from the state the renderer will draw', () => {
    const small = createEditorState(640, 400)
    expect(planRenderDimensions(small, PREVIEW_MAX_EDGE, false)).toEqual({ width: 640, height: 400 })

    const cropped = createEditorState(5000, 2500)
    cropped.crop = { x: 100, y: 100, width: 1000, height: 1000 }
    // Not crop mode: the preview shows the crop itself, already under the edge.
    expect(planRenderDimensions(cropped, PREVIEW_MAX_EDGE, false)).toEqual({ width: 1000, height: 1000 })
    // Crop mode draws the full source, so the preview edge bounds it.
    expect(planRenderDimensions(cropped, PREVIEW_MAX_EDGE, true)).toEqual({ width: 2400, height: 1200 })

    const rotated = createEditorState(640, 400)
    rotated.rotation = 90
    expect(planRenderDimensions(rotated, PREVIEW_MAX_EDGE, false)).toEqual({ width: 400, height: 640 })
  })

  it('agrees with the bitmap renderEditor actually returns', () => {
    const state = createEditorState(3000, 2000)
    state.crop = { x: 10, y: 20, width: 1500, height: 900 }
    state.rotation = 90
    const source: DecodedSource = { width: 3000, height: 2000, draw: () => {}, close: () => {} }
    const rendered = renderEditor(source, state, stubFactory(), { maxEdge: PREVIEW_MAX_EDGE, showFullSource: true })
    expect({ width: rendered.width, height: rendered.height }).toEqual(
      planRenderDimensions(state, PREVIEW_MAX_EDGE, true)
    )
  })
})

describe('blackout erase region rendering', () => {
  const recordRects = () => {
    const calls: Array<{ kind: 'stroke' | 'fill'; style: string; lineWidth: number; alpha: number }> = []
    const factory: CanvasFactory = {
      create: (width, height) => {
        const canvas = { width, height }
        const context = {
          canvas,
          globalAlpha: 1,
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 0,
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          closePath: () => {},
          clearRect: () => {},
          drawImage: () => {},
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          measureText: () => ({ width: 10 }),
          stroke: () => {
            calls.push({ kind: 'stroke', style: context.strokeStyle, lineWidth: context.lineWidth, alpha: context.globalAlpha })
          },
          fill: () => {
            calls.push({ kind: 'fill', style: context.fillStyle, lineWidth: context.lineWidth, alpha: context.globalAlpha })
          },
        }
        return { width, height, getContext: () => context as never, convertToBlob: async () => new Blob() } as never
      },
    }
    return { factory, calls }
  }

  const blackoutState = () => {
    const state = createEditorState(100, 100)
    state.annotations = [
      { id: 'b1', type: 'rect', rect: { x: 10, y: 10, width: 40, height: 40 }, color: '#000000', strokeWidth: 0, opacity: 1 },
    ]
    return state
  }

  it('fills a strokeWidth-0 rect solid instead of outlining it', () => {
    const { factory, calls } = recordRects()
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    renderEditor(source, blackoutState(), factory, { maxEdge: 100 })

    // A hollow outline around the blackout region was the production bug: it
    // leaked into exports and poisoned the smart-erase mask context.
    expect(calls.some((call) => call.kind === 'stroke')).toBe(false)
    const fills = calls.filter((call) => call.kind === 'fill')
    expect(fills).toHaveLength(1)
    expect(fills[0].style).toBe('#000000')
    expect(fills[0].alpha).toBe(1)
  })

  it('still outlines a normal rect annotation with a stroke width', () => {
    const { factory, calls } = recordRects()
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    const state = createEditorState(100, 100)
    state.annotations = [
      { id: 'r1', type: 'rect', rect: { x: 10, y: 10, width: 40, height: 40 }, color: '#ef4444', strokeWidth: 4 },
    ]
    renderEditor(source, state, factory, { maxEdge: 100 })

    const strokes = calls.filter((call) => call.kind === 'stroke')
    expect(strokes).toHaveLength(1)
    expect(strokes[0].style).toBe('#ef4444')
    expect(strokes[0].lineWidth).toBe(4)
  })

  it('bakes the solid blackout into exports', async () => {
    const { factory, calls } = recordRects()
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    await exportEditor(source, blackoutState(), factory, 'image/png', 1)

    expect(calls.filter((call) => call.kind === 'fill')).toHaveLength(1)
    expect(calls.some((call) => call.kind === 'stroke')).toBe(false)
  })
})

describe('smart-erase marquee rendering', () => {
  const recordingFactory = () => {
    const calls = { setLineDash: 0, stroke: 0, fill: 0 }
    const factory: CanvasFactory = {
      create: (width, height) => {
        const canvas = { width, height }
        const context = {
          canvas,
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          closePath: () => {},
          clearRect: () => {},
          drawImage: () => {},
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          setLineDash: () => { calls.setLineDash += 1 },
          stroke: () => { calls.stroke += 1 },
          fill: () => { calls.fill += 1 },
          measureText: () => ({ width: 10 }),
        }
        return {
          width,
          height,
          getContext: () => context as never,
          convertToBlob: async () => new Blob(),
        } as never
      },
    }
    return { factory, calls }
  }

  const marqueeState = () => {
    const state = createEditorState(100, 100)
    state.annotations = [
      { id: 'm1', type: 'erase-ai', rect: { x: 10, y: 10, width: 40, height: 40 }, color: '#34d399', strokeWidth: 0 },
    ]
    return state
  }

  it('keeps the marquee in the live preview as a dashed stroke', async () => {
    const { factory, calls } = recordingFactory()
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    renderEditor(source, marqueeState(), factory, { maxEdge: 100 })
    expect(calls.setLineDash).toBeGreaterThanOrEqual(1)
    expect(calls.stroke).toBeGreaterThanOrEqual(1)
    expect(calls.fill).toBe(0)
  })

  it('never bakes the marquee into exports', async () => {
    const { factory, calls } = recordingFactory()
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    await exportEditor(source, marqueeState(), factory, 'image/png', 1)
    expect(calls.setLineDash).toBe(0)
    expect(calls.stroke).toBe(0)
    expect(calls.fill).toBe(0)
  })
})

describe('brush mosaic rendering', () => {
  interface CanvasLog { width: number; height: number; ops: string[] }

  const recordFactory = () => {
    const log: CanvasLog[] = []
    const factory: CanvasFactory = {
      create: (width, height) => {
        const entry: CanvasLog = { width, height, ops: [] }
        log.push(entry)
        const push = (value: string) => entry.ops.push(value)
        const canvas = { width, height }
        const context = { canvas, imageSmoothingEnabled: true, filter: 'none', fillStyle: '', strokeStyle: '', lineCap: 'butt', lineJoin: 'miter', lineWidth: 0 }
        let composite = 'source-over'
        Object.defineProperty(context, 'globalCompositeOperation', {
          get: () => composite,
          set: (value: string) => { composite = value; push(`composite:${value}`) },
        })
        Object.assign(context, {
          save: () => push('save'),
          restore: () => push('restore'),
          beginPath: () => push('beginPath'),
          moveTo: (x: number, y: number) => push(`moveTo:${x},${y}`),
          lineTo: (x: number, y: number) => push(`lineTo:${x},${y}`),
          arc: (x: number, y: number, r: number) => push(`arc:${x},${y},${r}`),
          rect: (x: number, y: number) => push(`rect:${x},${y}`),
          closePath: () => push('closePath'),
          clip: () => push('clip'),
          stroke: () => push(`stroke:${context.lineWidth}:${context.lineCap}`),
          fill: () => push('fill'),
          clearRect: () => push('clearRect'),
          drawImage: (...args: unknown[]) => push(`drawImage:${args.slice(1).map(String).join(',')}`),
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          measureText: () => ({ width: 10 }),
        })
        return { width, height, getContext: () => context as never, convertToBlob: async () => new Blob() } as never
      },
    }
    return { factory, log }
  }

  const strokeState = (points: Array<{ x: number; y: number }>) => {
    const state = createEditorState(100, 100)
    state.annotations = [
      { id: 'm1', type: 'mosaic', points, rect: { x: 0, y: 0, width: 100, height: 100 }, color: '#000000', strokeWidth: 20, mosaicType: 'pixel', mosaicBlockSize: 16 },
    ]
    return state
  }

  it('masks the blocky effect down to the brushed path and composites it once', () => {
    const { factory, log } = recordFactory()
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    renderEditor(source, strokeState([{ x: 20, y: 50 }, { x: 80, y: 50 }]), factory, { maxEdge: 100 })

    // main canvas, effect region (block-snapped), downsample tile, stroke mask
    expect(log[0]).toMatchObject({ width: 100, height: 100 })
    expect(log[1]).toMatchObject({ width: 96, height: 32 })
    expect(log[2]).toMatchObject({ width: 6, height: 2 })
    expect(log[3]).toMatchObject({ width: 96, height: 32 })

    // The effect is clipped by alpha, not by a canvas clip path.
    expect(log[1].ops).toContain('composite:destination-in')
    expect(log[1].ops).toContain('composite:source-over')
    expect(log[0].ops.some((op) => op.startsWith('clip'))).toBe(false)

    // Mask follows the stroke with a round-capped brush of the requested width.
    const maskOps = log[3].ops
    expect(maskOps).toContain('moveTo:20,18')
    expect(maskOps).toContain('lineTo:80,18')
    expect(maskOps).toContain('stroke:20:round')

    // Exactly one composite back onto the base image, at the region origin.
    const mainDraws = log[0].ops.filter((op) => op.startsWith('drawImage'))
    expect(mainDraws).toEqual(['drawImage:0,32'])
  })

  it('paints a dot when the brush is tapped without moving', () => {
    const { factory, log } = recordFactory()
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    renderEditor(source, strokeState([{ x: 50, y: 50 }]), factory, { maxEdge: 100 })

    const maskOps = log[log.length - 1].ops
    expect(maskOps.some((op) => op.startsWith('arc'))).toBe(true)
    expect(maskOps).toContain('fill')
    expect(maskOps.some((op) => op.startsWith('stroke'))).toBe(false)
  })

  it('still clips a rectangle for mosaic layers without points', () => {
    const { factory, log } = recordFactory()
    const source: DecodedSource = { width: 100, height: 100, draw: () => {}, close: () => {} }
    const state = createEditorState(100, 100)
    state.annotations = [
      { id: 'r1', type: 'mosaic', rect: { x: 20, y: 20, width: 40, height: 40 }, color: '#000000', strokeWidth: 1, mosaicType: 'pixel', mosaicBlockSize: 8 },
    ]
    renderEditor(source, state, factory, { maxEdge: 100 })

    expect(log[0].ops.some((op) => op.startsWith('clip'))).toBe(true)
    expect(log.some((entry) => entry.ops.some((op) => op.startsWith('composite:destination-in')))).toBe(false)
  })
})

describe('原图对比 render invariant', () => {
  function recordingFactory(record: { draws: string[]; filters: string[] }): CanvasFactory {
    return {
      create(width: number, height: number): RenderCanvas {
        const canvas = { width, height }
        const context = {
          canvas,
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          rect: () => {},
          moveTo: () => {},
          lineTo: () => {},
          closePath: () => {},
          clip: () => {},
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          drawImage: () => { record.draws.push('layer') },
          set filter(value: string) { record.filters.push(value) },
        }
        return { width, height, getContext: () => context as never }
      },
    }
  }

  it('compare view follows the root image geometry with its own pristine state', () => {
    // 当前文档是 90×60 的派生图；用户根原图是 200×120。
    const rootSource: DecodedSource = { width: 200, height: 120, draw: () => record.draws.push('source'), close: () => {} }
    const record = { draws: [] as string[], filters: [] as string[] }
    const rendered = renderEditor(rootSource, createEditorState(200, 120), recordingFactory(record), { maxEdge: 400 })
    expect([rendered.width, rendered.height]).toEqual([200, 120])
    expect(record.draws).toEqual(['source'])
    for (const f of record.filters) expect(f).toBe('brightness(1) contrast(1) saturate(1) blur(0px)')
  })

  it('pristine state never leaks edits of the current document into the compare view', () => {
    const record = { draws: [] as string[], filters: [] as string[] }
    const source: DecodedSource = { width: 100, height: 100, draw: () => record.draws.push('source'), close: () => {} }
    const factory = recordingFactory(record)
    const identity = 'brightness(1) contrast(1) saturate(1) blur(0px)'

    const edited = createEditorState(100, 100)
    edited.adjustments.brightness = 40
    edited.annotations = [
      { id: 'a1', type: 'mosaic', rect: { x: 10, y: 10, width: 50, height: 40 }, color: '#000000', strokeWidth: 1, mosaicType: 'pixel', mosaicBlockSize: 10 },
    ]
    renderEditor(source, edited, factory, { maxEdge: 100 })
    const editedDraws = [...record.draws]
    const editedFilters = [...record.filters]
    expect(editedDraws[0]).toBe('source')
    expect(editedDraws.filter((d) => d === 'layer').length).toBeGreaterThan(0)
    expect(editedFilters.some((f) => f !== identity)).toBe(true)

    record.draws.length = 0
    record.filters.length = 0
    renderEditor(source, createEditorState(100, 100), factory, { maxEdge: 100 })
    expect(record.draws).toEqual(['source'])
    for (const f of record.filters) expect(f).toBe(identity)
  })
})
