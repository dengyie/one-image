import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { validateImageFile } from './application/file-policy'
import { exportEditor, type DecodedSource } from './application/editor-renderer'
import { createBrowserCanvasFactory, decodeEditorSource } from './infrastructure/editor-canvas'
import {
  type EditorState,
  type Adjustments,
  type AnnotationLayer,
  type Rect,
  type TextBgStyle,
  DEFAULT_ADJUSTMENTS,
  aspectRatioId,
  createEditorState,
  normalizeAspectRatio,
  rotateEditorState,
} from './domain/editor-state'
import {
  EMPTY_SESSION,
  addAnnotationLayer,
  canRedoSession,
  canUndoSession,
  commitDraft,
  commitVisibleState,
  discardDraft,
  liveEdit,
  redoSession,
  sessionState,
  undoSession,
  type EditorSession,
} from './domain/editor-session'
import { createDocumentSwitcher } from './application/document-switch'
import {
  checkProvenance,
  createProvenanceInput,
} from './infrastructure/provenance-client'
import type { ProvenanceResult } from './infrastructure/openai-provenance-adapter'
import { CanvasViewport } from './components/editor/CanvasViewport'
import { TopActionBar } from './components/editor/TopActionBar'
import { BottomDock, type ActiveTool } from './components/editor/BottomDock'
import { EmptyDropzone } from './components/editor/EmptyDropzone'
import { PointerRipples } from './components/ui/PointerRipples'
import { UserNavCapsule } from './components/navigation/UserNavCapsule'
import { AuthModal } from './components/auth/AuthModal'
import { ProfileModal } from './components/auth/ProfileModal'
import { ImageGenModal } from './components/imagegen/ImageGenModal'
import { fetchImagegenCapabilities } from './infrastructure/imagegen-client'
import { HistoryDrawer, type UnifiedHistoryItem } from './components/history/HistoryDrawer'
import {
  fetchCurrentUser,
  logoutUser,
  fetchCloudProjects,
  saveCloudProject,
  deleteCloudProject,
  type SafeUser,
  type CloudProject,
} from './infrastructure/auth-client'
import {
  listLocalHistory,
  saveLocalHistory,
  deleteLocalHistory,
  clearAllLocalHistory,
  type LocalHistoryItem,
} from './infrastructure/history-storage'
import type { MarkupMode } from './components/editor/SubToolbars/MarkupSubToolbar'
import type { MosaicType, MosaicShape } from './components/editor/SubToolbars/MosaicSubToolbar'
import type { WatermarkLayout, WatermarkEraseType } from './components/editor/SubToolbars/WatermarkSubToolbar'
import { runSmartErase, disposeSmartEraseWorker, SMART_ERASE_MAX_EDGE, type SmartEraseStage } from './infrastructure/inpaint/smart-erase'
import { drawEraseAiMask } from './application/editor-renderer'
import { computeFitScale, clampZoom, isNearActualSize, MAX_FIT_SCALE } from './components/image-editor-model'
import './styles.css'

/** Stable per-document id; also the IndexedDB draft id for local drafts. */
function createDraftId(): string {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight })

