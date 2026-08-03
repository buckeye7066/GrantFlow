/**
 * Authorized auto-submit leg (owner addendum 2026-08-03): when auto-submit IS
 * authorized, the application must actually go out through the portal's real
 * submit action — "not just internal to grantflow" — for ANY profile type
 * (org ministries included). And truthfully: "clicked submit" and "portal
 * confirmed receipt" are different facts; the record must say which one we
 * have.
 *
 * Pins:
 *   1. STORED AUTHORIZATION REACHES THE SUBMIT STEP — the task's persisted
 *      allow_auto_submit (batch option) and auto_submit_enabled (the user's
 *      explicit approve-submit toggle, previously honored only by the legacy
 *      hamiltonApplicationAgent) flow into the autopilot engine's
 *      allowAutoSubmit on EVERY run, not only the batch that created the task.
 *   2. NO WIDENING — auto_submit_enabled still requires the global
 *      HAMILTON_ALLOW_AUTOSUBMIT flag (same rail as the legacy agent), the
 *      tailored-approval gate still forces filled-not-submitted when not
 *      approved, and everything defaults OFF.
 *   3. SUBMISSION EVIDENCE HONESTY — a run is only reported "submitted" with
 *      captured evidence; the task record distinguishes a portal-issued
 *      reference from a screenshot-only capture, and a submit click with NO
 *      evidence is a blocker, never a submission.
 *   4. ORG PROFILES FIRST-CLASS — the engine's fill values pull an org
 *      profile's mission/programs narrative when no personal essay exists.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

vi.mock('../services/hamilton/hamiltonAutopilotEngine.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    runAutopilot: vi.fn(async () => ({
      status: 'completed_draft',
      filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
      pages_visited: 1,
      trace: [],
    })),
  }
})

vi.mock('../services/hamilton/hamiltonPreflight.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    preflightSingleSource: vi.fn(async () => ({ ok: true, blockers: [], warnings: [] })),
  }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { runAutopilot, _internal: engineInternal } = await import('../services/hamilton/hamiltonAutopilotEngine.js')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const {
  ensureApplicationTask,
  updateApplicationTask,
  listTaskEvents,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-authorized-leg'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      created_by TEXT,
      display_name TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      description TEXT,
      application_url TEXT,
      source_url TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      application_url TEXT,
      status TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return db
}

async function seedFixture(db) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
    .run(PROFILE, 'user-1', 'Focus Forward Ministry')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Focus', last_name: 'Forward', email: 'ffm@example.org' }))
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')
    .run('opp-1', 'Community Ministry Grant', 'Apply through the portal.', 'https://portal.example.org/apply')
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)')
    .run('g-1', PROFILE, 'opp-1', 'Community Ministry Grant')
}

const AUTHORIZATIONS = {
  complete_forms: true,
  save_drafts: false,
  generate_narratives: false,
  submit_applications: false,
  use_saved_credentials_reference: false,
  use_saved_session: false,
  upload_documents: false,
  use_standing_attestation: false,
}

async function runSource(db, extraOptions = {}) {
  return automateSingleSource(db, {
    profileId: PROFILE,
    userId: 'user-1',
    source: { opportunity_id: 'opp-1', grant_id: 'g-1' },
    options: { authorizations: AUTHORIZATIONS, ...extraOptions },
  })
}

const savedEnv = {}
beforeEach(() => {
  runAutopilot.mockClear()
  runAutopilot.mockResolvedValue({
    status: 'completed_draft',
    filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
    pages_visited: 1,
    trace: [],
  })
  savedEnv.enabled = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  savedEnv.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  savedEnv.autosubmit = process.env.HAMILTON_ALLOW_AUTOSUBMIT
  savedEnv.gate = process.env.HAMILTON_TAILORED_APPROVAL_GATE
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
  delete process.env.HAMILTON_ALLOW_AUTOSUBMIT
  delete process.env.HAMILTON_TAILORED_APPROVAL_GATE
  return () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = savedEnv.enabled
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = savedEnv.allow
    if (savedEnv.autosubmit === undefined) delete process.env.HAMILTON_ALLOW_AUTOSUBMIT
    else process.env.HAMILTON_ALLOW_AUTOSUBMIT = savedEnv.autosubmit
    if (savedEnv.gate === undefined) delete process.env.HAMILTON_TAILORED_APPROVAL_GATE
    else process.env.HAMILTON_TAILORED_APPROVAL_GATE = savedEnv.gate
  }
})

// Pre-create the task automateSingleSource will idempotently reuse, so the
// STORED columns (not the batch options) are what authorize submission.
async function seedTaskWith(db, { allowAutoSubmit, autoSubmitEnabled } = {}) {
  const task = await ensureApplicationTask(db, {
    profileId: PROFILE, opportunityId: 'opp-1', grantId: 'g-1', automationType: 'portal',
  })
  const patch = {}
  if (allowAutoSubmit !== undefined) patch.allowAutoSubmit = allowAutoSubmit
  if (autoSubmitEnabled !== undefined) patch.autoSubmitEnabled = autoSubmitEnabled
  if (Object.keys(patch).length > 0) await updateApplicationTask(db, task.id, patch)
  return task
}

// ── 1 + 2. Stored authorization reaches the engine; rails stay closed ──────

describe('stored auto-submit authorization reaches the submit step', () => {
  it('persisted allow_auto_submit (batch option) authorizes the engine on a later run', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0' // operational escape hatch: isolate the wiring
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, { allowAutoSubmit: true })

    await runSource(db) // no options.allow_auto_submit on this run

    expect(runAutopilot).toHaveBeenCalledTimes(1)
    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(true)
  })

  it("the user's approve-submit toggle (auto_submit_enabled) authorizes the engine when the global flag is on", async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, { autoSubmitEnabled: true })

    await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(true)
  })

  it('auto_submit_enabled WITHOUT the global HAMILTON_ALLOW_AUTOSUBMIT flag stays draft-only (legacy-agent rail)', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, { autoSubmitEnabled: true })

    await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('nothing stored, nothing granted → allowAutoSubmit stays false (default OFF everywhere)', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, {})

    await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('an explicit batch denial overrides a stored authorization', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, { allowAutoSubmit: true })

    await runSource(db, { allow_auto_submit: false })

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('the tailored-approval gate (default ON) still forces filled-not-submitted for an unapproved card', async () => {
    // No HAMILTON_TAILORED_APPROVAL_GATE override → gate enforced.
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, { allowAutoSubmit: true })

    const result = await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((e) => e.step === 'auto_submit_gate')).toBeTruthy()
  })
})

// ── 3. Submission evidence honesty ─────────────────────────────────────────

describe('submission evidence honesty', () => {
  it('a portal-issued reference is reported as portal-confirmed receipt', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, { allowAutoSubmit: true })
    runAutopilot.mockResolvedValueOnce({
      status: 'submitted',
      submit_clicked: true,
      confirmation_evidence: 'portal_reference',
      confirmation_reference: 'CONF-12345',
      confirmation_screenshot_path: '/tmp/shot.png',
      filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
      pages_visited: 2,
      trace: [],
    })

    const result = await runSource(db)

    expect(result.task.status).toBe('submitted')
    const events = await listTaskEvents(db, result.task.id)
    const submittedEvent = events.find((e) => e.event_type === 'submitted')
    expect(submittedEvent.message).toMatch(/portal confirmed receipt/i)
    expect(submittedEvent.message).toContain('CONF-12345')
    expect(submittedEvent.details?.confirmation_evidence).toBe('portal_reference')
  })

  it('a screenshot-only capture never reads as portal-confirmed; the record says to verify', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, { allowAutoSubmit: true })
    runAutopilot.mockResolvedValueOnce({
      status: 'submitted',
      submit_clicked: true,
      confirmation_evidence: 'screenshot_only',
      confirmation_reference: null,
      confirmation_screenshot_path: '/tmp/shot.png',
      filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
      pages_visited: 2,
      trace: [],
    })

    const result = await runSource(db)

    expect(result.task.status).toBe('submitted')
    const events = await listTaskEvents(db, result.task.id)
    const submittedEvent = events.find((e) => e.event_type === 'submitted')
    expect(submittedEvent.message).not.toMatch(/portal confirmed receipt/i)
    expect(submittedEvent.message).toMatch(/verify/i)
    expect(submittedEvent.details?.confirmation_evidence).toBe('screenshot_only')
  })

  it('engine: a submit click with NO captured evidence is a blocker, never a submission', () => {
    const { assessSubmissionEvidence } = engineInternal
    expect(assessSubmissionEvidence({ reference: 'CONF-1', screenshot_path: null }))
      .toEqual({ ok: true, confirmation_evidence: 'portal_reference' })
    expect(assessSubmissionEvidence({ reference: null, screenshot_path: '/tmp/s.png' }))
      .toEqual({ ok: true, confirmation_evidence: 'screenshot_only' })
    expect(assessSubmissionEvidence({ reference: null, screenshot_path: null }))
      .toEqual({ ok: false, confirmation_evidence: 'none' })
  })
})

// ── 4. Org profiles are first-class fill sources ────────────────────────────

describe('org-profile fill values', () => {
  it("pulls a ministry's mission + programs narrative when no personal essay exists", () => {
    const values = engineInternal.readProfileValues({
      basic_information: { first_name: 'Focus', last_name: 'Forward', email: 'ffm@example.org' },
      narrative: {
        mission_statement: 'We serve families in Vermilion County.',
        programs_description: 'Food pantry, youth mentoring, recovery support.',
      },
    })
    expect(values.essay).toBe('We serve families in Vermilion County.\n\nFood pantry, youth mentoring, recovery support.')
  })

  it('a personal essay still wins for individual profiles (unchanged behavior)', () => {
    const values = engineInternal.readProfileValues({
      essays: { primary: 'my personal essay' },
      narrative: { mission_statement: 'org mission' },
    })
    expect(values.essay).toBe('my personal essay')
  })
})
