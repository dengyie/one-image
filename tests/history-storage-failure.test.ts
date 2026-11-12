import { describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import {
  saveLocalHistory,
  listLocalHistory,
  getLocalHistory,
} from '../src/infrastructure/history-storage'
import { createEditorState } from '../src/domain/editor-state'

function makeItem(id: string) {
  return {
    id,
    title: `Item ${id}`,
    fileName: `${id}.png`,
    fileSize: 1000,
    mimeType: 'image/png',
    width: 100,
    height: 100,
    thumbnail: 'data:stub',
    originalBlob: new Blob([`blob-${id}`]),
    editorState: createEditorState(100, 100),
  }
}

describe('history-storage failure paths', () => {
  it('degrades gracefully when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined)

    // Honest contract: without IndexedDB nothing was persisted, so the save
    // reports null (the same signal as a quota failure) instead of a fake
    // item the caller would trust.
    const saved = await saveLocalHistory(makeItem('unavailable'))
    expect(saved).toBeNull()
    expect(await listLocalHistory()).toEqual([])
    expect(await getLocalHistory('unavailable')).toBeNull()

    vi.unstubAllGlobals()
  })

  it('reports null instead of pretending a failed write succeeded', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request: { error?: Error; onerror?: (event: unknown) => void; onsuccess?: (event: unknown) => void } = {}
        setTimeout(() => {
          request.error = new DOMException('encountered a full disk', 'QuotaExceededError')
          request.onerror?.({ target: request })
        }, 0)
        return request
      },
    })

    const saved = await saveLocalHistory(makeItem('doomed'))
    expect(saved).toBeNull()
    expect(await listLocalHistory()).toEqual([])
    expect(await getLocalHistory('doomed')).toBeNull()

    vi.unstubAllGlobals()
  })

  it('recovers with a fresh connection after a failed open', async () => {
    // The previous test left a poisoned connection promise; the singleton must
    // reset itself so the next operation gets a working database.
    const saved = await saveLocalHistory(makeItem('recovered'))
    expect(saved).not.toBeNull()
    const listed = await listLocalHistory()
    expect(listed.map((item) => item.id)).toContain('recovered')

    await import('../src/infrastructure/history-storage').then(async ({ clearAllLocalHistory }) => {
      await clearAllLocalHistory()
    })
  })
})
