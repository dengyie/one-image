import type { AnnotationLayer, EditorState } from '../domain/editor-state'
import { exportEditor, type CanvasFactory, type DecodedSource } from './editor-renderer'
import { drawEraseAiMask } from './editor-renderer'
import { countHolePixels } from '../infrastructure/inpaint/classical-fill'
import { routeFill, resolveEraseProvider, type FillProvider, type SmartEraseMode } from '../infrastructure/inpaint/auto-route'
import { compositeRgba } from '../infrastructure/inpaint/inpaint-core'
import { refineMaskToStrokes } from '../infrastructure/inpaint/mask-refine'
import { runSmartErase, SMART_ERASE_MAX_EDGE, type SmartEraseStage } from '../infrastructure/inpaint/smart-erase'
import { computeLamaCropRect, encodeLamaCrop, postServerLama, blobToBase64 } from '../infrastructure/inpaint/lama-client'
import type { WatermarkEraseType } from '../components/editor/SubToolbars/WatermarkSubToolbar'

// The erase pipeline that used to live inline in App.tsx: snapshot the current
// edit, build the model planes, route the hole to a filler, composite, and
// package the result as a File. React-side concerns (toasts, session edits,
// document switching) stay in the caller — this module is pure pipeline and
// now testable without rendering the app.

export interface EraseRunInput {
  decodedSource: DecodedSource
  file: File
  state: EditorState
  factory: CanvasFactory
  eraseType: WatermarkEraseType
  eraseMode: SmartEraseMode
  modeOverride?: SmartEraseMode
  serverLamaAvailable: boolean
  onStage: (stage: SmartEraseStage | null) => void
}

export type EraseRunOutcome =
  | { ok: false; reason: 'empty-selection' }
  | { ok: true; resultFile: File; provider: FillProvider; regions: number; clearedMask: AnnotationLayer[] }

