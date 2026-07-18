/**
 * SECURITY REGRESSION (round 20): a locked-out OLDER OTP row must not be
 * consumable after a fresh /start.
 *
 * atomicVerifyOtpCode (r19) enforced the cap only against the LATEST active row,
 * and /email/start + /phone/start APPENDED a new code without invalidating older
 * active rows. So a code that already hit maxAttempts stayed active+unconsumed;
 * after a fresh /start minted a newer (attempt_count=0) row, submitting the OLDER
 * locked-out code passed the latest-row cap check and was consumed → lockout
 * bypass (and, by alternating /start + guess, unlimited attempts on a target).
 *
 * Two belt-and-suspenders fixes:
 *   1. insertFreshVerificationCode invalidates all prior active codes in the same
 *      transaction as the insert → at most ONE consumable active code / credential.
 *   2. atomicVerifyOtpCode enforces the cap on the MATCHED row (not just latest),
 *      so a matched-but-capped older row is locked_out, never consumed.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import { getAppAndDb, resetDb } from './testServer.js'

const Database = (await import('better-sqlite3')).default
const { hashValue, atomicVerifyOtpCode, insertFreshVerificationCode } = await import('../routes/auth.js')

const EMAIL_MAX = 6 // default EMAIL_MAX_VERIFY_ATTEMPTS under getAppAndDb
const wrongCode = (avoid, i) => String(100000 + ((Number(avoid) + i + 1) % 900000))
const future = () => new Date(Date.now() + 600_000).toISOString()
const now = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// Dialect-agnostic unit coverage of the SHARED helpers (used by BOTH email and
// phone verify), each independently red-able.
// ---------------------------------------------------------------------------
describe('single-active-code + matched-row cap (shared email/phone helpers)', () => {
  const MAX = 4
  function makeDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE user_credentials (id TEXT PRIMARY KEY, attempt_count INTEGER DEFAULT 0, verified_at TEXT, secret_hash TEXT, last_sent_at TEXT);
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
        return { run: async (...a) => stmt.run(...a), get: async (...a) => stmt.get(...a), all: async (...a) => stmt.all(...a) }
      },
      _txLock: null,
      // Mirror the real SqliteDb: serialize async transactions so concurrent
      // callers don't collide on BEGIN IMMEDIATE ("transaction within a transaction").
      async withTransaction(fn) {
        while (this._txLock) await this._txLock
        let unlock
        this._txLock = new Promise((r) => { unlock = r })
        raw.exec('BEGIN IMMEDIATE')
        try { const r = await fn(this); raw.exec('COMMIT'); return r } catch (e) { try { raw.exec('ROLLBACK') } catch { /* ignore */ } throw e } finally { this._txLock = null; unlock() }
      },
    }
  }
  const insertCode = (db, code, { attempt = 0 } = {}) =>
    db._raw
      .prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at, attempt_count) VALUES ('cred-1', ?, ?, ?)`)
      .run(hashValue(`p:${code}`), future(), attempt).lastInsertRowid
  const activeCount = (db) =>
    db._raw.prepare(`SELECT COUNT(*) c FROM user_verification_codes WHERE consumed_at IS NULL`).get().c

  it('insertFreshVerificationCode invalidates all prior active codes (exactly one consumable)', async () => {
    const db = makeDb()
    insertCode(db, '111111')
    insertCode(db, '222222')
    expect(activeCount(db)).toBe(2)
    await insertFreshVerificationCode(db, 'cred-1', hashValue('p:333333'), future())
    // Only the newest row remains active.
    expect(activeCount(db)).toBe(1)
    // ...and it is the fresh one.
    expect(await atomicVerifyOtpCode(db, 'cred-1', hashValue('p:333333'), MAX)).toBe('ok')
  })

  it('a matched-but-capped OLDER row is locked_out even when a newer under-cap row exists', async () => {
    const db = makeDb()
    // Old code A already at the cap, plus a newer fresh code B (attempt_count=0).
    insertCode(db, 'AAAAAA'.replace(/A/g, '1'), { attempt: MAX }) // '111111' capped
    insertCode(db, '999999', { attempt: 0 })
    // Submitting the OLD, capped code must NOT be consumed (cap is on the matched row).
    expect(await atomicVerifyOtpCode(db, 'cred-1', hashValue('p:111111'), MAX)).toBe('locked_out')
    // The capped row was never consumed.
    const capped = db._raw.prepare(`SELECT consumed_at FROM user_verification_codes WHERE code_hash = ?`).get(hashValue('p:111111'))
    expect(capped.consumed_at).toBeNull()
  })

  it('concurrent insertFreshVerificationCode for one credential leaves exactly one active code', async () => {
    // NOTE: the shim's withTransaction (BEGIN IMMEDIATE) serializes writers, as
    // the real SqliteDb does; on Postgres the per-credential SELECT ... FOR UPDATE
    // provides the same serialization. True pooled-Postgres concurrency isn't
    // reproducible here, so this asserts the serialized-mint outcome and the
    // partial-unique-index backstop below is the storage-level guarantee.
    const db = makeDb()
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => insertFreshVerificationCode(db, 'cred-1', hashValue(`p:concur${i}`), future())),
    )
    expect(activeCount(db)).toBe(1)
  })

  it('the partial unique index REJECTS a second active code (DB backstop)', () => {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE user_verification_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id TEXT NOT NULL, code_hash TEXT NOT NULL,
        expires_at TEXT, consumed_at TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX ux_uvc_one_active_per_credential
        ON user_verification_codes (credential_id) WHERE consumed_at IS NULL;
    `)
    const ins = (hash) => raw.prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES ('cred-1', ?, ?)`).run(hash, future())
    ins(hashValue('p:aaa')) // first active code — OK
    // A second UNCONSUMED code for the same credential is rejected by the index.
    expect(() => ins(hashValue('p:bbb'))).toThrow(/unique/i)
    // Consuming the first frees the slot for a new active code.
    raw.prepare(`UPDATE user_verification_codes SET consumed_at = ? WHERE code_hash = ?`).run(now(), hashValue('p:aaa'))
    expect(() => ins(hashValue('p:bbb'))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Full-app EMAIL: lockout survives a fresh /start; happy path still works.
// ---------------------------------------------------------------------------
describe('full-app EMAIL: locked-out code cannot be verified after a fresh /start', () => {
  let app, db
  beforeAll(async () => { const l = await getAppAndDb(); app = l.app; db = l.db })
  beforeEach(() => resetDb(db))

  const startEmail = async (email) => {
    const r = await request(app).post('/api/auth/email/start').send({ email })
    expect(r.status).toBe(202)
    return r.body.previewCode
  }
  const verifyEmail = (email, code) => request(app).post('/api/auth/email/verify').send({ email, code })
  const clearCooldown = (email) => db.prepare(`UPDATE user_credentials SET last_sent_at = NULL WHERE identifier = ?`).run(email)
  const activeEmailCodes = (email) =>
    db.prepare(
      `SELECT COUNT(*) c FROM user_verification_codes vc JOIN user_credentials uc ON uc.id = vc.credential_id
       WHERE uc.identifier = ? AND vc.consumed_at IS NULL AND (vc.expires_at IS NULL OR vc.expires_at >= ?)`,
    ).get(email, now())

  it('lock out code A, mint code B, then code A is rejected (lockout not bypassable); happy path still works', async () => {
    const email = 'bypass-email@example.test'
    const codeA = await startEmail(email)

    // Lock out code A with MAX wrong guesses.
    for (let i = 0; i < EMAIL_MAX; i++) {
      const r = await verifyEmail(email, wrongCode(codeA, i))
      expect(r.status).toBe(400)
    }

    // Fresh /start mints code B (invalidates A).
    await clearCooldown(email)
    const codeB = await startEmail(email)
    expect(codeB).not.toBe(codeA)

    // Exactly one consumable active code remains.
    expect(Number(activeEmailCodes(email).c)).toBe(1)

    // (a)+(b) The OLD, locked-out/invalidated code A cannot verify — no session.
    const resA = await verifyEmail(email, codeA)
    expect(resA.status).not.toBe(200)
    expect(resA.body.accessToken).toBeUndefined()

    // (d) Happy path: the NEWEST code B verifies and mints a session.
    const resB = await verifyEmail(email, codeB)
    expect(resB.status).toBe(200)
    expect(resB.body.accessToken).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Full-app PHONE: same invariant via the phone routes.
// ---------------------------------------------------------------------------
describe('full-app PHONE: locked-out code cannot be verified after a fresh /start', () => {
  let app, db
  beforeAll(async () => { const l = await getAppAndDb(); app = l.app; db = l.db })
  beforeEach(() => resetDb(db))

  it('lock out a known phone code A, fresh /start invalidates it, verifying A is rejected', async () => {
    const phone = '+15550009876'
    // Create the phone credential (and an initial, unknown code).
    const s1 = await request(app).post('/api/auth/phone/start').send({ phone })
    expect(s1.status).toBe(202)
    const cred = await db.prepare(`SELECT id FROM user_credentials WHERE identifier = ? AND type = 'phone_otp'`).get(phone)
    expect(cred?.id).toBeTruthy()

    // Seed a KNOWN active code A (invalidate the unknown one first, as a fresh start would).
    const codeA = '424242'
    db.prepare(`UPDATE user_verification_codes SET consumed_at = ? WHERE credential_id = ? AND consumed_at IS NULL`).run(now(), cred.id)
    db.prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES (?, ?, ?)`).run(cred.id, hashValue(`${phone}:${codeA}`), future())

    // Lock out code A.
    for (let i = 0; i < EMAIL_MAX; i++) {
      const r = await request(app).post('/api/auth/phone/verify').send({ phone, code: wrongCode(codeA, i) })
      expect(r.status).toBe(400)
    }
    const capped = await db.prepare(`SELECT attempt_count FROM user_verification_codes WHERE credential_id = ? AND consumed_at IS NULL`).get(cred.id)
    expect(Number(capped.attempt_count)).toBe(EMAIL_MAX)

    // Fresh /phone/start (clear cooldown) mints code B and invalidates A.
    db.prepare(`UPDATE user_credentials SET last_sent_at = NULL WHERE id = ?`).run(cred.id)
    const s2 = await request(app).post('/api/auth/phone/start').send({ phone })
    expect(s2.status).toBe(202)

    // The OLD code A is rejected — lockout not bypassable.
    const resA = await request(app).post('/api/auth/phone/verify').send({ phone, code: codeA })
    expect(resA.status).not.toBe(200)
    expect(resA.body.accessToken).toBeUndefined()

    // Exactly one consumable active code remains.
    const active = await db.prepare(
      `SELECT COUNT(*) c FROM user_verification_codes WHERE credential_id = ? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`,
    ).get(cred.id, now())
    expect(Number(active.c)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Full-app CONCURRENT /start: racing mints for the same credential must leave
// exactly one active code (serialized per credential + partial-unique-index
// backstop). On the single-connection SQLite harness writers serialize (as the
// real SqliteDb does); true pooled-Postgres FOR UPDATE contention isn't
// reproducible here — the storage-level backstop (unit-tested above) is the hard
// guarantee. See r19 for the same honest-limitation note.
// ---------------------------------------------------------------------------
describe('full-app CONCURRENT /start leaves exactly one active OTP code per credential', () => {
  let app, db
  beforeAll(async () => { const l = await getAppAndDb(); app = l.app; db = l.db })
  beforeEach(() => resetDb(db))

  const activeEmail = (email) =>
    db.prepare(
      `SELECT COUNT(*) c FROM user_verification_codes vc JOIN user_credentials uc ON uc.id = vc.credential_id
       WHERE uc.identifier = ? AND vc.consumed_at IS NULL AND (vc.expires_at IS NULL OR vc.expires_at >= ?)`,
    ).get(email, now())

  it('EMAIL: N concurrent /email/start for one credential -> one active code, one 202', async () => {
    const email = 'concurrent-email@example.test'
    // Create the credential first, then clear the cooldown so all N race the mint.
    expect((await request(app).post('/api/auth/email/start').send({ email })).status).toBe(202)
    db.prepare(`UPDATE user_credentials SET last_sent_at = NULL WHERE identifier = ?`).run(email)

    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/auth/email/start').send({ email })),
    )
    // Serialized mint + under-lock cooldown re-check: exactly one wins.
    expect(results.filter((r) => r.status === 202).length).toBe(1)
    // The invariant: exactly one consumable active code.
    expect(Number(activeEmail(email).c)).toBe(1)
  })

  it('the migration created the partial unique index (migrated DB rejects a 2nd active code)', async () => {
    const email = 'index-backstop@example.test'
    expect((await request(app).post('/api/auth/email/start').send({ email })).status).toBe(202)
    const cred = await db.prepare(`SELECT id FROM user_credentials WHERE identifier = ? AND type = 'email_otp'`).get(email)
    // Clear the existing active code, then insert one active code directly.
    await db.prepare(`UPDATE user_verification_codes SET consumed_at = ? WHERE credential_id = ? AND consumed_at IS NULL`).run(now(), cred.id)
    await db.prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES (?, ?, ?)`).run(cred.id, hashValue('x:1'), future())
    // A SECOND unconsumed code for the same credential is rejected by the index
    // created in migration 136 (the r21 DB backstop).
    let threw = false
    try {
      await db.prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES (?, ?, ?)`).run(cred.id, hashValue('x:2'), future())
    } catch (e) {
      threw = /unique/i.test(String(e?.message))
    }
    expect(threw).toBe(true)
  })

  it('PHONE: N concurrent /phone/start for one credential -> one active code', async () => {
    const phone = '+15550002222'
    expect((await request(app).post('/api/auth/phone/start').send({ phone })).status).toBe(202)
    const cred = await db.prepare(`SELECT id FROM user_credentials WHERE identifier = ? AND type = 'phone_otp'`).get(phone)
    db.prepare(`UPDATE user_credentials SET last_sent_at = NULL WHERE id = ?`).run(cred.id)

    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/auth/phone/start').send({ phone })),
    )
    expect(results.filter((r) => r.status === 202).length).toBe(1)
    const active = await db.prepare(
      `SELECT COUNT(*) c FROM user_verification_codes WHERE credential_id = ? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`,
    ).get(cred.id, now())
    expect(Number(active.c)).toBe(1)
  })
})
