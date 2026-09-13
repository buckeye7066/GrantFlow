/**
 * backend/scripts/hamilton-durable-confirmations.mjs — the census the
 * integrator runs against production after the 2026-09-12 proof fixes.
 *
 * Pins that the script counts THROUGH the canonical predicate
 * (`assessTaskSubmissionProof`), never by hand SQL: the four production
 * shapes (bare Mark-Submitted, a real run with a retrievable confirmation
 * document, a run whose only "reference" is a DOM slug, a packet masquerading
 * as proof) land in the dispositions the tracker shows, the accounting sums,
 * a non-submitted task is never counted, `--profile` narrows, and importing
 * the module opens NO database (the DB is imported lazily inside main()).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const { runDurableConfirmationCensus, dispositionOf } = await import('../scripts/hamilton-durable-confirmations.mjs')
const { SUBMISSION_PROOF_STATE } = await import('../services/hamilton/submissionProofPredicate.js')

const SLUG = 'children-notification-children-notification'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, grant_id TEXT, status TEXT,
      current_step TEXT, output_document_id TEXT, submitted_at TEXT, updated_at TEXT
    );
    CREATE TABLE hamilton_autopilot_runs (
      id TEXT PRIMARY KEY, task_id TEXT, profile_id TEXT, status TEXT,
      confirmation_reference TEXT, confirmation_screenshot_path TEXT, result_json TEXT DEFAULT '{}'
    );
    CREATE TABLE documents (id TEXT PRIMARY KEY, profile_id TEXT, name TEXT, type TEXT, file_bytes BLOB, file_path TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT);
  `)
  return db
}

function seed(db) {
  db.prepare("INSERT INTO funding_opportunities (id, title) VALUES ('opp-usb', 'U.S. Bank Scholarship')").run()
  // A: bare tracker Mark Submitted — nothing attached.
  db.prepare("INSERT INTO application_tasks (id, profile_id, status, current_step, submitted_at) VALUES ('t-a', 'p-1', 'submitted', 'marked_submitted_internal', '2026-07-03T00:00:00Z')").run()
  // B: a real portal submission with a retrievable confirmation document.
  db.prepare("INSERT INTO documents (id, profile_id, name, type, file_bytes) VALUES ('conf-1', 'p-1', 'confirmation', 'hamilton_submission_confirmation', ?)").run(Buffer.from('png-bytes'))
  db.prepare("INSERT INTO application_tasks (id, profile_id, opportunity_id, status, output_document_id, submitted_at) VALUES ('t-b', 'p-1', 'opp-usb', 'submitted', 'conf-1', '2026-08-23T00:00:00Z')").run()
  db.prepare(`INSERT INTO hamilton_autopilot_runs (id, task_id, profile_id, status, confirmation_reference, result_json)
    VALUES ('run-b', 't-b', 'p-1', 'submitted', 'USB-2026-4471', ?)`).run(JSON.stringify({
    confirmation_evidence: 'portal_reference', confirmation_reference: 'USB-2026-4471',
    confirmation_reference_is_new: true, confirmation_document_id: 'conf-1',
  }))
  // C: the prod DOM-slug row — a 'submitted' run whose reference is a scraped element id.
  db.prepare("INSERT INTO application_tasks (id, profile_id, status, submitted_at) VALUES ('t-c', 'p-2', 'submitted', '2026-08-23T01:00:00Z')").run()
  db.prepare(`INSERT INTO hamilton_autopilot_runs (id, task_id, profile_id, status, confirmation_reference, result_json)
    VALUES ('run-c', 't-c', 'p-2', 'submitted', ?, ?)`).run(SLUG, JSON.stringify({
    confirmation_evidence: 'portal_reference', confirmation_reference: SLUG, confirmation_reference_is_new: true,
  }))
  // D: a draft PACKET pointed at by output_document_id (the NAEMT class).
  db.prepare("INSERT INTO documents (id, profile_id, name, type, file_bytes) VALUES ('packet-1', 'p-1', 'NAEMT — PDF', 'hamilton_generated_application', ?)").run(Buffer.from('pdf'))
  db.prepare("INSERT INTO application_tasks (id, profile_id, status, output_document_id, submitted_at) VALUES ('t-d', 'p-1', 'submitted', 'packet-1', '2026-07-02T00:00:00Z')").run()
  // E: not submitted — must never be counted.
  db.prepare("INSERT INTO application_tasks (id, profile_id, status) VALUES ('t-e', 'p-1', 'completed')").run()
  // A FAILED run carrying the slug too (prod had two of those) — surfaces in the shape-guard list.
  db.prepare("INSERT INTO hamilton_autopilot_runs (id, task_id, profile_id, status, confirmation_reference, result_json) VALUES ('run-c2', 't-c', 'p-2', 'failed', ?, '{}')").run(SLUG)
}

describe('hamilton-durable-confirmations census', () => {
  let db
  beforeEach(() => { db = makeDb(); seed(db) })

  it('counts through the canonical predicate and the accounting sums', async () => {
    const report = await runDurableConfirmationCensus(db)
    expect(report.ok).toBe(true)
    expect(report.submitted_rows).toBe(4)
    expect(report.durable_via_run).toBe(1)
    expect(report.durable_via_receipt).toBe(0)
    expect(report.durable_confirmed_total).toBe(1)
    expect(report.internal_only).toBe(3)
    expect(report.internal_only_by_reason).toEqual({
      no_run_no_confirmation_doc: 1,
      run_without_captured_evidence: 1,
      output_document_is_hamilton_generated_application: 1,
    })
    const byId = Object.fromEntries(report.tasks.map((t) => [t.task_id, t]))
    expect(byId['t-a'].disposition).toBe('internal_only:no_run_no_confirmation_doc')
    expect(byId['t-b'].disposition).toBe('durable_via_run')
    expect(byId['t-b'].confirmation_reference).toBe('USB-2026-4471')
    expect(byId['t-b'].proof_document_id).toBe('conf-1')
    expect(byId['t-b'].title).toBe('U.S. Bank Scholarship')
    expect(byId['t-c'].disposition).toBe('internal_only:run_without_captured_evidence')
    expect(byId['t-d'].disposition).toBe('internal_only:output_document_is_hamilton_generated_application')
    expect(byId['t-e']).toBeUndefined()
  })

  it('lists every submitted run with the evidence keys the read side judges, and flags DOM-slug references on ANY run status', async () => {
    const report = await runDurableConfirmationCensus(db)
    expect(report.submitted_runs).toBe(2)
    expect(report.submitted_runs_with_shape_valid_reference).toBe(1)
    const runC = report.runs.find((r) => r.run_id === 'run-c')
    expect(runC.reference_passes_shape_guard).toBe(false)
    expect(runC.reference_is_new).toBe(true) // the flag alone never promotes it
    expect(report.implausible_reference_runs).toBe(2)
    expect(report.implausible_references.map((r) => r.run_id).sort()).toEqual(['run-c', 'run-c2'])
  })

  it('--profile narrows the census to one profile', async () => {
    const report = await runDurableConfirmationCensus(db, { profileId: 'p-2' })
    expect(report.submitted_rows).toBe(1)
    expect(report.tasks[0].task_id).toBe('t-c')
    expect(report.durable_confirmed_total).toBe(0)
    expect(report.submitted_runs).toBe(1)
  })

  it('dispositionOf is the predicate verdict, never a status flip', () => {
    expect(dispositionOf({ verified_external: true, source: 'run_document' })).toBe('durable_via_run')
    expect(dispositionOf({ verified_external: true, source: 'confirmation_reference' })).toBe('durable_via_run')
    expect(dispositionOf({ verified_external: true, source: 'owner_attested_manual_receipt' })).toBe('durable_via_receipt')
    expect(dispositionOf({ verified_external: false, unverified_reason: 'no_run_no_confirmation_doc' })).toBe('internal_only:no_run_no_confirmation_doc')
    expect(dispositionOf({ verified_external: false, state: SUBMISSION_PROOF_STATE.NOT_SUBMITTED })).toBe('internal_only:not_submitted')
    expect(dispositionOf(null)).toBe('internal_only:unknown')
  })

  it('a database without application_tasks reports itself unreadable instead of printing zero', async () => {
    const bare = new Database(':memory:')
    const report = await runDurableConfirmationCensus(bare)
    expect(report.ok).toBe(false)
    expect(report.error).toMatch(/application_tasks/)
  })
})
