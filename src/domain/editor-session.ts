import { editorStatesEqual, type AnnotationLayer, type EditorState, type HistoryTree } from './editor-state'

/**
 * A history entry is a whole document, not just its parameters: restoring a
 * draft from the history drawer replaces the decoded image as well, so undo has
 * to be able to bring the previous image back.
 */
export interface EditorSnapshot {
  /** Stable per-document id; also the IndexedDB draft id for restored drafts. */
  docId: string
  file: File
  state: EditorState
}

/**
 * `history` only ever holds committed snapshots. Live gesture output (a crop
 * drag, a slider sweep) lives in `draft` until the gesture ends, so committing
 * can push the state the user started from instead of the state they ended on.
 */
export interface EditorSession {
  history: HistoryTree<EditorSnapshot> | null
  draft: EditorState | null
}

export const EMPTY_SESSION: EditorSession = { history: null, draft: null }

export function sessionState(session: EditorSession): EditorState | null {
  return session.draft ?? session.history?.present.state ?? null
}

export function sessionSnapshot(session: EditorSession): EditorSnapshot | null {
  return session.history?.present ?? null
}

export function canUndoSession(session: EditorSession): boolean {
  return (session.history?.past.length ?? 0) > 0
}

export function canRedoSession(session: EditorSession): boolean {
  return (session.history?.future.length ?? 0) > 0
}

/** What the user is currently looking at, draft included. */
function visibleSnapshot(session: EditorSession): EditorSnapshot | null {
  const present = session.history?.present
  if (!present) return null
  return session.draft ? { ...present, state: session.draft } : present
}

/** Live gesture output: shown immediately, not yet an undoable step. */
export function liveEdit(session: EditorSession, next: EditorState): EditorSession {
  if (!session.history) return session
  const visible = sessionState(session)
  if (visible && editorStatesEqual(visible, next)) return session
  // The redo branch is abandoned when an edit is committed, not when a gesture
  // starts: a sweep that returns to its starting value must keep redo alive.
  return { history: session.history, draft: next }
}

/**
 * Commits whatever the live gesture produced (crop drag, slider sweep). The
 * state comes from the session itself — never from a caller's render snapshot,
 * which can lag a pointer move or predate the gesture.
 */
export function commitDraft(session: EditorSession): EditorSession {
  const { history, draft } = session
  if (!history || !draft) return session
  // A live draft always differs from the committed state (liveEdit filters
  // no-ops); this also keeps a hand-built session from recording a duplicate.
  if (editorStatesEqual(history.present.state, draft)) return { history, draft: null }
  return {
    history: { past: [...history.past, history.present], present: { ...history.present, state: draft }, future: [] },
    draft: null,
  }
}

/**
 * Records a discrete action. Unlike a gesture, an uncommitted draft is part of
 * the state the user was looking at, so undo restores the draft too.
 */
export function commitVisibleState(session: EditorSession, next: EditorState): EditorSession {
  const visible = visibleSnapshot(session)
  if (!visible) return session
  if (editorStatesEqual(visible.state, next)) return { history: session.history, draft: null }
  return {
    history: { past: [...(session.history?.past ?? []), visible], present: { ...visible, state: next }, future: [] },
    draft: null,
  }
}

/**
 * Adds an annotation layer to whatever the user is looking at — an uncommitted
 * gesture included — as one undoable step. The viewport hands over the layer
 * alone so the state it is drawn onto always comes from the session.
 */
export function addAnnotationLayer(session: EditorSession, layer: AnnotationLayer): EditorSession {
  const visible = visibleSnapshot(session)
  if (!visible) return session
  const annotations = [...(visible.state.annotations ?? []), layer]
  return commitVisibleState(session, { ...visible.state, annotations })
}

/**
 * Drops an in-flight gesture, restoring the committed state. A cancelled crop
 * or slider sweep is not an edit the user meant to keep, and must not become an
 * undo step.
 */
export function discardDraft(session: EditorSession): EditorSession {
  if (!session.draft) return session
  return { history: session.history, draft: null }
}

export function undoSession(session: EditorSession): EditorSession {
  const history = session.history
  const visible = visibleSnapshot(session)
  if (!history || !visible || history.past.length === 0) return session
  const target = history.past[history.past.length - 1]
  return {
    history: { past: history.past.slice(0, -1), present: target, future: [visible, ...history.future] },
    draft: null,
  }
}

export function redoSession(session: EditorSession): EditorSession {
  const history = session.history
  const visible = visibleSnapshot(session)
  if (!history || !visible || history.future.length === 0) return session
  const target = history.future[0]
  return {
    history: { past: [...history.past, visible], present: target, future: history.future.slice(1) },
    draft: null,
  }
}

/**
 * Opens a document (new image, or a draft restored from history). The document
 * being replaced stays in the tree, so undo switches back to it.
 */
export function openDocument(session: EditorSession, snapshot: EditorSnapshot): EditorSession {
  const visible = visibleSnapshot(session)
  if (!visible) return { history: { past: [], present: snapshot, future: [] }, draft: null }
  return {
    history: { past: [...(session.history?.past ?? []), visible], present: snapshot, future: [] },
    draft: null,
  }
}

/**
 * A fresh history tree rooted at `snapshot` — the session shape for an image
 * loaded into the multi-image working set. Images in the set are decoupled:
 * each owns its tree, so undo/redo never walks into another image.
 */
export function standaloneSession(snapshot: EditorSnapshot): EditorSession {
  return { history: { past: [], present: snapshot, future: [] }, draft: null }
}
