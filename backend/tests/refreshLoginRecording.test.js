// Login recording on the token-refresh path — the admin "Logins" panel was
// stale because RETURNING users never hit a session-mint path: the frontend
// keeps the refresh token in localStorage and POST /api/auth/refresh slides
// the 30-day window forward on every rotation, so createSessionAndTokens (the
// choke point that stamps users.last_login_at and appends the durable
// client_sign_in audit the panel reads) never ran again for them.
//
// Semantics pinned here (the panel tab is "Logins"):
//   - A magic-code login (POST /email/verify, the stateless-OTP path the
//     emailed code / onboarding funnel uses) stamps last_login_at and appends
//     a client_sign_in audit event.                             [fresh login]
//   - A refresh that RESUMES a lapsed session (access token already expired —
//     the user was away and came back on a remembered session) is a returning
//     sign-in: stamps last_login_at + appends client_sign_in with method
//     'session_resume'.                                         [resume]
//   - An IN-SESSION rotation (refresh arrives while the access token is still
//     valid — the app proactively refreshing during active use) is NOT a
//     login: no last_login_at stamp, no login event.            [refresh]
import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-refresh-recording'
process.env.AUTH_EMAIL_SEND_TIMEOUT_MS = '100'

const authModule = await import('../routes/auth.js')
const authRouter = authModule.default
const { hashValue, signOtpToken } = authModule

function normalizeValue(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return value
}
function normalizeArgs(args) {
  return args.map(normalizeValue)
}

class SqliteShim {
  constructor() {
    this._db = new Database(':memory:')
    this.dialect = 'sqlite'
  }
  prepare(sql) {
    const stmt = this._db.prepare(sql)
    return {
      run: async (...params) => stmt.run(...normalizeArgs(params)),
      get: async (...params) => stmt.get(...normalizeArgs(params)),
      all: async (...params) => stmt.all(...normalizeArgs(params)),
    }
  }
  exec(sql) { this._db.exec(sql) }
  raw() { return this._db }
  // Mirror backend/db SqliteDb.withTransaction (manual BEGIN IMMEDIATE) so the
  // atomic OTP verification path exercises a real transaction under test.
  async withTransaction(fn) {
    this._db.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn(this)
      this._db.exec('COMMIT')
      return result
    } catch (err) {
      try { this._db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  }
}

function seedSchema(db) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_email TEXT,
      primary_phone TEXT,
      avatar_url TEXT,
      is_admin INTEGER DEFAULT 0,
      has_completed_onboarding INTEGER DEFAULT 0,
      onboarding_completed_at TEXT,
      guided_cycle_tour_status TEXT DEFAULT NULL,
      last_seen_manual_version INTEGER DEFAULT 0,
      last_completed_tour_version INTEGER DEFAULT 0,
      tour_dismissed_at TEXT,
      last_login_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      organization_id TEXT,
      user_id TEXT,
      created_by TEXT,
      status TEXT DEFAULT 'active',
      avatar_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      identifier TEXT,
      secret_hash TEXT,
      verified_at TEXT,
      attempt_count INTEGER DEFAULT 0,
      last_sent_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT,
      consumed_at TEXT,
      attempt_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      profile_id TEXT,
      issued_at TEXT,
      access_expires_at TEXT,
      refresh_expires_at TEXT,
      refresh_token_hash TEXT,
      revoked_at TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

function buildApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.db = db; next() })
  app.use('/api/auth', authRouter)
  return app
}

async function seedUser(db, { id, email, lastLoginAt = null }) {
  await db.prepare(
    `INSERT INTO users (id, display_name, primary_email, is_admin, last_login_at)
     VALUES (?, ?, ?, 0, ?)`,
  ).run(id, `User ${id}`, email, lastLoginAt)
}

