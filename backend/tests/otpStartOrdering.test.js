/**
 * SECURITY REGRESSION (round 22): /start ordering + atomic idempotent creation.
 *
 * (1) [HIGH] The sender (SMS/email) must run only for the serialized MINT winner —
 *     previously /phone/start sent BEFORE the mint, so two concurrent starts both
 *     sent (the loser got an unstored code that could never verify + a duplicate
 *     Twilio charge). Now: mint FIRST, winner-only send; on send failure,
 *     compensate (invalidate the code + rewind last_sent_at).
 * (2) [MED] First-ever concurrent /start created the credential/user OUTSIDE any
 *     lock (select-then-insert), so two concurrent first-ever calls could make
 *     duplicate users/profiles or hit UNIQUE(type,identifier). Now creation is
 *     serialized per identifier + idempotent (ON CONFLICT) → one user/credential/
 *     profile.
 *
 * Honest limitation (as r19/r21): the single-connection SQLite harness serializes
 * writers, so it can't reproduce true pooled-Postgres concurrency; these assert the
 * serialized outcome + the deterministic compensation/idempotency logic.
 */

// Raise the per-IP /start rate limits BEFORE auth.js is imported (its limiters read
// these at module load) so this file's many concurrent starts from one test IP
// aren't throttled by the limiter (we're testing the mint/creation serialization,
// not the IP limiter).
process.env.AUTH_EMAIL_RATE_LIMIT = '1000'
process.env.AUTH_PHONE_RATE_LIMIT = '1000'

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import { getAppAndDb, resetDb } from './testServer.js'

const Database = (await import('better-sqlite3')).default
const { compensateFailedOtpSend } = await import('../routes/auth.js')

const now = () => new Date().toISOString()
const future = () => new Date(Date.now() + 600_000).toISOString()

// ---------------------------------------------------------------------------
// Deterministic unit: compensateFailedOtpSend invalidates the code + rewinds
// last_sent_at (red-able: without it, a usable code + cooldown remain).
// ---------------------------------------------------------------------------
describe('compensateFailedOtpSend (send-failure compensation)', () => {
  function makeDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE user_credentials (id TEXT PRIMARY KEY, last_sent_at TEXT, attempt_count INTEGER DEFAULT 0);
      CREATE TABLE user_verification_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id TEXT NOT NULL, code_hash TEXT NOT NULL,
        expires_at TEXT, consumed_at TEXT, attempt_count INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO user_credentials (id, last_sent_at) VALUES ('cred-1', '2026-07-18T00:00:00.000Z');
      INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES ('cred-1', 'h', ?);
    `)
    return {
      dialect: 'sqlite', _raw: raw,
      prepare: (sql) => { const s = raw.prepare(sql); return { run: async (...a) => s.run(...a), get: async (...a) => s.get(...a), all: async (...a) => s.all(...a) } },
      async withTransaction(fn) { raw.exec('BEGIN IMMEDIATE'); try { const r = await fn(this); raw.exec('COMMIT'); return r } catch (e) { try { raw.exec('ROLLBACK') } catch { /* ignore */ } throw e } },
    }
  }

  it('invalidates THE MINTED code and clears last_sent_at (no usable unsent code, retry unblocked)', async () => {
    const db = makeDb()
    const sentAt = '2026-07-18T00:00:00.000Z'
    db._raw.prepare(`UPDATE user_verification_codes SET expires_at = ?`).run(future())
    const codeId = db._raw.prepare(`SELECT id FROM user_verification_codes LIMIT 1`).get().id
    await compensateFailedOtpSend(db, 'cred-1', { codeId, sentAt })
    const active = db._raw.prepare(`SELECT COUNT(*) c FROM user_verification_codes WHERE consumed_at IS NULL`).get()
    expect(active.c).toBe(0)
    const cred = db._raw.prepare(`SELECT last_sent_at FROM user_credentials WHERE id='cred-1'`).get()
    expect(cred.last_sent_at).toBeNull()
  })

  it('is SCOPED: does not invalidate a NEWER code nor rewind a NEWER cooldown', async () => {
    const db = makeDb()
    // Old mint: code id=1, sentAt = the seeded value.
    const oldSentAt = '2026-07-18T00:00:00.000Z'
    const oldCodeId = db._raw.prepare(`SELECT id FROM user_verification_codes LIMIT 1`).get().id
    db._raw.prepare(`UPDATE user_verification_codes SET consumed_at = ? WHERE id = ?`).run(new Date().toISOString(), oldCodeId)
    // A retry minted a NEWER active code and moved the cooldown.
    const newSentAt = '2026-07-18T00:05:00.000Z'
    db._raw.prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES ('cred-1', 'new', ?)`).run(future())
    db._raw.prepare(`UPDATE user_credentials SET last_sent_at = ? WHERE id = 'cred-1'`).run(newSentAt)

    // The OLD request's late failure compensates its OWN (already-consumed) mint.
    await compensateFailedOtpSend(db, 'cred-1', { codeId: oldCodeId, sentAt: oldSentAt })

    // The NEWER code is still active and the NEWER cooldown is intact.
    const active = db._raw.prepare(`SELECT COUNT(*) c FROM user_verification_codes WHERE consumed_at IS NULL`).get()
    expect(active.c).toBe(1)
    const cred = db._raw.prepare(`SELECT last_sent_at FROM user_credentials WHERE id='cred-1'`).get()
    expect(cred.last_sent_at).toBe(newSentAt)
  })
})

