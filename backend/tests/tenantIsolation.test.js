/**
 * tenantIsolation.test.js — REAL cross-tenant isolation, driven through the
 * ACTUAL production enforcement code.
 *
 * The previous file with this name was a decoy: it defined its own in-memory
 * repo, its own RBAC matrix, its own session parser and CSRF guard, asserted
 * against those fixtures, and early-returned if the real module failed to
 * import — it tested the production system's isolation not at all while its
 * name implied it did (found by the epic slice-9 gap audit).
 *
 * This replacement drives the real layers, cross-tenant, against a real DB:
 *   1. scopedQuery — the SQL-layer guard: a profile-scoped read under tenant
 *      A's claim must never return tenant B's rows, and an unscoped read of
 *      a profile-scoped table under a tenant claim raises ProfileScopeError.
 *   2. ensureProfileAccess (backend/middleware/auth.js) — the route-level
 *      profile gate: 403 across tenants, 401 unauthenticated, admin bypass.
 *   3. accessControl.ensureGrantAccess — the grant gate the record routes
 *      build on: cross-org denial and org-member admission.
 *   4. An end-to-end HTTP assertion through a real mounted router
 *      (milestones): tenant A listing/reading can never see tenant B's rows.
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runProfileContext, assertProfileScopedSql, ProfileScopeError } from '../db/scopedQuery.js'
import { ensureProfileAccess } from '../middleware/auth.js'
import { ensureGrantAccess } from '../utils/accessControl.js'
import milestonesRouter from '../routes/milestones.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, organization_id TEXT, user_id TEXT, created_by TEXT, status TEXT DEFAULT 'active'
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, organization_id TEXT, title TEXT, status TEXT
    );
    CREATE TABLE milestones (
      id TEXT PRIMARY KEY, grant_id TEXT, organization_id TEXT, title TEXT,
      due_date TEXT, completed INTEGER DEFAULT 0, type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (id, email, role, is_admin) VALUES
      ('admin', 'admin@example.org', 'admin', 1),
      ('uA', 'a@example.org', 'user', 0),
      ('uB', 'b@example.org', 'user', 0);
    INSERT INTO profiles (id, organization_id, user_id) VALUES
      ('pA', 'orgA', 'uA'),
      ('pB', 'orgB', 'uB');
    INSERT INTO grants (id, profile_id, organization_id, title, status) VALUES
      ('gA', 'pA', 'orgA', 'Tenant A Grant', 'awarded'),
      ('gB', 'pB', 'orgB', 'Tenant B Grant', 'awarded');
    INSERT INTO milestones (id, grant_id, organization_id, title, due_date) VALUES
      ('mA', 'gA', 'orgA', 'A milestone', '2026-12-01'),
      ('mB', 'gB', 'orgB', 'B milestone', '2026-12-01');
  `)
  db.dialect = 'sqlite'
  return db
}

const CTX_A = { userId: 'uA', isAdmin: false, accessibleProfileIds: new Set(['pA']), accessibleOrgIds: new Set(['orgA']) }
const CTX_B = { userId: 'uB', isAdmin: false, accessibleProfileIds: new Set(['pB']), accessibleOrgIds: new Set(['orgB']) }

describe('layer 1 — scopedQuery (the SQL guard the db.prepare wrapper invokes)', () => {
  it('an UNSCOPED read of a profile-scoped table under a tenant claim throws ProfileScopeError', () => {
    runProfileContext({ profileId: 'pA', userId: 'uA', role: 'user' }, () => {
      expect(() => assertProfileScopedSql('SELECT * FROM grants')).toThrow(ProfileScopeError)
    })
  })

  it('a profile-narrowed read passes; an org-key-narrowed read passes (the two sanctioned shapes)', () => {
    runProfileContext({ profileId: 'pA', userId: 'uA', role: 'user' }, () => {
      expect(assertProfileScopedSql('SELECT * FROM grants WHERE profile_id = ?')).toBeTruthy()
      expect(assertProfileScopedSql('SELECT * FROM grants WHERE organization_id = ?')).toBeTruthy()
    })
  })

  it('an admin claim is exempt; NO claim (boot/migration path) is exempt', () => {
    runProfileContext({ profileId: 'pA', userId: 'admin', role: 'admin' }, () => {
      expect(assertProfileScopedSql('SELECT * FROM grants')).toBeTruthy()
    })
    expect(assertProfileScopedSql('SELECT * FROM grants')).toBeTruthy()
  })
})

describe('layer 2 — ensureProfileAccess (the route-level profile gate)', () => {
  function appWithGate(db, { user, ctx } = {}) {
    const app = express()
    app.use((req, _res, next) => {
      if (user) { req.user = user; req.ctx = ctx }
      req.db = db
      next()
    })
    app.get('/profiles/:id/secret', ensureProfileAccess('id'), (_req, res) => res.json({ ok: true }))
    return app
  }

  it('tenant A is DENIED tenant B\'s profile (403), admitted to its own (200)', async () => {
    const db = createDb()
    const app = appWithGate(db, { user: { id: 'uA', role: 'user' }, ctx: CTX_A })
    expect((await request(app).get('/profiles/pB/secret')).status).toBe(403)
    expect((await request(app).get('/profiles/pA/secret')).status).toBe(200)
  })

  it('unauthenticated is 401; admin crosses tenants by design', async () => {
    const db = createDb()
    expect((await request(appWithGate(db, {})).get('/profiles/pA/secret')).status).toBe(401)
    const adminApp = appWithGate(db, { user: { id: 'admin', role: 'admin' }, ctx: { userId: 'admin', isAdmin: true } })
    expect((await request(adminApp).get('/profiles/pB/secret')).status).toBe(200)
  })
})

describe('layer 3 — ensureGrantAccess (the grant gate)', () => {
  function fakeRes() {
    const res = { statusCode: null, body: null }
    res.status = (c) => { res.statusCode = c; return res }
    res.json = (b) => { res.body = b; return res }
    return res
  }

  it('tenant A cannot reach tenant B\'s grant; reaches its own', async () => {
    const db = createDb()
    const reqA = { db, user: { id: 'uA', role: 'user' }, ctx: CTX_A }
    const denied = await ensureGrantAccess(reqA, fakeRes(), 'gB')
    expect(denied).toBeNull()
    const admitted = await ensureGrantAccess(reqA, fakeRes(), 'gA')
    expect(admitted?.id).toBe('gA')
  })
})

describe('layer 4 — end to end through a real mounted router (milestones)', () => {
  function appFor(db, { user, ctx } = {}) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (user) { req.user = user; req.ctx = ctx }
      req.db = db
      next()
    })
    app.use('/api/milestones', milestonesRouter)
    return app
  }

  it('tenant A\'s milestone list NEVER contains tenant B\'s rows', async () => {
    const db = createDb()
    const res = await request(appFor(db, { user: { id: 'uA', role: 'user' }, ctx: CTX_A })).get('/api/milestones')
    expect(res.status).toBe(200)
    const rows = Array.isArray(res.body) ? res.body : res.body?.milestones ?? []
    const ids = rows.map((r) => r.id)
    expect(ids).not.toContain('mB')
  })

  it('tenant A cannot read tenant B\'s milestone by id', async () => {
    const db = createDb()
    const res = await request(appFor(db, { user: { id: 'uA', role: 'user' }, ctx: CTX_A })).get('/api/milestones/mB')
    expect([403, 404]).toContain(res.status)
  })

  it('tenant B still sees its own row (the gate blocks, it does not blind)', async () => {
    const db = createDb()
    const res = await request(appFor(db, { user: { id: 'uB', role: 'user' }, ctx: CTX_B })).get('/api/milestones/mB')
    expect(res.status).toBe(200)
    expect(res.body?.id ?? res.body?.milestone?.id).toBe('mB')
  })
})
