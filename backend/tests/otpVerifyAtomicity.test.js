/**
 * SECURITY REGRESSION (round 19): /email/verify must be ATOMIC under concurrency.
 *
 * The pre-r19 flow checked the attempt cap, then SEPARATELY looked up a matching
 * code, then SEPARATELY incremented attempts or marked consumed_at — no
 * transaction, lock, or affected-row check. Under pooled Postgres (and even under
 * interleaved async on SQLite) that TOCTOU race meant:
 *   (a) parallel WRONG guesses all observe attempt_count < max before any
 *       increment lands → the cap is not strictly enforced; and
 *   (b) two parallel CORRECT submissions both pass the SELECT before either
 *       consumed_at write lands → a one-time code MINTS MULTIPLE SESSIONS.
 *
 * atomicVerifyOtpCode now runs the whole check-and-consume in one row-locked
 * transaction, so: exactly one session per one-time code, and the wrong-guess cap
 * is exact. This suite fires the two races and asserts those invariants.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import { getAppAndDb, resetDb } from './testServer.js'

const Database = (await import('better-sqlite3')).default
const { hashValue, atomicVerifyOtpCode } = await import('../routes/auth.js')

// Matches the default EMAIL_MAX_VERIFY_ATTEMPTS (env AUTH_EMAIL_MAX_VERIFY_ATTEMPTS
// is unset under getAppAndDb).
const MAX_ATTEMPTS = 6

let app, db
beforeAll(async () => {
  const loaded = await getAppAndDb()
  app = loaded.app
  db = loaded.db
})
beforeEach(() => resetDb(db))

async function start(email) {
  const res = await request(app).post('/api/auth/email/start').send({ email })
  expect(res.status).toBe(202)
  expect(res.body.previewCode).toMatch(/^\d{6}$/)
  return res.body.previewCode
}
const wrongCode = (avoid, i) => String(100000 + ((Number(avoid) + i + 1) % 900000))

describe('/email/verify is atomic under concurrency', () => {
  it('two parallel CORRECT submissions of a one-time code mint exactly ONE session', async () => {
    const email = 'race-correct@example.test'
    const code = await start(email)

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/api/auth/email/verify').send({ email, code }),
      ),
    )

    const ok = results.filter((r) => r.status === 200)
    const rejected = results.filter((r) => r.status !== 200)

    // Exactly one succeeds (one session); the rest are rejected as consumed —
    // never a second session.
    expect(ok.length).toBe(1)
    expect(ok[0].body.accessToken).toBeTruthy()
    expect(ok[0].body.refreshToken).toBeUndefined()
    expect((ok[0].headers['set-cookie'] || []).some((cookie) => cookie.startsWith('grantflow_refresh='))).toBe(true)
    expect(rejected.length).toBe(4)
    for (const r of rejected) {
      expect(r.status).toBe(400)
      expect(r.body.accessToken).toBeUndefined()
    }

    // And the DB shows the code consumed exactly once.
    const consumedRows = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM user_verification_codes vc
         JOIN user_credentials uc ON uc.id = vc.credential_id
         WHERE uc.identifier = ? AND vc.consumed_at IS NOT NULL`,
      )
      .get(email)
    expect(Number(consumedRows.c)).toBe(1)
  })

  it('N parallel WRONG guesses cannot slip past the attempt cap', async () => {
    const email = 'race-wrong@example.test'
    const code = await start(email)
    const N = 12 // > MAX_ATTEMPTS

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app).post('/api/auth/email/verify').send({ email, code: wrongCode(code, i) }),
      ),
    )

    const invalid = results.filter((r) => r.status === 400)
    const lockedOut = results.filter((r) => r.status === 429)

    // Cap strictly bounded: at most MAX_ATTEMPTS wrong guesses were ever
    // evaluated (without the atomic cap, parallel guesses slip under and exceed it).
    expect(invalid.length).toBeLessThanOrEqual(MAX_ATTEMPTS)
    // Once the cap is hit the remainder are locked out (not silently evaluated).
    expect(lockedOut.length).toBeGreaterThan(0)
    for (const r of lockedOut) expect(r.body.error_type).toBe('too_many_attempts')
    // No wrong guess ever succeeds.
    expect(results.some((r) => r.status === 200)).toBe(false)

    // The active code's recorded attempts never exceeded the cap.
    const maxAttempt = await db
      .prepare(
        `SELECT MAX(vc.attempt_count) AS m FROM user_verification_codes vc
         JOIN user_credentials uc ON uc.id = vc.credential_id
         WHERE uc.identifier = ?`,
      )
      .get(email)
    expect(Number(maxAttempt.m)).toBeLessThanOrEqual(MAX_ATTEMPTS)
  })
})

/**
 * Deterministic unit coverage of the load-bearing logic in atomicVerifyOtpCode.
 * (The full pooled-Postgres TOCTOU race cannot be reproduced on the single-
 * connection SQLite test harness — writers serialize — so these assert the
 * conditional one-time consume and the raceless attempt cap directly. Each CAN
 * go red: remove the consume → replay succeeds; remove the cap → no lockout.)
 */
