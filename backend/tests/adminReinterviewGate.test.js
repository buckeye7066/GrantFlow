// Admin reinterview gate — "an ADMIN/owner account is only ever interviewed
// at most once; a secondary login must NEVER re-trigger the Anya interview"
// (owner-directed, 2026-07-06).
//
// Pins all three layers:
//   1. resolveGuidedCycleTourStatus() (services/onboardingGates.js): the pure
//      per-call gate every auth payload passes through.
//   2. The LIVE login path: POST /api/auth/email/verify for an admin whose
//      users row still carries the bulk-reset 'pending_reinterview' flag must
//      respond with guided_cycle_tour_status 'completed' (no interview
//      prompt), while a NON-admin in the same state keeps
//      'pending_reinterview' (their reset flow is deliberate).
//   3. The boot net: enforceAdminReinterviewSuppression() repairs the DB rows
//      themselves — admin rows that already had their first-run are cleared,
//      fresh admins and all non-admins are never touched.
import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

// auth.js resolves the JWT secret at import time (process.exit(1) without
// one), so pin the env BEFORE the dynamic import below.
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-admin-reinterview'
process.env.AUTH_EMAIL_SEND_TIMEOUT_MS = '100'

const {
  resolveGuidedCycleTourStatus,
  hasHadFirstRunAlready,
} = await import('../services/onboardingGates.js')
const { enforceAdminReinterviewSuppression } = await import('../startup/enforceInvariants.js')
const authModule = await import('../routes/auth.js')
const authRouter = authModule.default
const { hashValue } = authModule

// ---------------------------------------------------------------------------
// SQLite shim mirroring the prod wrapper's prepare/.run/.get/.all signature
// (same pattern as onboardingRoute.test.js) so boolean/object binds coerce.
// ---------------------------------------------------------------------------
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

async function seedLoginReadyUser(db, {
  id,
  email,
  isAdmin,
  guidedStatus,
  hasCompletedOnboarding = 1,
  lastLoginAt = '2026-07-01T00:00:00.000Z',
}) {
  await db.prepare(
    `INSERT INTO users (id, display_name, primary_email, is_admin, has_completed_onboarding, guided_cycle_tour_status, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `User ${id}`, email, isAdmin ? 1 : 0, hasCompletedOnboarding, guidedStatus, lastLoginAt)
  await db.prepare(
    `INSERT INTO user_credentials (id, user_id, type, identifier) VALUES (?, ?, 'email_otp', ?)`,
  ).run(`cred-${id}`, id, email)
  await db.prepare(
    `INSERT INTO profiles (id, display_name, primary_type, user_id, status) VALUES (?, ?, 'individual', ?, 'active')`,
  ).run(`profile-${id}`, `Profile ${id}`, id)
}

/**
 * Drive the real OTP login (the magic-code path) for an email. Server-side
 * one-time verification is now authoritative, so we seed the real DB code row
 * (as /email/start would) rather than relying on a client token — the token no
 * longer carries a verifier. See emailOtpTokenNoVerifier.test.js.
 */
async function loginViaEmailVerify(app, db, email) {
  const code = '123456'
  const cred = await db
    .prepare(`SELECT id FROM user_credentials WHERE identifier = ? AND type = 'email_otp' LIMIT 1`)
    .get(email)
  if (cred?.id) {
    await db
      .prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES (?, ?, ?)`)
      .run(cred.id, hashValue(`${email}:${code}`), new Date(Date.now() + 600_000).toISOString())
  }
  return request(app).post('/api/auth/email/verify').send({ email, code })
}

