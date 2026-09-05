/**
 * Owner order 2026-09-05 ("Hamilton needs to be able to submit to portal e2e").
 * Prod that day: five of six re-selected MTSU/TSAC rows never ran because their
 * tasks had ended `completed` as research leads ("found no application form",
 * a listing decomposition) and the launch transition refused a terminal state
 * — "Hamilton did not start because the task moved to protected state
 * completed". A close with NO portal confirmation is not a finished
 * application; a deliberate re-run re-opens it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  ensureApplicationTask,
  updateApplicationTask,
  REOPENABLE_CLOSED_STATUSES,
  _resetSchemaCache,
} from '../services/hamilton/applicationTaskStore.js'
import { ensureHamiltonAuthorizationSchema, createAutopilotRun, updateAutopilotRun, _resetAuthSchemaCache } from '../services/hamilton/hamiltonAuthorizationStore.js'

const PROFILE = 'profile-reopen'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, description TEXT,
      opportunity_kind TEXT, application_url TEXT, apply_url TEXT,
      source_url TEXT, url TEXT, evidence_url TEXT, record_origin TEXT,
      source TEXT, source_trust_tier TEXT, reality_status TEXT, is_active INTEGER,
      need_types_supported TEXT, categories TEXT, link_status TEXT,
      last_verified_at TEXT, state TEXT, is_national INTEGER
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      match_score REAL, match_decision TEXT, match_explanation TEXT,
      matcher_version TEXT, updated_at TEXT, computed_at TEXT
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, profile_id TEXT, grant_id TEXT, name TEXT, type TEXT,
      file_path TEXT, file_bytes BLOB, mime_type TEXT, created_at TEXT
    );
  `)
  sqlite.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run(PROFILE, 'Reopen Test')
  return wrapSqlite(sqlite)
}

let db
beforeEach(async () => {
  _resetSchemaCache()
  _resetAuthSchemaCache()
  db = makeDb()
  // The proof scan reads hamilton_autopilot_runs; the real store creates it.
  await ensureHamiltonAuthorizationSchema(db)
})

async function closedTask(status, { withProof = false } = {}) {
  const task = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', initialStatus: 'queued' })
  let outputDocumentId
  if (withProof) {
    // The real proof shape (#1114/#1123): a SUBMITTED autopilot run carrying a
    // captured portal confirmation reference, bound to this task.
    const run = await createAutopilotRun(db, { taskId: task.id, profileId: PROFILE, userId: 'u', status: 'preflight', preflight: {} })
    await updateAutopilotRun(db, run.id, { status: 'submitted', confirmationReference: 'CONF-2026-0001', result: { confirmation_evidence: 'portal_reference', confirmation_reference_is_new: true }, finishedAt: '2026-09-05T22:00:00Z' })
    await db.prepare(`INSERT INTO documents (id, profile_id, grant_id, name, type, file_bytes, mime_type) VALUES ('doc-proof', ?, 'g-1', 'confirmation.png', 'hamilton_submission_confirmation', X'89504E47', 'image/png')`).run(PROFILE)
    outputDocumentId = 'doc-proof'
  }
  await db.prepare('UPDATE application_tasks SET status = ?, completed_at = ?, next_retry_at = ?, last_agent_message = ?, output_document_id = ? WHERE id = ?')
    .run(status, '2026-09-05T22:00:00Z', '2026-09-06T01:00:00Z', 'Hamilton found no application form to submit at https://example.org', outputDocumentId ?? null, task.id)
  return task
}

describe('ensureApplicationTask — re-open a task closed WITHOUT submission proof', () => {
  it('a deliberate re-run re-opens a `completed` research lead at the initial status and records why', async () => {
    const task = await closedTask('completed')
    const again = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', initialStatus: 'ready_to_start', reopenClosed: true })
    expect(again.id).toBe(task.id)
    expect(again.status).toBe('ready_to_start')
    expect(again.completed_at).toBeNull()
    expect(again.next_retry_at).toBeNull()
    expect(again.last_agent_message).toMatch(/Re-opened/)
    const events = await db.prepare('SELECT step, message FROM application_task_events WHERE task_id = ?').all(task.id)
    expect(events.some((e) => e.step === 'reopened' && /no portal confirmation/.test(e.message))).toBe(true)
    // The launch transition the orchestrator makes now succeeds.
    const launched = await updateApplicationTask(db, task.id, { unlessCancelled: true, status: 'launching_portal' })
    expect(launched.status).toBe('launching_portal')
  })

  it('a `failed` task re-opens the same way', async () => {
    const task = await closedTask('failed')
    const again = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', initialStatus: 'queued', reopenClosed: true })
    expect(again.id).toBe(task.id)
    expect(again.status).toBe('queued')
  })

  it('WITHOUT the deliberate flag (an autonomous sweep) a closed task stays closed', async () => {
    const task = await closedTask('completed')
    const again = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', initialStatus: 'ready_to_start' })
    expect(again.id).toBe(task.id)
    expect(again.status).toBe('completed')
  })

  it('a `completed` task WITH a durable portal confirmation is never re-opened', async () => {
    const task = await closedTask('completed', { withProof: true })
    const again = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1', initialStatus: 'ready_to_start', reopenClosed: true })
    expect(again.id).toBe(task.id)
    expect(again.status).toBe('completed')
  })

  it('`submitted` and `cancelled` are not re-openable states', () => {
    expect(REOPENABLE_CLOSED_STATUSES).toEqual(['completed', 'failed'])
  })
})
