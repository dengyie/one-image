import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../server/db'

// db.ts itself is exercised indirectly by every route test; what nothing
// pins yet is the schema's referential contract — cascade deletes and the
// env-var path fallback — which matters because sessions/projects hang off
// users with ON DELETE CASCADE.
const dirs: string[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oneimage-schema-'))
  dirs.push(dir)
  return join(dir, 'oneimage.db')
}

afterEach(() => {
  delete process.env.ONEIMAGE_DB_PATH
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('schema referential integrity', () => {
  it('cascades session and project deletion when a user is removed', () => {
    const appDb = initDatabase(tempDbPath())
    appDb.db.exec(`
      INSERT INTO users (id, username, email, password_hash, salt, nickname, avatar_color, created_at, updated_at)
      VALUES ('usr_c', 'cascade', 'cascade@example.com', 'h', 's', 'c', '#10b981', 1, 1);
      INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('tok', 'usr_c', 9999999999999, 1);
      INSERT INTO cloud_projects (id, user_id, title, original_filename, dimensions_width, dimensions_height, thumbnail_data, state_json, created_at, updated_at)
      VALUES ('proj_c', 'usr_c', 't', 'f.png', 10, 10, '', '{}', 1, 1);
    `)
    appDb.db.prepare('DELETE FROM users WHERE id = ?').run('usr_c')
    for (const table of ['sessions', 'cloud_projects']) {
      const row = appDb.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
      expect(row.n).toBe(0)
    }
    appDb.close()
  })

  it('rejects a session referencing a missing user (foreign_keys = ON)', () => {
    const appDb = initDatabase(tempDbPath())
    expect(() =>
      appDb.db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run('tok_orphan', 'usr_missing', 1, 1)
    ).toThrow()
    appDb.close()
  })

  it('enforces unique username and email independently', () => {
    const appDb = initDatabase(tempDbPath())
    const insert = appDb.db.prepare(`
      INSERT INTO users (id, username, email, password_hash, salt, nickname, avatar_color, created_at, updated_at)
      VALUES (?, ?, ?, 'h', 's', 'n', '#10b981', 1, 1)
    `)
    insert.run('usr_1', 'dup', 'dup@example.com')
    expect(() => insert.run('usr_2', 'dup', 'other@example.com')).toThrow()
    expect(() => insert.run('usr_3', 'other', 'dup@example.com')).toThrow()
    appDb.close()
  })
})

describe('database path resolution', () => {
  it('honours ONEIMAGE_DB_PATH and creates the parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oneimage-env-'))
    dirs.push(dir)
    const target = join(dir, 'nested', 'deep.db')
    process.env.ONEIMAGE_DB_PATH = target
    // No explicit argument: the env var must drive the path, including
    // creating the missing parent directory.
    const fromEnv = initDatabase()
    fromEnv.close()
    expect(existsSync(target)).toBe(true)
  })

  it('reopening an existing file preserves committed rows (no destructive re-init)', () => {
    const dbPath = tempDbPath()
    const first = initDatabase(dbPath)
    first.db.prepare(`
      INSERT INTO users (id, username, email, password_hash, salt, nickname, avatar_color, created_at, updated_at)
      VALUES ('usr_p', 'persist', 'persist@example.com', 'h', 's', 'p', '#10b981', 1, 1)
    `).run()
    first.close()
    const second = initDatabase(dbPath)
    const row = second.db.prepare('SELECT username FROM users WHERE id = ?').get('usr_p') as { username: string }
    expect(row.username).toBe('persist')
    second.close()
  })
})
