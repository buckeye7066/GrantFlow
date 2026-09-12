/**
 * Post-click parks at the irreversible boundary (hamilton-submit-3, 2026-09-12).
 *
 * The orchestrator's three-state protocol moves the task to
 * `submit_evidence_pending` right after the engine returns from a leased
 * attempt. The "provably NOT submitted, safe to retry" park for a failed
 * submit click then wrote `status='blocked'` with `unlessCancelled: true` —
 * and that guard EXCLUDES `submit_evidence_pending`, so the UPDATE matched
 * zero rows, the task stayed pending, and the next recovery sweep quarantined
 * it as `submission_verification_required` (the exact opposite of the
 * documented intent). Reproduced against the repo modules with an in-memory
 * SQLite probe on 2026-09-12.
 *
 * Pins:
 *   1. click_failed + provably_not_submitted → the park LANDS from the real
 *      state: task `blocked` / `submit_click_failed`, run `failed`, event.
 *   2. click_failed that MAY have reached the page (dispatched=true) is an
 *      UNCERTAIN outcome: parked at submission_verification_required with the
 *      precise resumable state (allow_auto_submit false, next_retry_at NULL,
 *      one notification), and never re-attempted automatically.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

vi.mock('../services/hamilton/hamiltonAutopilotEngine.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, runAutopilot: vi.fn() }
})
vi.mock('../services/hamilton/hamiltonPreflight.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, preflightSingleSource: vi.fn(async () => ({ ok: true, blockers: [], warnings: [] })) }
})
vi.mock('../services/hamilton/hamiltonFundingSourcePolicy.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, assessHamiltonFundingSource: vi.fn(async () => ({ ok: true, reasons: [] })) }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { runAutopilot } = await import('../services/hamilton/hamiltonAutopilotEngine.js')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const {
  ensureApplicationTask, updateApplicationTask, getApplicationTask, listTaskEvents, _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache, recordAuthorizations, listAutopilotRuns } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-boundary-parks'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, display_name TEXT, primary_type TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, description TEXT,
      opportunity_kind TEXT, entity_types_allowed TEXT,
      application_url TEXT, source_url TEXT, source TEXT, record_origin TEXT,
      source_trust_tier TEXT, reality_status TEXT, is_active INTEGER
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,
      application_url TEXT, status TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT,
      match_explanation TEXT, matcher_version TEXT, updated_at DATETIME, computed_at DATETIME
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), user_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL, data TEXT, read INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP
    );
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return db
}

async function seedFixture(db) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES (?, ?, ?, ?)')
    .run(PROFILE, 'user-1', 'Focus Forward Ministry', 'nonprofit')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Focus', last_name: 'Forward', email: 'ffm@example.org' }))
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'automation_preferences', JSON.stringify({ automations: { hamilton_auto_submit: true, hamilton_autopilot: true } }))
  await db.prepare(`INSERT INTO funding_opportunities
    (id, title, description, opportunity_kind, entity_types_allowed, application_url,
     source_url, source, record_origin, source_trust_tier, reality_status, is_active)
    VALUES (?, ?, ?, 'direct_grant', ?, ?, ?, 'curated_verified', 'curated_verified', 'official', 'real', 1)`)
    .run('opp-1', 'Community Ministry Grant', 'Apply through the portal.', JSON.stringify(['nonprofit']),
      'https://hamilton-submit-fixture.invalid/apply', 'https://hamilton-submit-fixture.invalid/apply')
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)')
    .run('g-1', PROFILE, 'opp-1', 'Community Ministry Grant')
  await db.prepare(`INSERT INTO profile_opportunity_matches
    (profile_id, opportunity_id, match_score, match_decision, matcher_version, updated_at, computed_at)
    VALUES (?, ?, 90, 'accept', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(PROFILE, 'opp-1')
  await recordAuthorizations(db, {
    userId: 'user-1', profileId: PROFILE, scope: 'funding_source', fundingSourceIds: ['opp-1'],
    authorizationTypes: ['complete_forms', 'submit_applications'],
    authorizationText: 'Test authorization', authorizationVersion: 'hamilton-autopilot-test-v1',
    options: { require_human_review: false }, replaceOmittedTypes: true,
  })
  const task = await ensureApplicationTask(db, {
    profileId: PROFILE, opportunityId: 'opp-1', grantId: 'g-1', automationType: 'portal',
  })
  await updateApplicationTask(db, task.id, { allowAutoSubmit: true })
  return task
}

const runSource = (db) => automateSingleSource(db, {
  profileId: PROFILE, userId: 'user-1', source: { opportunity_id: 'opp-1', grant_id: 'g-1' }, options: {},
})

const savedEnv = {}
beforeEach(() => {
  runAutopilot.mockReset()
  savedEnv.enabled = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  savedEnv.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  savedEnv.gate = process.env.HAMILTON_TAILORED_APPROVAL_GATE
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
  process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
  return () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = savedEnv.enabled
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = savedEnv.allow
    if (savedEnv.gate === undefined) delete process.env.HAMILTON_TAILORED_APPROVAL_GATE
    else process.env.HAMILTON_TAILORED_APPROVAL_GATE = savedEnv.gate
  }
})

describe('hamilton-submit-3: the provably-not-submitted click park must land from the real state', () => {
  it('click_failed + provably_not_submitted after the lease → blocked / submit_click_failed (not wedged at submit_evidence_pending)', async () => {
    const db = makeDb()
    const task = await seedFixture(db)
    runAutopilot.mockImplementationOnce(async ({ beforeSubmit }) => {
      const boundary = await beforeSubmit()
      expect(boundary.allow).toBe(true)
      return {
        status: 'failed',
        blocker_kind: 'click_failed',
        blocker_detail: 'Submit button could not be clicked (the control was never actually activated — no submission occurred). Safe to retry.',
        provably_not_submitted: true,
        submission_attempt_started: true,
        submit_clicked: false,
        filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
        pages_visited: 1, trace: [],
      }
    })

    const result = await runSource(db)

    expect(result.blocker_kind).toBe('click_failed')
    expect(result.task.status).toBe('blocked')
    expect(result.task.current_step).toBe('submit_click_failed')
    expect(result.task.next_retry_at).toBeNull()
    const stored = await getApplicationTask(db, task.id)
    expect(stored.status).toBe('blocked')
    const runs = await listAutopilotRuns(db, { taskId: task.id })
    expect(runs[0].status).toBe('failed')
    expect(runs[0].blocker_kind).toBe('click_failed')
    const events = await listTaskEvents(db, task.id)
    const park = events.find((e) => e.step === 'submit_click_failed')
    expect(park).toBeTruthy()
    expect(park.details?.provably_not_submitted).toBe(true)
    expect(events.find((e) => e.event_type === 'submitted')).toBeFalsy()
  })

  it('an UNCERTAIN click failure (the event may have reached the page) stays parked at submission_verification_required with a precise resumable state', async () => {
    const db = makeDb()
    const task = await seedFixture(db)
    runAutopilot.mockImplementationOnce(async ({ beforeSubmit }) => {
      await beforeSubmit()
      return {
        status: 'failed',
        blocker_kind: 'click_failed',
        blocker_detail: 'Submit click failed after it may have reached the page; check the portal before retrying.',
        provably_not_submitted: false,
        submission_attempt_started: true,
        submit_clicked: false,
        filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
        pages_visited: 1, trace: [],
      }
    })

    const result = await runSource(db)

    expect(result.submission_verification_required).toBe(true)
    expect(result.task.status).toBe('submission_verification_required')
    expect(result.task.current_step).toBe('submission_verification_required')
    expect(result.task.allow_auto_submit).toBe(false)
    expect(result.task.auto_submit_enabled).toBe(false)
    expect(result.task.next_retry_at).toBeNull()
    expect(result.task.last_agent_message).toMatch(/check the funder portal/i)
    const notices = await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'hamilton_submission_verification_required' AND user_id = 'user-1'").get()
    expect(Number(notices.n)).toBe(1)
    const events = await listTaskEvents(db, task.id)
    const park = events.find((e) => e.step === 'submission_verification_required')
    expect(park?.details?.irreversible_boundary).toBe(true)

    // NEVER blindly retried: a second pass re-asserts the quarantine without opening the portal.
    const again = await runSource(db)
    expect(again.blocker_kind).toBe('submission_verification_required')
    expect(again.task.status).toBe('submission_verification_required')
    expect(runAutopilot).toHaveBeenCalledTimes(1)
  })
})