export async function runErasePipeline(input: EraseRunInput): Promise<EraseRunOutcome> {
  const { decodedSource, file, state, factory, eraseType, eraseMode, modeOverride, serverLamaAvailable, onStage } = input
  // exportEditor strips the marquee layers itself; the mask is drawn from
  // the unstripped state through the same transform pipeline.
  const snapshot = await exportEditor(decodedSource, state, factory, 'image/png', 1)
  const bitmap = await createImageBitmap(snapshot)
  const { width, height } = bitmap
  // The AI pipeline pads to 512-aligned tiles internally; an unbounded
  // source (a 25MB PNG can be 10000px wide) would blow the WASM linear
  // memory. The guard applies to every filler so the limit stays one rule.
  if (Math.max(width, height) > SMART_ERASE_MAX_EDGE) {
    bitmap.close()
    throw new Error(`图片最大边 ${Math.max(width, height)}px 超过消除上限 ${SMART_ERASE_MAX_EDGE}px，请先裁剪或缩放`)
  }

  const makeCanvas = () => factory.create(width, height)
  const ctxOf = (canvas: ReturnType<typeof factory.create>) =>
    canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

  const imageCanvas = makeCanvas()
  ctxOf(imageCanvas).drawImage(bitmap, 0, 0)
  bitmap.close()
  const imageData = ctxOf(imageCanvas).getImageData(0, 0, width, height)

  // Model mask: crisp white-on-black regions.
  const maskCanvas = makeCanvas()
  const maskCtx = ctxOf(maskCanvas)
  maskCtx.fillStyle = '#000000'
  maskCtx.fillRect(0, 0, width, height)
  drawEraseAiMask(maskCtx, state, width, height, 1)
  const maskData = maskCtx.getImageData(0, 0, width, height)

  // Tighten whatever the user drew down to the overlay strokes it actually
  // covers. A box around a watermark otherwise hands the filler a large
  // rectangle of clean background to scramble — the exact reason the result
  // looked "changed". Solid blackout is the guaranteed-cover option and
  // keeps the region exactly as drawn; a filler that detects no stroke at
  // all falls back to the drawn mask, so this can only ever shrink.
  if (eraseType !== 'blackout') {
    const refined = refineMaskToStrokes(
      { data: imageData.data, width, height },
      { data: maskData.data, width, height }
    )
    maskData.data.set(refined)
  }
  const maskGrid = { data: maskData.data, width, height }
  if (countHolePixels(maskGrid) === 0) {
    return { ok: false, reason: 'empty-selection' }
  }

  // Route the hole to a filler: the AI mode picks between local diffusion
  // and Gaussian frost by hole size (MI-GAN only when explicitly picked);
  // the other modes are their own filler.
  // A stale 高质量 selection (server lost its model between renders) must
  // not fall into a guaranteed-502 path — degrade to auto routing.
  const effectiveMode: SmartEraseMode =
    modeOverride ?? (eraseMode === 'lama' && !serverLamaAvailable ? 'auto' : eraseMode)
  const provider: FillProvider =
    eraseType === 'ai'
      ? routeFill({ mode: effectiveMode, mask: maskGrid, imageWidth: width, imageHeight: height }).provider
      : resolveEraseProvider(eraseType)

  // Composite alpha: the working mask blurred twice so the interior stays
  // fully covered while edges feather into untouched pixels. It is built
  // from the same mask the filler sees, so the blend window can never be
  // wider than the hole.
  const refineCanvas = makeCanvas()
  ctxOf(refineCanvas).putImageData(maskData, 0, 0)
  const alphaCanvas = makeCanvas()
  const alphaCtx = ctxOf(alphaCanvas)
  alphaCtx.fillStyle = '#000000'
  alphaCtx.fillRect(0, 0, width, height)
  alphaCtx.filter = 'blur(3px)'
  alphaCtx.drawImage(refineCanvas as unknown as CanvasImageSource, 0, 0)
  alphaCtx.drawImage(refineCanvas as unknown as CanvasImageSource, 0, 0)
  const alphaData = alphaCtx.getImageData(0, 0, width, height)

  let result: ImageData
  if (provider === 'lama') {
    // Server tier: crop to the mask neighborhood, upload the pair, blend
    // the returned fill through the same feathered composite. The canvases
    // are still alive here (the classical retry below relies on that too).
    onStage({ phase: 'upload' })
    const rect = computeLamaCropRect(maskGrid)
    if (!rect) {
      return { ok: false, reason: 'empty-selection' }
    }
    const createBlob = (canvas: unknown): Promise<Blob> => {
      const anyCanvas = canvas as {
        convertToBlob?: (options?: { type: string }) => Promise<Blob>
        toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void
      }
      return anyCanvas.convertToBlob
        ? anyCanvas.convertToBlob({ type: 'image/png' })
        : new Promise<Blob>((resolve, reject) =>
            anyCanvas.toBlob?.((b) => (b ? resolve(b) : reject(new Error('裁剪编码失败'))), 'image/png'),
          )
    }
    const imageBlob = await encodeLamaCrop(imageCanvas as unknown as CanvasImageSource, rect, factory, createBlob)
    const maskBlob = await encodeLamaCrop(refineCanvas as unknown as CanvasImageSource, rect, factory, createBlob)
    onStage({ phase: 'inference', provider: 'lama' })
    const response = await postServerLama(
      { imageBase64: await blobToBase64(imageBlob), maskBase64: await blobToBase64(maskBlob) },
      { timeoutMs: 110_000 },
    )
    if (!response.ok || !response.data) {
      throw new Error(response.message ?? '服务端修复失败')
    }
    const filledBlob = await (async () => {
      const bytes = Uint8Array.from(atob(response.data!.image.base64), (ch) => ch.charCodeAt(0))
      return new Blob([bytes], { type: 'image/png' })
    })()
    const filledBitmap = await createImageBitmap(filledBlob)
    const filledCanvas = makeCanvas()
    const filledCtx = ctxOf(filledCanvas)
    filledCtx.imageSmoothingEnabled = rect.scale < 1
    // The server answers at the encoded resolution; draw it back at the
    // crop's original size so the composite stays in full-frame space.
    filledCtx.drawImage(filledBitmap, rect.x, rect.y, rect.width, rect.height)
    filledBitmap.close()
    const filled = ctxOf(filledCanvas).getImageData(0, 0, width, height)
    result = new ImageData(width, height)
    result.data.set(
      compositeRgba(
        { data: imageData.data, width, height },
        { data: filled.data, width, height },
        { data: alphaData.data, width, height },
      ),
    )
  } else {
    try {
      result = await runSmartErase(
        { image: imageData, mask: maskData, composite: alphaData, provider },
        onStage
      )
    } catch (err) {
      // The classical filler refuses pathologically large working sets; fall
      // back to the model rather than failing the whole edit. The failed run
      // transferred the caller's buffers away (they are detached now), so the
      // retry re-reads the very planes it received from the canvases that
      // produced them: imageCanvas holds the snapshot, refineCanvas the
      // tightened mask, alphaCanvas the feathered alpha.
      if (provider !== 'classical') throw err
      result = await runSmartErase(
        {
          image: ctxOf(imageCanvas).getImageData(0, 0, width, height),
          mask: ctxOf(refineCanvas).getImageData(0, 0, width, height),
          composite: ctxOf(alphaCanvas).getImageData(0, 0, width, height),
          provider: 'migan',
        },
        onStage
      )
    }
  }

  const outCanvas = makeCanvas()
  ctxOf(outCanvas).putImageData(result, 0, 0)
  const outCanvasAny = outCanvas as unknown as {
    convertToBlob?: (options?: { type: string }) => Promise<Blob>
    toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void
  }
  const blob = outCanvasAny.convertToBlob
    ? await outCanvasAny.convertToBlob({ type: 'image/png' })
    : await new Promise<Blob>((resolve, reject) =>
        outCanvasAny.toBlob?.((b) => (b ? resolve(b) : reject(new Error('修复结果导出失败'))), 'image/png')
      )

  const baseName = file.name.replace(/\.[^/.]+$/, '')
  const resultFile = new File([blob], `${baseName}_erased.png`, { type: 'image/png' })
  const clearedMask = (state.annotations ?? []).filter((layer) => layer.type === 'erase-ai')
  const regions = (state.annotations ?? []).filter((layer) => layer.type === 'erase-ai' && layer.rect).length
  return { ok: true, resultFile, provider, regions, clearedMask }
}