// ---------------------------------------------------------------------------
// Full-app: first-ever concurrent /start + concurrent post-cooldown /start.
// ---------------------------------------------------------------------------
describe('full-app /start ordering + idempotent creation', () => {
  let app, db
  beforeAll(async () => { const l = await getAppAndDb(); app = l.app; db = l.db })
  beforeEach(() => resetDb(db))

  const countEmailUser = (email) => db.prepare(`SELECT COUNT(*) c FROM users WHERE LOWER(TRIM(primary_email)) = ?`).get(email)
  const countCred = (type, id) => db.prepare(`SELECT COUNT(*) c FROM user_credentials WHERE type = ? AND identifier = ?`).get(type, id)
  const activeForCred = (type, id) => db.prepare(
    `SELECT COUNT(*) c FROM user_verification_codes vc JOIN user_credentials uc ON uc.id = vc.credential_id
     WHERE uc.type = ? AND uc.identifier = ? AND vc.consumed_at IS NULL AND (vc.expires_at IS NULL OR vc.expires_at >= ?)`,
  ).get(type, id, now())

  it('EMAIL: N concurrent FIRST-EVER /email/start → one user, one credential, one profile, one active code', async () => {
    const email = 'first-ever-email@example.test'
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/auth/email/start').send({ email })),
    )
    expect(results.filter((r) => r.status === 202).length).toBe(1) // winner-only send/mint
    expect(Number(countEmailUser(email).c)).toBe(1)
    expect(Number(countCred('email_otp', email).c)).toBe(1)
    expect(Number(activeForCred('email_otp', email).c)).toBe(1)
    // No duplicate owned profile for the new user.
    const user = db.prepare(`SELECT id FROM users WHERE LOWER(TRIM(primary_email)) = ?`).get(email)
    const profiles = db.prepare(`SELECT COUNT(*) c FROM profiles WHERE user_id = ?`).get(user.id)
    expect(Number(profiles.c)).toBeLessThanOrEqual(1)
  })

  it('PHONE: N concurrent FIRST-EVER /phone/start → one user, one credential, one profile, one active code', async () => {
    const phone = '+15550003333'
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/auth/phone/start').send({ phone })),
    )
    expect(results.filter((r) => r.status === 202).length).toBe(1)
    const users = db.prepare(`SELECT COUNT(*) c FROM users WHERE primary_phone = ?`).get(phone)
    expect(Number(users.c)).toBe(1)
    expect(Number(countCred('phone_otp', phone).c)).toBe(1)
    expect(Number(activeForCred('phone_otp', phone).c)).toBe(1)
    const user = db.prepare(`SELECT id FROM users WHERE primary_phone = ?`).get(phone)
    const profiles = db.prepare(`SELECT COUNT(*) c FROM profiles WHERE user_id = ?`).get(user.id)
    expect(Number(profiles.c)).toBeLessThanOrEqual(1)
  })

  it('EMAIL: concurrent POST-COOLDOWN /email/start → one 202 (winner-only), one active code', async () => {
    const email = 'post-cooldown-email@example.test'
    expect((await request(app).post('/api/auth/email/start').send({ email })).status).toBe(202)
    db.prepare(`UPDATE user_credentials SET last_sent_at = NULL WHERE identifier = ?`).run(email)
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/auth/email/start').send({ email })),
    )
    expect(results.filter((r) => r.status === 202).length).toBe(1)
    expect(Number(activeForCred('email_otp', email).c)).toBe(1)
  })

  it('happy path: start → verify newest code → session (r17 adoption path intact)', async () => {
    const email = 'happy-r22@example.test'
    const start = await request(app).post('/api/auth/email/start').send({ email })
    expect(start.status).toBe(202)
    const res = await request(app).post('/api/auth/email/verify').send({ email, code: start.body.previewCode })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeTruthy()
  })
})
