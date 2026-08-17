/**
 * SECURITY REGRESSION (round 13): ctx.userId ownership fallbacks must be gated on
 * a TRUSTED identity (ctx.identityResolved). A deleted-user JWT or a JWT whose sub
 * collides with a reserved synthetic id (no serviceToken) keeps ctx.userId
 * populated but is NOT a trusted principal — it must gain no ownership/authority.
 *
 * Covers: POST /api/profiles (create/adopt), GET /api/outreach-logs, and
 * GET /api/grant-applications.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../services/crawlerDispatcher.js', () => ({ dispatchCrawlerJob: vi.fn() }))
vi.mock('../services/hamilton/applicationTaskStore.js', () => ({
  reconcileProfileFieldsToTasks: vi.fn(),
  updateApplicationTask: vi.fn(),
  appendTaskEvent: vi.fn(),
}))

const Database = (await import('better-sqlite3')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const { enforceResolvedIdentity } = await import('../middleware/enforceResolvedIdentity.js')
const profilesRouter = (await import('../routes/profiles.js')).default
const outreachRouter = (await import('../routes/outreachLogs.js')).default
const grantAppsRouter = (await import('../routes/grantApplications.js')).default
const foundationsRouter = (await import('../routes/foundations.js')).default
const anyaMatchRouter = (await import('../routes/anyaMatchSuggestions.js')).default
const savedGrantsRouter = (await import('../routes/savedGrants.js')).default
const pricingRouter = (await import('../routes/pricing.js')).default
const authRouter = (await import('../routes/auth.js')).default

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0, primary_email TEXT, display_name TEXT, primary_phone TEXT, avatar_url TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, organization_id TEXT, display_name TEXT, status TEXT DEFAULT 'active', primary_type TEXT, created_at TEXT DEFAULT '2026-01-01');
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, identifier TEXT, verified_at DATETIME);
    CREATE TABLE grant_applications (id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, status TEXT, created_at TEXT DEFAULT '2026-01-01', updated_at TEXT DEFAULT '2026-01-01');
    INSERT INTO users (id, is_admin, primary_email) VALUES
      ('u-real', 0, 'real@x.example'),
      ('u-collab', 0, 'collab@x.example');
    -- Self-healed reserved synthetic row (as /auth/me self-heal may create):
    INSERT INTO users (id, is_admin, primary_email) VALUES ('system_admin_token', 1, 'svc@grantflow.app');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-real', 'u-real', 'u-real', 'Real Profile');
    -- Lingering profiles owned by a now-DELETED user / the reserved id:
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-stale', 'deleted-user', 'deleted-user', 'Stale');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-svc', 'system_admin_token', 'system_admin_token', 'Svc-owned');
    INSERT INTO grant_applications (id, user_id, profile_id, status) VALUES ('ga-stale', 'deleted-user', 'p-stale', 'draft');
  `)
  return db
}

function appWith(db, user, router, mount) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.db = db; req.user = user; next() })
  app.use(attachRequestContext())
  app.use(mount, router)
  return app
}

const DELETED = { role: 'user', userId: 'deleted-user' }
const SYNTH_COLLISION = { role: 'user', userId: 'system_admin_token', roles: ['admin'] } // NO serviceToken
const REAL = { role: 'user', userId: 'u-real' }
const COLLABORATOR = { role: 'user', userId: 'u-collab' }

describe('DELETE /api/profiles/:id requires destructive ownership', () => {
  it('DENIES a trusted collaborator whose active profile is owned by someone else', async () => {
    const db = makeDb()
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.db = db; req.user = COLLABORATOR; next() })
    app.use(attachRequestContext())
    // Model the canonical shared-profile access computed by requestContext.
    // It may authorize reads/edits, but must never become delete ownership.
    app.use((req, _res, next) => {
      req.ctx.activeProfileId = 'p-real'
      req.ctx.accessibleProfileIds = new Set(['p-real'])
      next()
    })
    app.use('/api/profiles', profilesRouter)

    const response = await request(app).delete('/api/profiles/p-real')
    expect(response.status).toBe(403)
    expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get('p-real')).toEqual({ id: 'p-real' })
  })
})

describe('POST /api/profiles create/adopt requires a trusted identity', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('DENIES a deleted-user JWT (403, no adopt/create)', async () => {
    const res = await request(appWith(db, DELETED, profilesRouter, '/api/profiles'))
      .post('/api/profiles').send({ display_name: 'X' })
    expect(res.status).toBe(403)
  })

  it('DENIES a synthetic-id-collision JWT without serviceToken (403)', async () => {
    const res = await request(appWith(db, SYNTH_COLLISION, profilesRouter, '/api/profiles'))
      .post('/api/profiles').send({ display_name: 'X' })
    expect(res.status).toBe(403)
  })

  it('ALLOWS a real user past the identity gate (not 401/403)', async () => {
    // The trusted real user clears the identity gate and reaches the create path.
    // (A 500 here would only mean this minimal test schema lacks a create column;
    // the security-relevant fact is that it was NOT denied by the gate.)
    const res = await request(appWith(db, REAL, profilesRouter, '/api/profiles'))
      .post('/api/profiles').send({ display_name: 'My Profile' })
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })
})

describe('GET /api/outreach-logs denies stale/synthetic identities', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('DENIES a deleted-user JWT reading its lingering profile (403)', async () => {
    const res = await request(appWith(db, DELETED, outreachRouter, '/api/outreach-logs'))
      .get('/api/outreach-logs?profile_id=p-stale')
    expect(res.status).toBe(403)
  })

  it('DENIES a synthetic-collision JWT reading the reserved-id profile (403)', async () => {
    const res = await request(appWith(db, SYNTH_COLLISION, outreachRouter, '/api/outreach-logs'))
      .get('/api/outreach-logs?profile_id=p-svc')
    expect(res.status).toBe(403)
  })

  it('ALLOWS a real user reading their own profile (200)', async () => {
    const res = await request(appWith(db, REAL, outreachRouter, '/api/outreach-logs'))
      .get('/api/outreach-logs?profile_id=p-real')
    expect(res.status).toBe(200)
  })
})

describe('GET /api/grant-applications denies stale/synthetic identities', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('DENIES a deleted-user JWT (403 — cannot scope to its stale user_id)', async () => {
    const res = await request(appWith(db, DELETED, grantAppsRouter, '/api/grant-applications'))
      .get('/api/grant-applications')
    expect(res.status).toBe(403)
  })

  it('DENIES a synthetic-collision JWT (403)', async () => {
    const res = await request(appWith(db, SYNTH_COLLISION, grantAppsRouter, '/api/grant-applications'))
      .get('/api/grant-applications')
    expect(res.status).toBe(403)
  })

  it('ALLOWS a real user (200)', async () => {
    const res = await request(appWith(db, REAL, grantAppsRouter, '/api/grant-applications'))
      .get('/api/grant-applications')
    expect(res.status).toBe(200)
  })
})

describe('round-14 named routes deny stale/synthetic identities (explicit requireResolvedIdentity gate)', () => {
  let db
  beforeEach(() => { db = makeDb() })

  for (const [label, user] of [['deleted-user', DELETED], ['synthetic-collision', SYNTH_COLLISION]]) {
    it(`GET /api/foundations/calendar/deadlines denies a ${label} JWT (403)`, async () => {
      const res = await request(appWith(db, user, foundationsRouter, '/api/foundations'))
        .get('/api/foundations/calendar/deadlines')
      expect(res.status).toBe(403)
    })
    it(`GET /api/anya-match-suggestions/pending denies a ${label} JWT (403)`, async () => {
      const res = await request(appWith(db, user, anyaMatchRouter, '/api/anya-match-suggestions'))
        .get('/api/anya-match-suggestions/pending')
      expect(res.status).toBe(403)
    })
    it(`GET /api/saved-grants denies a ${label} JWT (403)`, async () => {
      const res = await request(appWith(db, user, savedGrantsRouter, '/api/saved-grants'))
        .get('/api/saved-grants')
      expect(res.status).toBe(403)
    })
    it(`POST /api/saved-grants denies a ${label} JWT (403)`, async () => {
      const res = await request(appWith(db, user, savedGrantsRouter, '/api/saved-grants'))
        .post('/api/saved-grants').send({ opportunity_id: 'opp-1' })
      expect(res.status).toBe(403)
    })
  }

  it('a real user is NOT denied by the identity gate on these routes', async () => {
    const anya = await request(appWith(db, REAL, anyaMatchRouter, '/api/anya-match-suggestions'))
      .get('/api/anya-match-suggestions/pending')
    expect(anya.status).not.toBe(403)
    const saved = await request(appWith(db, REAL, savedGrantsRouter, '/api/saved-grants'))
      .get('/api/saved-grants')
    expect(saved.status).not.toBe(403)
  })
})

describe('GET /api/pricing/my-estimate/:profileId requires identity + profile access', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('DENIES a deleted-user JWT (403)', async () => {
    const res = await request(appWith(db, DELETED, pricingRouter, '/api/pricing'))
      .get('/api/pricing/my-estimate/p-real')
    expect(res.status).toBe(403)
  })

  it('DENIES a synthetic-collision JWT (403)', async () => {
    const res = await request(appWith(db, SYNTH_COLLISION, pricingRouter, '/api/pricing'))
      .get('/api/pricing/my-estimate/p-svc')
    expect(res.status).toBe(403)
  })

  it('DENIES a real user requesting ANOTHER profile\'s estimate (403)', async () => {
    const res = await request(appWith(db, REAL, pricingRouter, '/api/pricing'))
      .get('/api/pricing/my-estimate/p-stale') // owned by deleted-user, not by REAL
    expect(res.status).toBe(403)
  })

  it('ALLOWS the owner requesting their own estimate (not 403)', async () => {
    const res = await request(appWith(db, REAL, pricingRouter, '/api/pricing'))
      .get('/api/pricing/my-estimate/p-real')
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })
})

describe('PATCH /api/auth/onboarding-state (user-scoped auth MUTATION) is identityResolved-gated', () => {
  function makeAuthDb() {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0, primary_email TEXT,
        has_completed_onboarding INTEGER DEFAULT 0, onboarding_completed_at TEXT,
        last_seen_manual_version INTEGER DEFAULT 0, last_completed_tour_version INTEGER DEFAULT 0,
        tour_dismissed_at TEXT, guided_cycle_tour_status TEXT, last_login_at TEXT
      );
      CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, status TEXT DEFAULT 'active');
      INSERT INTO users (id, is_admin, primary_email) VALUES ('u-real', 0, 'real@x.example');
      -- self-healed reserved synthetic row (must NOT be mutable via a colliding JWT)
      INSERT INTO users (id, is_admin, primary_email) VALUES ('system_admin_token', 1, 'svc@grantflow.app');
    `)
    return db
  }

  it('DENIES a deleted-user JWT (403, no auth-state write)', async () => {
    const db = makeAuthDb()
    const res = await request(appWith(db, DELETED, authRouter, '/api/auth'))
      .patch('/api/auth/onboarding-state').send({ has_completed_onboarding: true })
    expect(res.status).toBe(403)
  })

  it('DENIES a synthetic-collision JWT (403, no reserved-row mutation)', async () => {
    const db = makeAuthDb()
    const res = await request(appWith(db, SYNTH_COLLISION, authRouter, '/api/auth'))
      .patch('/api/auth/onboarding-state').send({ has_completed_onboarding: true })
    expect(res.status).toBe(403)
    // The reserved synthetic row must be untouched.
    const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get('system_admin_token')
    expect(row.has_completed_onboarding).toBe(0)
  })

  it('ALLOWS a real user to update their own onboarding state (200)', async () => {
    const db = makeAuthDb()
    const res = await request(appWith(db, REAL, authRouter, '/api/auth'))
      .patch('/api/auth/onboarding-state').send({ has_completed_onboarding: true })
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get('u-real')
    expect(row.has_completed_onboarding).toBe(1)
  })
})

describe('enforceResolvedIdentity middleware (structural close) nulls unresolved caller ids', () => {
  function run(reqCtx, reqUser) {
    const req = { ctx: reqCtx, user: reqUser }
    let called = false
    enforceResolvedIdentity()(req, {}, () => { called = true })
    return { req, called }
  }

  it('clears the WHOLE untrusted identity surface (id, profileId, email, role, is_admin) -> guest', () => {
    const { req } = run(
      { userId: 'system_admin_token', email: 'svc@grantflow.app', activeProfileId: 'p-svc', isAdmin: false, identityResolved: false, accessibleProfileIds: new Set() },
      { role: 'admin', is_admin: true, roles: ['admin'], userId: 'system_admin_token', id: 'system_admin_token', user_id: 'system_admin_token', profileId: 'p-svc', profile_id: 'p-svc', email: 'svc@grantflow.app', primary_email: 'svc@grantflow.app' },
    )
    // ctx: every identity field cleared; empty (never null/all-access) sets.
    expect(req.ctx.userId).toBeNull()
    expect(req.ctx.email).toBeNull()
    expect(req.ctx.activeProfileId).toBeNull()
    expect(req.ctx.accessibleProfileIds instanceof Set && req.ctx.accessibleProfileIds.size === 0).toBe(true)
    // req.user: reduced to a guest — no id/profileId/email/role/is_admin survive.
    expect(req.user.role).toBe('guest')
    expect(req.user.userId ?? null).toBeNull()
    expect(req.user.id ?? null).toBeNull()
    expect(req.user.profileId ?? null).toBeNull()
    expect(req.user.email ?? null).toBeNull()
    expect(req.user.is_admin ?? null).toBeNull()
    expect(req.user.roles ?? null).toBeNull()
  })

  it('clears the surface even when only a token profileId/email survives (no ctx.userId)', () => {
    const { req } = run(
      { userId: null, isAdmin: false, identityResolved: false },
      { role: 'user', profileId: 'p-svc', email: 'svc@grantflow.app' },
    )
    expect(req.user.role).toBe('guest')
    expect(req.user.profileId ?? null).toBeNull()
    expect(req.user.email ?? null).toBeNull()
  })

  it('leaves a trusted identity (identityResolved=true) untouched', () => {
    const { req } = run(
      { userId: 'u1', isAdmin: false, identityResolved: true, accessibleProfileIds: new Set(['p1']) },
      { role: 'user', userId: 'u1' },
    )
    expect(req.ctx.userId).toBe('u1')
    expect(req.user.userId).toBe('u1')
  })

  it('leaves an admin untouched', () => {
    const { req } = run(
      { userId: 'system_admin_token', isAdmin: true, identityResolved: false },
      { role: 'admin', userId: 'system_admin_token' },
    )
    expect(req.ctx.userId).toBe('system_admin_token')
  })

  it('leaves a validated synthetic service token untouched', () => {
    const { req } = run(
      { userId: 'system_admin_token', isAdmin: false, identityResolved: false },
      { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' },
    )
    expect(req.ctx.userId).toBe('system_admin_token')
  })
})
