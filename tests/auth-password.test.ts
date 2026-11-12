import { describe, expect, it } from 'vitest'
import { scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { initDatabase } from '../server/db'
import {
  authenticateUser,
  createUser,
  hashPassword,
  needsPasswordRehash,
  verifyPassword,
} from '../server/auth'

const scryptAsync = promisify(scrypt)

describe('password hashing', () => {
  it('round-trips the current format and rejects a wrong password', async () => {
    const salt = 'aabbccdd'
    const hash = await hashPassword('correct horse battery', salt)
    expect(hash.startsWith('s2$')).toBe(true)
    expect(await verifyPassword('correct horse battery', salt, hash)).toBe(true)
    expect(await verifyPassword('wrong password', salt, hash)).toBe(false)
    expect(needsPasswordRehash(hash)).toBe(false)
  })

  it('verifies a legacy Node-default hash and flags it for rehash', async () => {
    const salt = 'legacy-salt'
    const legacy = (await scryptAsync('old-password', salt, 64) as Buffer).toString('hex')
    expect(needsPasswordRehash(legacy)).toBe(true)
    expect(await verifyPassword('old-password', salt, legacy)).toBe(true)
    expect(await verifyPassword('old-password-typo', salt, legacy)).toBe(false)
    expect(await verifyPassword('old-password', salt, legacy.slice(2))).toBe(false)
  })

  it('rejects a tampered hash', async () => {
    const salt = 'tamper-salt'
    const hash = await hashPassword('secret', salt)
    const hex = hash.slice(3)
    const flipped = (hex[0] === '0' ? '1' : '0') + hex.slice(1)
    expect(await verifyPassword('secret', salt, 's2$' + flipped)).toBe(false)
  })
})

describe('transparent rehash on login', () => {
  it('upgrades a legacy hash on the first successful login', async () => {
    const appDb = initDatabase(':memory:')
    const legacySalt = 'migration-salt'
    const legacyHash = (await scryptAsync('legacy-login-pw', legacySalt, 64) as Buffer).toString('hex')
    // Seed a user row directly with a legacy-format hash.
    appDb.db.prepare(`
      INSERT INTO users (id, username, email, password_hash, salt, nickname, avatar_color, created_at, updated_at)
      VALUES ('usr_legacy', 'legacyuser', 'legacy@example.com', ?, ?, 'legacy', '#123456', 1, 1)
    `).run(legacyHash, legacySalt)

    const user = await authenticateUser(appDb.db, 'legacy@example.com', 'legacy-login-pw')
    expect(user?.username).toBe('legacyuser')

    const row = appDb.db.prepare('SELECT password_hash, salt FROM users WHERE id = ?').get('usr_legacy') as { password_hash: string; salt: string }
    expect(row.password_hash.startsWith('s2$')).toBe(true)
    expect(row.salt).toBe(legacySalt)
    // The upgraded hash still verifies.
    expect(await verifyPassword('legacy-login-pw', row.salt, row.password_hash)).toBe(true)
    appDb.close()
  })

  it('keeps the legacy hash when login fails', async () => {
    const appDb = initDatabase(':memory:')
    const legacyHash = (await scryptAsync('keep-pw', 'salt', 64) as Buffer).toString('hex')
    appDb.db.prepare(`
      INSERT INTO users (id, username, email, password_hash, salt, nickname, avatar_color, created_at, updated_at)
      VALUES ('usr_keep', 'keepuser', 'keep@example.com', ?, 'salt', 'keep', '#abcdef', 1, 1)
    `).run(legacyHash)
    expect(await authenticateUser(appDb.db, 'keep@example.com', 'wrong')).toBeNull()
    const row = appDb.db.prepare('SELECT password_hash FROM users WHERE id = ?').get('usr_keep') as { password_hash: string }
    expect(row.password_hash).toBe(legacyHash)
    appDb.close()
  })
})

describe('register/login through the upgraded hasher', () => {
  it('registers with the new format and logs in', async () => {
    const appDb = initDatabase(':memory:')
    const user = await createUser(appDb.db, {
      username: 'fresh',
      email: 'fresh@example.com',
      password: 'long-enough-password',
    })
    expect(user.username).toBe('fresh')
    const row = appDb.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string }
    expect(row.password_hash.startsWith('s2$')).toBe(true)
    expect(await authenticateUser(appDb.db, 'fresh', 'long-enough-password')).not.toBeNull()
    expect(await authenticateUser(appDb.db, 'fresh', 'not-the-password')).toBeNull()
    appDb.close()
  })
})
