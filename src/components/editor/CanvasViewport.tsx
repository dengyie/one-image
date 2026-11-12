import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { EditorState, Rect, AnnotationLayer } from '../../domain/editor-state'
import { createEditorState, clampCrop, rotatedDimensions, isStrokePointRedundant } from '../../domain/editor-state'
import { renderEditor, schedulePreview, planRenderDimensions, PREVIEW_MAX_EDGE, type CanvasFactory, type DecodedSource, type RenderCanvas } from '../../application/editor-renderer'
import { createBrowserCanvasFactory } from '../../infrastructure/editor-canvas'
import { mapPointerToSource, mapSourceRectToViewport, createCropGesture, updateCropGesture, computeCursorAnchoredPan, clampZoom, isNearActualSize, type CropHandle, type CropGesture } from '../image-editor-model'
import { resolveSwitchDirection, type SwitchDirection } from '../../application/document-switch'
import type { ActiveTool } from './BottomDock'
import type { MarkupMode } from './SubToolbars/MarkupSubToolbar'
import type { MosaicType, MosaicShape } from './SubToolbars/MosaicSubToolbar'
import type { TextBgStyle } from '../../domain/editor-state'

interface CanvasViewportProps {
  source: DecodedSource | null
  state: EditorState
  activeTool: ActiveTool
  markupMode: MarkupMode
  markupColor: string
  markupWidth: number
  mosaicType: MosaicType
  mosaicBlockSize: number
  /** Brush strokes (WeChat/QQ style) vs a dragged box. */
  mosaicShape: MosaicShape
  /** Brush diameter in source pixels; ignored while mosaicShape is 'rect'. */
  mosaicBrushSize: number
  /** Smart-erase mask shape: a box drawn by the toolbar, or a painted stroke. */
  eraseMaskShape: MosaicShape
  /** Painted smart-erase mask diameter in source pixels. */
  eraseBrushSize: number
  /**
   * Mirrored out: true while a pointer gesture (pan / crop drag / stroke) is
   * in flight. Keyboard undo/redo in the parent reads this to avoid swapping
   * the document underneath a live gesture.
   */
  gestureActiveRef?: { current: boolean }
  /**
   * Whether a painted stroke may open an erase region. Off while the watermark
   * tool shows the "add watermark" tab, so that tab's gestures stay inert.
   */
  eraseDrawingEnabled?: boolean
  textStyle: TextBgStyle
  textColor: string
  textSize: number
  isComparingOriginal: boolean
  /**
   * The user's root image (what they loaded), when it differs from the current
   * document. Erase results open as derived documents; while comparing, the
   * viewport shows this root so the feature keeps meaning "original vs now".
   */
  compareSource?: DecodedSource | null
  zoomScale: number
  panOffset: { x: number; y: number }
  onZoomChange: (scale: number) => void
  onPanChange: (offset: { x: number; y: number }) => void
  /** Frames the whole document in the window; owned by the app so every fit path agrees. */
  onFitViewport: () => void
  /** Live crop drag output; null-safe clamp/commit belongs to the session. */
  onCropChange: (crop: Rect) => void
  /** Ends a crop drag so it becomes one undoable step. */
  onCommitDraft: () => void
  /** Drops an interrupted gesture, restoring the committed crop. */
  onCancelDraft: () => void
  /**
   * Adds a finished stroke or text layer. Only the layer is handed over: the
   * state it is drawn onto comes from the session, never from this render.
   */
  onAddAnnotation: (layer: AnnotationLayer) => void
  /** Identity of the open document (working-set root id); changes on switch. */
  docKey?: string | null
  /** Gesture hint for the pending switch: slide direction, or open fade. */
  switchHint?: CanvasSwitchHint | null
}

/** Direction the viewport should animate toward for the next document. */
export interface CanvasSwitchHint {
  dir: SwitchDirection | 'open'
  /** Monotonic token so a newer click supersedes an in-flight animation. */
  token: number
}

