import type { EditorState } from '../domain/editor-state'

export interface LocalHistoryItem {
  id: string
  title: string
  fileName: string
  fileSize: number
  mimeType: string
  width: number
  height: number
  thumbnail: string // 320px WebP / JPEG data URL
  originalBlob: Blob // Raw file blob
  editorState: EditorState
  updatedAt: number
  isCloudSynced?: boolean
  cloudId?: string
}

// Stored layout: project metadata lives in `projects`; the raw original image
// lives in `blobs`, written exactly once per draft id. For a given draft id
// the original image never changes (loading or replacing a file always
// allocates a new draft id, and restoring keeps the stored blob), so rewriting
// up to 25MB of pixels on every debounced autosave was pure write
// amplification — subsequent saves only touch the small metadata record.
interface StoredProject extends Omit<LocalHistoryItem, 'originalBlob'> {}

const DB_NAME = 'oneimage_history_v1' // name unchanged: preserves existing user data
const STORE_NAME = 'projects'
const BLOB_STORE_NAME = 'blobs'
const DB_VERSION = 2
const MAX_LOCAL_ITEMS = 30
// Count alone is not a storage budget: 30 drafts × a 25MB original ≈ 750MB,
// which can eat the whole quota and silently stop autosaving. Originals are
// stored once per draft id, so summing fileSize across ids approximates the
// real footprint (thumbnails are data URLs, orders of magnitude smaller).
export const MAX_LOCAL_BYTES = 256 * 1024 * 1024

function isIndexedDBSupported(): boolean {
  return typeof indexedDB !== 'undefined'
}

// One connection per page lifetime: IndexedDB connections are cheap to hold
// and expensive to churn (every open registers with the browser and blocks
// future version upgrades while alive).
let connectionPromise: Promise<IDBDatabase> | null = null

export function openHistoryDB(): Promise<IDBDatabase> {
  if (!isIndexedDBSupported()) {
    return Promise.reject(new Error('IndexedDB is not supported in this environment'))
  }
  if (!connectionPromise) {
    connectionPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = (event) => {
        const req = event.target as IDBOpenDBRequest
        const db = req.result
        const tx = req.transaction
        if (!tx) throw new Error('upgrade transaction unavailable')

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
          store.createIndex('by_updatedAt', 'updatedAt', { unique: false })
        }
        if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) {
          db.createObjectStore(BLOB_STORE_NAME)
        }

        // v1 -> v2: inline blobs move to the blob store so autosaves stop
        // rewriting megabytes of pixels for unchanged images.
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          const projects = tx.objectStore(STORE_NAME)
          const blobs = tx.objectStore(BLOB_STORE_NAME)
          const cursorReq = projects.openCursor()
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor) return
            const item = cursor.value as StoredProject & { originalBlob?: Blob }
            if (item.originalBlob instanceof Blob) {
              blobs.put(item.originalBlob, item.id)
              const { originalBlob: _dropped, ...rest } = item
              cursor.update(rest)
            }
            cursor.continue()
          }
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    connectionPromise.catch(() => {
      connectionPromise = null
    })
  }
  return connectionPromise
}

function dropOriginalBlob(item: LocalHistoryItem): StoredProject {
  const { originalBlob: _dropped, ...rest } = item
  return rest
}

export async function listLocalHistory(): Promise<LocalHistoryItem[]> {
  if (!isIndexedDBSupported()) return []

  try {
    const db = await openHistoryDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readonly')
      const index = tx.objectStore(STORE_NAME).index('by_updatedAt')
      const blobs = tx.objectStore(BLOB_STORE_NAME)
      const request = index.openCursor(null, 'prev') // newest first
      const records: StoredProject[] = []
      const blobRequests: IDBRequest<Blob | undefined>[] = []

      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          records.push(cursor.value as StoredProject)
          blobRequests.push(blobs.get(cursor.value.id))
          cursor.continue()
        }
      }
      request.onerror = () => reject(request.error)
      tx.oncomplete = () => {
        const results: LocalHistoryItem[] = []
        for (let i = 0; i < records.length; i++) {
          const blob = blobRequests[i].result
          // A record without its blob is unrestorable leftover; drop it
          // instead of surfacing a draft that would fail on restore.
          if (blob instanceof Blob) results.push({ ...records[i], originalBlob: blob })
        }
        resolve(results)
      }
    })
  } catch (err) {
    console.error('Failed to list local history:', err)
    return []
  }
}

