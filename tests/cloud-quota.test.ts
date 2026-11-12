import { describe, expect, it } from 'vitest'
import { initDatabase } from '../server/db'
import {
  MAX_PROJECTS_PER_USER,
  MAX_TOTAL_PROJECT_BYTES_PER_USER,
  getUserStorageStats,
  projectBytes,
} from '../server/cloud-quota'

const UTF8_PROBE = '中文水印' // 4 chars = 12 UTF-8 bytes — pins the byte-not-chars contract

describe('cloud-quota accounting', () => {
  it('measures payloads in UTF-8 bytes, not characters', () => {
    const bytes = projectBytes({ title: UTF8_PROBE, original_filename: '', thumbnail_data: '', state_json: '' })
    expect(bytes).toBe(12)
  })

  it('tracks per-user project count and byte totals in UTF-8', () => {
    const appDb = initDatabase(':memory:')
    const userId = 'usr_quota'
    const seedUser = (id: string): void => {
      appDb.db.prepare(`
        INSERT INTO users (id, username, email, password_hash, salt, nickname, avatar_color, created_at, updated_at)
        VALUES (?, ?, ?, 'hash', 'salt', ?, '#123456', 1, 1)
      `).run(id, id, `${id}@example.com`, id)
    }
    seedUser(userId)
    seedUser('usr_other')

    appDb.db.prepare(`
      INSERT INTO cloud_projects (id, user_id, title, original_filename, dimensions_width, dimensions_height, thumbnail_data, state_json, created_at, updated_at)
      VALUES ('proj_1', ?, ?, ?, 0, 0, ?, ?, 1, 1)
    `).run(userId, UTF8_PROBE, 'a.png', 'thumb', JSON.stringify({ version: 1 }))

    const stats = getUserStorageStats(appDb.db, userId)
    expect(stats.projects).toBe(1)
    const expected = Buffer.byteLength(UTF8_PROBE) + Buffer.byteLength('a.png') + Buffer.byteLength('thumb') + Buffer.byteLength(JSON.stringify({ version: 1 }))
    expect(stats.bytes).toBe(expected)

    // Another user's usage does not leak into the tally.
    appDb.db.prepare(`
      INSERT INTO cloud_projects (id, user_id, title, original_filename, dimensions_width, dimensions_height, thumbnail_data, state_json, created_at, updated_at)
      VALUES ('proj_2', 'usr_other', 'big', 'b.png', 0, 0, 'thumb', ?, 1, 1)
    `).run('x'.repeat(1024))
    expect(getUserStorageStats(appDb.db, userId).bytes).toBe(expected)
    expect(getUserStorageStats(appDb.db, 'usr_other').projects).toBe(1)
    appDb.close()
  })

  it('reports empty storage as zero', () => {
    const appDb = initDatabase(':memory:')
    expect(getUserStorageStats(appDb.db, 'usr_nobody')).toEqual({ projects: 0, bytes: 0 })
    appDb.close()
  })

  it('keeps the ceilings sane against the real surfaces', () => {
    // The ceilings are the last line of defense for a shared NFS volume:
    // 50 projects × the 16MB project-body cap would far exceed the byte
    // ceiling, so the byte ceiling is the binding one for large payloads —
    // pin both constants so a change is a conscious decision.
    expect(MAX_PROJECTS_PER_USER).toBe(50)
    expect(MAX_TOTAL_PROJECT_BYTES_PER_USER).toBe(64 * 1024 * 1024)
  })
})
