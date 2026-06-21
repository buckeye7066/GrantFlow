// Integration tests for /api/onboarding routes.
//
// These tests pin the contract for the SINGLE new-user funnel:
//   1. POST /start creates a session and returns the first question.
//   2. POST /answer with valid input advances the question pointer.
//   3. POST /answer rejects out-of-order answers (you can't skip ahead).
//   4. GET /sessions/:id resumes a session in flight.
//   5. POST /complete with a finished session creates a profile, persists
//      every section the engine collected, and emits a verification token
//      the frontend can hand to /api/auth/email/verify.
//
// All scenarios run against an in-memory SQLite DB seeded with the minimum
// shape the route uses (users, profiles, profile_sections, user_credentials,
// user_otp_codes, onboarding_sessions). The auth helpers re-exported from
// backend/routes/auth.js are exercised live so we catch any drift between
// the onboarding completion path and the canonical email-OTP flow.
import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

import onboardingRouter from '../routes/onboarding.js'

// ---------------------------------------------------------------------------
// SQLite shim that mimics the prepare/.run/.get/.all signature the
// production sqlite wrapper exposes — including the boolean / object / Date
// → SQLite-bindable coercion the real wrapper performs (without it,
// better-sqlite3 throws "SQLite3 can only bind numbers, strings, …").
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
  if (args.length === 1 && Array.isArray(args[0])) {
    return [args[0].map(normalizeValue)]
  }
  return args.map(normalizeValue)
}

class SqliteShim {
  constructor() {
    this._db = new Database(':memory:')
    this._db.pragma('foreign_keys = ON')
  }
  prepare(sql) {
    const stmt = this._db.prepare(sql)
    return {
      run: async (...params) => stmt.run(...normalizeArgs(params)),
      get: async (...params) => stmt.get(...normalizeArgs(params)),
      all: async (...params) => stmt.all(...normalizeArgs(params)),
    }
  }
  exec(sql) {
    this._db.exec(sql)
  }
  async withTransaction(fn) {
    this._db.exec('BEGIN IMMEDIATE')
    try {
      const txCtx = {
        prepare: (sql) => {
          const stmt = this._db.prepare(sql)
          return {
            run: (...params) => stmt.run(...normalizeArgs(params)),
            get: (...params) => stmt.get(...normalizeArgs(params)),
            all: (...params) => stmt.all(...normalizeArgs(params)),
          }
        },
      }
      const result = await fn(txCtx)
      this._db.exec('COMMIT')
      return result
    } catch (err) {
      try { this._db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  }
  raw() { return this._db }
}

function buildApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.db = db; next() })
  app.use('/api/onboarding', onboardingRouter)
  return app
}

