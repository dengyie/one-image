import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { validateImageFile } from './application/file-policy'
import { exportEditor, PREVIEW_MAX_EDGE, resolveRenderDimensions, type DecodedSource } from './application/editor-renderer'
import { createBrowserCanvasFactory, decodeEditorSource } from './infrastructure/editor-canvas'
import type { OpenImageItem } from './components/editor/ImageListPanel'
import { MAX_OPEN_IMAGES, findRootIdForSession } from './domain/working-set'
import { formatBytes } from './domain/format'
import { ImageListPanel } from './components/editor/ImageListPanel'
import {
  type EditorState,
  type Adjustments,
  type AnnotationLayer,
  type Rect,
  type TextBgStyle,
  DEFAULT_ADJUSTMENTS,
  aspectRatioId,
  createEditorState,
  editorStatesEqual,
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
import type { WatermarkLayout, WatermarkEraseType, WatermarkTab } from './components/editor/SubToolbars/WatermarkSubToolbar'
import { runSmartErase, SMART_ERASE_MAX_EDGE, type SmartEraseStage } from './infrastructure/inpaint/smart-erase'
import { drawEraseAiMask } from './application/editor-renderer'
import { refineMaskToStrokes, detectStrokeRegions } from './infrastructure/inpaint/mask-refine'
import { countHolePixels } from './infrastructure/inpaint/classical-fill'
import { routeFill, resolveEraseProvider, type SmartEraseMode, type FillProvider } from './infrastructure/inpaint/auto-route'
import { computeFitScale, clampZoom, isNearActualSize, isViewportOffFit, resolveCompareSource, MAX_FIT_SCALE } from './components/image-editor-model'
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
  // Smart erase (browser-local fillers: diffusion / Gaussian frost / optional MI-GAN)
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
  // Smart-erase mask: painted strokes by default so only the watermark pixels
  // become the hole; a box is still available. 'auto' routes small holes to the
  // local diffusion filler and larger ones to the Gaussian frost filler; MI-GAN
  // runs only when explicitly picked in the toolbar.
  const [eraseMaskShape, setEraseMaskShape] = useState<MosaicShape>('brush')
  const [eraseBrushSize, setEraseBrushSize] = useState(32)
  const [eraseMode, setEraseMode] = useState<SmartEraseMode>('auto')
  // Which sub-tab the watermark tool shows. Painting a mask is only meaningful
  // on the 'erase' tab; on 'add' the same gesture must not mint erase regions.
  const [watermarkTab, setWatermarkTab] = useState<WatermarkTab>('add')
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
  // The image the user actually brought in (load/paste/换图 or a history
  // restore). Erase results open as derived documents, so 原图对比 must keep
  // comparing against this root — against the latest derived bitmap the
  // feature would show two identical frames and look broken. Held as a
  // standalone canvas snapshot: the document switcher closes replaced decoded
  // bitmaps, so a raw reference would go dead on the first erase.
  const rootOriginalMap = useRef<Map<string, DecodedSource>>(new Map())

  // Multi-image working set. Every user-loaded image owns a STANDALONE session
  // (fresh history tree), so undo/redo/还原 stay inside the image being edited
  // and never walk into another one; the left list switches between them.
  const imageSessionsRef = useRef<Map<string, EditorSession>>(new Map())
  const activeRootIdRef = useRef<string | null>(null)
  const [activeRootId, setActiveRootId] = useState<string | null>(null)
  const [openImages, setOpenImages] = useState<OpenImageItem[]>([])
  const switchActiveRoot = useCallback((id: string | null) => {
    activeRootIdRef.current = id
    setActiveRootId(id)
  }, [])
  const setRootOriginal = useCallback(
    (rootId: string, decoded: DecodedSource) => {
      // 对比预览的渲染上限就是 PREVIEW_MAX_EDGE，快照存到同一上限即可满足
      // 对比渲染——同时把每张图的常驻内存从最高 ~100MB（25MP×4B）压到 ~23MB。
      // 合成的 DecodedSource 仍报告原始尺寸（planRender 按原图算画布），
      // draw 时再把快照缩放到位。
      const { width, height } = resolveRenderDimensions(decoded.width, decoded.height, PREVIEW_MAX_EDGE)
      const snapshot = factory.create(width, height)
      const ctx = snapshot.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
      decoded.draw(ctx, width, height)
      rootOriginalMap.current.set(rootId, {
        width: decoded.width,
        height: decoded.height,
        draw: (target, drawWidth, drawHeight) => target.drawImage(snapshot as unknown as CanvasImageSource, 0, 0, drawWidth, drawHeight),
        close: () => {},
      })
    },
    [factory]
  )

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
  // Single write path for session changes: the ref, the React state and the
  // working-set entry of the owning image always move together.
  const applySessionChange = useCallback((next: EditorSession) => {
    sessionRef.current = next
    setSession(next)
    if (activeRootIdRef.current) imageSessionsRef.current.set(activeRootIdRef.current, next)
  }, [])

  const updateSession = useCallback((updater: (prev: EditorSession) => EditorSession) => {
    const prev = sessionRef.current
    const next = updater(prev)
    if (next === prev) return
    applySessionChange(next)
  }, [applySessionChange])

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
        commit: (next) => applySessionChange(next),
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
    [flushPendingPersist, resetDocumentUi, showToast, applySessionChange]
  )

  // Loads the file as a NEW image in the working set: a standalone session
  // (own history tree) plus a list entry. The previous image stays in the left
  // list — switching between images happens there, never through undo.
  const loadFile = useCallback(
    async (nextFile: File) => {
      // Same gate as list switching: a paste mid-erase would become the active
      // session and the running result would chain into the NEW image's tree.
      if (isSmartErasing) {
        showToast('正在执行智能清理，请等待完成后再载入新图片', 'info')
        return
      }
      const validation = validateImageFile(nextFile)
      if (!validation.ok) {
        setErrorMessage(validation.message)
        showToast(validation.message, 'error')
        return
      }

      if (openImages.length >= MAX_OPEN_IMAGES) {
        showToast(`工作集最多同时打开 ${MAX_OPEN_IMAGES} 张图片，请先在左侧列表移除部分图片`, 'info')
        return
      }

      setErrorMessage(null)
      const rootId = createDraftId()
      switchActiveRoot(rootId)
      let dims = { width: 0, height: 0 }
      const opened = await documentSwitcher.openStandaloneDocument(nextFile, (decoded) => {
        setRootOriginal(rootId, decoded)
        dims = { width: decoded.width, height: decoded.height }
        return {
          docId: rootId,
          file: nextFile,
          state: createEditorState(decoded.width, decoded.height),
        }
      })
      if (opened) {
        setOpenImages((prev) => [
          ...prev,
          { rootId, name: nextFile.name, size: nextFile.size, url: URL.createObjectURL(nextFile), ...dims },
        ])
        showToast(`已载入 ${nextFile.name}，完全在本地处理`, 'success')
      }
    },
    [documentSwitcher, showToast, setRootOriginal, switchActiveRoot, openImages, isSmartErasing]
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
    // An erase run owns the active session until it lands; undoing mid-run
    // would let the result chain onto a tree the user already walked away from.
    if (isSmartErasing) return
    const from = documentSwitcher.pendingSession() ?? sessionRef.current
    const next = undoSession(from)
    if (next !== from) void documentSwitcher.applySession(next)
  }, [documentSwitcher, isSmartErasing])

  const handleRedo = useCallback(() => {
    if (isSmartErasing) return
    const from = documentSwitcher.pendingSession() ?? sessionRef.current
    const next = redoSession(from)
    if (next !== from) void documentSwitcher.applySession(next)
  }, [documentSwitcher, isSmartErasing])

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
      const baseName = file.name.replace(/\.[^/.]+$/, '')
      const ext = mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'avif'
      const filename = `${baseName}_edited.${ext}`

      // Nothing was edited and the requested container matches the source: the
      // only truly "image unchanged" export is the original bytes, so hand them
      // back untouched instead of round-tripping through a canvas (which would
      // re-encode, drop the ICC profile, and shift wide-gamut colours).
      const pristine = editorStatesEqual(createEditorState(decodedSource.width, decodedSource.height), currentState)
      if (pristine && file.type === mime) {
        return { blob: file, filename: `${baseName}_original.${ext}` }
      }

      const blob = await exportEditor(decodedSource, currentState, factory, mime, q / 100)
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

  // Every erase mode shares one mask representation: an `erase-ai` layer that
  // the run handler turns into the selected filler. Blur/pixel/blackout used to
  // mint live annotation layers here, which made them whole-rectangle effects
  // and left brush strokes (always erase-ai) unusable in those modes.
  const handleAddEraseRegion = useCallback(() => {
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

      const newLayer: AnnotationLayer = {
        id: layerId,
        type: 'erase-ai',
        rect: { x: boxX, y: boxY, width: boxW, height: boxH },
        color: '#34d399',
        strokeWidth: 0,
      }

      return { ...state, annotations: [...(state.annotations ?? []), newLayer] }
    })
    showToast('已生成消除选框（绿色虚线），点击「运行」执行', 'success')
  }, [commitEdit, showToast])

  const handleClearEraseRegions = useCallback(() => {
    const state = sessionState(sessionRef.current)
    if (!state) return
    commitEdit((prev) => ({
      ...prev,
      annotations: (prev.annotations ?? []).filter((layer) => layer.type !== 'erase-ai'),
    }))
  }, [commitEdit])

  // Working-set list handlers. Switching installs that image's own session
  // (decode handled by the switcher); closing drops the session and, when the
  // active image is closed, lands on the most recently opened remaining one.
  const handleSelectImage = useCallback(
    (rootId: string) => {
      // Switching mid-erase would let the result chain onto (or wipe masks of)
      // an image the user is no longer looking at.
      if (isSmartErasing) return
      if (rootId === activeRootIdRef.current) return
      const target = imageSessionsRef.current.get(rootId)
      if (!target) return
      switchActiveRoot(rootId)
      void documentSwitcher.applySession(target).then(() => {
        // A silently aborted switch (an edit landed during the decode) leaves
        // the previous document visible — follow the session, not the click.
        if (sessionRef.current !== target) {
          switchActiveRoot(findRootIdForSession(imageSessionsRef.current, sessionRef.current))
        }
      })
    },
    [documentSwitcher, switchActiveRoot, isSmartErasing]
  )

  const handleCloseImage = useCallback(
    (rootId: string) => {
      if (isSmartErasing) return
      const entry = openImages.find((img) => img.rootId === rootId)
      if (!entry) return
      flushPendingPersist()
      URL.revokeObjectURL(entry.url)
      imageSessionsRef.current.delete(rootId)
      rootOriginalMap.current.delete(rootId)
      const remaining = openImages.filter((img) => img.rootId !== rootId)
      setOpenImages(remaining)
      if (rootId !== activeRootIdRef.current) return
      const next = remaining[remaining.length - 1] ?? null
      switchActiveRoot(next?.rootId ?? null)
      if (next) {
        const target = imageSessionsRef.current.get(next.rootId)!
        void documentSwitcher.applySession(target).then(() => {
          if (sessionRef.current !== target) {
            switchActiveRoot(findRootIdForSession(imageSessionsRef.current, sessionRef.current))
          }
        })
      } else {
        // Last image closed: back to the landing screen.
        rootOriginalMap.current.clear()
        sessionRef.current = EMPTY_SESSION
        setSession(EMPTY_SESSION)
        setFile(null)
        setDecodedSource(null)
      }
    },
    [openImages, documentSwitcher, switchActiveRoot, flushPendingPersist, isSmartErasing]
  )

  // Watermark erase: bake the current state at full resolution, run the filler
  // chosen by the erase mode in the browser-local worker under the pending mask
  // regions, and open the result as a new document. Pixels outside the mask are
  // preserved bit-for-bit by the compositor; everything here stays on-device.
  const ERASE_ENGINE_LABELS: Record<FillProvider, string> = {
    blur: '高斯磨砂',
    pixel: '像素打码',
    solid: '实心遮蔽',
    classical: '本地扩散',
    migan: 'MI-GAN 合成',
  }

  // modeOverride lets the one-click cleanup pin the routing to the safe local
  // path regardless of which engine the toolbar happens to have selected.
  const handleRunErase = useCallback(async (eraseType: WatermarkEraseType, modeOverride?: SmartEraseMode) => {
    const state = sessionState(sessionRef.current)
    if (!decodedSource || !file || !state) return
    const aiLayers = (state.annotations ?? []).filter((layer) => layer.type === 'erase-ai' && layer.rect)
    if (aiLayers.length === 0) {
      showToast('请先涂抹或框选水印', 'info')
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
        showToast('选区为空：请先涂抹或框选水印', 'info')
        return
      }

      // Route the hole to a filler: the AI mode picks between local diffusion
      // and Gaussian frost by hole size (MI-GAN only when explicitly picked);
      // the other modes are their own filler.
      const provider: FillProvider =
        eraseType === 'ai'
          ? routeFill({ mode: modeOverride ?? eraseMode, mask: maskGrid, imageWidth: width, imageHeight: height }).provider
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
      try {
        result = await runSmartErase(
          { image: imageData, mask: maskData, composite: alphaData, provider },
          setSmartEraseStage
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
          setSmartEraseStage
        )
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
        showToast(`消除完成（${ERASE_ENGINE_LABELS[provider]}）：${aiLayers.length} 个区域，掩膜外像素未改动`, 'success')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setSmartEraseError(message)
      showToast(`消除失败：${message}`, 'error')
    } finally {
      setIsSmartErasing(false)
      setSmartEraseStage(null)
    }
  }, [decodedSource, file, factory, documentSwitcher, showToast, commitEdit, eraseMode])

  // One-click whole-image watermark cleanup: scan the full frame for sparse
  // stroke components, drop the resulting boxes in as erase masks, and run the
  // smart-repair pipeline pinned to the auto routing (local diffusion / Gaussian
  // frost only — never the generative model, whose hallucinated patches on
  // textured backgrounds read as "the picture got covered"). Non-destructive
  // end to end — the result opens as a new document and the original stays
  // untouched.
  const handleCleanAllWatermarks = useCallback(async () => {
    const state = sessionState(sessionRef.current)
    if (!decodedSource || !file || !state) return
    setIsSmartErasing(true)
    setSmartEraseError(null)
    setSmartEraseStage(null)
    let detected = 0
    try {
      const snapshot = await exportEditor(decodedSource, state, factory, 'image/png', 1)
      const bitmap = await createImageBitmap(snapshot)
      const { width, height } = bitmap
      if (Math.max(width, height) > SMART_ERASE_MAX_EDGE) {
        bitmap.close()
        throw new Error(`图片最大边 ${Math.max(width, height)}px 超过消除上限 ${SMART_ERASE_MAX_EDGE}px，请先裁剪或缩放`)
      }
      const imageCanvas = factory.create(width, height)
      const ctx = imageCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const imageData = ctx.getImageData(0, 0, width, height)
      const regions = detectStrokeRegions({ data: imageData.data, width, height })
      if (regions.length === 0) {
        showToast('未检测到疑似水印笔画：可手动涂抹或框选水印后运行', 'info')
        return
      }
      const totalArea = regions.reduce((sum, box) => sum + box.width * box.height, 0)
      if (totalArea > width * height * 0.6) {
        showToast(`疑似区域覆盖过大（${Math.round((totalArea / (width * height)) * 100)}%），已取消：请手动涂抹水印后运行`, 'info')
        return
      }
      const now = Date.now()
      commitEdit((prev) => ({
        ...prev,
        annotations: [
          ...(prev.annotations ?? []).filter((layer) => layer.type !== 'erase-ai'),
          ...regions.map((box, index) => ({
            id: `erase_detect_${now}_${index}`,
            type: 'erase-ai' as const,
            rect: { x: box.x, y: box.y, width: box.width, height: box.height },
            color: '#34d399',
            strokeWidth: 0,
          })),
        ],
      }))
      detected = regions.length
      showToast(`检测到 ${detected} 处疑似水印，开始高斯磨砂清理`, 'success')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setSmartEraseError(message)
      showToast(`一键清理失败：${message}`, 'error')
      return
    } finally {
      setIsSmartErasing(false)
      setSmartEraseStage(null)
    }
    if (detected > 0) await handleRunErase('ai', 'auto')
  }, [decodedSource, file, factory, commitEdit, showToast, handleRunErase])

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
      if (isSmartErasing) {
        showToast('正在执行智能清理，请等待完成后再恢复草稿', 'info')
        return
      }
      const restoredFile = new File([local.originalBlob], local.fileName, { type: local.mimeType })
      const alreadyListed = openImages.some((img) => img.rootId === local.id)
      if (!alreadyListed && openImages.length >= MAX_OPEN_IMAGES) {
        showToast(`工作集最多同时打开 ${MAX_OPEN_IMAGES} 张图片，请先在左侧列表移除部分图片`, 'info')
        return
      }
      switchActiveRoot(local.id)
      let dims = { width: 0, height: 0 }
      const restored = await documentSwitcher.openStandaloneDocument(
        restoredFile,
        (decoded) => {
          setRootOriginal(local.id, decoded)
          dims = { width: decoded.width, height: decoded.height }
          return { docId: local.id, file: restoredFile, state: local.editorState }
        },
        'restore'
      )
      if (!restored) return
      setOpenImages((prev) =>
        prev.some((img) => img.rootId === local.id)
          ? prev
          : [...prev, { rootId: local.id, name: local.fileName, size: local.fileSize, url: URL.createObjectURL(restoredFile), ...dims }]
      )
      setShowHistoryDrawer(false)
      showToast(`已恢复草稿：${local.title}`, 'success')
    },
    [documentSwitcher, showToast, setRootOriginal, switchActiveRoot, openImages, isSmartErasing]
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
            // Viewport-only movement (pan/zoom live outside the session tree)
            // must also make reset reachable, or a moved image can never be
            // brought back to its origin.
            canReset={
              canUndoSession(session) ||
              Boolean(session.draft) ||
              (Boolean(decodedSource) && isViewportOffFit(panOffset, zoomScale, computeFitScale(decodedSource, viewportSize())))
            }
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

          <ImageListPanel
            images={openImages}
            activeRootId={activeRootId}
            disabled={isSmartErasing}
            onSelect={handleSelectImage}
            onClose={handleCloseImage}
          />

          {/* Master Spatial Canvas Viewport */}
          <main className="w-full h-full">
            <CanvasViewport
              source={decodedSource}
              compareSource={resolveCompareSource(decodedSource, rootOriginalMap.current, activeRootIdRef.current)}
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
              eraseMaskShape={eraseMaskShape}
              eraseBrushSize={eraseBrushSize}
              eraseDrawingEnabled={activeTool === 'watermark' && watermarkTab === 'erase'}
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
            onRunErase={(type) => void handleRunErase(type)}
            onCleanAllWatermarks={() => void handleCleanAllWatermarks()}
            isSmartErasing={isSmartErasing}
            smartEraseStage={smartEraseStage}
            smartEraseError={smartEraseError}
            eraseMaskShape={eraseMaskShape}
            eraseBrushSize={eraseBrushSize}
            eraseMode={eraseMode}
            onEraseMaskShapeSelect={setEraseMaskShape}
            onEraseBrushSizeSelect={setEraseBrushSize}
            onEraseModeSelect={setEraseMode}
            onClearEraseRegions={handleClearEraseRegions}
            onWatermarkTabChange={setWatermarkTab}
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
