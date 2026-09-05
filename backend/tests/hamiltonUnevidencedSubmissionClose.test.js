/**
 * #1475: a parked "verify the portal" card whose funding source the four-gate
 * reconciliation already removed, whose read-only re-checks are exhausted, and
 * for which no run ever captured a confirmation reference is settled as
 * cancelled HISTORY — never left as a permanent Needs-you obligation.
 * Everything else stays parked exactly as before.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  closeUnevidencedParkedSubmissions,
  UNEVIDENCED_CLOSE_STEP,
} from '../services/hamilton/hamiltonAutonomySweeps.js'
import {
  runSubmissionVerificationSweep,
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
  await db.prepare('CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, profile_id TEXT, status TEXT)').run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, organization_id TEXT, grant_id TEXT, profile_id TEXT,
    name TEXT, type TEXT, file_url TEXT, file_path TEXT, file_size INTEGER,
    mime_type TEXT, file_bytes BLOB, extracted_text TEXT, processing_status TEXT,
    notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run()
})

const DAY_MS = 24 * 60 * 60_000

async function seedParked(id, { grantId = null, ageMs = 5 * DAY_MS, url = 'https://www.hud.gov/program_offices/comm_planning' } = {}) {
  await db.prepare(`
    INSERT INTO application_tasks (id, profile_id, status, current_step, grant_id, opportunity_id, application_url, portal_url, updated_at)
    VALUES (?, 'p1', 'submission_verification_required', 'submission_verification_required', ?, ?, ?, ?, ?)
  `).run(id, grantId, `fo-${id}`, url, url, new Date(Date.now() - ageMs).toISOString())
}

async function spendRechecks(id, n, { ageMs = DAY_MS } = {}) {
  for (let i = 1; i <= n; i += 1) {
    await appendTaskEvent(db, {
      taskId: id, eventType: 'note', status: 'submission_verification_required',
      step: 'submission_verification_recheck', message: `attempt ${i}`, actorRole: 'agent',
    })
  }
  await db.prepare('UPDATE application_task_events SET created_at = ? WHERE task_id = ?')
    .run(new Date(Date.now() - ageMs).toISOString(), id)
}

async function seedRun(taskId, { confirmationReference = null } = {}) {
  const run = await createAutopilotRun(db, { taskId, profileId: 'p1', status: 'running' })
  await updateAutopilotRun(db, run.id, {
    status: 'submission_verification_required',
    blockerKind: 'submission_verification_required',
    ...(confirmationReference ? { confirmationReference } : {}),
    result: { status: 'blocked', submission_attempt_started: true },
  })
  return run
}

const taskRow = async (id) => db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(id)

describe('closeUnevidencedParkedSubmissions', () => {
  it('closes a parked task whose grant is gone, re-checks exhausted, and no run carries a reference', async () => {
    await seedParked('t-hud')
    await seedRun('t-hud')
    await spendRechecks('t-hud', VERIFICATION_MAX_ATTEMPTS)

    const out = await closeUnevidencedParkedSubmissions(db)
    expect(out).toMatchObject({ scanned: 1, closed: 1, kept: 0, failed: 0, closed_ids: ['t-hud'] })

    const row = await taskRow('t-hud')
    expect(row.status).toBe('cancelled')
    expect(row.current_step).toBe('cancelled')
    expect(row.cancelled_at).toBeTruthy()
    expect(row.submitted_at).toBeNull()
    expect(Boolean(row.allow_auto_submit)).toBe(false)
    expect(row.last_agent_message).toMatch(/re-checked .* 3 time\(s\)/)
    expect(row.last_agent_message).toMatch(/No application is recorded as submitted/)
    expect(row.last_agent_message).toMatch(/retained/)

    const events = await db.prepare('SELECT event_type, step, details_json FROM application_task_events WHERE task_id = ? AND step = ?')
      .all('t-hud', UNEVIDENCED_CLOSE_STEP)
    expect(events).toHaveLength(1)
    expect(events[0].event_type).toBe('cancelled')
    expect(JSON.parse(events[0].details_json)).toMatchObject({ rechecks: 3, grant_removed: true, submission_evidence: 'none' })

    // Idempotent: a second pass finds nothing.
    expect(await closeUnevidencedParkedSubmissions(db)).toMatchObject({ scanned: 0, closed: 0 })
  })

  it('keeps a parked task whose pipeline grant still exists (a valid source stays a human question)', async () => {
    await db.prepare("INSERT INTO grants (id, profile_id, status) VALUES ('g-live', 'p1', 'portal')").run()
    await seedParked('t-live', { grantId: 'g-live' })
    await seedRun('t-live')
    await spendRechecks('t-live', VERIFICATION_MAX_ATTEMPTS)
    expect(await closeUnevidencedParkedSubmissions(db)).toMatchObject({ scanned: 0, closed: 0 })
    expect((await taskRow('t-live')).status).toBe('submission_verification_required')
  })

  it('keeps a parked task whose re-checks are not exhausted yet', async () => {
    await seedParked('t-young')
    await seedRun('t-young')
    await spendRechecks('t-young', VERIFICATION_MAX_ATTEMPTS - 1)
    expect(await closeUnevidencedParkedSubmissions(db)).toMatchObject({ scanned: 0, closed: 0 })
    expect((await taskRow('t-young')).status).toBe('submission_verification_required')
  })

  it('keeps a parked task when any run captured a confirmation reference (evidence outranks cleanup)', async () => {
    await seedParked('t-ref')
    await seedRun('t-ref', { confirmationReference: 'CONF-2026-000123' })
    await spendRechecks('t-ref', VERIFICATION_MAX_ATTEMPTS)
    expect(await closeUnevidencedParkedSubmissions(db)).toMatchObject({ scanned: 0, closed: 0 })
    expect((await taskRow('t-ref')).status).toBe('submission_verification_required')
  })

  it('never touches a task already stamped submitted_at', async () => {
    await seedParked('t-sub')
    await db.prepare("UPDATE application_tasks SET submitted_at = ? WHERE id = 't-sub'").run(new Date().toISOString())
    await spendRechecks('t-sub', VERIFICATION_MAX_ATTEMPTS)
    expect(await closeUnevidencedParkedSubmissions(db)).toMatchObject({ scanned: 0, closed: 0 })
    expect((await taskRow('t-sub')).status).toBe('submission_verification_required')
  })
})

describe('runSubmissionVerificationSweep no longer starves behind exhausted tasks', () => {
  it('three exhausted older tasks do not consume the LIMIT; the fresh one is re-checked', async () => {
    for (const id of ['old-1', 'old-2', 'old-3']) {
      await seedParked(id, { ageMs: 10 * DAY_MS })
      await seedRun(id)
      await spendRechecks(id, VERIFICATION_MAX_ATTEMPTS)
    }
    await seedParked('fresh', { ageMs: 60_000, url: 'https://portal.example.org/apply' })
    await seedRun('fresh')
    const openPage = async () => ({
      page: {
        goto: async () => {},
        waitForLoadState: async () => null,
        url: () => 'https://portal.example.org/apply',
        locator: () => ({ innerText: async () => 'Just a portal home page.' }),
        content: async () => '<html><body>Just a portal home page.</body></html>',
        screenshot: async () => {},
        click: async () => { throw new Error('the verifier must never click') },
      },
      close: async () => {},
    })
    const out = await runSubmissionVerificationSweep(db, { limit: 3, _openPage: openPage })
    expect(out.exhausted).toBe(3)
    expect(out.checked).toBe(1)
    expect(out.still_unverified).toBe(1)
    const events = await db.prepare("SELECT COUNT(*) AS n FROM application_task_events WHERE task_id = 'fresh' AND step = 'submission_verification_recheck'").get()
    expect(events.n).toBe(1)
  })
})
