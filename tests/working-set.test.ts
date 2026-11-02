import { describe, expect, it } from 'vitest'
import { MAX_OPEN_IMAGES, findRootIdForSession } from '../src/domain/working-set'

describe('findRootIdForSession', () => {
  const sessions = new Map<string, object>([
    ['root-a', { id: 'session-a' }],
    ['root-b', { id: 'session-b' }],
  ])

  it('finds the owning entry by identity', () => {
    expect(findRootIdForSession(sessions, sessions.get('root-a'))).toBe('root-a')
  })

  it('returns null for a session that belongs to no entry (structurally equal is not enough)', () => {
    expect(findRootIdForSession(sessions, { id: 'session-a' })).toBeNull()
  })

  it('returns null for null/undefined sessions', () => {
    expect(findRootIdForSession(sessions, null)).toBeNull()
    expect(findRootIdForSession(sessions, undefined)).toBeNull()
  })
})

describe('MAX_OPEN_IMAGES', () => {
  it('bounds the working set', () => {
    expect(MAX_OPEN_IMAGES).toBeGreaterThan(1)
    expect(MAX_OPEN_IMAGES).toBeLessThanOrEqual(16)
  })
})
