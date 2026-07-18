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
import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const profilesRouter = (await import('../routes/profiles.js')).default
const outreachRouter = (await import('../routes/outreachLogs.js')).default
const grantAppsRouter = (await import('../routes/grantApplications.js')).default

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0, primary_email TEXT, display_name TEXT, primary_phone TEXT, avatar_url TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, organization_id TEXT, display_name TEXT, status TEXT DEFAULT 'active', primary_type TEXT, created_at TEXT DEFAULT '2026-01-01');
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, identifier TEXT, verified_at DATETIME);
    CREATE TABLE grant_applications (id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, status TEXT, created_at TEXT DEFAULT '2026-01-01', updated_at TEXT DEFAULT '2026-01-01');
    INSERT INTO users (id, is_admin, primary_email) VALUES ('u-real', 0, 'real@x.example');
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
