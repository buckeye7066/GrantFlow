/**
 * Post-submit verification sweep (2026-08-31) — the re-check that
 * `submission_verification_required` never had. Pins:
 *
 *  - a re-opened portal showing durable receipt evidence (a plausible NEW
 *    reference on the run's own captured outcome page, or an explicit receipt
 *    acknowledgement) promotes the task + run to `submitted` through the same
 *    evidence primitives the live submit uses;
 *  - no evidence → the task STAYS parked and the attempt is recorded durably;
 *  - the re-check is bounded (VERIFICATION_MAX_ATTEMPTS) and spaced;
 *  - a ToS-forbidden portal (studentaid.gov class) is never re-opened;
 *  - the sweep never clicks anything (the fake page would throw).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  runSubmissionVerificationSweep,
  verifyOneParkedSubmission,
  VERIFICATION_MAX_ATTEMPTS,
} from '../services/hamilton/hamiltonSubmissionVerifier.js'
import { ensureApplicationTaskSchema, appendTaskEvent, _resetSchemaCache } from '../services/hamilton/applicationTaskStore.js'
import { createAutopilotRun, updateAutopilotRun, _resetAuthSchemaCache } from '../services/hamilton/hamiltonAuthorizationStore.js'

let db

beforeEach(async () => {
  _resetSchemaCache()
  _resetAuthSchemaCache()
  db = wrapSqlite(new Database(':memory:'))
  await ensureApplicationTaskSchema(db)
  // Minimal documents table so registerConfirmationArtifact can retain
  // owner-retrievable proof (the acknowledgement-only path requires it).
  db.prepare(`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, organization_id TEXT, grant_id TEXT, profile_id TEXT,
    name TEXT, type TEXT, file_url TEXT, file_path TEXT, file_size INTEGER,
    mime_type TEXT, file_bytes BLOB, extracted_text TEXT, processing_status TEXT,
    notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run()
})

async function seedParkedTask(id, { portalUrl = 'https://portal.example.org/apply', profileId = 'p1' } = {}) {
  await db.prepare(`
    INSERT INTO application_tasks (id, profile_id, status, portal_url, application_url, updated_at)
    VALUES (?, ?, 'submission_verification_required', ?, ?, ?)
  `).run(id, profileId, portalUrl, portalUrl, new Date(Date.now() - 60_000).toISOString())
  return (await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(id))
}

async function seedParkedRun(taskId, { confirmationUrl = null } = {}) {
  const run = await createAutopilotRun(db, { taskId, profileId: 'p1', status: 'running' })
  await updateAutopilotRun(db, run.id, {
    status: 'submission_verification_required',
    blockerKind: 'submission_verification_required',
    result: {
      status: 'blocked',
      submission_attempt_started: true,
      ...(confirmationUrl ? { confirmation_url: confirmationUrl } : {}),
    },
  })
  return run
}

// A read-only fake portal page. Any click attempt throws — pinning that the
// verifier NEVER interacts, so it can never double-submit.
function fakePage(bodyText, { finalUrl = 'https://portal.example.org/confirmation' } = {}) {
  return {
    goto: async () => {},
    waitForLoadState: async () => null,
    url: () => finalUrl,
    locator: () => ({ innerText: async () => bodyText }),
    content: async () => `<html><body>${bodyText}</body></html>`,
    screenshot: async () => {},
    click: async () => { throw new Error('the verifier must never click') },
  }
}

const openPageWith = (bodyText, opts) => async () => ({
  page: fakePage(bodyText, opts),
  close: async () => {},
})

describe('verifyOneParkedSubmission', () => {
  it('promotes to submitted on the run\'s captured outcome page carrying a NEW plausible reference', async () => {
    const task = await seedParkedTask('t1')
    await seedParkedRun('t1', { confirmationUrl: 'https://portal.example.org/confirmation' })
    const verdict = await verifyOneParkedSubmission(db, task, {
      _openPage: openPageWith('Thank you. Confirmation #: GF2026-88431. Your application has been received.'),
    })
    expect(verdict.outcome).toBe('confirmed')
    expect(verdict.evidence.reference).toBe('GF2026-88431')
    const after = await db.prepare('SELECT status, submitted_at, last_agent_message FROM application_tasks WHERE id = ?').get('t1')
    expect(after.status).toBe('submitted')
    expect(after.submitted_at).toBeTruthy()
    expect(after.last_agent_message).toMatch(/GF2026-88431/)
    const run = await db.prepare("SELECT status, confirmation_reference FROM hamilton_autopilot_runs WHERE task_id = 't1'").get()
    expect(run.status).toBe('submitted')
    expect(run.confirmation_reference).toBe('GF2026-88431')
    const ev = await db.prepare("SELECT event_type, step FROM application_task_events WHERE task_id = 't1' AND step = 'post_submit_verification'").get()
    expect(ev?.event_type).toBe('submitted')
  })

  it('an explicit receipt ACKNOWLEDGEMENT qualifies even on the portal URL (portals do not print it for drafts)', async () => {
    const task = await seedParkedTask('t2')
    await seedParkedRun('t2')
    const verdict = await verifyOneParkedSubmission(db, task, {
      _openPage: openPageWith('Dashboard. We have received your application. It is now under review.'),
    })
    expect(verdict.outcome).toBe('confirmed')
    const after = await db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('t2')
    expect(after.status).toBe('submitted')
  })

  it('a bare "Application ID" on a NON-outcome page does NOT qualify (drafts carry ids too) — stays parked', async () => {
    const task = await seedParkedTask('t3')
    await seedParkedRun('t3') // no captured confirmation_url
    const verdict = await verifyOneParkedSubmission(db, task, {
      _openPage: openPageWith('My applications. Application ID: DRAFT9912 (status: draft, not submitted).'),
    })
    expect(verdict.outcome).toBe('still_unverified')
    const after = await db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('t3')
    expect(after.status).toBe('submission_verification_required')
  })

  it('never re-opens a ToS-forbidden portal (studentaid.gov class)', async () => {
    const task = await seedParkedTask('t4', { portalUrl: 'https://studentaid.gov/fafsa/apply' })
    await seedParkedRun('t4')
    const verdict = await verifyOneParkedSubmission(db, task, {
      _openPage: async () => { throw new Error('must not be called for a ToS-forbidden portal') },
    })
    expect(verdict.outcome).toBe('skipped')
    expect(verdict.reason).toBe('portal_terms_forbid_automation')
  })
})

describe('runSubmissionVerificationSweep', () => {
  it('records a durable recheck attempt when nothing is found, and exhausts after VERIFICATION_MAX_ATTEMPTS', async () => {
    await seedParkedTask('t5')
    await seedParkedRun('t5')
    const first = await runSubmissionVerificationSweep(db, {
      limit: 3, _openPage: openPageWith('Just a portal home page.'),
    })
    expect(first.checked).toBe(1)
    expect(first.still_unverified).toBe(1)
    const events = await db.prepare("SELECT message FROM application_task_events WHERE task_id = 't5' AND step = 'submission_verification_recheck'").all()
    expect(events).toHaveLength(1)
    expect(events[0].message).toMatch(/attempt 1\/3/)

    // Seed the remaining attempts as already spent (back-dated so spacing passes).
    for (let i = 2; i <= VERIFICATION_MAX_ATTEMPTS; i += 1) {
      await appendTaskEvent(db, {
        taskId: 't5', eventType: 'note', status: 'submission_verification_required',
        step: 'submission_verification_recheck', message: `attempt ${i}`, actorRole: 'agent',
      })
    }
    await db.prepare("UPDATE application_task_events SET created_at = ? WHERE task_id = 't5'")
      .run(new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    const done = await runSubmissionVerificationSweep(db, {
      limit: 3, _openPage: openPageWith('Still just a portal home page.'),
    })
    expect(done.exhausted).toBe(1)
    expect(done.checked).toBe(0)
  })

  it('spacing: a recheck minutes ago is not repeated this tick', async () => {
    await seedParkedTask('t6')
    await seedParkedRun('t6')
    await appendTaskEvent(db, {
      taskId: 't6', eventType: 'note', status: 'submission_verification_required',
      step: 'submission_verification_recheck', message: 'attempt 1', actorRole: 'agent',
    })
    const out = await runSubmissionVerificationSweep(db, {
      limit: 3, _openPage: openPageWith('portal home'),
    })
    expect(out.checked).toBe(0)
    expect(out.skipped).toBe(1)
  })
})
