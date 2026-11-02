import { describe, expect, it, vi } from 'vitest'
import {
  createDocumentSwitcher,
  type SwitchFailure,
} from '../src/application/document-switch'
import type { DecodedSource } from '../src/application/editor-renderer'
import { createEditorState } from '../src/domain/editor-state'
import {
  EMPTY_SESSION,
  canUndoSession,
  commitVisibleState,
  openDocument,
  sessionState,
  standaloneSession,
  undoSession,
  type EditorSession,
  type EditorSnapshot,
} from '../src/domain/editor-session'

function makeFile(name: string): File {
  return new File([new Uint8Array([0])], name, { type: 'image/png' })
}

function snapshot(docId: string): EditorSnapshot {
  return { docId, file: makeFile(`${docId}.png`), state: createEditorState(100, 100) }
}

function fakeDecoded(width = 100, height = 100) {
  const close = vi.fn()
  const source: DecodedSource = { width, height, draw: () => {}, close }
  return { source, close }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Harness {
  switcher: ReturnType<typeof createDocumentSwitcher>
  decode: ReturnType<typeof vi.fn>
  installed: Array<{ snapshot: EditorSnapshot; decoded: DecodedSource }>
  commits: EditorSession[]
  busy: boolean[]
  errors: Array<{ error: unknown; failure: SwitchFailure }>
  flushCalls: number
  session(): EditorSession
  setSession(next: EditorSession): void
}

function createHarness(
  decodeImpl: (file: File) => Promise<DecodedSource> = async () => fakeDecoded().source
): Harness {
  const state = {
    session: EMPTY_SESSION as EditorSession,
    installed: [] as Array<{ snapshot: EditorSnapshot; decoded: DecodedSource }>,
    commits: [] as EditorSession[],
    busy: [] as boolean[],
    errors: [] as Array<{ error: unknown; failure: SwitchFailure }>,
    flushCalls: 0,
  }

  const decode = vi.fn(decodeImpl)
  const switcher = createDocumentSwitcher({
    decode,
    getSession: () => state.session,
    install: (snapshot, decoded) => {
      state.installed.push({ snapshot, decoded })
    },
    commit: (next) => {
      state.session = next
      state.commits.push(next)
    },
    flushPending: () => {
      state.flushCalls += 1
    },
    setBusy: (busy) => {
      state.busy.push(busy)
    },
    onError: (error, failure) => {
      state.errors.push({ error, failure })
    },
  })

  return {
    switcher,
    decode,
    installed: state.installed,
    commits: state.commits,
    busy: state.busy,
    errors: state.errors,
    get flushCalls() {
      return state.flushCalls
    },
    session: () => state.session,
    setSession: (next) => {
      state.session = next
    },
  }
}

describe('document switcher', () => {
  it('commits a same-document undo without decoding', async () => {
    const harness = createHarness()
    const base = openDocument(EMPTY_SESSION, snapshot('doc-a'))
    harness.setSession(base)
    const edited = commitVisibleState(base, { ...base.history!.present.state, rotation: 90 })

    await harness.switcher.applySession(edited)

    expect(harness.decode).not.toHaveBeenCalled()
    expect(harness.installed).toHaveLength(0)
    expect(harness.session()).toBe(edited)
    expect(harness.busy).toEqual([true, false])
    expect(harness.switcher.pendingSession()).toBeNull()
  })

  it('decodes and installs the target document before committing', async () => {
    const decoded = fakeDecoded()
    const harness = createHarness(async () => decoded.source)
    const base = openDocument(EMPTY_SESSION, snapshot('doc-a'))
    harness.setSession(base)
    const toB = openDocument(base, snapshot('doc-b'))

    await harness.switcher.applySession(toB)

    expect(harness.decode).toHaveBeenCalledTimes(1)
    expect(harness.installed.map((entry) => entry.snapshot.docId)).toEqual(['doc-b'])
    expect(harness.commits.at(-1)).toBe(toB)
    expect(harness.flushCalls).toBe(1)
    expect(harness.busy).toEqual([true, false])
  })

  it('never lets a superseded switch paint over a newer one', async () => {
    const first = deferred<DecodedSource>()
    const second = deferred<DecodedSource>()
    const queue = [first.promise, second.promise]
    const harness = createHarness(() => queue.shift()!)
    const decodedB = fakeDecoded()
    const decodedC = fakeDecoded()

    const base = openDocument(EMPTY_SESSION, snapshot('doc-a'))
    harness.setSession(base)
    const toB = openDocument(base, snapshot('doc-b'))
    const toC = openDocument(base, snapshot('doc-c'))

    const firstSwitch = harness.switcher.applySession(toB)
    const secondSwitch = harness.switcher.applySession(toC)
    expect(harness.switcher.pendingSession()).toBe(toC)

    second.resolve(decodedC.source)
    await secondSwitch
    first.resolve(decodedB.source)
    await firstSwitch

    expect(harness.installed.map((entry) => entry.snapshot.docId)).toEqual(['doc-c'])
    expect(harness.session()).toBe(toC)
    // The stale bitmap is released instead of leaking.
    expect(decodedB.close).toHaveBeenCalledTimes(1)
    expect(decodedC.close).not.toHaveBeenCalled()
    // Only the newer switch owns the busy indicator; the stale one must not
    // clear it early or toggle it twice.
    expect(harness.busy).toEqual([true, false])
  })

  it('cancels a switch when the user edited while the bitmap decoded', async () => {
    const progress = deferred<DecodedSource>()
    const harness = createHarness(() => progress.promise)
    const decoded = fakeDecoded()

    const base = openDocument(EMPTY_SESSION, snapshot('doc-a'))
    harness.setSession(base)
    const toB = openDocument(base, snapshot('doc-b'))

    const switching = harness.switcher.applySession(toB)
    // The user keeps working on the live document during the decode.
    const edited = commitVisibleState(base, { ...base.history!.present.state, flipX: true })
    harness.setSession(edited)

    progress.resolve(decoded.source)
    await switching

    expect(harness.installed).toHaveLength(0)
    expect(harness.session()).toBe(edited)
    expect(decoded.close).toHaveBeenCalledTimes(1)
    expect(harness.busy).toEqual([true, false])
  })

  it('chains repeated undo from the pending session and clears it on settle', async () => {
    const progress = deferred<DecodedSource>()
    const harness = createHarness(() => progress.promise)
    const base = openDocument(EMPTY_SESSION, snapshot('doc-a'))
    harness.setSession(base)
    const toB = openDocument(base, snapshot('doc-b'))

    const switching = harness.switcher.applySession(toB)
    // A second ⌘Z must walk back from doc-b, not from the still-visible doc-a.
    expect(harness.switcher.pendingSession()).toBe(toB)

    progress.resolve(fakeDecoded().source)
    await switching
    expect(harness.switcher.pendingSession()).toBeNull()
  })

  it('opens a document on top of edits made during its decode', async () => {
    const progress = deferred<DecodedSource>()
    const harness = createHarness(() => progress.promise)
    const base = openDocument(EMPTY_SESSION, snapshot('doc-a'))
    harness.setSession(base)

    const opening = harness.switcher.openDocument(makeFile('doc-b.png'), () => snapshot('doc-b'))
    const edited = commitVisibleState(base, { ...base.history!.present.state, rotation: 90 })
    harness.setSession(edited)

    progress.resolve(fakeDecoded().source)
    const opened = await opening

    expect(opened).toBe(true)
    expect(harness.session().history?.present.docId).toBe('doc-b')
    // The in-flight edit stays in the tree, one undo away.
    const undone = undoSession(harness.session())
    expect(undone.history?.present.docId).toBe('doc-a')
    expect(sessionState(undone)).toEqual({ ...base.history!.present.state, rotation: 90 })
  })

  it('reports a failed switch with its context and clears busy', async () => {
    const harness = createHarness(async () => {
      throw new Error('decode failed')
    })
    const base = openDocument(EMPTY_SESSION, snapshot('doc-a'))
    harness.setSession(base)

    await harness.switcher.applySession(openDocument(base, snapshot('doc-b')))

    expect(harness.errors).toHaveLength(1)
    expect(harness.errors[0].failure).toBe('switch')
    expect(harness.installed).toHaveLength(0)
    expect(harness.session()).toBe(base)
    expect(harness.busy).toEqual([true, false])
  })

  it('reports a failed restore as a restore, not a generic load', async () => {
    const harness = createHarness(async () => {
      throw new Error('decode failed')
    })

    const opened = await harness.switcher.openDocument(makeFile('doc-b.png'), () => snapshot('doc-b'), 'restore')

    expect(opened).toBe(false)
    expect(harness.errors[0].failure).toBe('restore')
    expect(harness.busy).toEqual([true, false])
  })

  it('returns false when a newer switch owns the canvas', async () => {
    const first = deferred<DecodedSource>()
    const second = deferred<DecodedSource>()
    const queue = [first.promise, second.promise]
    const harness = createHarness(() => queue.shift()!)
    const decodedA = fakeDecoded()
    const decodedB = fakeDecoded()

    const firstOpen = harness.switcher.openDocument(makeFile('a.png'), () => snapshot('doc-a'))
    const secondOpen = harness.switcher.openDocument(makeFile('b.png'), () => snapshot('doc-b'))

    second.resolve(decodedB.source)
    await secondOpen
    first.resolve(decodedA.source)
    expect(await firstOpen).toBe(false)

    expect(harness.installed.map((entry) => entry.snapshot.docId)).toEqual(['doc-b'])
    expect(decodedA.close).toHaveBeenCalledTimes(1)
  })
})

describe('standalone (multi-image) sessions', () => {
  it('openStandaloneDocument starts a fresh tree instead of chaining the previous document', async () => {
    const decoded = fakeDecoded()
    const harness = createHarness(async () => decoded.source)
    const first = standaloneSession(snapshot('doc-a'))
    harness.setSession(first)

    await harness.switcher.openStandaloneDocument(makeFile('doc-b.png'), () => snapshot('doc-b'))

    const committed = harness.session()
    expect(committed.history!.present.docId).toBe('doc-b')
    expect(committed.history!.past).toEqual([])
    // The first image stays alive in its own session, untouched.
    expect(first.history!.present.docId).toBe('doc-a')
    expect(canUndoSession(first)).toBe(false)
  })

  it('keeps two images decoupled: switching never merges trees and undo stays per image', () => {
    const sessionA = standaloneSession(snapshot('img-a'))
    const sessionB = standaloneSession(snapshot('img-b'))

    // Edit A twice, B once.
    const a1 = commitVisibleState(sessionA, { ...sessionA.history!.present.state, rotation: 90 })
    const a2 = commitVisibleState(a1, { ...a1.history!.present.state, rotation: 180 })
    const b1 = commitVisibleState(sessionB, { ...sessionB.history!.present.state, rotation: 45 })

    expect(canUndoSession(a2)).toBe(true)
    expect(canUndoSession(b1)).toBe(true)
    expect(b1.history!.past.some((entry) => entry.docId === 'img-a')).toBe(false)
    expect(a2.history!.past.every((entry) => entry.docId === 'img-a')).toBe(true)

    // Undo on B never lands on A.
    const b0 = undoSession(b1)
    expect(b0.history!.present.docId).toBe('img-b')
    expect(canUndoSession(b0)).toBe(false)

    // Undo on A walks only A's own two steps.
    const a1undone = undoSession(a2)
    expect(a1undone.history!.present.docId).toBe('img-a')
    const a0 = undoSession(a1undone)
    expect(a0.history!.present.docId).toBe('img-a')
    expect(canUndoSession(a0)).toBe(false)
  })

  it('openStandaloneDocument routes failures through the same error path', async () => {
    const harness = createHarness(async () => {
      throw new Error('bad image')
    })
    const ok = await harness.switcher.openStandaloneDocument(makeFile('x.png'), () => snapshot('x'))
    expect(ok).toBe(false)
    expect(harness.errors).toHaveLength(1)
    expect(harness.errors[0].failure).toBe('load')
  })
})
