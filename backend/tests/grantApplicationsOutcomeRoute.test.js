/**
 * POST /api/grant-applications/:id/outcome — legacy unaudited result reports.
 *
 * A button click is not proof of a funder decision. The legacy endpoint must
 * never move an application/pipeline into a terminal state or count funds
 * secured without the durable, exact-profile evidence enforced by the canonical
 * lifecycle endpoint. These tests also retain the cross-tenant pointer guards.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../services/hamilton/applicationTaskStore.js', () => ({
  updateApplicationTask: vi.fn(),
  appendTaskEvent: vi.fn(),
  _resetSchemaCache: vi.fn(),
}))

const Database = (await import('better-sqlite3')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const grantAppsRouter = (await import('../routes/grantApplications.js')).default
const _resetSchemaCache = vi.fn()

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0, primary_email TEXT, display_name TEXT, primary_phone TEXT, avatar_url TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, organization_id TEXT, display_name TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT '2026-01-01');
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, identifier TEXT, verified_at DATETIME);
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, pipeline_grant_id TEXT, user_id TEXT,
      status TEXT, title TEXT, grant_name TEXT, funder_name TEXT,
      amount_requested REAL, amount_awarded REAL, deadline_date TEXT,
      submitted_at TEXT, response_expected_date TEXT, response_received_at TEXT,
      notes TEXT, contact_name TEXT, contact_email TEXT,
      created_at TEXT DEFAULT '2026-01-01', updated_at TEXT DEFAULT '2026-01-01'
    );
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, sponsor TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT,
      title TEXT, funder TEXT, status TEXT DEFAULT 'submitted',
      amount_requested REAL, amount_awarded REAL, submitted_date TEXT, award_date TEXT,
      updated_at TEXT DEFAULT '2026-01-01'
    );
    INSERT INTO users (id, primary_email) VALUES
      ('u-1', 'one@x.example'),
      ('u-2', 'two@x.example');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-1', 'u-1', 'u-1', 'Robert');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-2', 'u-2', 'u-2', 'Other tenant');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-3', 'u-1', 'u-1', 'Second authorized profile');
    INSERT INTO funding_opportunities (id, title, sponsor) VALUES
      ('opp-1', 'TMEF Scholarship', 'TMEF'),
      ('opp-2', 'Private Tenant Program', 'Other Funder'),
      ('opp-3', 'Second Profile Program', 'Shared User Funder');
    INSERT INTO grants (id, profile_id, funding_opportunity_id, title, funder, status) VALUES
      ('g-1', 'p-1', 'opp-1', 'TMEF Scholarship', 'TMEF', 'submitted'),
      ('g-2', 'p-2', 'opp-2', 'Private Tenant Program', 'Other Funder', 'submitted'),
      ('g-3', 'p-3', 'opp-3', 'Second Profile Program', 'Shared User Funder', 'submitted');
    INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name, pipeline_grant_id)
      VALUES ('ga-1', 'p-1', 'u-1', 'submitted', 'TMEF Scholarship', 'g-1');
    INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name, pipeline_grant_id)
      VALUES ('ga-orphan', 'p-1', 'u-1', 'submitted', 'Unlinked application', NULL);
    INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name, pipeline_grant_id)
      VALUES ('ga-cross-grant', 'p-1', 'u-1', 'submitted', 'Poisoned link', 'g-2');
    INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name, pipeline_grant_id)
      VALUES ('ga-wrong-accessible-grant', 'p-1', 'u-1', 'submitted', 'Wrong accessible link', 'g-3');
    INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name, pipeline_grant_id)
      VALUES ('ga-cross-profile', 'p-2', 'u-1', 'submitted', 'Spoofed owner', NULL);
  `)
  return db
}

function appWith(db, user) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.db = db; req.user = user; next() })
  app.use(attachRequestContext())
  app.use('/api/grant-applications', grantAppsRouter)
  return app
}

const USER = { role: 'user', userId: 'u-1' }

describe('POST /api/grant-applications/:id/outcome', () => {
  let db
  beforeEach(() => {
    _resetSchemaCache()
    db = makeDb()
  })

  it('refuses to mark an award or funds secured without durable outcome evidence', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-1/outcome')
      .send({ outcome: 'awarded', amount_awarded: 5000 })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('OUTCOME_EVIDENCE_REQUIRED')
    expect(res.body.lifecycle_url).toBe('/GrantLifecycle/ga-1')

    const grant = db.prepare('SELECT status, amount_awarded, award_date FROM grants WHERE id = ?').get('g-1')
    expect(grant.status).toBe('submitted')
    expect(grant.amount_awarded).toBeNull()
    expect(grant.award_date).toBeNull()
    expect(db.prepare('SELECT status, amount_awarded FROM grant_applications WHERE id = ?').get('ga-1'))
      .toMatchObject({ status: 'submitted', amount_awarded: null })
  })

  it('refuses to mark a denial without durable outcome evidence', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-1/outcome')
      .send({ outcome: 'denied' })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('OUTCOME_EVIDENCE_REQUIRED')
    const grant = db.prepare('SELECT status, amount_awarded, award_date FROM grants WHERE id = ?').get('g-1')
    expect(grant.status).toBe('submitted')
    expect(grant.amount_awarded).toBeNull()
    expect(grant.award_date).toBeNull()
  })

  it('also requires evidence when no pipeline grant is linked', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-orphan/outcome')
      .send({ outcome: 'awarded', amount_awarded: 250 })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('OUTCOME_EVIDENCE_REQUIRED')

    const row = db.prepare('SELECT status, amount_awarded FROM grant_applications WHERE id = ?').get('ga-orphan')
    expect(row.status).toBe('submitted')
    expect(row.amount_awarded).toBeNull()
  })

  it('rejects an outcome value that is not awarded or denied', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-1/outcome')
      .send({ outcome: 'maybe' })

    expect(res.status).toBe(400)
    const grant = db.prepare('SELECT status FROM grants WHERE id = ?').get('g-1')
    expect(grant.status).toBe('submitted')
  })

  it('rejects a poisoned cross-tenant grant link before mutating either row', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-cross-grant/outcome')
      .send({ outcome: 'awarded', amount_awarded: 99_999 })

    expect(res.status).toBe(403)
    expect(db.prepare('SELECT status, amount_awarded FROM grant_applications WHERE id = ?').get('ga-cross-grant'))
      .toMatchObject({ status: 'submitted', amount_awarded: null })
    expect(db.prepare('SELECT status, amount_awarded FROM grants WHERE id = ?').get('g-2'))
      .toMatchObject({ status: 'submitted', amount_awarded: null })
  })

  it('does not treat legacy user_id ownership as profile authorization', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-cross-profile/outcome')
      .send({ outcome: 'denied' })

    expect(res.status).toBe(403)
    expect(db.prepare('SELECT status FROM grant_applications WHERE id = ?').get('ga-cross-profile').status)
      .toBe('submitted')
  })

  it('rejects a linked grant from another profile even when the user can access both', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-wrong-accessible-grant/outcome')
      .send({ outcome: 'awarded', amount_awarded: 1_000 })

    expect(res.status).toBe(403)
    expect(db.prepare('SELECT status FROM grant_applications WHERE id = ?').get('ga-wrong-accessible-grant').status)
      .toBe('submitted')
    expect(db.prepare('SELECT status FROM grants WHERE id = ?').get('g-3').status).toBe('submitted')
  })
})

describe('POST /api/grant-applications tenant-scoped references', () => {
  let db
  beforeEach(() => {
    _resetSchemaCache()
    db = makeDb()
  })

  it('rejects a pipeline grant from another tenant', async () => {
    const foreignTenant = await request(appWith(db, USER))
      .post('/api/grant-applications')
      .send({ profile_id: 'p-1', pipeline_grant_id: 'g-2', grant_name: 'Attack' })
    const wrongAccessibleProfile = await request(appWith(db, USER))
      .post('/api/grant-applications')
      .send({ profile_id: 'p-1', pipeline_grant_id: 'g-3', grant_name: 'Cross profile' })

    expect(foreignTenant.status).toBe(403)
    expect(wrongAccessibleProfile.status).toBe(403)
    expect(db.prepare("SELECT COUNT(*) AS count FROM grant_applications WHERE grant_name IN ('Attack', 'Cross profile')").get().count).toBe(0)
  })

  it('rejects an opportunity that does not match the submitted profile/grant', async () => {
    const mismatchedPair = await request(appWith(db, USER))
      .post('/api/grant-applications')
      .send({
        profile_id: 'p-1',
        pipeline_grant_id: 'g-1',
        opportunity_id: 'opp-2',
        grant_name: 'Mismatched pair',
      })
    const unscopedOpportunity = await request(appWith(db, USER))
      .post('/api/grant-applications')
      .send({ profile_id: 'p-1', opportunity_id: 'opp-2', grant_name: 'Unscoped opportunity' })

    expect(mismatchedPair.status).toBe(403)
    expect(unscopedOpportunity.status).toBe(403)
    expect(db.prepare("SELECT COUNT(*) AS count FROM grant_applications WHERE grant_name IN ('Mismatched pair', 'Unscoped opportunity')").get().count).toBe(0)
  })

  it('accepts exact-profile references and derives the grant opportunity when omitted', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications')
      .send({ profile_id: 'p-1', pipeline_grant_id: 'g-1', grant_name: 'Legitimate application' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      profile_id: 'p-1',
      pipeline_grant_id: 'g-1',
      opportunity_id: 'opp-1',
    })
  })
})
