/**
 * Hamilton automation route auth + profile-scope regression tests.
 *
 * These lock the fix for the LAST_72H_MISSION_AUDIT finding: a block of
 * Hamilton routes (payment-authorizations, sessions, attestations,
 * resolved-fields, portal-policies, and the :id revoke surfaces) trusted a
 * caller-supplied profileId without verifying authentication or profile
 * access — allowing unauthenticated reads and cross-profile mutation of
 * another user's automation authorization state.
 *
 * We mount the real router on a bare express app, inject req.db (in-memory
 * SQLite) and req.user via a tiny test-auth middleware (driven by an
 * x-test-user header), and assert:
 *   - unauthenticated reads are rejected (401)
 *   - a user cannot read OR mutate another profile's records (403)
 *   - a user CAN operate on their own profile (200)
 *   - a cross-profile revoke leaves the target record untouched
 *   - portal-policy writes are restricted to the canonical admin (403/200)
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'

import hamiltonRouter from '../../backend/routes/hamiltonAutomation.js'
import { recordSession } from '../../backend/services/hamilton/hamiltonCredentialSessionService.js'
import { attachRequestContext } from '../../backend/middleware/requestContext.js'

// Two users, each owning one profile.
const USERS = {
  'u-A': { id: 'u-A', role: 'user', email: 'a@test.com' },
  'u-B': { id: 'u-B', role: 'user', email: 'b@test.com' },
  'u-admin': { id: 'u-admin', role: 'user', email: 'buckeye7066@gmail.com' },
  // Demoted admin: the JWT still claims role:'admin' but users.is_admin=0.
  'u-demoted': { id: 'u-demoted', role: 'admin', is_admin: true, roles: ['admin'], email: 'demoted@test.com' },
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0, role TEXT);
    INSERT INTO profiles (id, user_id, display_name) VALUES ('p-A', 'u-A', 'Profile A');
    INSERT INTO profiles (id, user_id, display_name) VALUES ('p-B', 'u-B', 'Profile B');
    INSERT INTO users (id, primary_email, is_admin, role) VALUES ('u-A', 'a@test.com', 0, 'user');
    INSERT INTO users (id, primary_email, is_admin, role) VALUES ('u-B', 'b@test.com', 0, 'user');
    -- The canonical admin is DB-backed (users.is_admin), NOT a token/email claim.
    INSERT INTO users (id, primary_email, is_admin, role) VALUES ('u-admin', 'buckeye7066@gmail.com', 1, 'admin');
    -- Demoted admin: DB says NOT admin even though the JWT still claims role:'admin'.
    INSERT INTO users (id, primary_email, is_admin, role) VALUES ('u-demoted', 'demoted@test.com', 0, 'user');
  `)
  return db
}

function makeApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    const who = req.headers['x-test-user']
    if (who && USERS[who]) req.user = USERS[who]
    next()
  })
  // Mirror production: attachRequestContext resolves the DB-backed req.ctx
  // (isAdmin, accessible sets) that the routes now authorize against.
  app.use(attachRequestContext())
  app.use('/api/hamilton/automation', hamiltonRouter)
  return app
}

describe('Hamilton route auth + profile scoping', () => {
  let db
  let app
  let sessionA // a saved session owned by profile A

  before(async () => {
    db = makeDb()
    app = makeApp(db)
    // Seed a saved session owned by profile A directly via the store, so we
    // can attempt cross-profile revokes against a real row.
    sessionA = await recordSession(db, {
      userId: 'u-A',
      profileId: 'p-A',
      portalHost: 'grants.example.gov',
      storageStateRef: 'ref://A',
    })
    assert.ok(sessionA?.id, 'seed session for profile A')
  })

  it('rejects unauthenticated reads of profile-scoped session list (401)', async () => {
    const res = await request(app).get('/api/hamilton/automation/sessions?profileId=p-A')
    assert.equal(res.status, 401)
  })

  it('forbids reading another profile\'s sessions (403)', async () => {
    const res = await request(app)
      .get('/api/hamilton/automation/sessions?profileId=p-A')
      .set('x-test-user', 'u-B')
    assert.equal(res.status, 403)
  })

  it('allows reading own profile sessions (200)', async () => {
    const res = await request(app)
      .get('/api/hamilton/automation/sessions?profileId=p-A')
      .set('x-test-user', 'u-A')
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.ok(Array.isArray(res.body.sessions))
  })

  it('forbids cross-profile session revoke and leaves the row intact (403)', async () => {
    const res = await request(app)
      .post(`/api/hamilton/automation/sessions/${sessionA.id}/revoke`)
      .set('x-test-user', 'u-B')
      .send({ reason: 'malicious' })
    assert.equal(res.status, 403)
    // The target session must NOT have been revoked.
    const row = db.prepare('SELECT status FROM hamilton_saved_sessions WHERE id = ?').get(sessionA.id)
    assert.notEqual(row.status, 'revoked')
  })

  it('rejects unauthenticated payment-authorization reads (401)', async () => {
    const res = await request(app).get('/api/hamilton/automation/payment-authorizations?profileId=p-A')
    assert.equal(res.status, 401)
  })

  it('forbids creating a payment authorization on another profile (403)', async () => {
    const res = await request(app)
      .post('/api/hamilton/automation/payment-authorizations')
      .set('x-test-user', 'u-B')
      .send({ profileId: 'p-A', category: 'application_fee', maxAmountCents: 5000, authorizationText: 'x' })
    assert.equal(res.status, 403)
  })

  it('forbids reading another profile\'s resolved fields (403)', async () => {
    const res = await request(app)
      .get('/api/hamilton/automation/resolved-fields?profileId=p-A')
      .set('x-test-user', 'u-B')
    assert.equal(res.status, 403)
  })

  it('a demoted admin (role:admin JWT, users.is_admin=0) cannot read another profile\'s sessions (403)', async () => {
    const res = await request(app)
      .get('/api/hamilton/automation/sessions?profileId=p-A')
      .set('x-test-user', 'u-demoted')
    assert.equal(res.status, 403)
  })

  it('a demoted admin cannot cross-profile revoke a session (403, row intact)', async () => {
    const res = await request(app)
      .post(`/api/hamilton/automation/sessions/${sessionA.id}/revoke`)
      .set('x-test-user', 'u-demoted')
      .send({ reason: 'stale token' })
    assert.equal(res.status, 403)
    const row = db.prepare('SELECT status FROM hamilton_saved_sessions WHERE id = ?').get(sessionA.id)
    assert.notEqual(row.status, 'revoked')
  })

  it('restricts portal-policy writes to the canonical admin', async () => {
    const nonAdmin = await request(app)
      .post('/api/hamilton/automation/portal-policies')
      .set('x-test-user', 'u-A')
      .send({ portalHost: 'evil.example.com', automationAllowed: true })
    assert.equal(nonAdmin.status, 403)

    const admin = await request(app)
      .post('/api/hamilton/automation/portal-policies')
      .set('x-test-user', 'u-admin')
      .send({ portalHost: 'grants.example.gov', automationAllowed: true })
    assert.equal(admin.status, 200)
  })
})

// REGRESSION: the auth middleware writes the canonical user id as
// `req.user.userId` (JWT `sub` claim), never `req.user.id`. The Hamilton
// authorize route used to read `user.id` directly when calling
// recordAuthorizations, which produced "userId required" → 500 →
// {error: 'authorize_failed'} → the modal showed the literal string
// "authorize_failed" to the user. We resolve via getAuthUserId() now; this
// regression mounts the real router with a JWT-shaped req.user (userId only,
// no id) and asserts the authorize call succeeds.
describe('Hamilton authorize route — JWT-shaped req.user with userId-only', () => {
  it('accepts a JWT-shaped user (userId, no id) and records the authorization', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0, role TEXT);
      INSERT INTO profiles (id, user_id, display_name) VALUES ('p-jwt', 'u-jwt', 'JWT Profile');
      INSERT INTO users (id, primary_email, is_admin, role) VALUES ('u-jwt', 'jwt@test.com', 0, 'user');
    `)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.db = db
      // EXACTLY the shape backend/server.js builds for a JWT token: userId,
      // never id. This is the production path for every signed-in user.
      req.user = {
        role: 'user',
        is_admin: false,
        userId: 'u-jwt',
        profileId: null,
        sessionId: 'sess-jwt',
        full_name: 'JWT User',
        email: 'jwt@test.com',
        roles: [],
      }
      next()
    })
    app.use('/api/hamilton/automation', hamiltonRouter)

    const res = await request(app)
      .post('/api/hamilton/automation/authorize')
      .send({
        profile_id: 'p-jwt',
        scope: 'funding_source',
        funding_source_ids: ['opp-1'],
        authorization_types: ['complete_forms', 'upload_documents'],
        authorization_text: 'test authorization text',
        authorization_version: 'hamilton-autopilot-v1',
        options: { complete_forms: true },
      })
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.ok, true)
    assert.ok(Array.isArray(res.body.authorization_ids))
    assert.equal(res.body.authorization_ids.length, 2, 'two authorization rows for two types')
  })

  it('returns a friendly 401 when the auth context has no user id at all', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0, role TEXT);
      INSERT INTO profiles (id, user_id, display_name) VALUES ('p-x', 'u-x', 'X');
    `)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.db = db
      // Pathological middleware: marks user as authenticated but supplies no
      // id field at all. We must NOT 500 here.
      req.user = { role: 'user', email: 'lost@test.com' }
      next()
    })
    app.use('/api/hamilton/automation', hamiltonRouter)

    const res = await request(app)
      .post('/api/hamilton/automation/authorize')
      .send({
        profile_id: 'p-x',
        scope: 'funding_source',
        funding_source_ids: ['opp-1'],
        authorization_types: ['complete_forms'],
      })
    assert.equal(res.status, 401)
    assert.equal(res.body.error, 'session_invalid')
    assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0)
  })

  it('error responses include a human-readable `message` (not just an error code)', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0, role TEXT);
      INSERT INTO profiles (id, user_id, display_name) VALUES ('p-z', 'u-z', 'Z');
      -- u-z must exist as a real users row (a deleted user gets no profile access).
      INSERT INTO users (id, primary_email, is_admin, role) VALUES ('u-z', 'z@test.com', 0, 'user');
    `)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.db = db
      req.user = { role: 'user', userId: 'u-z' }
      next()
    })
    app.use('/api/hamilton/automation', hamiltonRouter)

    // Empty authorization_types triggers the 400 — assert the message field
    // is set so the frontend never has to render the raw error code.
    const res = await request(app)
      .post('/api/hamilton/automation/authorize')
      .send({
        profile_id: 'p-z',
        scope: 'funding_source',
        funding_source_ids: ['opp-1'],
        authorization_types: [],
      })
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'authorization_types_required')
    assert.ok(
      typeof res.body.message === 'string' && res.body.message.length > 0,
      'response must include a friendly `message` so the modal does not display the raw error token',
    )
  })
})
