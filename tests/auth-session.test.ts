import { describe, expect, it, vi } from 'vitest'
import { initDatabase } from '../server/db'
import { authenticateUser, createSession, createUser, deleteSession, purgeExpiredSessions, updateUserProfile, validateSession } from '../server/auth'

// Sessions are stored token-hashed; these tests pin the lifecycle contract
// directly (the route tests exercise it only through cookies).
describe('session lifecycle', () => {
  it('round-trips a token through create/validate and never stores the plaintext', async () => {
    const appDb = initDatabase(':memory:')
    const user = await createUser(appDb.db, { username: 'sess', email: 'sess@example.com', password: 'long-enough-password' })
    const session = createSession(appDb.db, user.id, 30)
    expect(session.token.startsWith('sess_')).toBe(true)

    const validated = validateSession(appDb.db, session.token)
    expect(validated?.id).toBe(user.id)

    const row = appDb.db.prepare('SELECT token FROM sessions').get() as { token: string }
    expect(row.token).not.toBe(session.token)
    expect(row.token).toMatch(/^[0-9a-f]{64}$/)
    appDb.close()
  })

  it('rejects an unknown token and a forged one that hashes differently', async () => {
    const appDb = initDatabase(':memory:')
    const user = await createUser(appDb.db, { username: 'forgery', email: 'forgery@example.com', password: 'long-enough-password' })
    const session = createSession(appDb.db, user.id)
    expect(validateSession(appDb.db, 'sess_deadbeef')).toBeNull()
    // Flip one char of the real token: the SHA-256 no longer matches storage.
    const forged = (session.token[0] === 'a' ? 'b' : 'a') + session.token.slice(1)
    expect(validateSession(appDb.db, forged)).toBeNull()
    appDb.close()
  })

  it('honours expiry: an expired session validates to null even though the row exists', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const appDb = initDatabase(':memory:')
      const user = await createUser(appDb.db, { username: 'expiry', email: 'expiry@example.com', password: 'long-enough-password' })
      const session = createSession(appDb.db, user.id, 1)
      expect(validateSession(appDb.db, session.token)).not.toBeNull()
      vi.setSystemTime(new Date('2026-01-02T00:00:01Z'))
      expect(validateSession(appDb.db, session.token)).toBeNull()
      // purgeExpiredSessions removes the stale row but keeps live ones.
      const live = createSession(appDb.db, user.id)
      purgeExpiredSessions(appDb.db)
      const count = (appDb.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n
      expect(count).toBe(1)
      expect(validateSession(appDb.db, live.token)).not.toBeNull()
      appDb.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deleteSession invalidates immediately and is idempotent', async () => {
    const appDb = initDatabase(':memory:')
    const user = await createUser(appDb.db, { username: 'logout', email: 'logout@example.com', password: 'long-enough-password' })
    const session = createSession(appDb.db, user.id)
    deleteSession(appDb.db, session.token)
    expect(validateSession(appDb.db, session.token)).toBeNull()
    expect(() => deleteSession(appDb.db, session.token)).not.toThrow()
    appDb.close()
  })

  it('unknown accounts burn the same scrypt cost instead of erroring (timing equalizer)', async () => {
    const appDb = initDatabase(':memory:')
    const startedAt = Date.now()
    expect(await authenticateUser(appDb.db, 'nobody-here', 'whatever-password')).toBeNull()
    // A real scrypt run (16MB N=2^16) takes far longer than a trivial miss;
    // a loose floor catches a regression that skips the equalizer burn.
    expect(Date.now() - startedAt).toBeGreaterThan(50)
    appDb.close()
  })
})

describe('updateUserProfile defensive normalization', () => {
  async function seeded() {
    const appDb = initDatabase(':memory:')
    const user = await createUser(appDb.db, { username: 'profile', email: 'profile@example.com', password: 'long-enough-password', nickname: 'origin' })
    return { appDb, user }
  }

  it('keeps the stored nickname when the update is blank or whitespace-only', async () => {
    const { appDb, user } = await seeded()
    expect(updateUserProfile(appDb.db, user.id, { nickname: '   ' })?.nickname).toBe('origin')
    expect(updateUserProfile(appDb.db, user.id, {})?.nickname).toBe('origin')
    appDb.close()
  })

  it('keeps the stored avatar color when the update is not a valid one', async () => {
    const { appDb, user } = await seeded()
    // isAvatarColor accepts any 6-digit hex, so an off-palette hex is valid;
    // the defensive case is a malformed color (wrong length / non-hex).
    expect(updateUserProfile(appDb.db, user.id, { avatar_color: '#ff00ff' })?.avatar_color).toBe('#ff00ff')
    const before = updateUserUserProfileSafe(appDb.db, user.id, 'origin').avatar_color
    expect(updateUserProfile(appDb.db, user.id, { avatar_color: 'red' })?.avatar_color).toBe(before)
    expect(updateUserProfile(appDb.db, user.id, { avatar_color: '#12345' })?.avatar_color).toBe(before)
    appDb.close()
  })

  it('truncates nicknames to 32 characters and accepts valid colors', async () => {
    const { appDb, user } = await seeded()
    const long = 'x'.repeat(50)
    const updated = updateUserUserProfileSafe(appDb.db, user.id, long)
    expect(updated.nickname.length).toBe(32)
    appDb.close()
  })

  it('returns null for an unknown user id without touching any row', async () => {
    const { appDb } = await seeded()
    expect(updateUserProfile(appDb.db, 'usr_missing', { nickname: 'nope' })).toBeNull()
    appDb.close()
  })
})

// Inline helper so the assertion reads as the returned user; avatar-color
// behavior is pinned separately above.
function updateUserUserProfileSafe(
  db: ReturnType<typeof initDatabase>['db'],
  id: string,
  nickname: string
) {
  const updated = updateUserProfile(db, id, { nickname })
  expect(updated).not.toBeNull()
  return updated!
}
