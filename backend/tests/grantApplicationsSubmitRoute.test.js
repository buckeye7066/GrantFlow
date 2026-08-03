/**
 * POST /api/grant-applications/:id/submit — "Mark Submitted".
 *
 * Regression: the tracker's list endpoint merges Hamilton's application_tasks
 * rows (source 'hamilton') alongside manual grant_applications rows, using the
 * TASK id as the card id. The submit handler only looked up grant_applications,
 * so "Mark Submitted" on any Hamilton card returned 404 ("Not found") and the
 * application stayed In Progress — hit in production on two Hamilton-worked
 * scholarship applications.
 *
 * The fix: when the id has no grant_applications row, resolve it against
 * application_tasks (same user scoping the list used to SHOW the card) and mark
 * the task submitted with a persisted submitted_at (mapHamiltonStatus requires
 * both before it presents 'submitted').
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const grantAppsRouter = (await import('../routes/grantApplications.js')).default
const {
  ensureApplicationTask,
  getApplicationTask,
  listTaskEvents,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')

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
    CREATE TABLE grants (id TEXT PRIMARY KEY, title TEXT, funder TEXT);
    INSERT INTO users (id, primary_email) VALUES ('u-1', 'one@x.example');
    INSERT INTO users (id, primary_email) VALUES ('u-2', 'two@x.example');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-1', 'u-1', 'u-1', 'Robert');
    INSERT INTO funding_opportunities (id, title, sponsor) VALUES ('opp-1', 'TMEF Medical Education Scholarships', 'TMEF');
    INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name)
      VALUES ('ga-1', 'p-1', 'u-1', 'in_progress', 'Manual application');
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
const OTHER = { role: 'user', userId: 'u-2' }

async function makeHamiltonTask(db, overrides = {}) {
  return await ensureApplicationTask(db, {
    profileId: 'p-1',
    userId: 'u-1',
    opportunityId: 'opp-1',
    initialStatus: 'queued',
    ...overrides,
  })
}

describe('POST /api/grant-applications/:id/submit', () => {
  let db
  beforeEach(() => {
    _resetSchemaCache()
    db = makeDb()
  })

  it('marks a manual grant_applications row submitted with a submitted_at', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/ga-1/submit')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('submitted')
    expect(res.body.submitted_at).toBeTruthy()

    const row = db.prepare('SELECT status, submitted_at FROM grant_applications WHERE id = ?').get('ga-1')
    expect(row.status).toBe('submitted')
    expect(row.submitted_at).toBeTruthy()
  })

  it('REGRESSION: marks a Hamilton application_tasks card submitted instead of 404ing', async () => {
    const task = await makeHamiltonTask(db)

    const res = await request(appWith(db, USER))
      .post(`/api/grant-applications/${task.id}/submit`)
    expect(res.status).toBe(200) // was 404 "Not found" — the reported bug
    expect(res.body.status).toBe('submitted')
    expect(res.body.source).toBe('hamilton')
    expect(res.body.submitted_at).toBeTruthy()

    // Honesty invariant: 'submitted' requires BOTH the status and a persisted
    // submitted_at (mapHamiltonStatus demotes submitted-with-NULL-date).
    const stored = await getApplicationTask(db, task.id)
    expect(stored.status).toBe('submitted')
    expect(stored.submitted_at).toBeTruthy()

    // The user's attestation is recorded as a task event with actor identity.
    const events = await listTaskEvents(db, task.id)
    const submittedEvent = events.find((e) => e.event_type === 'submitted')
    expect(submittedEvent).toBeTruthy()
    expect(submittedEvent.actor_user_id).toBe('u-1')
  })

  it('the tracker list then shows the Hamilton card as submitted', async () => {
    const task = await makeHamiltonTask(db)
    const app = appWith(db, USER)

    await request(app).post(`/api/grant-applications/${task.id}/submit`).expect(200)

    const list = await request(app).get('/api/grant-applications')
    expect(list.status).toBe(200)
    const card = list.body.find((r) => r.id === task.id)
    expect(card).toBeTruthy()
    expect(card.status).toBe('submitted')
  })

  it("404s on another user's Hamilton task (not visible in that user's tracker)", async () => {
    const task = await makeHamiltonTask(db)

    const res = await request(appWith(db, OTHER))
      .post(`/api/grant-applications/${task.id}/submit`)
    expect(res.status).toBe(404)

    const stored = await getApplicationTask(db, task.id)
    expect(stored.status).not.toBe('submitted')
  })

  it('still 404s on an id that exists nowhere', async () => {
    const res = await request(appWith(db, USER))
      .post('/api/grant-applications/no-such-id/submit')
    expect(res.status).toBe(404)
  })
})
