/**
 * Canonical submission-proof predicate (2026-08-03).
 *
 * OWNER NORTH STAR: the system must NEVER present something as "externally
 * submitted with proof" when it isn't. A generated application PACKET/DRAFT PDF
 * is the thing we would submit — never proof that we did.
 *
 * The verbatim prod case (Robert 6b3c75ec…): an `application_tasks` row stamped
 * `status='submitted'` whose `output_document_id` points at
 * "NAEMT EMS Scholarships — PDF", a `hamilton_generated_application` PACKET, with
 * NO autopilot run carrying a confirmation reference or a durable confirmation
 * document. This MUST read as "marked submitted (internal record)", never as
 * externally-submitted-with-proof.
 *
 * Pins:
 *   1. NAEMT packet output_document_id → verified_external === false (the bug).
 *   2. No run + no output doc → internal only.
 *   3. A durable `hamilton_submission_confirmation` document → verified.
 *   4. A submitted run whose confirmation is retrievable (durable doc bytes) →
 *      verified, via the #1114 assessStoredConfirmationProof check.
 *   5. A submitted run carrying only a captured portal confirmation reference →
 *      verified.
 *   6. A non-submitted task → not_submitted (never claims proof).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  assessTaskSubmissionProof,
  taskHasVerifiedExternalSubmission,
  SUBMISSION_PROOF_STATE,
  _internal,
} = await import('../services/hamilton/submissionProofPredicate.js')

const CONFIRMATION_TYPE = _internal.CONFIRMATION_DOCUMENT_TYPE // 'hamilton_submission_confirmation'
const PACKET_TYPE = 'hamilton_generated_application'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, profile_id TEXT, name TEXT, type TEXT,
      file_bytes BLOB, file_path TEXT
    );
    CREATE TABLE hamilton_autopilot_runs (
      id TEXT PRIMARY KEY, task_id TEXT, profile_id TEXT, status TEXT,
      confirmation_reference TEXT, confirmation_screenshot_path TEXT,
      result_json TEXT DEFAULT '{}'
    );
  `)
  return wrapSqlite(sqlite)
}

async function insertDoc(db, { id, type, bytes = null }) {
  await db.prepare('INSERT INTO documents (id, profile_id, name, type, file_bytes) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'p1', `${type} doc`, type, bytes)
}

async function insertRun(db, { id, taskId, status = 'submitted', reference = null, resultJson = '{}', screenshot = null }) {
  await db.prepare(
    'INSERT INTO hamilton_autopilot_runs (id, task_id, profile_id, status, confirmation_reference, confirmation_screenshot_path, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, taskId, 'p1', status, reference, screenshot, resultJson)
}

let db
beforeEach(() => { db = makeDb() })

describe('assessTaskSubmissionProof', () => {
  it('1) does NOT treat a generated PACKET output_document as proof (the NAEMT case)', async () => {
    await insertDoc(db, { id: 'doc-naemt', type: PACKET_TYPE, bytes: Buffer.from('%PDF packet bytes') })
    const task = { id: 't-naemt', status: 'submitted', output_document_id: 'doc-naemt' }

    const res = await assessTaskSubmissionProof(db, task)

    expect(res.verified_external).toBe(false)
    expect(res.state).toBe(SUBMISSION_PROOF_STATE.INTERNAL_ONLY)
    expect(res.label).toMatch(/internal record/i)
    expect(res.unverified_reason).toBe(`output_document_is_${PACKET_TYPE}`)
    expect(await taskHasVerifiedExternalSubmission(db, task)).toBe(false)
  })

  it('2) a submitted task with no run and no output document is internal-only', async () => {
    const task = { id: 't-bare', status: 'submitted', output_document_id: null }
    const res = await assessTaskSubmissionProof(db, task)
    expect(res.verified_external).toBe(false)
    expect(res.state).toBe(SUBMISSION_PROOF_STATE.INTERNAL_ONLY)
    expect(res.unverified_reason).toBe('no_run_no_confirmation_doc')
  })

  it('3) a durable hamilton_submission_confirmation output_document IS proof', async () => {
    await insertDoc(db, { id: 'doc-conf', type: CONFIRMATION_TYPE, bytes: Buffer.from('PNG confirmation screenshot') })
    const task = { id: 't-conf', status: 'submitted', output_document_id: 'doc-conf' }
    const res = await assessTaskSubmissionProof(db, task)
    expect(res.verified_external).toBe(true)
    expect(res.state).toBe(SUBMISSION_PROOF_STATE.VERIFIED_EXTERNAL)
    expect(res.proof_document_id).toBe('doc-conf')
    expect(res.source).toBe('output_confirmation_doc')
    expect(await taskHasVerifiedExternalSubmission(db, task)).toBe(true)
  })

  it('4) a submitted run with a retrievable confirmation document IS proof', async () => {
    await insertDoc(db, { id: 'run-conf', type: CONFIRMATION_TYPE, bytes: Buffer.from('durable bytes') })
    await insertRun(db, {
      id: 'r1', taskId: 't-run', status: 'submitted',
      resultJson: JSON.stringify({ confirmation_document_id: 'run-conf' }),
    })
    // Even though the output_document is a mere packet, the run's proof wins.
    await insertDoc(db, { id: 'pk', type: PACKET_TYPE, bytes: Buffer.from('packet') })
    const task = { id: 't-run', status: 'submitted', output_document_id: 'pk' }
    const res = await assessTaskSubmissionProof(db, task)
    expect(res.verified_external).toBe(true)
    expect(res.source).toMatch(/^run_/)
    expect(res.proof_document_id).toBe('run-conf')
  })

  it('5) a submitted run carrying only a captured portal confirmation reference IS proof', async () => {
    await insertRun(db, { id: 'r2', taskId: 't-ref', status: 'submitted', reference: 'CONF-2026-ABC123' })
    const task = { id: 't-ref', status: 'submitted', output_document_id: null }
    const res = await assessTaskSubmissionProof(db, task)
    expect(res.verified_external).toBe(true)
    expect(res.source).toBe('confirmation_reference')
    expect(res.confirmation_reference).toBe('CONF-2026-ABC123')
  })

  it('5b) a run that is NOT submitted (blocked/failed) never grants proof', async () => {
    await insertRun(db, { id: 'r3', taskId: 't-blk', status: 'blocked', reference: 'SHOULD-NOT-COUNT' })
    const task = { id: 't-blk', status: 'submitted', output_document_id: null }
    const res = await assessTaskSubmissionProof(db, task)
    expect(res.verified_external).toBe(false)
    expect(res.state).toBe(SUBMISSION_PROOF_STATE.INTERNAL_ONLY)
  })

  it('6) a non-submitted task never claims proof', async () => {
    const task = { id: 't-draft', status: 'draft_completed', output_document_id: 'doc-naemt' }
    const res = await assessTaskSubmissionProof(db, task)
    expect(res.verified_external).toBe(false)
    expect(res.state).toBe(SUBMISSION_PROOF_STATE.NOT_SUBMITTED)
  })

  it('a confirmation output_document with NO bytes does not qualify (not retrievable)', async () => {
    await insertDoc(db, { id: 'empty-conf', type: CONFIRMATION_TYPE, bytes: null })
    const task = { id: 't-empty', status: 'submitted', output_document_id: 'empty-conf' }
    const res = await assessTaskSubmissionProof(db, task)
    expect(res.verified_external).toBe(false)
  })
})