// ---------------------------------------------------------------------------
// 1) Pure resolver
// ---------------------------------------------------------------------------
describe('onboardingGates.resolveGuidedCycleTourStatus', () => {
  it('admin with a completed interview + pending_reinterview flag resolves to completed', () => {
    expect(resolveGuidedCycleTourStatus({
      is_admin: 1,
      guided_cycle_tour_status: 'pending_reinterview',
      has_completed_onboarding: 1,
    })).toBe('completed')
  })

  it('admin who has EVER signed in before (last_login_at) is never re-served pending_reinterview', () => {
    expect(resolveGuidedCycleTourStatus({
      is_admin: true,
      guided_cycle_tour_status: 'pending_reinterview',
      has_completed_onboarding: 0,
      onboarding_completed_at: null,
      last_login_at: '2026-07-01T00:00:00.000Z',
    })).toBe('completed')
  })

  it('a genuinely FRESH admin (never onboarded, never signed in) keeps their one first-run', () => {
    expect(resolveGuidedCycleTourStatus({
      is_admin: 1,
      guided_cycle_tour_status: 'pending_reinterview',
      has_completed_onboarding: 0,
      onboarding_completed_at: null,
      last_login_at: null,
    })).toBe('pending_reinterview')
  })

  it('non-admin behavior is unchanged: pending_reinterview passes through even when onboarded', () => {
    expect(resolveGuidedCycleTourStatus({
      is_admin: 0,
      guided_cycle_tour_status: 'pending_reinterview',
      has_completed_onboarding: 1,
      last_login_at: '2026-07-01T00:00:00.000Z',
    })).toBe('pending_reinterview')
  })

  it('every non-reinterview status passes through untouched for admins and users alike', () => {
    for (const status of ['pending', 'completed', 'skipped', null]) {
      expect(resolveGuidedCycleTourStatus({ is_admin: 1, guided_cycle_tour_status: status, has_completed_onboarding: 1 })).toBe(status)
      expect(resolveGuidedCycleTourStatus({ is_admin: 0, guided_cycle_tour_status: status, has_completed_onboarding: 1 })).toBe(status)
    }
  })

  it('hasHadFirstRunAlready reads all three durable signals (and Postgres boolean shapes)', () => {
    expect(hasHadFirstRunAlready({ has_completed_onboarding: true })).toBe(true)
    expect(hasHadFirstRunAlready({ has_completed_onboarding: 't' })).toBe(true)
    expect(hasHadFirstRunAlready({ onboarding_completed_at: '2026-01-01T00:00:00Z' })).toBe(true)
    expect(hasHadFirstRunAlready({ last_login_at: '2026-01-01T00:00:00Z' })).toBe(true)
    expect(hasHadFirstRunAlready({ has_completed_onboarding: 0, onboarding_completed_at: null, last_login_at: null })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2) Live login path (secondary login of a flagged admin)
// ---------------------------------------------------------------------------
describe('secondary login never re-triggers the interview for admins (live /email/verify)', () => {
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

  it('admin with completed interview + pending_reinterview backfill logs in WITHOUT an interview prompt', async () => {
    await seedLoginReadyUser(db, {
      id: 'admin-1',
      email: 'admin@example.test',
      isAdmin: true,
      guidedStatus: 'pending_reinterview',
      hasCompletedOnboarding: 1,
    })

    const res = await loginViaEmailVerify(app, db, 'admin@example.test')
    expect(res.status).toBe(200)
    expect(res.body.user?.is_admin).toBe(true)
    // The interview trigger the frontend keys on must NOT be served.
    expect(res.body.user?.guided_cycle_tour_status).toBe('completed')
  })

  it('admin whose only first-run signal is a prior sign-in is also protected (backfill regardless)', async () => {
    await seedLoginReadyUser(db, {
      id: 'admin-2',
      email: 'admin2@example.test',
      isAdmin: true,
      guidedStatus: 'pending_reinterview',
      hasCompletedOnboarding: 0,
      lastLoginAt: '2026-06-15T09:00:00.000Z',
    })

    const res = await loginViaEmailVerify(app, db, 'admin2@example.test')
    expect(res.status).toBe(200)
    expect(res.body.user?.guided_cycle_tour_status).toBe('completed')
  })

  it('non-admin with the same completed-interview + pending_reinterview state keeps the reset flow', async () => {
    await seedLoginReadyUser(db, {
      id: 'user-1',
      email: 'client@example.test',
      isAdmin: false,
      guidedStatus: 'pending_reinterview',
      hasCompletedOnboarding: 1,
    })

    const res = await loginViaEmailVerify(app, db, 'client@example.test')
    expect(res.status).toBe(200)
    expect(res.body.user?.is_admin).toBe(false)
    // Deliberate product behavior: existing non-admin users reset by the
    // admin bulk operation DO get the video -> interview -> tour sequence.
    expect(res.body.user?.guided_cycle_tour_status).toBe('pending_reinterview')
  })
})

// ---------------------------------------------------------------------------
// 3) Boot net (durable DB repair)
// ---------------------------------------------------------------------------
describe('enforceAdminReinterviewSuppression (boot invariant)', () => {
  let db
  beforeEach(() => {
    db = new SqliteShim()
    seedSchema(db)
  })
  afterEach(() => {
    try { db.raw().close() } catch { /* ignore */ }
  })

  async function insertUser(id, { isAdmin, status, completed = 0, lastLogin = null, completedAt = null }) {
    await db.prepare(
      `INSERT INTO users (id, primary_email, is_admin, has_completed_onboarding, onboarding_completed_at, guided_cycle_tour_status, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, `${id}@example.test`, isAdmin ? 1 : 0, completed, completedAt, status, lastLogin)
  }
  async function statusOf(id) {
    const row = await db.prepare('SELECT guided_cycle_tour_status FROM users WHERE id = ?').get(id)
    return row?.guided_cycle_tour_status ?? null
  }

  it('clears pending_reinterview ONLY from admin rows that already had their first-run', async () => {
    await insertUser('admin-onboarded', { isAdmin: true, status: 'pending_reinterview', completed: 1 })
    await insertUser('admin-signed-in', { isAdmin: true, status: 'pending_reinterview', lastLogin: '2026-06-01T00:00:00Z' })
    await insertUser('admin-completed-at', { isAdmin: true, status: 'pending_reinterview', completedAt: '2026-05-01T00:00:00Z' })
    await insertUser('admin-fresh', { isAdmin: true, status: 'pending_reinterview' })
    await insertUser('user-onboarded', { isAdmin: false, status: 'pending_reinterview', completed: 1, lastLogin: '2026-06-01T00:00:00Z' })
    await insertUser('admin-other-status', { isAdmin: true, status: 'pending', completed: 1 })

    const result = await enforceAdminReinterviewSuppression(db)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(3)

    expect(await statusOf('admin-onboarded')).toBe('completed')
    expect(await statusOf('admin-signed-in')).toBe('completed')
    expect(await statusOf('admin-completed-at')).toBe('completed')
    // A genuinely fresh admin keeps their one first-run experience.
    expect(await statusOf('admin-fresh')).toBe('pending_reinterview')
    // Non-admins are NEVER touched.
    expect(await statusOf('user-onboarded')).toBe('pending_reinterview')
    // Other statuses untouched.
    expect(await statusOf('admin-other-status')).toBe('pending')
  })

  it('is idempotent (second run repairs nothing)', async () => {
    await insertUser('admin-onboarded', { isAdmin: true, status: 'pending_reinterview', completed: 1 })
    const first = await enforceAdminReinterviewSuppression(db)
    expect(first.repaired).toBe(1)
    const second = await enforceAdminReinterviewSuppression(db)
    expect(second.ok).toBe(true)
    expect(second.repaired).toBe(0)
  })
})
