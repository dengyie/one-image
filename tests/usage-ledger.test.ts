import { describe, expect, it } from 'vitest'
import { initDatabase } from '../server/db'
import { addUsage, readUsage, subUsage, todayKey } from '../server/usage-ledger'

const TABLE = 'imagegen_usage' as const
const CLIENT = '203.0.113.7'

function freshDb() {
  return initDatabase(':memory:').db
}

describe('usage ledger', () => {
  it('counts per client per day, isolated across clients and tables', () => {
    const db = freshDb()
    addUsage(db, TABLE, CLIENT, '2026-11-13', 1)
    addUsage(db, TABLE, CLIENT, '2026-11-13', 2)
    expect(readUsage(db, TABLE, CLIENT, '2026-11-13')).toBe(3)
    // Another client starts from zero; another table too.
    expect(readUsage(db, TABLE, '198.51.100.1', '2026-11-13')).toBe(0)
    expect(readUsage(db, 'videogen_usage', CLIENT, '2026-11-13')).toBe(0)
    db.close()
  })

  it('deletes yesterday buckets on the first write of a new day', () => {
    const db = freshDb()
    addUsage(db, TABLE, CLIENT, '2026-11-12', 5)
    addUsage(db, TABLE, '198.51.100.9', '2026-11-12', 7)
    // The day rolled: the first write of the new day sweeps every stale bucket.
    addUsage(db, TABLE, CLIENT, '2026-11-13', 1)
    expect(readUsage(db, TABLE, CLIENT, '2026-11-12')).toBe(0)
    expect(readUsage(db, TABLE, '198.51.100.9', '2026-11-12')).toBe(0)
    expect(readUsage(db, TABLE, CLIENT, '2026-11-13')).toBe(1)
    db.close()
  })

  it('keeps the current day reachable for later reads while sweeping', () => {
    const db = freshDb()
    addUsage(db, TABLE, CLIENT, '2026-11-13', 4)
    // A sweep triggered by another client's write must not touch today's row.
    addUsage(db, 'videogen_usage', '198.51.100.2', '2026-11-13', 1)
    expect(readUsage(db, TABLE, CLIENT, '2026-11-13')).toBe(4)
    db.close()
  })

  it('refunds are clamped at zero and delete a bucket that lands back at zero', () => {
    const db = freshDb()
    // Refunding a client with no row must not create a negative count.
    subUsage(db, TABLE, '198.51.100.3', '2026-11-13', 2)
    expect(readUsage(db, TABLE, '198.51.100.3', '2026-11-13')).toBe(0)
    addUsage(db, TABLE, CLIENT, '2026-11-13', 3)
    subUsage(db, TABLE, CLIENT, '2026-11-13', 5)
    expect(readUsage(db, TABLE, CLIENT, '2026-11-13')).toBe(0)
    subUsage(db, TABLE, CLIENT, '2026-11-13', 1)
    // Still zero, never negative.
    expect(readUsage(db, TABLE, CLIENT, '2026-11-13')).toBe(0)
    // Partial refund leaves the remainder standing.
    addUsage(db, TABLE, CLIENT, '2026-11-13', 4)
    subUsage(db, TABLE, CLIENT, '2026-11-13', 1)
    expect(readUsage(db, TABLE, CLIENT, '2026-11-13')).toBe(3)
    db.close()
  })

  it('derives the day key in local calendar terms', () => {
    // 2026-02-28 23:30 local → the Feb 28 bucket (single-operator site
    // budgeting by local calendar day).
    expect(todayKey(new Date(2026, 1, 28, 23, 30))).toBe('2026-02-28')
    expect(todayKey(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31')
  })
})
