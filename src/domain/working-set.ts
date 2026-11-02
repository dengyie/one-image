// Multi-image working set helpers. Pure and Node-testable: the App wires these
// into its component state and refs.

/** Upper bound on simultaneously open images — each open image holds a session
 * tree plus a full-resolution root snapshot canvas, so the set stays bounded. */
export const MAX_OPEN_IMAGES = 8

/** Reverse-lookup which working-set entry currently owns `session` (by
 * identity). Returns null when the session belongs to no open image. */
export function findRootIdForSession<T>(sessions: ReadonlyMap<string, T>, session: T | null | undefined): string | null {
  if (!session) return null
  for (const [rootId, value] of sessions) if (value === session) return rootId
  return null
}
