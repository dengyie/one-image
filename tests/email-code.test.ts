import { describe, expect, it } from 'vitest'
import { initDatabase } from '../server/db'
import {
  checkEmailCodeSendGate,
  generateEmailCode,
  purgeStaleEmailCodes,
  storeEmailCode,
  verifyEmailCode,
  EMAIL_CODE_HOURLY_LIMIT,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODE_TTL_MS,
} from '../server/email-code'

const EMAIL = 'user@example.com'
const MINUTE = 60_000

function freshDb() {
  return initDatabase(':memory:').db
}

describe('email verification codes', () => {
  it('generates six-digit codes', () => {
    for (let i = 0; i < 20; i++) expect(generateEmailCode()).toMatch(/^\d{6}$/)
  })

  it('enforces the resend cooldown', () => {
    const db = freshDb()
    const now = 1_000_000_000_000
    storeEmailCode(db, EMAIL, '123456', now)
    expect(checkEmailCodeSendGate(db, EMAIL, now + 1000)).toEqual({
      ok: false,
      reason: 'cooldown',
      retryAfterSeconds: Math.ceil((EMAIL_CODE_RESEND_COOLDOWN_MS - 1000) / 1000),
    })
    expect(checkEmailCodeSendGate(db, EMAIL, now + EMAIL_CODE_RESEND_COOLDOWN_MS)).toEqual({ ok: true })
    db.close()
  })

  it('caps sends per rolling hour, then frees the window', () => {
    const db = freshDb()
    let now = 2_000_000_000_000
    for (let i = 0; i < EMAIL_CODE_HOURLY_LIMIT; i++) {
      storeEmailCode(db, EMAIL, '123456', now)
      now += EMAIL_CODE_RESEND_COOLDOWN_MS
    }
    expect(checkEmailCodeSendGate(db, EMAIL, now)).toEqual({ ok: false, reason: 'hourly_limit', retryAfterSeconds: expect.any(Number) })
    // One hour past the window start, the cap frees up.
    expect(checkEmailCodeSendGate(db, EMAIL, now + 60 * MINUTE)).toEqual({ ok: true })
    db.close()
  })

  it('verifies the right code once and locks out after five wrong ones', () => {
    const db = freshDb()
    const now = 3_000_000_000_000
    storeEmailCode(db, EMAIL, '654321', now)
    // Five wrong guesses exhaust the attempt budget.
    for (let i = 1; i <= 5; i++) {
      expect(verifyEmailCode(db, EMAIL, '00000' + String(i % 10), now + i * 1000)).toBe(i < 5 ? 'mismatch' : 'locked')
    }
    // Even the correct code is spent by the lockout.
    expect(verifyEmailCode(db, EMAIL, '654321', now + 6000)).toBe('locked')
    db.close()
  })

  it('expires codes after the TTL', () => {
    const db = freshDb()
    const now = 4_000_000_000_000
    storeEmailCode(db, EMAIL, '111222', now)
    expect(verifyEmailCode(db, EMAIL, '111222', now + EMAIL_CODE_TTL_MS)).toBe('expired')
    // Expiry invalidates the stored code.
    expect(verifyEmailCode(db, EMAIL, '111222', now + EMAIL_CODE_TTL_MS)).toBe('missing')
    db.close()
  })

  it('answers missing for unknown emails', () => {
    const db = freshDb()
    expect(verifyEmailCode(db, 'nobody@example.com', '999999', 5_000_000_000_000)).toBe('missing')
    db.close()
  })

  it('stores only the hash, never the code', () => {
    const db = freshDb()
    const now = 6_000_000_000_000
    storeEmailCode(db, EMAIL, '444555', now)
    const row = db.prepare('SELECT code_hash FROM email_verifications WHERE email = ?').get(EMAIL) as { code_hash: string }
    expect(row.code_hash).not.toContain('444555')
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
    db.close()
  })

  it('purges rows older than a day but keeps the anti-bomb window', () => {
    const db = freshDb()
    const now = 7_000_000_000_000
    storeEmailCode(db, 'old@example.com', '123123', now - 25 * 60 * MINUTE)
    storeEmailCode(db, EMAIL, '321321', now)
    purgeStaleEmailCodes(db, now)
    expect(verifyEmailCode(db, EMAIL, '321321', now)).toBe('ok')
    expect(verifyEmailCode(db, 'old@example.com', '123123', now)).toBe('missing')
    db.close()
  })
})