async function seedSession(db, { id, userId, accessExpiresAt, refreshToken }) {
  const future = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString()
  await db.prepare(
    `INSERT INTO user_sessions (id, user_id, profile_id, issued_at, access_expires_at, refresh_expires_at, refresh_token_hash)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
  ).run(id, userId, '2026-06-01T00:00:00.000Z', accessExpiresAt, future, hashValue(refreshToken))
}

async function lastLoginOf(db, userId) {
  const row = await db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(userId)
  return row?.last_login_at ?? null
}

async function signInAuditRows(db) {
  try {
    return await db
      .prepare(`SELECT details, user_id FROM audit_logs WHERE action = 'client_sign_in' ORDER BY created_at ASC`)
      .all()
  } catch {
    return [] // audit table is auto-created on first write; absent = no events
  }
}

/**
 * last_login_at is stamped fire-and-forget (void recordSuccessfulLogin) so
 * the response can return before the write lands — poll briefly.
 */
async function waitForLastLogin(db, userId, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await lastLoginOf(db, userId)
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('login recording across auth paths', () => {
  let db
  let app
  beforeEach(() => {
    db = new SqliteShim()
    seedSchema(db)
    app = buildApp(db)
  })
  afterEach(() => {
    try { db.raw().close() } catch { /* ignore */ }
  })

  it('magic-code login (/email/verify stateless-OTP) stamps last_login_at and appends a client_sign_in event', async () => {
    const email = 'client@example.test'
    await seedUser(db, { id: 'user-1', email })
    await db.prepare(
      `INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('cred-1', 'user-1', 'email_otp', ?)`,
    ).run(email)
    await db.prepare(
      `INSERT INTO profiles (id, display_name, primary_type, user_id, status) VALUES ('profile-1', 'Client', 'individual', 'user-1', 'active')`,
    ).run()

    const code = '654321'
    // Server-side one-time verification is now authoritative: seed the real DB
    // code row the way /email/start would (the client token is no longer a
    // verifier). See emailOtpTokenNoVerifier.test.js for the security rationale.
    await db.prepare(
      `INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES ('cred-1', ?, ?)`,
    ).run(hashValue(`${email}:${code}`), new Date(Date.now() + 600_000).toISOString())
    const verificationToken = signOtpToken({
      kind: 'email',
      identifier: email,
      ttlSeconds: 600,
    })
    const res = await request(app)
      .post('/api/auth/email/verify')
      .send({ email, code, verification_token: verificationToken })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()

    // Durable stamp for the admin panel's user login info.
    expect(await waitForLastLogin(db, 'user-1')).toBeTruthy()

    // Durable login event the /api/admin/login-events tracker reads.
    const events = await signInAuditRows(db)
    expect(events.length).toBe(1)
    const details = JSON.parse(events[0].details)
    expect(details.method).toBe('email')
    expect(details.identifier).toBe(email)
  })

  it('a refresh that RESUMES a lapsed session records a returning login (last_login_at + session_resume event)', async () => {
    const email = 'returning@example.test'
    const refreshToken = 'r'.repeat(64)
    await seedUser(db, { id: 'user-2', email })
    await seedSession(db, {
      id: 'session-2',
      userId: 'user-2',
      // Access token lapsed two days ago: the user was away and is coming back.
      accessExpiresAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      refreshToken,
    })

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeTruthy()

    expect(await waitForLastLogin(db, 'user-2')).toBeTruthy()

    const events = await signInAuditRows(db)
    expect(events.length).toBe(1)
    const details = JSON.parse(events[0].details)
    expect(details.method).toBe('session_resume')
    expect(details.identifier).toBe(email)
    expect(events[0].user_id).toBe('user-2')
  })

  it('an IN-SESSION token refresh (access token still valid) is NOT counted as a login', async () => {
    const email = 'active@example.test'
    const refreshToken = 'a'.repeat(64)
    const priorLogin = '2026-07-05T08:00:00.000Z'
    await seedUser(db, { id: 'user-3', email, lastLoginAt: priorLogin })
    await seedSession(db, {
      id: 'session-3',
      userId: 'user-3',
      // Access token still valid for 2 more hours: proactive mid-use rotation.
      accessExpiresAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      refreshToken,
    })

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeTruthy()

    // Give any (incorrect) fire-and-forget stamp a moment to land, then assert
    // nothing changed and no login event was fabricated.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await lastLoginOf(db, 'user-3')).toBe(priorLogin)
    expect((await signInAuditRows(db)).length).toBe(0)
  })

  it('a resumed session keeps rotating silently afterwards (only the resume is counted once)', async () => {
    const email = 'once@example.test'
    const refreshToken = 'b'.repeat(64)
    await seedUser(db, { id: 'user-4', email })
    await seedSession(db, {
      id: 'session-4',
      userId: 'user-4',
      accessExpiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      refreshToken,
    })

    const first = await request(app).post('/api/auth/refresh').send({ refreshToken })
    expect(first.status).toBe(200)
    await waitForLastLogin(db, 'user-4')

    // Immediately rotate again with the fresh token (access now valid again).
    const second = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: first.body.refreshToken })
    expect(second.status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 150))
    const events = await signInAuditRows(db)
    expect(events.length).toBe(1)
    expect(JSON.parse(events[0].details).method).toBe('session_resume')
  })
})
