import type { DecodedSource } from './editor-renderer'
import {
  openDocument as openInTree,
  sessionSnapshot,
  standaloneSession,
  type EditorSession,
  type EditorSnapshot,
} from '../domain/editor-session'

export type SwitchFailure = 'load' | 'restore' | 'switch'

/** Which way the spatial canvas slides during an image-to-image switch. */
export type SwitchDirection = 'forward' | 'backward'

/**
 * Reads the switch direction off the working-set order: moving to a later
 * entry pages forward (the incoming image slides in from the right). Unknown
 * ids default to forward so a missing entry can never flip the animation the
 * wrong way; equal ids never reach this (the switch is a no-op upstream).
 */
export function resolveSwitchDirection(ids: readonly string[], fromId: string, toId: string): SwitchDirection {
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from === -1 || to === -1) return 'forward'
  return to > from ? 'forward' : 'backward'
}

export interface DocumentSwitchHooks {
  /** Decodes a file; injected so the switch choreography is testable. */
  decode(file: File): Promise<DecodedSource>
  /** The session being shown right now. Must be current, not a render snapshot. */
  getSession(): EditorSession
  /** Installs a freshly decoded bitmap as the visible document. */
  install(snapshot: EditorSnapshot, decoded: DecodedSource): void
  /** Publishes a new session (React state and the ref behind `getSession`). */
  commit(session: EditorSession): void
  /** Saves the outgoing draft while its bitmap is still decodable. */
  flushPending(): void
  /** Toggles the busy indicator. */
  setBusy(busy: boolean): void
  onError(error: unknown, failure: SwitchFailure): void
}

export interface DocumentSwitcher {
  /**
   * Applies a session produced by undo/redo. A newer request supersedes an
   * older one, and an edit made while the bitmap decodes cancels the switch so
   * the user's work is never replaced by a tree computed before it.
   */
  applySession(next: EditorSession): Promise<void>
  /**
   * Decodes a document and opens it on top of the tree that is live at install
   * time, so an edit made during the decode stays undoable.
   */
  openDocument(
    file: File,
    prepare: (decoded: DecodedSource) => EditorSnapshot,
    failure?: 'load' | 'restore'
  ): Promise<boolean>
  /**
   * Decodes a file into a STANDALONE session (fresh history tree) for the
   * multi-image working set: the previous document is not chained into the new
   * session, so undo never crosses images.
   */
  openStandaloneDocument(
    file: File,
    prepare: (decoded: DecodedSource) => EditorSnapshot,
    failure?: 'load' | 'restore'
  ): Promise<boolean>
  /** The session a further undo/redo must chain from while a switch runs. */
  pendingSession(): EditorSession | null
}

/**
 * Serializes document switches. Every switch decodes asynchronously, so an
 * epoch decides which one owns the canvas and the busy indicator, and a
 * pending session lets repeated undo walk back more than one step without
 * waiting for each bitmap.
 */
export function createDocumentSwitcher(hooks: DocumentSwitchHooks): DocumentSwitcher {
  let epoch = 0
  let pending: EditorSession | null = null
  let busy = false

  function begin(): number {
    epoch += 1
    if (!busy) {
      busy = true
      hooks.setBusy(true)
    }
    return epoch
  }

  function settle(myEpoch: number): void {
    // A newer switch owns the pending session and the indicator.
    if (myEpoch !== epoch) return
    pending = null
    if (busy) {
      busy = false
      hooks.setBusy(false)
    }
  }

  async function applySession(next: EditorSession): Promise<void> {
    const myEpoch = begin()
    const live = hooks.getSession()
    const target = sessionSnapshot(next)
    const active = sessionSnapshot(live)
    pending = next

    // Same document (or nothing loaded): nothing to decode.
    if (!target || (active && active.docId === target.docId)) {
      hooks.commit(next)
      settle(myEpoch)
      return
    }

    try {
      hooks.flushPending()
      const decoded = await hooks.decode(target.file)
      if (myEpoch !== epoch) {
        decoded.close()
        return
      }
      if (hooks.getSession() !== live) {
        // The user kept working while the bitmap decoded; installing the older
        // tree now would discard that work.
        decoded.close()
        return
      }
      hooks.install(target, decoded)
      hooks.commit(next)
    } catch (error) {
      if (myEpoch === epoch) hooks.onError(error, 'switch')
    } finally {
      settle(myEpoch)
    }
  }

  async function openDocument(
    file: File,
    prepare: (decoded: DecodedSource) => EditorSnapshot,
    failure: 'load' | 'restore' = 'load'
  ): Promise<boolean> {
    const myEpoch = begin()
    try {
      hooks.flushPending()
      const decoded = await hooks.decode(file)
      if (myEpoch !== epoch) {
        decoded.close()
        return false
      }
      const snapshot = prepare(decoded)
      hooks.install(snapshot, decoded)
      hooks.commit(openInTree(hooks.getSession(), snapshot))
      return true
    } catch (error) {
      if (myEpoch === epoch) hooks.onError(error, failure)
      return false
    } finally {
      settle(myEpoch)
    }
  }

  async function openStandaloneDocument(
    file: File,
    prepare: (decoded: DecodedSource) => EditorSnapshot,
    failure: 'load' | 'restore' = 'load'
  ): Promise<boolean> {
    const myEpoch = begin()
    try {
      hooks.flushPending()
      const decoded = await hooks.decode(file)
      if (myEpoch !== epoch) {
        decoded.close()
        return false
      }
      const snapshot = prepare(decoded)
      hooks.install(snapshot, decoded)
      hooks.commit(standaloneSession(snapshot))
      return true
    } catch (error) {
      if (myEpoch === epoch) hooks.onError(error, failure)
      return false
    } finally {
      settle(myEpoch)
    }
  }

  return { applySession, openDocument, openStandaloneDocument, pendingSession: () => pending }
}