export const CanvasViewport: React.FC<CanvasViewportProps> = ({
  source,
  state,
  activeTool,
  markupMode,
  markupColor,
  markupWidth,
  mosaicType,
  mosaicBlockSize,
  mosaicShape,
  mosaicBrushSize,
  eraseMaskShape,
  eraseBrushSize,
  eraseDrawingEnabled = true,
  gestureActiveRef,
  textStyle,
  textColor,
  textSize,
  isComparingOriginal,
  compareSource = null,
  zoomScale,
  panOffset,
  onZoomChange,
  onPanChange,
  onFitViewport,
  onCropChange,
  onCommitDraft,
  onCancelDraft,
  onAddAnnotation,
  docKey = null,
  switchHint = null,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlaySvgRef = useRef<SVGSVGElement>(null)

  interface DrawingStroke {
    mode: MarkupMode | 'mosaic' | 'mosaic-brush' | 'erase-brush' | 'erase-rect'
    points: Array<{ x: number; y: number }>
    canvasPoints: Array<{ x: number; y: number }>
    rect?: Rect
    canvasRect?: Rect
  }

  // Ephemeral active drawing state
  const [currentStroke, setCurrentStroke] = useState<DrawingStroke | null>(null)
  const currentStrokeRef = useRef<DrawingStroke | null>(null)

  // Active inline text input
  const [activeTextInput, setActiveTextInput] = useState<{
    x: number
    y: number
    screenX: number
    screenY: number
    text: string
  } | null>(null)

  // Active crop gesture
  const cropGestureRef = useRef<CropGesture | null>(null)
  // Keep the parent's gesture mirror in sync at every lifecycle boundary.
  const syncGestureActive = () => {
    const ref = gestureActiveRef
    if (ref) ref.current = Boolean(isPanningRef.current || cropGestureRef.current || currentStrokeRef.current)
  }

  // Panning drag state
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 })
  const isSpaceDownRef = useRef(false)

  // Canvas factory
  const factory = useRef(createBrowserCanvasFactory()).current

  // Image-switch transition. When the open document changes, the master
  // canvas still shows the outgoing bitmap (the session decode has not
  // committed yet), so we can snapshot it in a layout effect, then slide
  // old and new apart like turning a page. Animated on the canvas itself,
  // never on the pan/zoom wrapper, so viewport transforms stay untouched.
  const [switchFx, setSwitchFx] = useState<{
    snapshot: HTMLCanvasElement | null
    dir: SwitchDirection | 'open'
    token: number
    width: number
    height: number
  } | null>(null)
  const prevDocKeyRef = useRef<string | null>(null)
  const fxCanvasRef = useRef<HTMLCanvasElement>(null)
  const fxTokenRef = useRef(0)
  const switchHintRef = useRef(switchHint)
  switchHintRef.current = switchHint
  const zoomScaleRef = useRef(zoomScale)
  zoomScaleRef.current = zoomScale
  const panOffsetRef = useRef(panOffset)
  panOffsetRef.current = panOffset

  // Render canvas pipeline
  // The preview renders straight into the master canvas (drawEditor paints
  // the full opaque base first), and scratch canvases (mosaic/blur/watermark
  // layers) come from a per-size pool whose handout index resets each frame —
  // a frame's scratch canvases are unreferenced after the render callback
  // returns, so frame N+1 reuses them instead of allocating ~17MB churn per
  // frame.
  const masterUsedRef = useRef(false)
  const previewPoolRef = useRef<Map<string, RenderCanvas[]>>(new Map())
  const poolIndexRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    if (!source || !canvasRef.current) return
    const canvas = canvasRef.current
    // If comparing original, render the root image with its own pristine
    // state: the current document may be a derived bitmap (an erase result),
    // whose "original" is no longer what the user means by 原图.
    const viewSource = isComparingOriginal && compareSource ? compareSource : source
    const effectiveState = isComparingOriginal && compareSource
      ? createEditorState(viewSource.width, viewSource.height)
      : state

    const cancel = schedulePreview(async () => {
      try {
        // Reset the per-frame handout: this frame's base canvas is the
        // master, later creates (layer scratch) come from the pool.
        masterUsedRef.current = false
        poolIndexRef.current.clear()
        const previewFactory: CanvasFactory = {
          create: (width: number, height: number) => {
            if (!masterUsedRef.current) {
              masterUsedRef.current = true
              canvas.width = width
              canvas.height = height
              return canvas as unknown as RenderCanvas
            }
            const key = `${width}x${height}`
            let pool = previewPoolRef.current.get(key)
            if (!pool) {
              pool = []
              previewPoolRef.current.set(key, pool)
            }
            const index = poolIndexRef.current.get(key) ?? 0
            poolIndexRef.current.set(key, index + 1)
            if (index < pool.length) return pool[index]
            const made = factory.create(width, height)
            // Cap per-size scratch retention; beyond it, allocate transiently.
            if (pool.length < 6) pool.push(made)
            return made
          },
        }
        const rendered = renderEditor(viewSource, effectiveState, previewFactory, {
          maxEdge: PREVIEW_MAX_EDGE,
          showFullSource: activeTool === 'crop',
        })
        // The base canvas WAS the master — no copy pass needed. Only the
        // compare/full-source paths that bypassed the master handout (the
        // master was used by something else this frame) still copy.
        if (rendered.canvas !== (canvas as unknown as RenderCanvas)) {
          canvas.width = rendered.width
          canvas.height = rendered.height
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.clearRect(0, 0, rendered.width, rendered.height)
            ctx.drawImage(rendered.canvas as CanvasImageSource, 0, 0)
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          console.error('Canvas render error:', err)
        }
      }
    })

    return cancel
  }, [source, state, activeTool, isComparingOriginal, compareSource, factory])

  // Capture the outgoing frame the moment the document identity flips —
  // synchronously, before the async session decode repaints the canvas.
  useLayoutEffect(() => {
    const prev = prevDocKeyRef.current
    prevDocKeyRef.current = docKey
    if (typeof window === 'undefined') return
    if (!docKey || prev === docKey || !canvasRef.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const canvas = canvasRef.current
    let snapshot: HTMLCanvasElement | null = null
    if (prev) {
      snapshot = document.createElement('canvas')
      snapshot.width = canvas.width
      snapshot.height = canvas.height
      snapshot.getContext('2d')?.drawImage(canvas, 0, 0)
    }
    fxTokenRef.current += 1
    setSwitchFx({
      snapshot,
      dir: switchHintRef.current?.dir ?? 'forward',
      token: switchHintRef.current?.token ?? fxTokenRef.current,
      width: canvas.width,
      height: canvas.height,
    })
  }, [docKey])

  // Play the transition: the new frame slides in from the turn direction
  // while the frozen old frame slides out the other way. Opacity holds at 0
  // for the first third so the async repaint of the new document lands
  // before the incoming image becomes visible.
  useEffect(() => {
    if (!switchFx) return
    const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
    const DUR = 360
    const master = canvasRef.current
    if (master && switchFx.dir !== 'open') {
      const fromX = switchFx.dir === 'forward' ? 22 : -22
      master.animate(
        [
          { transform: `translateX(${fromX}%)`, opacity: 0 },
          { transform: `translateX(${fromX * 0.45}%)`, opacity: 0, offset: 0.35 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: DUR, easing: EASE },
      )
      const overlay = fxCanvasRef.current
      if (overlay && switchFx.snapshot) {
        overlay.width = switchFx.snapshot.width
        overlay.height = switchFx.snapshot.height
        overlay.getContext('2d')?.drawImage(switchFx.snapshot, 0, 0)
        const outX = switchFx.dir === 'forward' ? -18 : 18
        overlay.animate(
          [
            { transform: 'none', opacity: 1 },
            { transform: `translateX(${outX}%) scale(0.97)`, opacity: 0 },
          ],
          { duration: DUR, easing: EASE, fill: 'forwards' },
        )
      }
    } else if (master) {
      // First open of a document (nothing to turn away): a quiet reveal.
      master.animate(
        [
          { transform: 'scale(0.955)', opacity: 0 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 300, easing: EASE },
      )
    }
    const timer = window.setTimeout(() => setSwitchFx(null), DUR + 80)
    return () => window.clearTimeout(timer)
  }, [switchFx])

  // Space key tracking for Pan
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        isSpaceDownRef.current = true
        if (containerRef.current) containerRef.current.style.cursor = 'grab'
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpaceDownRef.current = false
        if (containerRef.current) containerRef.current.style.cursor = ''
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  // Mouse wheel zoom (cursor-centered). Native listener with
  // passive: false — React attaches wheel passively at the root, so an
  // onWheel preventDefault is a no-op (and the console warns).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = container.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const factor = e.deltaY < 0 ? 1.15 : 0.87
      const newScale = clampZoom(zoomScaleRef.current * factor)

      const { x: newPanX, y: newPanY } = computeCursorAnchoredPan(
        mouseX,
        mouseY,
        rect.width / 2,
        rect.height / 2,
        panOffsetRef.current,
        zoomScaleRef.current,
        newScale
      )

      onZoomChange(newScale)
      onPanChange({ x: newPanX, y: newPanY })
    }
    container.addEventListener('wheel', handler, { passive: false })
    return () => container.removeEventListener('wheel', handler)
  }, [onZoomChange, onPanChange])

  // Convert screen coordinates to canvas-local coordinates// Convert screen coordinates to canvas-local coordinates (0 to canvas.width, 0 to canvas.height)
  const getCanvasLocalCoord = useCallback((clientX: number, clientY: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 }
    const canvasRect = canvasRef.current.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvasRef.current.width, (clientX - canvasRect.left) / zoomScale)),
      y: Math.max(0, Math.min(canvasRef.current.height, (clientY - canvasRect.top) / zoomScale)),
    }
  }, [zoomScale])

  // Convert screen coordinates to intrinsic source image coordinates
  const getPointerSourceCoord = useCallback((clientX: number, clientY: number) => {
    if (!canvasRef.current || !source) return { x: 0, y: 0 }
    const local = getCanvasLocalCoord(clientX, clientY)
    const isCropMode = activeTool === 'crop'
    const baseW = isCropMode ? source.width : state.crop.width
    const baseH = isCropMode ? source.height : state.crop.height
    const rotated = rotatedDimensions(baseW, baseH, state.rotation)
    const scaleFactorX = rotated.width / (canvasRef.current.width || 1)
    const scaleFactorY = rotated.height / (canvasRef.current.height || 1)
    const vpX = local.x * scaleFactorX
    const vpY = local.y * scaleFactorY
    const mapped = mapPointerToSource(
      { x: vpX, y: vpY },
      { width: baseW, height: baseH },
      state.rotation,
      state.flipX,
      state.flipY
    )
    if (isCropMode) {
      return mapped
    }
    return {
      x: mapped.x + state.crop.x,
      y: mapped.y + state.crop.y,
    }
  }, [source, state, activeTool, getCanvasLocalCoord])

  // Pointer Down handling
  const handlePointerDown = (e: React.PointerEvent) => {
    if (!source || !canvasRef.current || !containerRef.current) return

    // Middle button or Space held -> Pan
    if (e.button === 1 || isSpaceDownRef.current || activeTool === 'none') {
      isPanningRef.current = true
      syncGestureActive()
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: panOffset.x,
        panY: panOffset.y,
      }
      containerRef.current.style.cursor = 'grabbing'
      // Capture so a fast drag that leaves the viewport keeps panning and still
      // delivers its pointerup.
      try {
        containerRef.current.setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      return
    }

    // Right click -> Ignore
    if (e.button !== 0) return

    const sourcePt = getPointerSourceCoord(e.clientX, e.clientY)
    const localPt = getCanvasLocalCoord(e.clientX, e.clientY)

    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }

    if (activeTool === 'markup') {
      const stroke: DrawingStroke = {
        mode: markupMode,
        points: [sourcePt],
        canvasPoints: [localPt],
        rect: { x: sourcePt.x, y: sourcePt.y, width: 0, height: 0 },
        canvasRect: { x: localPt.x, y: localPt.y, width: 0, height: 0 },
      }
      currentStrokeRef.current = stroke
      syncGestureActive()
      setCurrentStroke(stroke)
    } else if (activeTool === 'mosaic') {
      const stroke: DrawingStroke = {
        mode: mosaicShape === 'brush' ? 'mosaic-brush' : 'mosaic',
        points: [sourcePt],
        canvasPoints: [localPt],
        rect: { x: sourcePt.x, y: sourcePt.y, width: 0, height: 0 },
        canvasRect: { x: localPt.x, y: localPt.y, width: 0, height: 0 },
      }
      currentStrokeRef.current = stroke
      syncGestureActive()
      setCurrentStroke(stroke)
    } else if (activeTool === 'watermark' && eraseDrawingEnabled && eraseMaskShape === 'brush') {
      const stroke: DrawingStroke = {
        mode: 'erase-brush',
        points: [sourcePt],
        canvasPoints: [localPt],
        rect: { x: sourcePt.x, y: sourcePt.y, width: 0, height: 0 },
        canvasRect: { x: localPt.x, y: localPt.y, width: 0, height: 0 },
      }
      currentStrokeRef.current = stroke
      syncGestureActive()
      setCurrentStroke(stroke)
    } else if (activeTool === 'watermark' && eraseDrawingEnabled && eraseMaskShape === 'rect') {
      // Drag-to-draw the erase box. Before this branch the gesture fell through
      // every case and did nothing, so box mode could only place the toolbar's
      // centered template and never a box where the watermark actually is.
      const stroke: DrawingStroke = {
        mode: 'erase-rect',
        points: [sourcePt],
        canvasPoints: [localPt],
        rect: { x: sourcePt.x, y: sourcePt.y, width: 0, height: 0 },
        canvasRect: { x: localPt.x, y: localPt.y, width: 0, height: 0 },
      }
      currentStrokeRef.current = stroke
      syncGestureActive()
      setCurrentStroke(stroke)
    } else if (activeTool === 'text') {
      setActiveTextInput({
        x: sourcePt.x,
        y: sourcePt.y,
        screenX: e.clientX,
        screenY: e.clientY,
        text: '',
      })
    }
  }

  // Pointer Move handling
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!source || !canvasRef.current) return

    // No button is held: the pointerup happened outside the captured element
    // (or capture was lost). Ending the gesture here keeps a drag from sticking
    // to the cursor for the rest of the session.
    if (e.buttons === 0) {
      if (isPanningRef.current || cropGestureRef.current || currentStrokeRef.current) {
        handlePointerUp(e)
      }
      return
    }

    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      onPanChange({
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      })
      return
    }

    // Crop dragging
    if (cropGestureRef.current) {
      const sourcePt = getPointerSourceCoord(e.clientX, e.clientY)
      onCropChange(updateCropGesture(cropGestureRef.current, sourcePt))
      return
    }

    // Active drawing stroke
    if (currentStrokeRef.current) {
      const sourcePt = getPointerSourceCoord(e.clientX, e.clientY)
      const localPt = getCanvasLocalCoord(e.clientX, e.clientY)

      const mode = currentStrokeRef.current.mode
      if (mode === 'brush' || mode === 'highlighter' || mode === 'mosaic-brush' || mode === 'erase-brush') {
        const lastPoint = currentStrokeRef.current.points[currentStrokeRef.current.points.length - 1]
        // Sub-pixel source moves cannot alter the rendered stroke; skipping
        // them avoids both state bloat and a re-render per pointer event.
        if (isStrokePointRedundant(lastPoint, sourcePt)) return
        const nextPoints = [...currentStrokeRef.current.points, sourcePt]
        const nextCanvasPoints = [...currentStrokeRef.current.canvasPoints, localPt]
        const updated: DrawingStroke = {
          ...currentStrokeRef.current,
          points: nextPoints,
          canvasPoints: nextCanvasPoints,
        }
        currentStrokeRef.current = updated
        setCurrentStroke(updated)
      } else {
        // Shapes, arrow, or mosaic
        const p0 = currentStrokeRef.current.points[0]
        const cp0 = currentStrokeRef.current.canvasPoints[0]
        const minX = Math.min(p0.x, sourcePt.x)
        const minY = Math.min(p0.y, sourcePt.y)
        const w = Math.abs(sourcePt.x - p0.x)
        const h = Math.abs(sourcePt.y - p0.y)
        const minCpX = Math.min(cp0.x, localPt.x)
        const minCpY = Math.min(cp0.y, localPt.y)
        const cpW = Math.abs(localPt.x - cp0.x)
        const cpH = Math.abs(localPt.y - cp0.y)
        const updated: DrawingStroke = {
          ...currentStrokeRef.current,
          points: [p0, sourcePt],
          canvasPoints: [cp0, localPt],
          rect: { x: minX, y: minY, width: w, height: h },
          canvasRect: { x: minCpX, y: minCpY, width: cpW, height: cpH },
        }
        currentStrokeRef.current = updated
        setCurrentStroke(updated)
      }
    }
  }

  // Pointer Up handling
  const handlePointerUp = (e?: React.PointerEvent) => {
    if (e) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
    }

    if (isPanningRef.current) {
      isPanningRef.current = false
      syncGestureActive()
      if (containerRef.current) {
        containerRef.current.style.cursor = isSpaceDownRef.current ? 'grab' : ''
      }
    }

    if (cropGestureRef.current) {
      cropGestureRef.current = null
      syncGestureActive()
      // Commit the session's own draft: the crop the user dragged to is queued
      // as a live edit, and reading a render-time `state` here can lag behind
      // the last pointer move (or predate the drag entirely).
      onCommitDraft()
      return
    }

    const stroke = currentStrokeRef.current || currentStroke
    if (stroke) {
      currentStrokeRef.current = null
      syncGestureActive()
      setCurrentStroke(null)

      let newLayer: AnnotationLayer | null = null
      const id = `annot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

      if (stroke.mode === 'brush' || stroke.mode === 'highlighter') {
        if (stroke.points.length > 0) {
          newLayer = {
            id,
            type: stroke.mode,
            points: stroke.points,
            color: markupColor,
            strokeWidth: markupWidth,
            opacity: stroke.mode === 'highlighter' ? 0.45 : 1.0,
          }
        }
      } else if (stroke.mode === 'arrow') {
        if (stroke.points.length >= 2) {
          newLayer = {
            id,
            type: 'arrow',
            points: stroke.points,
            color: markupColor,
            strokeWidth: markupWidth,
          }
        }
      } else if (stroke.mode === 'rect' || stroke.mode === 'ellipse') {
        if (stroke.rect && stroke.rect.width > 3 && stroke.rect.height > 3) {
          newLayer = {
            id,
            type: stroke.mode,
            rect: stroke.rect,
            color: markupColor,
            strokeWidth: markupWidth,
          }
        }
      } else if (stroke.mode === 'mosaic') {
        if (stroke.rect && stroke.rect.width > 4 && stroke.rect.height > 4) {
          newLayer = {
            id,
            type: 'mosaic',
            rect: stroke.rect,
            color: '#000000',
            strokeWidth: 1,
            mosaicType,
            mosaicBlockSize,
          }
        }
      } else if (stroke.mode === 'mosaic-brush') {
        if (stroke.points.length > 0) {
          const half = mosaicBrushSize / 2
          let minX = Number.POSITIVE_INFINITY
          let minY = Number.POSITIVE_INFINITY
          let maxX = Number.NEGATIVE_INFINITY
          let maxY = Number.NEGATIVE_INFINITY
          for (const point of stroke.points) {
            if (point.x < minX) minX = point.x
            if (point.y < minY) minY = point.y
            if (point.x > maxX) maxX = point.x
            if (point.y > maxY) maxY = point.y
          }
          newLayer = {
            id,
            type: 'mosaic',
            // `points` marks this as a brush mosaic; the renderer strokes it
            // through a mask instead of clipping a rectangle.
            points: stroke.points,
            // Bounding box of the stroke, kept for consumers that only know
            // about rect-based mosaic layers.
            rect: {
              x: minX - half,
              y: minY - half,
              width: maxX - minX + half * 2,
              height: maxY - minY + half * 2,
            },
            color: '#000000',
            strokeWidth: mosaicBrushSize,
            mosaicType,
            mosaicBlockSize,
          }
        }
      } else if (stroke.mode === 'erase-brush') {
        if (stroke.points.length > 0) {
          const half = eraseBrushSize / 2
          let minX = Number.POSITIVE_INFINITY
          let minY = Number.POSITIVE_INFINITY
          let maxX = Number.NEGATIVE_INFINITY
          let maxY = Number.NEGATIVE_INFINITY
          for (const point of stroke.points) {
            if (point.x < minX) minX = point.x
            if (point.y < minY) minY = point.y
            if (point.x > maxX) maxX = point.x
            if (point.y > maxY) maxY = point.y
          }
          newLayer = {
            id,
            type: 'erase-ai',
            // `points` marks a painted mask: only the stroke is inpainted, not
            // the box around it. `rect` is kept as the stroke's bounding box so
            // rect-only consumers still know where the region is.
            points: stroke.points,
            rect: {
              x: minX - half,
              y: minY - half,
              width: maxX - minX + half * 2,
              height: maxY - minY + half * 2,
            },
            color: '#34d399',
            strokeWidth: eraseBrushSize,
          }
        }
      } else if (stroke.mode === 'erase-rect') {
        if (stroke.rect && stroke.rect.width > 4 && stroke.rect.height > 4) {
          newLayer = {
            id,
            type: 'erase-ai',
            rect: stroke.rect,
            color: '#34d399',
            strokeWidth: 0,
          }
        }
      }

      if (newLayer) {
        // Hand over the layer alone: the state it lands on comes from the
        // session, so a queued update can never be overwritten with a stale copy.
        onAddAnnotation(newLayer)
      }
    }
  }

  // The browser cancelled the gesture (system gesture, focus loss, capture
  // stolen). Abandon it: no layer is added and no crop step is recorded.
  const handlePointerCancel = () => {
    if (isPanningRef.current) {
      isPanningRef.current = false
      syncGestureActive()
      if (containerRef.current) {
        containerRef.current.style.cursor = isSpaceDownRef.current ? 'grab' : ''
      }
    }
    if (cropGestureRef.current) {
      cropGestureRef.current = null
      syncGestureActive()
      onCancelDraft()
      return
    }
    if (currentStrokeRef.current) {
      currentStrokeRef.current = null
      syncGestureActive()
      setCurrentStroke(null)
    }
    setActiveTextInput(null)
  }

  // Start Crop Handle Gesture
  const handleCropHandleDown = (handle: CropHandle, e: React.PointerEvent) => {
    e.stopPropagation()
    if (!source || !canvasRef.current) return
    // Crop handles sit above the canvas and stop propagation, so the container's
    // pointerdown capture never runs. Capture here or a drag that leaves the
    // handle is never completed and the crop overlay stays stuck to the cursor.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    const sourcePt = getPointerSourceCoord(e.clientX, e.clientY)
    syncGestureActive()
    cropGestureRef.current = createCropGesture(
      handle,
      sourcePt,
      state.crop,
      { x: 0, y: 0, width: source.width, height: source.height },
      state.aspectRatio,
    )
    syncGestureActive()
  }

  // Double click toggles Fit / 100%
  const handleDoubleClick = () => {
    if (isNearActualSize(zoomScale)) {
      onFitViewport()
    } else {
      onZoomChange(1.0)
    }
  }

  // Commit text input
  const handleCommitText = () => {
    if (activeTextInput && activeTextInput.text.trim()) {
      const id = `text_${Date.now()}`
      const newLayer: AnnotationLayer = {
        id,
        type: 'text',
        rect: {
          x: activeTextInput.x,
          y: activeTextInput.y,
          width: 100,
          height: textSize,
        },
        text: activeTextInput.text.trim(),
        color: textColor,
        fontSize: textSize,
        textBgStyle: textStyle,
        strokeWidth: 1,
      }
      onAddAnnotation(newLayer)
    }
    setActiveTextInput(null)
  }

  // Viewport crop rect calculation (for handle overlays)
  const rotatedDim = source ? rotatedDimensions(source.width, source.height, state.rotation) : null
  // Plan the bitmap size instead of measuring the canvas element: the render
  // effect resizes it after paint, so a DOM read here reports the previous
  // document's size (or the 300x150 default) and the crop rectangle is drawn
  // against the wrong scale until an unrelated re-render happens to fix it.
  const renderPlan = useMemo(() => {
    if (!source) return { width: 0, height: 0 }
    const viewSource = isComparingOriginal && compareSource ? compareSource : source
    const effectiveState = isComparingOriginal && compareSource
      ? createEditorState(viewSource.width, viewSource.height)
      : state
    return planRenderDimensions(effectiveState, PREVIEW_MAX_EDGE, activeTool === 'crop')
  }, [source, state, activeTool, isComparingOriginal, compareSource])
  const canvasWidth = renderPlan.width
  const canvasHeight = renderPlan.height
  // Canvas pixels per source pixel, for draft overlays drawn in canvas space
  // that must match the brush width in source pixels.
  const overlayScale = useMemo(() => {
    if (!source || canvasWidth <= 0) return 1
    const baseWidth = activeTool === 'crop' ? source.width : state.crop.width
    const baseHeight = activeTool === 'crop' ? source.height : state.crop.height
    const rotated = rotatedDimensions(baseWidth, baseHeight, state.rotation)
    return rotated.width > 0 ? canvasWidth / rotated.width : 1
  }, [source, activeTool, state.crop.width, state.crop.height, state.rotation, canvasWidth])
  const cropScale = (source && activeTool === 'crop' && rotatedDim && canvasWidth > 0)
    ? canvasWidth / rotatedDim.width
    : 1

  const viewportCrop = source && activeTool === 'crop'
    ? mapSourceRectToViewport(
        state.crop,
        { width: source.width, height: source.height },
        state.rotation,
        state.flipX,
        state.flipY
      )
    : null

  const displayCrop = viewportCrop
    ? {
        x: viewportCrop.x * cropScale,
        y: viewportCrop.y * cropScale,
        width: viewportCrop.width * cropScale,
        height: viewportCrop.height * cropScale,
      }
    : null

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={handleDoubleClick}
      className={`relative w-full h-full overflow-hidden select-none touch-none flex items-center justify-center ${
        activeTool === 'none' || isSpaceDownRef.current ? 'cursor-grab' : 'cursor-crosshair'
      }`}
    >
      {/* Transformed spatial viewport container */}
      <div
        style={{
          transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`,
          transformOrigin: 'center center',
          transition: isPanningRef.current ? 'none' : 'transform 0.05s linear',
        }}
        className="relative flex items-center justify-center shadow-2xl shadow-black/90"
      >
        {/* Alpha checkerboard backdrop under image */}
        <div className="absolute inset-0 bg-checkerboard rounded-sm" />

        {/* Master rendered canvas */}
        <canvas ref={canvasRef} className="block relative z-10 max-w-none" />
        {switchFx?.snapshot && (
          <canvas
            key={switchFx.token}
            ref={fxCanvasRef}
            className="pointer-events-none absolute inset-0 z-30 max-w-none"
            style={{ width: switchFx.width, height: switchFx.height }}
          />
        )}

        {/* Ephemeral in-flight drawing stroke overlay */}
        {currentStroke && (
          <svg
            ref={overlaySvgRef}
            className="absolute inset-0 z-20 pointer-events-none w-full h-full"
            style={{ width: canvasWidth, height: canvasHeight }}
          >
            {(currentStroke.mode === 'brush' || currentStroke.mode === 'highlighter') && (
              <polyline
                points={(currentStroke.canvasPoints || currentStroke.points).map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={markupColor}
                strokeWidth={markupWidth}
                strokeLinecap={currentStroke.mode === 'highlighter' ? 'square' : 'round'}
                strokeLinejoin="round"
                opacity={currentStroke.mode === 'highlighter' ? 0.45 : 1.0}
              />
            )}
            {currentStroke.mode === 'arrow' && (currentStroke.canvasPoints || currentStroke.points).length >= 2 && (
              <line
                x1={(currentStroke.canvasPoints || currentStroke.points)[0].x}
                y1={(currentStroke.canvasPoints || currentStroke.points)[0].y}
                x2={(currentStroke.canvasPoints || currentStroke.points)[1].x}
                y2={(currentStroke.canvasPoints || currentStroke.points)[1].y}
                stroke={markupColor}
                strokeWidth={markupWidth}
                strokeLinecap="round"
              />
            )}
            {currentStroke.mode === 'rect' && (currentStroke.canvasRect || currentStroke.rect) && (
              <rect
                x={(currentStroke.canvasRect || currentStroke.rect)!.x}
                y={(currentStroke.canvasRect || currentStroke.rect)!.y}
                width={(currentStroke.canvasRect || currentStroke.rect)!.width}
                height={(currentStroke.canvasRect || currentStroke.rect)!.height}
                fill="none"
                stroke={markupColor}
                strokeWidth={markupWidth}
              />
            )}
            {currentStroke.mode === 'ellipse' && (currentStroke.canvasRect || currentStroke.rect) && (
              <ellipse
                cx={(currentStroke.canvasRect || currentStroke.rect)!.x + (currentStroke.canvasRect || currentStroke.rect)!.width / 2}
                cy={(currentStroke.canvasRect || currentStroke.rect)!.y + (currentStroke.canvasRect || currentStroke.rect)!.height / 2}
                rx={(currentStroke.canvasRect || currentStroke.rect)!.width / 2}
                ry={(currentStroke.canvasRect || currentStroke.rect)!.height / 2}
                fill="none"
                stroke={markupColor}
                strokeWidth={markupWidth}
              />
            )}
            {currentStroke.mode === 'mosaic-brush' && (() => {
              const brushWidth = Math.max(2, mosaicBrushSize * overlayScale)
              const pts = currentStroke.canvasPoints || currentStroke.points
              const polylinePoints = pts.map((p) => `${p.x},${p.y}`).join(' ')
              return (
                <>
                  {pts.length === 1 ? (
                    <circle
                      cx={pts[0].x}
                      cy={pts[0].y}
                      r={brushWidth / 2}
                      fill="rgba(34, 197, 94, 0.18)"
                      stroke="#22c55e"
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                    />
                  ) : (
                    <>
                      <polyline
                        points={polylinePoints}
                        fill="none"
                        stroke="rgba(34, 197, 94, 0.18)"
                        strokeWidth={brushWidth}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <polyline
                        points={polylinePoints}
                        fill="none"
                        stroke="#22c55e"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeDasharray="4 4"
                      />
                    </>
                  )}
                </>
              )
            })()}
            {currentStroke.mode === 'erase-brush' && (() => {
              const brushWidth = Math.max(2, eraseBrushSize * overlayScale)
              const pts = currentStroke.canvasPoints || currentStroke.points
              const polylinePoints = pts.map((p) => `${p.x},${p.y}`).join(' ')
              return (
                <>
                  {pts.length === 1 ? (
                    <circle
                      cx={pts[0].x}
                      cy={pts[0].y}
                      r={brushWidth / 2}
                      fill="rgba(52, 211, 153, 0.20)"
                      stroke="#34d399"
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                    />
                  ) : (
                    <polyline
                      points={polylinePoints}
                      fill="none"
                      stroke="rgba(52, 211, 153, 0.20)"
                      strokeWidth={brushWidth}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                </>
              )
            })()}
            {currentStroke.mode === 'mosaic' && (currentStroke.canvasRect || currentStroke.rect) && (
              <rect
                x={(currentStroke.canvasRect || currentStroke.rect)!.x}
                y={(currentStroke.canvasRect || currentStroke.rect)!.y}
                width={(currentStroke.canvasRect || currentStroke.rect)!.width}
                height={(currentStroke.canvasRect || currentStroke.rect)!.height}
                fill="rgba(255, 255, 255, 0.2)"
                stroke="#22c55e"
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
            )}
            {currentStroke.mode === 'erase-rect' && (currentStroke.canvasRect || currentStroke.rect) && (
              <rect
                x={(currentStroke.canvasRect || currentStroke.rect)!.x}
                y={(currentStroke.canvasRect || currentStroke.rect)!.y}
                width={(currentStroke.canvasRect || currentStroke.rect)!.width}
                height={(currentStroke.canvasRect || currentStroke.rect)!.height}
                fill="rgba(52, 211, 153, 0.12)"
                stroke="#34d399"
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
            )}
          </svg>
        )}

        {/* Interactive Crop Handles Overlay */}
        {activeTool === 'crop' && displayCrop && (
          <div
            style={{
              left: `${displayCrop.x}px`,
              top: `${displayCrop.y}px`,
              width: `${displayCrop.width}px`,
              height: `${displayCrop.height}px`,
            }}
            className="absolute z-30 border-2 border-emerald-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.65)] pointer-events-none"
          >
            {/* Rule-of-thirds grid lines */}
            <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none opacity-40">
              <div className="border-r border-b border-emerald-300/40" />
              <div className="border-r border-b border-emerald-300/40" />
              <div className="border-b border-emerald-300/40" />
              <div className="border-r border-b border-emerald-300/40" />
              <div className="border-r border-b border-emerald-300/40" />
              <div className="border-b border-emerald-300/40" />
              <div className="border-r border-emerald-300/40" />
              <div className="border-r border-emerald-300/40" />
              <div />
            </div>

            {/* Move area */}
            <div
              onPointerDown={(e) => handleCropHandleDown('move', e)}
              className="absolute inset-0 cursor-move pointer-events-auto"
            />

            {/* 8 Corner & Edge Handles */}
            {(['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'] as CropHandle[]).map((handle) => {
              const handlePosStyle =
                handle === 'nw'
                  ? 'top-[-8px] left-[-8px] cursor-nwse-resize'
                  : handle === 'ne'
                  ? 'top-[-8px] right-[-8px] cursor-nesw-resize'
                  : handle === 'sw'
                  ? 'bottom-[-8px] left-[-8px] cursor-nesw-resize'
                  : handle === 'se'
                  ? 'bottom-[-8px] right-[-8px] cursor-nwse-resize'
                  : handle === 'n'
                  ? 'top-[-8px] left-1/2 -translate-x-1/2 cursor-ns-resize'
                  : handle === 's'
                  ? 'bottom-[-8px] left-1/2 -translate-x-1/2 cursor-ns-resize'
                  : handle === 'w'
                  ? 'left-[-8px] top-1/2 -translate-y-1/2 cursor-ew-resize'
                  : 'right-[-8px] top-1/2 -translate-y-1/2 cursor-ew-resize'

              return (
                <div
                  key={handle}
                  onPointerDown={(e) => handleCropHandleDown(handle, e)}
                  className={`absolute w-4 h-4 bg-emerald-400 rounded-full border-2 border-zinc-950 pointer-events-auto shadow-md ${handlePosStyle}`}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Floating inline text input on canvas */}
      {activeTextInput && (
        <div
          style={{
            left: `${activeTextInput.screenX}px`,
            top: `${activeTextInput.screenY}px`,
          }}
          className="fixed z-50 -translate-y-1/2 flex items-center gap-1.5 p-1 rounded-xl bg-zinc-900/95 backdrop-blur-2xl border border-zinc-700 shadow-2xl"
        >
          <input
            autoFocus
            type="text"
            placeholder="输入文字..."
            value={activeTextInput.text}
            onChange={(e) =>
              setActiveTextInput((prev) => (prev ? { ...prev, text: e.target.value } : null))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCommitText()
              if (e.key === 'Escape') setActiveTextInput(null)
            }}
            className="px-2.5 py-1 text-sm bg-zinc-800 text-zinc-100 rounded-lg border border-zinc-700 outline-none focus:border-emerald-500 w-44"
          />
          <button
            onClick={handleCommitText}
            className="px-2.5 py-1 text-xs bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium rounded-lg"
          >
            完成
          </button>
        </div>
      )}
    </div>
  )
}