function generateThumbnailFromSource(source: DecodedSource, maxEdge = 320): string {
  if (typeof document === 'undefined') return ''
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
  const thumbW = Math.max(16, Math.round(source.width * scale))
  const thumbH = Math.max(16, Math.round(source.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = thumbW
  canvas.height = thumbH
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'medium'
  source.draw(ctx, thumbW, thumbH)
  return canvas.toDataURL('image/webp', 0.8)
}

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const factory = useMemo(() => createBrowserCanvasFactory(), [])

  // Loaded File & Source Bitmap
  const [file, setFile] = useState<File | null>(null)
  const [decodedSource, setDecodedSource] = useState<DecodedSource | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Editor Domain History
  const [session, setSession] = useState<EditorSession>(EMPTY_SESSION)
  // The ref is the synchronous source of truth: every mutation goes through
  // updateSession, so handlers never read a render snapshot that a queued
  // update has already superseded.
  const sessionRef = useRef(session)
  const currentDraftIdRef = useRef<string | null>(null)

  // Active User & Auth State
  const [currentUser, setCurrentUser] = useState<SafeUser | null>(null)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false)
  // Image generation: enabled is driven by the server capabilities endpoint,
  // so the entry buttons stay hidden until the operator configures providers.
  const [showImageGenModal, setShowImageGenModal] = useState(false)
  const [imagegenEnabled, setImagegenEnabled] = useState(false)
  // Smart erase (browser-local MI-GAN inpainting)
  const [isSmartErasing, setIsSmartErasing] = useState(false)
  const [smartEraseStage, setSmartEraseStage] = useState<SmartEraseStage | null>(null)
  const [smartEraseError, setSmartEraseError] = useState<string | null>(null)

  // History & Storage State
  const [localHistoryItems, setLocalHistoryItems] = useState<LocalHistoryItem[]>([])
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([])

  // Cleanup decoded bitmap on unmount
  useEffect(() => {
    return () => {
      decodedSource?.close()
    }
  }, [decodedSource])

  // Active Tooling & SubToolbar State
  const [activeTool, setActiveTool] = useState<ActiveTool>('none')

  // Tool settings
  const [markupMode, setMarkupMode] = useState<MarkupMode>('brush')
  const [markupColor, setMarkupColor] = useState('#ef4444')
  const [markupWidth, setMarkupWidth] = useState(6)
  const [mosaicType, setMosaicType] = useState<MosaicType>('pixel')
  const [mosaicBlockSize, setMosaicBlockSize] = useState(16)
  // Brush is the default shape: WeChat/QQ's mosaic is a freehand brush, and a
  // box is still one click away in the sub-toolbar.
  const [mosaicShape, setMosaicShape] = useState<MosaicShape>('brush')
  const [mosaicBrushSize, setMosaicBrushSize] = useState(48)
  const [textStyle, setTextStyle] = useState<TextBgStyle>('translucent')
  const [textColor, setTextColor] = useState('#ffffff')
  const [textSize, setTextSize] = useState(28)

  // Compress & Export settings
  const [outputMime, setOutputMime] = useState('image/webp')
  const [quality, setQuality] = useState(85)
  const [stripMetadata, setStripMetadata] = useState(true)
  const [estimatedBytes, setEstimatedBytes] = useState<number | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  // Provenance state
  const [isCheckingProvenance, setIsCheckingProvenance] = useState(false)
  const [provenanceResult, setProvenanceResult] = useState<{ detected: boolean; note?: string } | null>(null)
  const [provenanceResultDetail, setProvenanceResultDetail] = useState<ProvenanceResult | null>(null)
  const [provenanceError, setProvenanceError] = useState<string | null>(null)

  // Viewport Camera (Pan & Zoom)
  const [zoomScale, setZoomScale] = useState(1.0)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isComparingOriginal, setIsComparingOriginal] = useState(false)

  // Toast feedback
  const [toast, setToast] = useState<{ text: string; type: 'info' | 'success' | 'error' } | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const showToast = useCallback((text: string, type: 'info' | 'success' | 'error' = 'info') => {
    setToast({ text, type })
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 3000)
  }, [])

  // Check current user session on load
  useEffect(() => {
    let active = true
    void fetchCurrentUser()
      .then((user) => {
        if (active && user) {
          setCurrentUser(user)
        }
      })
      .catch((err: unknown) => {
        console.warn('Session check skipped:', err)
      })
    return () => {
      active = false
    }
  }, [])

  // Refresh local & cloud history
  const refreshHistory = useCallback(async () => {
    try {
      const locals = await listLocalHistory()
      setLocalHistoryItems(locals)
    } catch (err: unknown) {
      console.warn('Load local history failed:', err)
    }

    if (currentUser) {
      try {
        const projects = await fetchCloudProjects()
        setCloudProjects(projects)
      } catch (err: unknown) {
        console.warn('Load cloud projects failed:', err)
      }
    } else {
      setCloudProjects([])
    }
  }, [currentUser])

  // Trigger refresh when user login state changes
  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  // Imagegen capability probe: on mount and again whenever the window gains
  // focus, so visitors with the page already open see the entry buttons as
  // soon as the operator configures providers (no reload needed).
  useEffect(() => {
    const probe = () => {
      void fetchImagegenCapabilities().then((caps) => {
        setImagegenEnabled(Boolean(caps?.enabled && caps.providers.length > 0))
      })
    }
    probe()
    window.addEventListener('focus', probe)
    return () => window.removeEventListener('focus', probe)
  }, [])

  // Visible editor state: live gesture output wins over the committed snapshot.
  const currentState = sessionState(session)
  const hasEraseAiRegions = Boolean(currentState?.annotations?.some((layer) => layer.type === 'erase-ai'))

  // The crop pills derive their selection from the editor state, so undo and
  // history restore move the highlight with the crop instead of leaving a
  // separately tracked label behind.
  const cropRatio = aspectRatioId(currentState?.aspectRatio ?? null)

  // Every session mutation goes through here, writing the ref before React
  // state so a handler that runs between two renders still sees the last edit.
  const updateSession = useCallback((updater: (prev: EditorSession) => EditorSession) => {
    const prev = sessionRef.current
    const next = updater(prev)
    if (next === prev) return
    sessionRef.current = next
    setSession(next)
  }, [])

  /** Live gesture output (slider sweep); the state comes from the session. */
  const editVisibleState = useCallback(
    (updater: (state: EditorState) => EditorState) => {
      updateSession((prev) => {
        const visible = sessionState(prev)
        return visible ? liveEdit(prev, updater(visible)) : prev
      })
    },
    [updateSession]
  )

  /** Discrete action: one undoable step that also closes an open gesture. */
  const commitEdit = useCallback(
    (updater: (state: EditorState) => EditorState) => {
      updateSession((prev) => {
        const visible = sessionState(prev)
        return visible ? commitVisibleState(prev, updater(visible)) : prev
      })
    },
    [updateSession]
  )

  /** Adds a layer to whatever the user is looking at, as one undoable step. */
  const addAnnotation = useCallback(
    (layer: AnnotationLayer) => {
      updateSession((prev) => addAnnotationLayer(prev, layer))
    },
    [updateSession]
  )

  // Viewport framing that belongs to the document, not to the session. Every
  // "fit" affordance (open, revert, the zoom button, double-click) funnels
  // through frameToFit so none of them can drift to its own definition.
  const frameToFit = useCallback(() => {
    if (!decodedSource) return
    setZoomScale(computeFitScale(decodedSource, viewportSize()))
    setPanOffset({ x: 0, y: 0 })
  }, [decodedSource])

  const resetDocumentUi = useCallback((decoded: DecodedSource) => {
    setActiveTool('none')
    setProvenanceResult(null)
    setProvenanceResultDetail(null)
    setProvenanceError(null)
    setZoomScale(computeFitScale(decoded, viewportSize()))
    setPanOffset({ x: 0, y: 0 })
  }, [])

  // Auto-persist the current draft (debounced) whenever the editor state
  // changes. One effect owns persistence so commit/undo/redo/revert all flow
  // through it without side effects inside state updaters.
  const persistWarnedRef = useRef(false)
  const pendingPersistRef = useRef<{ draftId: string; file: File; state: EditorState; source: DecodedSource } | null>(null)

  // A draft's source image never changes, so its thumbnail is rendered once per
  // draft instead of on every debounced autosave.
  const thumbnailCacheRef = useRef<Map<string, string>>(new Map())
  const thumbnailFor = useCallback((draftId: string, source: DecodedSource) => {
    const cached = thumbnailCacheRef.current.get(draftId)
    if (cached) return cached
    const thumbnail = generateThumbnailFromSource(source, 320)
    const cache = thumbnailCacheRef.current
    cache.set(draftId, thumbnail)
    if (cache.size > 60) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return thumbnail
  }, [])

  const persistDraftNow = useCallback(
    async (draftId: string, targetFile: File, state: EditorState, source: DecodedSource) => {
      try {
        // The storage layer owns the per-draft invariants: it preserves cloud
        // linkage across upserts, reuses the stored thumbnail (the original
        // image never changes for a draft id) and writes the original blob
        // exactly once. This call only supplies fresh editor state.
        const saved = await saveLocalHistory({
          id: draftId,
          title: targetFile.name.replace(/\.[^/.]+$/, ''),
          fileName: targetFile.name,
          fileSize: targetFile.size,
          mimeType: targetFile.type || 'image/jpeg',
          width: source.width,
          height: source.height,
          thumbnail: thumbnailFor(draftId, source),
          originalBlob: targetFile,
          editorState: state,
          updatedAt: Date.now(),
        })

        if (saved === null) {
          if (!persistWarnedRef.current) {
            persistWarnedRef.current = true
            showToast('本地草稿保存失败（浏览器存储空间不足），请及时导出保留成果', 'error')
          }
          return
        }

        const locals = await listLocalHistory()
        setLocalHistoryItems(locals)
      } catch (err) {
        console.warn('Auto-save to IndexedDB skipped:', err)
        if (!persistWarnedRef.current) {
          persistWarnedRef.current = true
          showToast('本地草稿保存失败，请及时导出保留成果', 'error')
        }
      }
    },
    [showToast, thumbnailFor]
  )

  useEffect(() => {
    const draftId = currentDraftIdRef.current
    if (!file || !decodedSource || !currentState || !draftId) return
    pendingPersistRef.current = { draftId, file, state: currentState, source: decodedSource }
    const timer = window.setTimeout(() => {
      const pending = pendingPersistRef.current
      if (!pending) return
      pendingPersistRef.current = null
      void persistDraftNow(pending.draftId, pending.file, pending.state, pending.source)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [file, decodedSource, currentState, persistDraftNow])

  // Flush a pending debounced save before the page goes away, so a quick edit
  // followed by a tab close still lands in IndexedDB.
  const flushPendingPersist = useCallback(() => {
    const pending = pendingPersistRef.current
    if (!pending) return
    pendingPersistRef.current = null
    void persistDraftNow(pending.draftId, pending.file, pending.state, pending.source)
  }, [persistDraftNow])

  useEffect(() => {
    const flush = () => {
      const pending = pendingPersistRef.current
      if (!pending) return
      pendingPersistRef.current = null
      void persistDraftNow(pending.draftId, pending.file, pending.state, pending.source)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [persistDraftNow])

  // One switch choreography for every document change: a new image, a draft
  // restored from history, or undo/redo landing on another document. It decodes
  // before swapping, drops superseded decodes, and never discards edits made
  // while the next bitmap was decoding.
  const documentSwitcher = useMemo(
    () =>
      createDocumentSwitcher({
        decode: decodeEditorSource,
        getSession: () => sessionRef.current,
        install: (snapshot, decoded) => {
          setFile(snapshot.file)
          setDecodedSource(decoded)
          currentDraftIdRef.current = snapshot.docId
          resetDocumentUi(decoded)
        },
        commit: (next) => {
          sessionRef.current = next
          setSession(next)
        },
        flushPending: () => flushPendingPersist(),
        setBusy: (busy) => setIsProcessing(busy),
        onError: (error, failure) => {
          console.error(`Document ${failure} failed:`, error)
          if (failure === 'switch') {
            showToast('切换画布失败，请重试', 'error')
            return
          }
          setErrorMessage('图片解析失败，可能格式损坏或不支持')
          showToast(failure === 'restore' ? '恢复草稿失败，原图可能损坏' : '图片解析失败', 'error')
        },
      }),
    [flushPendingPersist, resetDocumentUi, showToast]
  )

  // Open or replace the working image. Replacing keeps the previous document in
  // the undo tree, so an accidental switch can be walked back.
  const loadFile = useCallback(
    async (nextFile: File) => {
      const validation = validateImageFile(nextFile)
      if (!validation.ok) {
        setErrorMessage(validation.message)
        showToast(validation.message, 'error')
        return
      }

      setErrorMessage(null)
      const opened = await documentSwitcher.openDocument(nextFile, (decoded) => ({
        docId: createDraftId(),
        file: nextFile,
        state: createEditorState(decoded.width, decoded.height),
      }))
      if (opened) {
        showToast(`已载入 ${nextFile.name}，完全在本地处理`, 'success')
      }
    },
    [documentSwitcher, showToast]
  )

  // Crop drag output: visible immediately, not yet an undoable step.
  const handleCropChange = useCallback(
    (crop: Rect) => {
      editVisibleState((state) => ({ ...state, crop }))
    },
    [editVisibleState]
  )

  // End of a gesture: commits the session's own draft.
  const handleCommitDraft = useCallback(() => {
    updateSession((prev) => commitDraft(prev))
  }, [updateSession])

  // A cancelled gesture is dropped rather than committed, so an interrupted
  // crop or slider sweep leaves no phantom undo step.
  const handleCancelDraft = useCallback(() => {
    updateSession((prev) => discardDraft(prev))
  }, [updateSession])

  // Undo and redo can land on a different image, so the target bitmap is
  // decoded before the session swaps: the canvas never renders one document's
  // parameters against another document's pixels. A switch still in flight is
  // chained from, so a repeated ⌘Z keeps walking back through history.
  const handleUndo = useCallback(() => {
    const from = documentSwitcher.pendingSession() ?? sessionRef.current
    const next = undoSession(from)
    if (next !== from) void documentSwitcher.applySession(next)
  }, [documentSwitcher])

  const handleRedo = useCallback(() => {
    const from = documentSwitcher.pendingSession() ?? sessionRef.current
    const next = redoSession(from)
    if (next !== from) void documentSwitcher.applySession(next)
  }, [documentSwitcher])

  const handleRevert = useCallback(() => {
    if (!decodedSource || !file) return
    // Resetting is a normal step in the tree, so it can be undone like any edit.
    const { width, height } = decodedSource
    commitEdit(() => createEditorState(width, height))
    // The pixels go back to the original, so the view must follow: otherwise the
    // user keeps staring at whichever corner they had zoomed into while the
    // content behind it jumped back to the full frame.
    frameToFit()
    showToast('已还原为原始状态', 'info')
  }, [decodedSource, file, commitEdit, frameToFit, showToast])

  // Crop controls
  const handleRatioSelect = useCallback(
    (ratioStr: string) => {
      const ratio = normalizeAspectRatio(ratioStr)
      commitEdit((state) => ({ ...state, aspectRatio: ratio }))
    },
    [commitEdit]
  )

  const handleRotate90 = useCallback(() => {
    commitEdit((state) => rotateEditorState(state, 1))
  }, [commitEdit])

  const handleFlipH = useCallback(() => {
    commitEdit((state) => ({ ...state, flipX: !state.flipX }))
  }, [commitEdit])

  const handleFlipV = useCallback(() => {
    commitEdit((state) => ({ ...state, flipY: !state.flipY }))
  }, [commitEdit])

  const handleResetCrop = useCallback(() => {
    if (!decodedSource) return
    const { width, height } = decodedSource
    commitEdit((state) => ({
      ...state,
      crop: { x: 0, y: 0, width, height },
      aspectRatio: null,
    }))
  }, [decodedSource, commitEdit])

  // Adjustments change: a slider sweep is a live gesture until it is committed.
  const handleAdjustmentsChange = useCallback(
    (adj: Adjustments) => {
      editVisibleState((state) => ({ ...state, adjustments: adj }))
    },
    [editVisibleState]
  )

  const handleAdjustmentsReset = useCallback(() => {
    commitEdit((state) => ({ ...state, adjustments: { ...DEFAULT_ADJUSTMENTS } }))
    showToast('调色已重置', 'info')
  }, [commitEdit, showToast])

  // Export to Blob
  const exportImage = useCallback(
    async (mime: string, q: number): Promise<{ blob: Blob; filename: string }> => {
      if (!decodedSource || !currentState || !file) {
        throw new Error('未加载图片')
      }
      const blob = await exportEditor(decodedSource, currentState, factory, mime, q / 100)
      const baseName = file.name.replace(/\.[^/.]+$/, '')
      const ext = mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'avif'
      const filename = `${baseName}_edited.${ext}`
      return { blob, filename }
    },
    [decodedSource, currentState, file, factory]
  )

  // Download Trigger
  const handleQuickExport = useCallback(async () => {
    if (!file || !decodedSource || !currentState) return
    setIsProcessing(true)
    try {
      const { blob, filename } = await exportImage(outputMime, quality)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)

      showToast(`已导出并下载：${filename}`, 'success')
    } catch (err) {
      console.error('Export failed:', err)
      showToast('导出失败，请重试', 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [file, decodedSource, currentState, exportImage, outputMime, quality, showToast])

  const handleExportFormat = useCallback(
    async (mime: string) => {
      setOutputMime(mime)
      setIsProcessing(true)
      try {
        const { blob, filename } = await exportImage(mime, quality)
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        showToast(`已保存为 ${mime.split('/')[1].toUpperCase()}：${filename}`, 'success')
      } catch (err) {
        console.error('Export failed:', err)
        showToast('保存失败', 'error')
      } finally {
        setIsProcessing(false)
      }
    },
    [exportImage, quality, showToast]
  )

  // Copy to Clipboard (as PNG)
  const handleCopyToClipboard = useCallback(async () => {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      showToast('当前浏览器不支持直接写入剪贴板图片', 'error')
      return
    }
    setIsProcessing(true)
    try {
      const { blob } = await exportImage('image/png', 100)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      showToast('已复制图片到系统剪贴板！可以直接在微信/QQ等按 ⌘V 粘贴', 'success')
    } catch (err) {
      console.error('Copy to clipboard failed:', err)
      showToast('复制到剪贴板失败', 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [exportImage, showToast])

  // Live estimated size (debounced)
  useEffect(() => {
    if (!decodedSource || !currentState || !file) {
      setEstimatedBytes(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const { blob } = await exportImage(outputMime, quality)
        // The image or settings may have changed while this estimate was
        // rendering; a stale size would label the wrong result.
        if (!cancelled) setEstimatedBytes(blob.size)
      } catch (err) {
        if (!cancelled) console.warn('Size estimation skipped:', err)
      }
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [decodedSource, currentState, file, outputMime, quality, exportImage])

  // Provenance AI Signal Check
  const handleCheckProvenance = useCallback(async () => {
    if (!file || !decodedSource || !currentState) return
    setIsCheckingProvenance(true)
    try {
      const { blob } = await exportImage('image/jpeg', 92)
      const input = createProvenanceInput(blob, file.name)
      const result = await checkProvenance(input)
      const detected = result.evidence.some((e) => e.outcome === 'detected')
      const note =
        result.evidence.length > 0
          ? result.evidence
              .map(
                (e) =>
                  `${e.signal.toUpperCase()}: ${e.outcome === 'detected' ? '已检出' : '未检出'}${
                    e.issuer ? ` (${e.issuer})` : ''
                  }`
              )
              .join(' · ')
          : detected
          ? '已识别到数字水印或元数据来源标记'
          : '未检出嵌入式 AI 来源信号'
      setProvenanceResult({ detected, note })
      setProvenanceResultDetail(result)
      showToast(detected ? '检出 AI 来源信号' : '未检出 AI 信号', detected ? 'info' : 'success')
    } catch (err) {
      console.error('Provenance check failed:', err)
      showToast('来源检测失败，服务可能未开启', 'error')
    } finally {
      setIsCheckingProvenance(false)
    }
  }, [file, decodedSource, currentState, exportImage, showToast])

  // Watermark Actions
  const handleAddWatermark = useCallback(
    (options: { text: string; layout: WatermarkLayout; opacity: number; color: string }) => {
      if (!sessionState(sessionRef.current)) return
      const newLayer: AnnotationLayer = {
        id: `watermark_${Date.now()}`,
        type: 'watermark',
        text: options.text,
        watermarkStyle: options.layout,
        opacity: options.opacity,
        color: options.color,
        strokeWidth: 0,
      }
      addAnnotation(newLayer)
      showToast(options.layout === 'tile' ? '已添加平铺全图防盗水印' : '已添加右下角署名水印', 'success')
    },
    [addAnnotation, showToast]
  )

  const handleAddEraseRegion = useCallback(
    (eraseType: WatermarkEraseType) => {
      if (!sessionState(sessionRef.current)) return
      // The mask is placed against the crop the user is looking at, so it is
      // computed inside the session rather than from a render snapshot.
      commitEdit((state) => {
        const cropW = state.crop.width
        const cropH = state.crop.height
        const boxW = Math.min(Math.round(cropW * 0.4), 320)
        const boxH = Math.min(Math.round(cropH * 0.2), 120)
        const boxX = state.crop.x + Math.round((cropW - boxW) / 2)
        const boxY = state.crop.y + Math.round((cropH - boxH) / 2)
        const layerId = `erase_${Date.now()}`

        const newLayer: AnnotationLayer =
          eraseType === 'blackout'
            ? {
                id: layerId,
                type: 'rect',
                rect: { x: boxX, y: boxY, width: boxW, height: boxH },
                color: '#000000',
                strokeWidth: 0,
                opacity: 1,
              }
            : eraseType === 'ai'
            ? {
                id: layerId,
                type: 'erase-ai',
                rect: { x: boxX, y: boxY, width: boxW, height: boxH },
                color: '#34d399',
                strokeWidth: 0,
              }
            : {
                id: layerId,
                type: 'mosaic',
                rect: { x: boxX, y: boxY, width: boxW, height: boxH },
                color: '#000000',
                strokeWidth: 0,
                mosaicType: eraseType === 'blur' ? 'blur' : 'pixel',
                mosaicBlockSize: eraseType === 'blur' ? 24 : 16,
              }

        return { ...state, annotations: [...(state.annotations ?? []), newLayer] }
      })
      showToast(
        eraseType === 'ai'
          ? '已生成智能修复选区（绿色虚线框），点击「运行智能修复」执行'
          : '已在画面中央生成水印消除遮罩选区（支持自由移动或缩放）',
        'success'
      )
    },
    [commitEdit, showToast]
  )

  // Smart erase: bake the current state at full resolution, run browser-local
  // MI-GAN under the pending marquee regions, and open the result as a new
  // document. Pixels outside the mask are preserved bit-for-bit by the
  // compositor; everything here stays on-device.
  const handleRunSmartErase = useCallback(async () => {
    const state = sessionState(sessionRef.current)
    if (!decodedSource || !file || !state) return
    const aiLayers = (state.annotations ?? []).filter((layer) => layer.type === 'erase-ai' && layer.rect)
    if (aiLayers.length === 0) {
      showToast('请先生成智能修复选区', 'info')
      return
    }

    setIsSmartErasing(true)
    setSmartEraseError(null)
    setSmartEraseStage(null)
    try {
      // exportEditor strips the marquee layers itself; the mask is drawn from
      // the unstripped state through the same transform pipeline.
      const snapshot = await exportEditor(decodedSource, state, factory, 'image/png', 1)
      const bitmap = await createImageBitmap(snapshot)
      const { width, height } = bitmap
      // The pipeline pads to 512-aligned tiles internally; an unbounded source
      // (a 25MB PNG can be 10000px wide) would blow the WASM linear memory.
      if (Math.max(width, height) > SMART_ERASE_MAX_EDGE) {
        bitmap.close()
        throw new Error(`图片最大边 ${Math.max(width, height)}px 超过智能修复上限 ${SMART_ERASE_MAX_EDGE}px，请先裁剪或缩放`)
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

      // Composite alpha: the same regions blurred twice so the interior stays
      // fully generated while edges feather into untouched pixels. Where the
      // platform lacks canvas filters this degrades to a crisp edge.
      const alphaCanvas = makeCanvas()
      const alphaCtx = ctxOf(alphaCanvas)
      alphaCtx.fillStyle = '#000000'
      alphaCtx.fillRect(0, 0, width, height)
      alphaCtx.filter = 'blur(3px)'
      drawEraseAiMask(alphaCtx, state, width, height, 1)
      drawEraseAiMask(alphaCtx, state, width, height, 1)
      const alphaData = alphaCtx.getImageData(0, 0, width, height)

      const result = await runSmartErase(
        { image: imageData, mask: maskData, composite: alphaData },
        setSmartEraseStage
      )

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
      const resultFile = new File([blob], `${baseName}_smart-erased.png`, { type: 'image/png' })
      // The pending marquees have served their purpose. Clear them from the
      // source document BEFORE switching, so undoing back to it does not
      // resurrect a stale "pending" frame over an already-erased region.
      commitEdit((prev) => ({
        ...prev,
        annotations: (prev.annotations ?? []).filter((layer) => layer.type !== 'erase-ai'),
      }))
      const opened = await documentSwitcher.openDocument(resultFile, (decoded) => ({
        docId: createDraftId(),
        file: resultFile,
        state: createEditorState(decoded.width, decoded.height),
      }))
      if (opened) {
        showToast(`智能修复完成：${aiLayers.length} 个区域已合成，掩膜外像素未改动`, 'success')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setSmartEraseError(message)
      showToast(`智能修复失败：${message}`, 'error')
    } finally {
      setIsSmartErasing(false)
      setSmartEraseStage(null)
    }
  }, [decodedSource, file, factory, documentSwitcher, showToast, commitEdit])

  const handleCheckProvenanceTarget = useCallback(
    async (target: 'current' | 'original') => {
      if (!file) return
      setIsCheckingProvenance(true)
      setProvenanceError(null)
      try {
        let blob: Blob
        let filename = file.name
        if (target === 'original') {
          blob = file
        } else {
          if (!decodedSource || !currentState) return
          const exported = await exportImage('image/jpeg', 92)
          blob = exported.blob
          filename = exported.filename
        }
        const input = createProvenanceInput(blob, filename)
        const result = await checkProvenance(input)
        setProvenanceResultDetail(result)
        const detected = result.evidence.some((e) => e.outcome === 'detected')
        const note =
          result.evidence.length > 0
            ? result.evidence
                .map(
                  (e) =>
                    `${e.signal.toUpperCase()}: ${e.outcome === 'detected' ? '已检出' : '未检出'}${
                      e.issuer ? ` (${e.issuer})` : ''
                    }`
                )
                .join(' · ')
            : detected
            ? '已识别到数字水印或元数据来源标记'
            : '未检出嵌入式 AI 来源信号'
        setProvenanceResult({ detected, note })
        showToast(
          detected ? '检出 AI / C2PA 隐形水印信号' : '未检出嵌入式 AI / C2PA 信号',
          detected ? 'info' : 'success'
        )
      } catch (err: unknown) {
        console.error('Provenance check failed:', err)
        const msg = err instanceof Error ? err.message : '来源检测服务响应异常'
        setProvenanceError(msg)
        showToast(`检测失败: ${msg}`, 'error')
      } finally {
        setIsCheckingProvenance(false)
      }
    },
    [file, decodedSource, currentState, exportImage, showToast]
  )

  // Restoring a local draft is a document switch, so it joins the undo tree:
  // the image that was open stays one undo away.
  const restoreLocalDraft = useCallback(
    async (local: LocalHistoryItem) => {
      const restoredFile = new File([local.originalBlob], local.fileName, { type: local.mimeType })
      const restored = await documentSwitcher.openDocument(
        restoredFile,
        () => ({ docId: local.id, file: restoredFile, state: local.editorState }),
        'restore'
      )
      if (!restored) return
      setShowHistoryDrawer(false)
      showToast(`已恢复草稿：${local.title}`, 'success')
    },
    [documentSwitcher, showToast]
  )

  // Restore project from history item
  const handleRestoreUnifiedItem = useCallback(
    async (item: UnifiedHistoryItem) => {
      if (item.localItem) {
        await restoreLocalDraft(item.localItem)
        return
      }

      const cloud = item.cloudItem
      if (!cloud) return
      // The sync flow stores the local draft id as the cloud project id, so a
      // surviving local copy is found by id instead of guessing by file name.
      const match = localHistoryItems.find((l) => l.cloudId === cloud.id || l.id === cloud.id)
      if (!match) {
        showToast('该云端草稿的原图未缓存在当前浏览器中，请先在原设备使用或重新拖入原图', 'info')
        return
      }
      await restoreLocalDraft(match)
    },
    [localHistoryItems, restoreLocalDraft, showToast]
  )

  // Fast direct download from history drawer
  const handleExportUnifiedItem = useCallback(
    async (item: UnifiedHistoryItem) => {
      if (!item.localItem) {
        showToast('该草稿无本地图像源，请在原设备下载', 'info')
        return
      }
      setIsProcessing(true)
      let decoded: DecodedSource | null = null
      try {
        decoded = await decodeEditorSource(item.localItem.originalBlob)
        const blob = await exportEditor(decoded, item.localItem.editorState, factory, 'image/webp', 0.85)
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${item.title}_exported.webp`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        showToast(`已快速导出：${item.title}`, 'success')
      } catch (err) {
        console.error('Fast export failed:', err)
        showToast('快速导出失败', 'error')
      } finally {
        // Also releases the bitmap when the export itself failed.
        decoded?.close()
        setIsProcessing(false)
      }
    },
    [factory, showToast]
  )

  // Sync local item to user's cloud projects
  const handleSyncToCloud = useCallback(
    async (localItem: LocalHistoryItem) => {
      if (!currentUser) {
        setShowAuthModal(true)
        showToast('请先登录账号以同步草稿至云端', 'info')
        return
      }

      try {
        const savedProject = await saveCloudProject({
          id: localItem.cloudId || localItem.id,
          title: localItem.title,
          original_filename: localItem.fileName,
          dimensions_width: localItem.width,
          dimensions_height: localItem.height,
          thumbnail_data: localItem.thumbnail,
          state_json: JSON.stringify(localItem.editorState),
        })

        if (savedProject) {
          const updated = await saveLocalHistory({
            ...localItem,
            isCloudSynced: true,
            cloudId: savedProject.id,
          })
          if (updated === null) {
            console.warn('Cloud sync succeeded but local linkage update failed')
          }
          await refreshHistory()
          showToast(`已同步「${localItem.title}」至云端项目`, 'success')
        } else {
          showToast('同步至云端失败', 'error')
        }
      } catch (err) {
        console.error('Sync to cloud failed:', err)
        showToast('网络错误，同步失败', 'error')
      }
    },
    [currentUser, refreshHistory, showToast]
  )

  // Delete item from local or cloud
  const handleDeleteUnifiedItem = useCallback(
    async (item: UnifiedHistoryItem) => {
      try {
        if (item.localItem) {
          await deleteLocalHistory(item.localItem.id)
        }
        if (item.cloudItem) {
          await deleteCloudProject(item.cloudItem.id)
        }
        await refreshHistory()
        showToast(`已删除草稿「${item.title}」`, 'info')
      } catch (err) {
        console.error('Delete item failed:', err)
        showToast('删除失败', 'error')
      }
    },
    [refreshHistory, showToast]
  )

  // Clear all local drafts
  const handleClearAllLocal = useCallback(async () => {
    try {
      await clearAllLocalHistory()
      await refreshHistory()
      showToast('已清空全部本地历史草稿', 'success')
    } catch (err) {
      console.error('Clear history failed:', err)
      showToast('清空失败', 'error')
    }
  }, [refreshHistory, showToast])

  // Logout handler
  const handleLogout = useCallback(async () => {
    try {
      await logoutUser()
      setCurrentUser(null)
      setCloudProjects([])
      showToast('已退出登录，当前继续使用访客模式', 'info')
    } catch (err) {
      console.warn('Logout failed:', err)
    }
  }, [showToast])

  // Total local cache size bytes
  const totalStorageBytes = useMemo(() => {
    return localHistoryItems.reduce((acc, cur) => {
      // Thumbnails are base64 data URLs: 4 characters carry 3 bytes.
      const thumbnailBytes = cur.thumbnail ? Math.round((cur.thumbnail.length * 3) / 4) : 0
      return acc + (cur.fileSize || 0) + thumbnailBytes
    }, 0)
  }, [localHistoryItems])

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault()
        handleUndo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && ((e.shiftKey && e.code === 'KeyZ') || e.code === 'KeyY')) {
        e.preventDefault()
        handleRedo()
        return
      }

      // Copy to clipboard
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyC') {
        if (file) {
          e.preventDefault()
          handleCopyToClipboard()
        }
        return
      }

      // Quick save
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') {
        e.preventDefault()
        handleQuickExport()
        return
      }

      // Single key tool shortcuts
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.code === 'KeyC') setActiveTool((prev) => (prev === 'crop' ? 'none' : 'crop'))
        else if (e.code === 'KeyB') setActiveTool((prev) => (prev === 'markup' ? 'none' : 'markup'))
        else if (e.code === 'KeyM') setActiveTool((prev) => (prev === 'mosaic' ? 'none' : 'mosaic'))
        else if (e.code === 'KeyT') setActiveTool((prev) => (prev === 'text' ? 'none' : 'text'))
        else if (e.code === 'KeyF') setActiveTool((prev) => (prev === 'adjust' ? 'none' : 'adjust'))
        else if (e.code === 'KeyW') setActiveTool((prev) => (prev === 'watermark' ? 'none' : 'watermark'))
        else if (e.code === 'KeyO') setActiveTool((prev) => (prev === 'compress' ? 'none' : 'compress'))
        else if (e.code === 'KeyH') {
        flushPendingPersist()
        setShowHistoryDrawer((v) => !v)
      }
        else if (e.code === 'Backslash') setIsComparingOriginal(true)
        else if (e.code === 'Escape') setActiveTool('none')
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Backslash') {
        setIsComparingOriginal(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
    }, [file, handleUndo, handleRedo, handleCopyToClipboard, handleQuickExport, flushPendingPersist])

  // Global Paste listener (Cmd+V)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        const pasted = e.clipboardData.files[0]
        if (pasted.type.startsWith('image/')) {
          e.preventDefault()
          void loadFile(pasted)
        }
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [loadFile])

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-zinc-950 select-none">
      {/* WebGL Multi-Color Interactive Fluid Ripples Backdrop */}
      <PointerRipples
        className="fixed inset-0 pointer-events-none w-full h-full z-0"
        opacity={0.58}
        curl={13}
        splatRadius={0.24}
        densityDissipation={2.4}
        velocityDissipation={1.6}
        colorIntensity={0.26}
        colorSaturation={0.72}
        idleMs={4000}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files[0]) {
            void loadFile(e.target.files[0])
          }
        }}
      />

      {/* Floating Top-Right User & History Navigation Capsule */}
      <UserNavCapsule
        user={currentUser}
        belowTopBar={Boolean(file && decodedSource)}
        historyCount={
          localHistoryItems.length +
          cloudProjects.filter(
            (c) => !localHistoryItems.some((l) => l.id === c.id || l.cloudId === c.id)
          ).length
        }
        onOpenHistory={() => {
          flushPendingPersist()
          setShowHistoryDrawer(true)
        }}
        onOpenAuth={() => setShowAuthModal(true)}
        onOpenProfile={() => setShowProfileModal(true)}
        onLogout={handleLogout}
      />

      {file && decodedSource && currentState ? (
        <>
          {/* Top Glass Action Bar */}
          <TopActionBar
            fileName={file.name}
            fileSize={file.size}
            dimensions={{ width: decodedSource.width, height: decodedSource.height }}
            zoomPercent={Math.round(zoomScale * 100)}
            onOpenImageGen={imagegenEnabled ? () => setShowImageGenModal(true) : undefined}
            canUndo={canUndoSession(session)}
            canRedo={canRedoSession(session)}
            canReset={canUndoSession(session) || Boolean(session.draft)}
            isComparingOriginal={isComparingOriginal}
            isProcessing={isProcessing}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onRevert={handleRevert}
            onZoomIn={() => setZoomScale((s) => clampZoom(s * 1.25))}
            onZoomOut={() => setZoomScale((s) => clampZoom(s * 0.8))}
            onZoomReset={() => {
              if (isNearActualSize(zoomScale)) {
                frameToFit()
              } else {
                setZoomScale(MAX_FIT_SCALE)
                setPanOffset({ x: 0, y: 0 })
              }
            }}
            onCompareStart={() => setIsComparingOriginal(true)}
            onCompareEnd={() => setIsComparingOriginal(false)}
            onReplaceImage={() => fileInputRef.current?.click()}
            onQuickExport={handleQuickExport}
            onExportFormat={handleExportFormat}
            onCopyToClipboard={handleCopyToClipboard}
          />

          {/* Master Spatial Canvas Viewport */}
          <main className="w-full h-full">
            <CanvasViewport
              source={decodedSource}
              state={currentState}
              activeTool={activeTool}
              markupMode={markupMode}
              markupColor={markupColor}
              markupWidth={markupWidth}
              mosaicType={mosaicType}
              mosaicBlockSize={mosaicBlockSize}
              mosaicShape={mosaicShape}
              mosaicBrushSize={mosaicBrushSize}
              textStyle={textStyle}
              textColor={textColor}
              textSize={textSize}
              isComparingOriginal={isComparingOriginal}
              zoomScale={zoomScale}
              panOffset={panOffset}
              onZoomChange={setZoomScale}
              onPanChange={setPanOffset}
              onFitViewport={frameToFit}
              onCropChange={handleCropChange}
              onCommitDraft={handleCommitDraft}
              onCancelDraft={handleCancelDraft}
              onAddAnnotation={addAnnotation}
            />
          </main>

          {/* Bottom WeChat / QQ Capsule Dock */}
          <BottomDock
            activeTool={activeTool}
            onToolSelect={setActiveTool}
            cropRatio={cropRatio}
            onRatioSelect={handleRatioSelect}
            onRotate90={handleRotate90}
            onFlipH={handleFlipH}
            onFlipV={handleFlipV}
            onResetCrop={handleResetCrop}
            markupMode={markupMode}
            markupColor={markupColor}
            markupWidth={markupWidth}
            onMarkupModeSelect={setMarkupMode}
            onMarkupColorSelect={setMarkupColor}
            onMarkupWidthSelect={setMarkupWidth}
            mosaicType={mosaicType}
            mosaicBlockSize={mosaicBlockSize}
            mosaicShape={mosaicShape}
            mosaicBrushSize={mosaicBrushSize}
            onMosaicTypeSelect={setMosaicType}
            onMosaicBlockSizeSelect={setMosaicBlockSize}
            onMosaicShapeSelect={setMosaicShape}
            onMosaicBrushSizeSelect={setMosaicBrushSize}
            textStyle={textStyle}
            textColor={textColor}
            textSize={textSize}
            onTextStyleSelect={setTextStyle}
            onTextColorSelect={setTextColor}
            onTextSizeSelect={setTextSize}
            adjustments={currentState.adjustments}
            onAdjustmentsChange={handleAdjustmentsChange}
            onAdjustmentsCommit={handleCommitDraft}
            onAdjustmentsReset={handleAdjustmentsReset}
            onAddWatermark={handleAddWatermark}
            onAddEraseRegion={handleAddEraseRegion}
            onCheckProvenanceTarget={handleCheckProvenanceTarget}
            hasEraseAiRegions={hasEraseAiRegions}
            onRunSmartErase={() => void handleRunSmartErase()}
            isSmartErasing={isSmartErasing}
            smartEraseStage={smartEraseStage}
            smartEraseError={smartEraseError}
            provenanceResultDetail={provenanceResultDetail}
            provenanceError={provenanceError}
            outputMime={outputMime}
            quality={quality}
            estimatedBytes={estimatedBytes}
            originalBytes={file.size}
            stripMetadata={stripMetadata}
            isCheckingProvenance={isCheckingProvenance}
            provenanceResult={provenanceResult}
            onMimeSelect={setOutputMime}
            onQualityChange={setQuality}
            onToggleStripMetadata={() => setStripMetadata((v) => !v)}
            onCheckProvenance={handleCheckProvenance}
          />
        </>
      ) : (
        /* Empty State Dropzone with Recent Items shelf */
        <EmptyDropzone
          onFileSelect={loadFile}
          error={errorMessage}
          onOpenImageGen={imagegenEnabled ? () => setShowImageGenModal(true) : undefined}
          recentItems={localHistoryItems.map((item) => ({
            id: item.id,
            title: item.title,
            thumbnail: item.thumbnail,
            dimensions: { width: item.width, height: item.height },
            updatedAt: item.updatedAt,
          }))}
          onSelectRecent={(id) => {
            const item = localHistoryItems.find((x) => x.id === id)
            if (item) {
              void handleRestoreUnifiedItem({
                id: item.id,
                source: 'local',
                title: item.title,
                fileName: item.fileName,
                fileSize: item.fileSize,
                dimensions: { width: item.width, height: item.height },
                thumbnail: item.thumbnail,
                updatedAt: item.updatedAt,
                originalBlob: item.originalBlob,
                localItem: item,
              })
            }
          }}
          onViewAllHistory={() => setShowHistoryDrawer(true)}
        />
      )}

      {/* Slide-over History Drawer */}
      <HistoryDrawer
        isOpen={showHistoryDrawer}
        user={currentUser}
        localItems={localHistoryItems}
        cloudItems={cloudProjects}
        storageBytes={totalStorageBytes}
        onClose={() => setShowHistoryDrawer(false)}
        onRestoreItem={(item) => void handleRestoreUnifiedItem(item)}
        onExportItem={(item) => void handleExportUnifiedItem(item)}
        onSyncToCloud={(item) => void handleSyncToCloud(item)}
        onDeleteItem={(item) => void handleDeleteUnifiedItem(item)}
        onClearAllLocal={() => void handleClearAllLocal()}
        onOpenAuth={() => {
          flushPendingPersist()
          setShowHistoryDrawer(false)
          setShowAuthModal(true)
        }}
      />

      {/* AI Image Generation Modal */}
      <ImageGenModal
        isOpen={showImageGenModal}
        onClose={() => setShowImageGenModal(false)}
        onGenerated={(files, model) => {
          setShowImageGenModal(false)
          void (async () => {
            // Each opened image pushes the previous one into the undo tree,
            // so a multi-image batch stays fully walkable.
            for (const file of files) {
              await documentSwitcher.openDocument(file, (decoded) => ({
                docId: createDraftId(),
                file,
                state: createEditorState(decoded.width, decoded.height),
              }))
            }
            showToast(
              files.length > 1
                ? `AI 生成完成（${model}）：${files.length} 张已入历史，当前显示最后一张`
                : `AI 生成完成（${model}），已进入工作台`,
              'success'
            )
          })()
        }}
      />

      {/* Auth Modal (Login / Register) */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onSuccess={(user) => {
          // refreshHistory is owned by the effect watching currentUser; calling
          // it here would run a stale closure and duplicate the refresh.
          setCurrentUser(user)
          showToast(`欢迎回来，${user.nickname || user.username}！`, 'success')
        }}
      />

      {/* Profile Modal */}
      <ProfileModal
        isOpen={showProfileModal}
        user={currentUser}
        localHistoryCount={localHistoryItems.length}
        cloudProjectsCount={cloudProjects.length}
        onClose={() => setShowProfileModal(false)}
        onUserUpdated={(updated) => {
          setCurrentUser(updated)
          showToast('个人资料已保存', 'success')
        }}
        onLogout={() => {
          void handleLogout()
          setShowProfileModal(false)
        }}
      />

      {/* Floating Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-2xl text-xs shadow-2xl transition-all animate-in fade-in slide-in-from-bottom-2 duration-200 ${
            toast.type === 'success'
              ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30'
              : toast.type === 'error'
              ? 'bg-rose-950/80 text-rose-300 border border-rose-500/30'
              : 'bg-zinc-900/80 text-zinc-300 border border-zinc-700/50'
          }`}
        >
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  )
}
