import { useCallback, useEffect, useRef } from 'react'
import type { EditorState } from '../domain/editor-state'
import { saveLocalHistory } from '../infrastructure/history-storage'
import type { DecodedSource } from './editor-renderer'

// Extracted from App.tsx: debounced draft autosave with its lifecycle — the
// once-per-draft thumbnail cache, the flush-before-pagehide/visibility, and
// the one-time quota warning. App keeps ownership of the draft id ref (the
// document switcher mints ids) and passes it in.

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

export interface DraftPersistenceInput {
  file: File | null
  decodedSource: DecodedSource | null
  currentState: EditorState | null
  currentDraftIdRef: { current: string | null }
  showToast: (text: string, type?: 'info' | 'success' | 'error') => void
  /** Re-render trigger after a save lands (App refreshes its history list). */
  onSaved: () => void
}

export function useDraftPersistence(input: DraftPersistenceInput): {
  flushPendingPersist: () => void
} {
  const { file, decodedSource, currentState, currentDraftIdRef, showToast, onSaved } = input

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

        onSaved()
      } catch (err) {
        console.warn('Auto-save to IndexedDB skipped:', err)
        if (!persistWarnedRef.current) {
          persistWarnedRef.current = true
          showToast('本地草稿保存失败，请及时导出保留成果', 'error')
        }
      }
    },
    [showToast, thumbnailFor, onSaved]
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
  }, [file, decodedSource, currentState, persistDraftNow, currentDraftIdRef])

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

  return { flushPendingPersist }
}