async function seedSchema(db) {
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      organization_id TEXT,
      user_id TEXT REFERENCES users(id),
      created_by TEXT,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE user_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      identifier TEXT,
      secret_hash TEXT,
      attempt_count INTEGER DEFAULT 0,
      last_sent_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE onboarding_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'in_progress',
      current_question TEXT,
      answers TEXT NOT NULL DEFAULT '{}',
      profile_patch TEXT NOT NULL DEFAULT '{}',
      email TEXT,
      user_id TEXT REFERENCES users(id),
      profile_id TEXT REFERENCES profiles(id),
      user_agent TEXT,
      ip_hash TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    );
  `)
}

async function answer(app, sessionId, questionId, value) {
  return request(app)
    .post('/api/onboarding/answer')
    .send({ session_id: sessionId, question_id: questionId, answer: value })
}

describe('/api/onboarding routes — Anya conversational funnel', () => {
  let db
  let app
  beforeEach(async () => {
    db = new SqliteShim()
    await seedSchema(db)
    app = buildApp(db)
    // Force the email-send race in /complete to bail out fast — without this
    // the route waits on a real SMTP attempt for up to 15s.
    process.env.AUTH_EMAIL_SEND_TIMEOUT_MS = '100'
    // Make sure the email service is not configured for tests so the fallback
    // exits immediately.
    delete process.env.SENDGRID_API_KEY
    delete process.env.AUTH_EMAIL_FROM
    delete process.env.SMTP_HOST
  })
  afterEach(() => {
    try { db.raw().close() } catch { /* ignore */ }
  })

  it('starts a session and returns the first question', async () => {
    const res = await request(app).post('/api/onboarding/start')
    expect(res.status).toBe(201)
    expect(res.body.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body.status).toBe('in_progress')
    expect(res.body.question?.id).toBe('language')
    expect(res.body.question?.kind).toBe('choice')
  })

  it('rejects out-of-order answers', async () => {
    const start = await request(app).post('/api/onboarding/start')
    const sid = start.body.session_id
    // Try to answer 'who' while we're still on the first ('language') question
    const bad = await answer(app, sid, 'who', 'personal_group')
    expect(bad.status).toBe(409)
    expect(bad.body.expected_question_id).toBe('language')
  })

  it('walks an entire personal interview to completion and surfaces canonical state', async () => {
    const start = await request(app).post('/api/onboarding/start')
    const sid = start.body.session_id

    let r = await answer(app, sid, 'language', 'en')
    expect(r.body.question?.id).toBe('intro')
    r = await answer(app, sid, 'intro', null)
    expect(r.body.question?.id).toBe('who')
    r = await answer(app, sid, 'who', 'personal_group')
    expect(r.body.question?.id).toBe('location')
    r = await answer(app, sid, 'location', { zip: '37205', state: 'TN' })
    expect(r.body.question?.id).toBe('personal_subtype')
    r = await answer(app, sid, 'personal_subtype', 'family')
    expect(r.body.question?.id).toBe('needs_personal')
    r = await answer(app, sid, 'needs_personal', ['housing', 'food'])
    expect(r.body.question?.id).toBe('situations')
    r = await answer(app, sid, 'situations', [])
    expect(r.body.question?.id).toBe('narrative')
    r = await answer(app, sid, 'narrative', 'Behind on rent.')
    expect(r.body.question?.id).toBe('name')
    r = await answer(app, sid, 'name', 'The Smiths')
    expect(r.body.question?.id).toBe('email')
    r = await answer(app, sid, 'email', 'family@example.com')
    expect(r.body.complete).toBe(true)
    expect(r.body.state.primary_type).toBe('family')
    expect(r.body.state.email).toBe('family@example.com')
  })

  it('resumes an in-flight session with GET /sessions/:id', async () => {
    const start = await request(app).post('/api/onboarding/start')
    const sid = start.body.session_id
    await answer(app, sid, 'language', 'en')
    await answer(app, sid, 'intro', null)
    await answer(app, sid, 'who', 'volunteer_fire_department')
    const r = await request(app).get(`/api/onboarding/sessions/${sid}`)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('in_progress')
    expect(r.body.question?.id).toBe('location')
    expect(r.body.state.primary_type).toBe('volunteer_fire_department')
  })

  it('refuses /complete before the interview has finished', async () => {
    const start = await request(app).post('/api/onboarding/start')
    const sid = start.body.session_id
    const r = await request(app)
      .post('/api/onboarding/complete')
      .send({ session_id: sid })
    expect(r.status).toBe(409)
    expect(r.body.next_question_id).toBe('language')
  })

  it('completes a finished interview: creates user, profile, sections, and verification token', { timeout: 30000 }, async () => {
    const start = await request(app).post('/api/onboarding/start')
    const sid = start.body.session_id

    // Walk the personal branch end-to-end with realistic answers.
    await answer(app, sid, 'language', 'en')
    await answer(app, sid, 'intro', null)
    await answer(app, sid, 'who', 'org_mission')
    await answer(app, sid, 'location', { zip: '37205', state: 'TN', city: 'Nashville', county: 'Davidson' })
    await answer(app, sid, 'org_subtype', 'church')
    await answer(app, sid, 'org_compliance', 'yes')
    await answer(app, sid, 'org_focus', ['food', 'community_facilities'])
    await answer(app, sid, 'narrative', 'Weekly food pantry expansion.')
    await answer(app, sid, 'name', 'Hope Community Church')
    await answer(app, sid, 'email', 'pastor@hcc.example')

    const completion = await request(app)
      .post('/api/onboarding/complete')
      .send({ session_id: sid })

    expect(completion.status).toBe(201)
    expect(completion.body.status).toBe('completed')
    expect(completion.body.email).toBe('pastor@hcc.example')
    expect(completion.body.verification_token).toMatch(/.+/)
    expect(completion.body.profile_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(completion.body.user_id).toMatch(/^[0-9a-f-]{36}$/)

    // Verify the canonical persisted state.
    const profile = await db.prepare('SELECT id, primary_type, display_name, tags FROM profiles WHERE id = ?')
      .get(completion.body.profile_id)
    expect(profile.primary_type).toBe('church')
    expect(profile.display_name).toBe('Hope Community Church')
    const tags = JSON.parse(profile.tags ?? '[]')
    expect(tags).toContain('food')

    const sections = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(completion.body.profile_id)
    const map = Object.fromEntries(sections.map((row) => [row.section_key, JSON.parse(row.data ?? '{}')]))
    expect(map.basic_information.zip_code).toBe('37205')
    expect(map.basic_information.state).toBe('TN')
    expect(map.organization_details.entity_type).toBe('church')
    expect(map.nonprofit_compliance.is_501c3).toBe(true)
    expect(map.programs_services.focus_areas).toEqual(expect.arrayContaining(['food']))
    expect(map.narrative.summary).toMatch(/food pantry/)

    // The session row must be marked completed and linked to the new
    // profile + user — that's how /api/auth/email/start later finds the
    // profile gate match.
    const sessionRow = await db.prepare('SELECT status, profile_id, user_id, email FROM onboarding_sessions WHERE id = ?')
      .get(sid)
    expect(sessionRow.status).toBe('completed')
    expect(sessionRow.profile_id).toBe(completion.body.profile_id)
    expect(sessionRow.user_id).toBe(completion.body.user_id)
    expect(sessionRow.email).toBe('pastor@hcc.example')

    // The user must exist with the email and be marked onboarded.
    const userRow = await db.prepare('SELECT id, primary_email, has_completed_onboarding FROM users WHERE id = ?')
      .get(completion.body.user_id)
    expect(userRow.primary_email).toBe('pastor@hcc.example')
    expect(Number(userRow.has_completed_onboarding)).toBe(1)

    // A credential + active OTP must exist for the email so /api/auth/email/verify
    // accepts the token returned to the client.
    const credential = await db.prepare(
      `SELECT id, type, identifier, secret_hash FROM user_credentials WHERE user_id = ?`
    ).get(completion.body.user_id)
    expect(credential?.type).toBe('email_otp')
    expect(credential?.identifier).toBe('pastor@hcc.example')
    const otpRow = await db.prepare(
      `SELECT * FROM user_verification_codes WHERE credential_id = ? AND consumed_at IS NULL`
    ).get(credential.id)
    expect(otpRow).toBeTruthy()
  })

  it('resolves a known ZIP to city/state/county for location auto-fill', async () => {
    const r = await request(app).get('/api/onboarding/zip/37205')
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('TN')
    expect(r.body.city).toMatch(/nashville/i)
    expect(r.body.zip).toBe('37205')
  })

  it('rejects a malformed ZIP and 404s an unknown one', async () => {
    const bad = await request(app).get('/api/onboarding/zip/abc')
    expect(bad.status).toBe(400)
    const unknown = await request(app).get('/api/onboarding/zip/00000')
    expect(unknown.status).toBe(404)
  })

  it('rejects /answer for unknown sessions', async () => {
    const r = await request(app)
      .post('/api/onboarding/answer')
      .send({ session_id: '00000000-0000-0000-0000-000000000000', question_id: 'intro', answer: null })
    expect(r.status).toBe(404)
  })
})
