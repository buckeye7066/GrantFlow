/**
 * POST /api/grant-applications/:id/outcome — recording a funder decision.
 *
 * This is the terminal leg of find -> apply -> submit -> confirmed. The route
 * wrote the outcome onto grant_applications only and never touched the linked
 * pipeline grant, despite holding pipeline_grant_id. Consequences in production:
 * the pipeline card stayed in its pre-decision stage, grants.award_date was
 * never set by anything at all, and the "funds secured" rollup (which sums
 * grants.amount_awarded) could not move even after a user reported an award.
 *
 * These tests assert the propagation by reading the grants row back, so a
 * regression that silently stops syncing fails here rather than showing up as a
 * permanently empty outcome report.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const grantAppsRouter = (await import('../routes/grantApplications.js')).default
const { _resetSchemaCache } = await import('../services/hamilton/applicationTaskStore.js')

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
      id TEXT PRIMARY KEY, title TEXT, funder TEXT, status TEXT DEFAULT 'submitted',
      amount_requested REAL, amount_awarded REAL, submitted_date TEXT, award_date TEXT,
      updated_at TEXT DEFAULT '2026-01-01'
    );
    INSERT INTO users (id, primary_email) VALUES ('u-1', 'one@x.example');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-1', 'u-1', 'u-1', 'Robert');
    INSERT INTO grants (id, title, funder, status) VALUES ('g-1', 'TMEF Scholarship', 'TMEF', 'submitted');
    INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name, pipeline_grant_id)
      VALUES ('ga-1', 'p-1', 'u-1', 'submitted', 'TMEF Scholarship', 'g-1');
    INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name, pipeline_grant_id)
      VALUES ('ga-orphan', 'p-1', 'u-1', 'submitted', 'Unlinked application', NULL);
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

  it('records an award on the linked pipeline grant, with amount and date', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-1/outcome')
      .send({ outcome: 'awarded', amount_awarded: 5000 })

    expect(res.status).toBe(200)
    expect(res.body.pipeline_grant_updated).toBe(true)

    const grant = db.prepare('SELECT status, amount_awarded, award_date FROM grants WHERE id = ?').get('g-1')
    expect(grant.status).toBe('awarded')
    expect(grant.amount_awarded).toBe(5000)
    // award_date was previously unwritable by ANY code path, which is what made
    // "time to award" structurally always empty.
    expect(grant.award_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('maps a denial to the grant pipeline as declined without inventing an award', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-1/outcome')
      .send({ outcome: 'denied' })

    expect(res.status).toBe(200)
    const grant = db.prepare('SELECT status, amount_awarded, award_date FROM grants WHERE id = ?').get('g-1')
    expect(grant.status).toBe('declined')
    expect(grant.amount_awarded).toBeNull()
    expect(grant.award_date).toBeNull()
  })

  it('still records the outcome when no pipeline grant is linked', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-orphan/outcome')
      .send({ outcome: 'awarded', amount_awarded: 250 })

    expect(res.status).toBe(200)
    expect(res.body.pipeline_grant_updated).toBe(false)
    expect(res.body.pipeline_grant_error).toBeNull()

    const row = db.prepare('SELECT status, amount_awarded FROM grant_applications WHERE id = ?').get('ga-orphan')
    expect(row.status).toBe('awarded')
    expect(row.amount_awarded).toBe(250)
  })

  it('rejects an outcome value that is not awarded or denied', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-1/outcome')
      .send({ outcome: 'maybe' })

    expect(res.status).toBe(400)
    const grant = db.prepare('SELECT status FROM grants WHERE id = ?').get('g-1')
    expect(grant.status).toBe('submitted')
  })
})