describe('atomicVerifyOtpCode: one-time consume + attempt cap', () => {
  const MAX = 4
  function makeDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE user_credentials (id TEXT PRIMARY KEY, attempt_count INTEGER DEFAULT 0, verified_at TEXT);
      CREATE TABLE user_verification_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id TEXT NOT NULL, code_hash TEXT NOT NULL,
        expires_at TEXT, consumed_at TEXT, attempt_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO user_credentials (id) VALUES ('cred-1');
    `)
    return {
      dialect: 'sqlite',
      _raw: raw,
      prepare: (sql) => {
        const stmt = raw.prepare(sql)
        return {
          run: async (...a) => stmt.run(...a),
          get: async (...a) => stmt.get(...a),
          all: async (...a) => stmt.all(...a),
        }
      },
      async withTransaction(fn) {
        raw.exec('BEGIN IMMEDIATE')
        try { const r = await fn(this); raw.exec('COMMIT'); return r } catch (e) { try { raw.exec('ROLLBACK') } catch { /* ignore */ } throw e }
      },
    }
  }
  function seedCode(db, email = 'u@x.test', code = '123456') {
    db._raw
      .prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES ('cred-1', ?, ?)`)
      .run(hashValue(`${email}:${code}`), new Date(Date.now() + 600_000).toISOString())
    return hashValue(`${email}:${code}`)
  }

  it('a correct code verifies ONCE, then is consumed (no replay)', async () => {
    const db = makeDb()
    const good = seedCode(db)
    expect(await atomicVerifyOtpCode(db, 'cred-1', good, MAX)).toBe('ok')
    // Replay of the same one-time code no longer succeeds.
    expect(await atomicVerifyOtpCode(db, 'cred-1', good, MAX)).not.toBe('ok')
    const consumed = db._raw.prepare(`SELECT COUNT(*) c FROM user_verification_codes WHERE consumed_at IS NOT NULL`).get()
    expect(consumed.c).toBe(1)
  })

  it('wrong guesses are capped at MAX then locked out — even a correct guess after lockout is refused', async () => {
    const db = makeDb()
    const good = seedCode(db)
    const wrong = hashValue('u@x.test:000000')
    for (let i = 0; i < MAX; i++) {
      expect(await atomicVerifyOtpCode(db, 'cred-1', wrong, MAX)).toBe('invalid')
    }
    // Cap reached: further attempts are locked out, and the code never exceeds MAX.
    expect(await atomicVerifyOtpCode(db, 'cred-1', wrong, MAX)).toBe('locked_out')
    expect(await atomicVerifyOtpCode(db, 'cred-1', good, MAX)).toBe('locked_out')
    const row = db._raw.prepare(`SELECT attempt_count FROM user_verification_codes LIMIT 1`).get()
    expect(row.attempt_count).toBe(MAX)
  })
})
