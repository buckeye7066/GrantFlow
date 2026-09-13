/**
 * Tracker "Mark Submitted" on a Hamilton card (hamilton-submit-9, 2026-09-12).
 *
 * POST /api/grant-applications/:taskId/submit flipped application_tasks to
 * status='submitted' with NOTHING attached — the likely origin of the 44
 * production rows that read "submitted" while the durable-confirmation count
 * is 0. The canonical predicate already labels them INTERNAL_ONLY on the task
 * read path, but the tracker payload never carried that label, so a bare
 * status flip READ as a confirmed submission on the board.
 *
 * Pins:
 *   1. The POST response and the tracker list carry `submission_proof` for a
 *      Hamilton card, and a bare Mark Submitted reads
 *      state 'marked_submitted_internal' / verified_external false.
 *   2. The stored task self-describes: current_step 'marked_submitted_internal',
 *      and the attestation event records evidence 'none'.
 *   3. A Hamilton card with a real submitted run + retrievable confirmation
 *      document reads verified_external true through the same payload.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const grantAppsRouter = (await import('../routes/grantApplications.js')).default
const {
  ensureApplicationTask, getApplicationTask, listTaskEvents, updateApplicationTask, _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { SUBMISSION_PROOF_STATE } = await import('../services/hamilton/submissionProofPredicate.js')

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
    CREATE TABLE documents (id TEXT PRIMARY KEY, profile_id TEXT, name TEXT, type TEXT, file_bytes BLOB, file_path TEXT);
    CREATE TABLE hamilton_autopilot_runs (
      id TEXT PRIMARY KEY, task_id TEXT, profile_id TEXT, status TEXT,
      confirmation_reference TEXT, confirmation_screenshot_path TEXT, result_json TEXT DEFAULT '{}'
    );
    INSERT INTO users (id, primary_email) VALUES ('u-1', 'one@x.example');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES ('p-1', 'u-1', 'u-1', 'Robert');
    INSERT INTO funding_opportunities (id, title, sponsor) VALUES ('opp-1', 'TMEF Medical Education Scholarships', 'TMEF');
    INSERT INTO funding_opportunities (id, title, sponsor) VALUES ('opp-2', 'U.S. Bank Scholarship', 'U.S. Bank');
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

describe('hamilton-submit-9: Mark Submitted is labeled internal-only unless proof is bound', () => {
  let db
  beforeEach(() => {
    _resetSchemaCache()
    db = makeDb()
  })

  it('a bare Mark Submitted returns (and lists) an INTERNAL_ONLY proof label, never a confirmed submission', async () => {
    const task = await ensureApplicationTask(db, { profileId: 'p-1', userId: 'u-1', opportunityId: 'opp-1', initialStatus: 'queued' })
    const app = appWith(db, USER)

    const res = await request(app).post(`/api/grant-applications/${task.id}/submit`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('submitted')
    expect(res.body.source).toBe('hamilton')
    expect(res.body.submission_proof).toBeTruthy()
    expect(res.body.submission_proof.verified_external).toBe(false)
    expect(res.body.submission_proof.state).toBe(SUBMISSION_PROOF_STATE.INTERNAL_ONLY)
    expect(res.body.submission_proof.label).toMatch(/internal record/i)
    expect(res.body.submission_proof.unverified_reason).toBe('no_run_no_confirmation_doc')

    const list = await request(app).get('/api/grant-applications')
    const card = list.body.find((r) => r.id === task.id)
    expect(card.status).toBe('submitted')
    expect(card.submission_proof.verified_external).toBe(false)
    expect(card.submission_proof.state).toBe(SUBMISSION_PROOF_STATE.INTERNAL_ONLY)

    const stored = await getApplicationTask(db, task.id)
    expect(stored.current_step).toBe('marked_submitted_internal')
    const events = await listTaskEvents(db, task.id)
    const ev = events.find((e) => e.event_type === 'submitted')
    expect(ev.details?.manual_submit).toBe(true)
    expect(ev.details?.evidence).toBe('none')
    expect(ev.details?.internal_record).toBe(true)
  })

  it('a Hamilton card backed by a submitted run with a retrievable confirmation document reads VERIFIED through the same payload', async () => {
    const task = await ensureApplicationTask(db, { profileId: 'p-1', userId: 'u-1', opportunityId: 'opp-2', initialStatus: 'queued' })
    db.prepare("INSERT INTO documents (id, profile_id, name, type, file_bytes) VALUES ('conf-1', 'p-1', 'confirmation', 'hamilton_submission_confirmation', ?)")
      .run(Buffer.from('png-bytes'))
    db.prepare(`INSERT INTO hamilton_autopilot_runs (id, task_id, profile_id, status, confirmation_reference, result_json)
      VALUES ('run-1', ?, 'p-1', 'submitted', 'USB-2026-4471', ?)`)
      .run(task.id, JSON.stringify({
        confirmation_evidence: 'portal_reference', confirmation_reference: 'USB-2026-4471',
        confirmation_reference_is_new: true, confirmation_document_id: 'conf-1',
      }))
    await updateApplicationTask(db, task.id, {
      status: 'submitted', submittedAt: new Date().toISOString(), completedAt: new Date().toISOString(), outputDocumentId: 'conf-1',
    })

    const list = await request(appWith(db, USER)).get('/api/grant-applications')
    const card = list.body.find((r) => r.id === task.id)
    expect(card.status).toBe('submitted')
    expect(card.submission_proof.verified_external).toBe(true)
    expect(card.submission_proof.state).toBe(SUBMISSION_PROOF_STATE.VERIFIED_EXTERNAL)
    expect(card.submission_proof.confirmation_reference).toBe('USB-2026-4471')
  })

  it('a non-submitted Hamilton card carries a not_submitted stub (no proof claim either way)', async () => {
    const task = await ensureApplicationTask(db, { profileId: 'p-1', userId: 'u-1', opportunityId: 'opp-1', initialStatus: 'queued' })
    const list = await request(appWith(db, USER)).get('/api/grant-applications')
    const card = list.body.find((r) => r.id === task.id)
    expect(card.status).toBe('in_progress')
    expect(card.submission_proof.verified_external).toBe(false)
    expect(card.submission_proof.state).toBe(SUBMISSION_PROOF_STATE.NOT_SUBMITTED)
  })
})