// Resolves to the persisted item, or null when the write failed (quota
// exceeded, private mode, corrupted database). Callers must surface null:
// silently pretending the draft was saved breaks the history guarantee.
//
// The storage layer owns the per-draft invariants: the original blob is
// written only when absent for this id, the thumbnail is reused after the
// first save (it renders the unchanging original image), and cloud linkage
// survives upserts unless the caller passes an explicit value.
export async function saveLocalHistory(
  item: Omit<LocalHistoryItem, 'updatedAt' | 'isCloudSynced' | 'cloudId'> & {
    updatedAt?: number
    isCloudSynced?: boolean
    cloudId?: string
  }
): Promise<LocalHistoryItem | null> {
  const updatedAt = item.updatedAt || Date.now()

  if (!isIndexedDBSupported()) {
    // No IndexedDB (private mode, old browser): nothing was persisted, so
    // returning a fake "saved" item would lie to the caller. null keeps the
    // quota-failure contract — callers warn instead of trusting history.
    return null
  }

  try {
    const db = await openHistoryDB()
    // Read-merge-write in ONE transaction: two tabs autosaving the same draft
    // would otherwise interleave the readonly get and the readwrite put and
    // lose cloud linkage merges.
    const merged = await new Promise<StoredProject>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readwrite')
      const projects = tx.objectStore(STORE_NAME)
      const blobs = tx.objectStore(BLOB_STORE_NAME)
      let record: StoredProject | null = null
      const existingReq = projects.get(item.id)
      existingReq.onsuccess = () => {
        const existing = (existingReq.result as StoredProject | undefined) ?? null
        record = {
          ...dropOriginalBlob(item as LocalHistoryItem),
          thumbnail: existing?.thumbnail ?? item.thumbnail,
          updatedAt,
        }
        if (item.isCloudSynced !== undefined) record!.isCloudSynced = item.isCloudSynced
        else if (existing?.isCloudSynced !== undefined) record!.isCloudSynced = existing.isCloudSynced
        if (item.cloudId !== undefined) record!.cloudId = item.cloudId
        else if (existing?.cloudId !== undefined) record!.cloudId = existing.cloudId
        // Blob-once: the original image for a draft id never changes, so only
        // the first save pays the bytes; later saves reuse the stored handle.
        const hasBlobReq = blobs.getKey(item.id)
        hasBlobReq.onsuccess = () => {
          if (hasBlobReq.result === undefined && item.originalBlob instanceof Blob) {
            blobs.put(item.originalBlob, item.id)
          }
          projects.put(record!)
        }
        hasBlobReq.onerror = () => reject(hasBlobReq.error)
      }
      existingReq.onerror = () => reject(existingReq.error)
      tx.oncomplete = () => resolve(record!)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })

    // Prune oldest items when over the count or byte budget. A prune failure
    // must not fail the save (the record is already durable) — surface it.
    try {
      await pruneOldestItems(db, MAX_LOCAL_ITEMS, MAX_LOCAL_BYTES, item.id)
    } catch (pruneErr) {
      console.warn('Local history prune failed:', pruneErr)
    }

    return { ...merged, originalBlob: item.originalBlob }
  } catch (err) {
    console.error('Failed to save to local history:', err)
    return null
  }
}

async function pruneOldestItems(db: IDBDatabase, maxItems: number, byteBudget: number, keepId?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readwrite')
    const projects = tx.objectStore(STORE_NAME)
    const blobs = tx.objectStore(BLOB_STORE_NAME)

    const index = projects.index('by_updatedAt')
    const allReq = index.getAll()
    allReq.onsuccess = () => {
      // Oldest-first (the index key is updatedAt). Evict until both the count
      // and byte budgets hold, never dropping the draft just saved or the
      // last remaining item.
      const records = (allReq.result as StoredProject[]).slice().sort((a, b) => a.updatedAt - b.updatedAt)
      const totalBytes = records.reduce((sum, r) => sum + (Number(r.fileSize) || 0), 0)
      let bytes = totalBytes
      const victims = new Set<string>()
      for (const record of records) {
        const remaining = records.length - victims.size
        const overCount = remaining > maxItems
        const overBytes = bytes > byteBudget && remaining > 1
        if (!overCount && !overBytes) break
        if (record.id === keepId) continue
        victims.add(record.id)
        bytes -= Number(record.fileSize) || 0
      }
      for (const id of victims) {
        blobs.delete(id)
        projects.delete(id)
      }
    }
    allReq.onerror = () => reject(allReq.error)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function getLocalHistory(id: string): Promise<LocalHistoryItem | null> {
  if (!isIndexedDBSupported()) return null

  try {
    const db = await openHistoryDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readonly')
      const recordRequest = tx.objectStore(STORE_NAME).get(id)
      const blobRequest = tx.objectStore(BLOB_STORE_NAME).get(id)
      tx.oncomplete = () => {
        const record = recordRequest.result as StoredProject | undefined
        const blob = blobRequest.result
        resolve(record && blob instanceof Blob ? { ...record, originalBlob: blob } : null)
      }
      recordRequest.onerror = () => reject(recordRequest.error)
      blobRequest.onerror = () => reject(blobRequest.error)
    })
  } catch {
    return null
  }
}

export async function deleteLocalHistory(id: string): Promise<void> {
  if (!isIndexedDBSupported()) return

  try {
    const db = await openHistoryDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readwrite')
      tx.objectStore(STORE_NAME).delete(id)
      tx.objectStore(BLOB_STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch (err) {
    console.error('Failed to delete local history:', err)
  }
}

export async function clearAllLocalHistory(): Promise<void> {
  if (!isIndexedDBSupported()) return

  try {
    const db = await openHistoryDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readwrite')
      tx.objectStore(STORE_NAME).clear()
      tx.objectStore(BLOB_STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch (err) {
    console.error('Failed to clear local history:', err)
  }
}
