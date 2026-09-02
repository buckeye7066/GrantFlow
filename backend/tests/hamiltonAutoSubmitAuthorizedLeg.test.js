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
const { _resetAuthSchemaCache, recordAuthorizations } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

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
  // The auto-submit toggle now defaults OFF when unset (2026-08-03). This
  // suite pins the AUTHORIZED leg — the profile has explicitly selected
  // auto-submit — so the fixture writes the explicit true a real selection
  // persists.
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'automation_preferences', JSON.stringify({ automations: { hamilton_auto_submit: true, hamilton_autopilot: true } }))
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')
    // Reserved synthetic host: the bounded release deliberately has zero real
    // reviewed submit adapters, but this fixture keeps the positive proof path
    // executable without enabling any real portal.
    .run('opp-1', 'Community Ministry Grant', 'Apply through the portal.', 'https://hamilton-submit-fixture.invalid/apply')
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)')
    .run('g-1', PROFILE, 'opp-1', 'Community Ministry Grant')
}

async function runSource(db, extraOptions = {}) {
  return automateSingleSource(db, {
    profileId: PROFILE,
    userId: 'user-1',
    source: { opportunity_id: 'opp-1', grant_id: 'g-1' },
    options: { ...extraOptions },
  })
}

async function seedStoredAuthorization(db, { submit = false, requireHumanReview = false } = {}) {
  return recordAuthorizations(db, {
    userId: 'user-1',
    profileId: PROFILE,
    scope: 'funding_source',
    fundingSourceIds: ['opp-1'],
    authorizationTypes: ['complete_forms', ...(submit ? ['submit_applications'] : [])],
    authorizationText: 'Test authorization',
    authorizationVersion: 'hamilton-autopilot-test-v1',
    options: { require_human_review: requireHumanReview },
    replaceOmittedTypes: true,
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
  process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
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
  it('persisted allow_auto_submit is intent only and cannot authorize submission by itself', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0' // operational escape hatch: isolate the wiring
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db)
    await seedTaskWith(db, { allowAutoSubmit: true })

    await runSource(db) // no options.allow_auto_submit on this run

    expect(runAutopilot).toHaveBeenCalledTimes(1)
    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it("the user's approve-submit toggle is intent only without a stored submit grant", async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db)
    await seedTaskWith(db, { autoSubmitEnabled: true })

    await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('auto_submit_enabled WITHOUT the global HAMILTON_ALLOW_AUTOSUBMIT flag stays draft-only (legacy-agent rail)', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    delete process.env.HAMILTON_ALLOW_AUTOSUBMIT
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { autoSubmitEnabled: true })

    await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('nothing stored, nothing granted → allowAutoSubmit stays false (default OFF everywhere)', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db)
    await seedTaskWith(db, {})

    await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('an explicit batch denial overrides a stored authorization', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })

    await runSource(db, { allow_auto_submit: false })

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('a persisted final-human-review preference vetoes an otherwise authorized submit', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true, requireHumanReview: true })
    await seedTaskWith(db, { allowAutoSubmit: true, autoSubmitEnabled: true })

    await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('a profile-level Disable during a live run vetoes the irreversible click', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })
    runAutopilot.mockImplementationOnce(async ({ beforeSubmit }) => {
      const row = await db.prepare(
        `SELECT data FROM profile_sections
          WHERE profile_id = ? AND section_key = 'automation_preferences'`,
      ).get(PROFILE)
      const prefs = JSON.parse(row.data)
      prefs.automations.hamilton_auto_submit = false
      await db.prepare(
        `UPDATE profile_sections SET data = ?
          WHERE profile_id = ? AND section_key = 'automation_preferences'`,
      ).run(JSON.stringify(prefs), PROFILE)

      const boundary = await beforeSubmit()
      expect(boundary).toMatchObject({
        allow: false,
        reason: 'profile_auto_submit_disabled',
      })
      return {
        status: 'completed_draft',
        submit_withheld_reason: boundary.reason,
        filled_fields: [],
        pages_visited: 1,
        trace: [],
      }
    })

    const result = await runSource(db)

    expect(result.task.status).toBe('waiting_for_review')
    expect(result.task.allow_auto_submit).toBe(true)
    expect(result.autopilot_result.submit_withheld_reason).toBe('profile_auto_submit_disabled')
  })

  it('a concurrent submitted-stage transition vetoes the irreversible click', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })
    runAutopilot.mockImplementationOnce(async ({ beforeSubmit }) => {
      await db.prepare('UPDATE grants SET status = ? WHERE id = ?')
        .run('submitted', 'g-1')

      const boundary = await beforeSubmit()
      expect(boundary).toMatchObject({
        allow: false,
        reason: 'pipeline_stage_protected',
        pipeline_stage: 'submitted',
      })
      return {
        status: 'completed_draft',
        submit_withheld_reason: boundary.reason,
        filled_fields: [],
        pages_visited: 1,
        trace: [],
      }
    })

    const result = await runSource(db)

    expect(result.task.status).toBe('waiting_for_review')
    expect(result.autopilot_result.submit_withheld_reason).toBe('pipeline_stage_protected')
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((event) => event.event_type === 'submitted')).toBeFalsy()
  })

  it('refuses an opportunity-only selection whose authoritative grant is submitted', async () => {
    const db = makeDb()
    await seedFixture(db)
    await db.prepare('UPDATE grants SET status = ? WHERE id = ?')
      .run('submitted', 'g-1')

    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: { opportunity_id: 'opp-1', current_stage: 'saved' },
      options: { allow_auto_submit: true },
    })

    expect(result).toMatchObject({
      task: null,
      skipped: true,
      reason: 'pipeline_stage_protected',
      pipeline_stage: 'submitted',
    })
    expect(runAutopilot).not.toHaveBeenCalled()
  })

  it('rejects a grant paired with a different opportunity before task creation', async () => {
    const db = makeDb()
    await seedFixture(db)

    await expect(automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: {
        grant_id: 'g-1',
        opportunity_id: 'opp-different',
        current_stage: 'saved',
      },
      options: { allow_auto_submit: true },
    })).rejects.toMatchObject({
      code: 'source_identity_mismatch',
      status: 409,
    })

    expect(runAutopilot).not.toHaveBeenCalled()
  })

  it('binds an opportunity-only run to its grant and rechecks it at submit time', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    runAutopilot.mockImplementationOnce(async ({ beforeSubmit }) => {
      await db.prepare('UPDATE grants SET status = ? WHERE id = ?')
        .run('submitted', 'g-1')

      const boundary = await beforeSubmit()
      expect(boundary).toMatchObject({
        allow: false,
        reason: 'pipeline_stage_protected',
        pipeline_stage: 'submitted',
      })
      return {
        status: 'completed_draft',
        submit_withheld_reason: boundary.reason,
        filled_fields: [],
        pages_visited: 1,
        trace: [],
      }
    })

    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: { opportunity_id: 'opp-1', current_stage: 'saved' },
      options: { allow_auto_submit: true },
    })

    expect(result.task.grant_id).toBe('g-1')
    expect(result.autopilot_result.submit_withheld_reason).toBe('pipeline_stage_protected')
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((event) => event.event_type === 'submitted')).toBeFalsy()
  })

  // OWNER RULE 2026-08-03: "auto submit should mean auto submit. No more, no
  // less." An unapproved (or absent) tailored record no longer withholds an
  // authorized submit; only genuine incompleteness (missing required
  // questions) still does.
  it('an authorized card with NO approved tailored record now SUBMITS (gate default ON)', async () => {
    // No HAMILTON_TAILORED_APPROVAL_GATE override → gate enforced.
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })

    const result = await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(true)
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((e) => e.step === 'auto_submit_gate')).toBeFalsy()
  })

  // SUPERSEDED CONTRACT. This case used to assert the opposite — "withholds
  // final Submit on every real host until a reviewed executable adapter
  // exists" — which pinned the 2026-08-06 controlled-beta boundary where the
  // reserved `hamilton-submit-fixture.invalid` origin was the only thing
  // Hamilton could open. The owner retired that on 2026-08-20 ("full
  // automation means full automation";
  // docs/agent-sync/2026-08-20-hamilton-real-portal-submit.md: "Do not
  // re-impose fixture-only controlled-beta refuse for real public HTTPS"), so
  // an authorized card on a real public HTTPS portal must now actually reach
  // the engine WITH the submit grant forwarded.
  it('reaches a real public HTTPS portal and carries the authorized submit grant', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await db.prepare('UPDATE funding_opportunities SET application_url = ? WHERE id = ?')
      .run('https://portal.example.org/apply', 'opp-1')
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })

    const result = await runSource(db)

    expect(runAutopilot).toHaveBeenCalledTimes(1)
    expect(runAutopilot.mock.calls[0][0].url).toBe('https://portal.example.org/apply')
    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(true)
    expect(result.skipped_browser).toBeFalsy()
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((event) => /Browser automation skipped/i.test(event.message || ''))).toBeFalsy()
  })

  // The SSRF floor is what the fixture-only boundary is NOT. A target Hamilton
  // must never open in a server browser still degrades to the lawful packet,
  // with the skip recorded — so "full automation" never became "any address".
  it('still withholds the browser (and packets instead) for an unsafe non-public target', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await db.prepare('UPDATE funding_opportunities SET application_url = ? WHERE id = ?')
      .run('http://127.0.0.1:8080/apply', 'opp-1')
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })

    const result = await runSource(db)

    expect(runAutopilot).not.toHaveBeenCalled()
    expect(['waiting_for_review', 'blocked']).toContain(result.task.status)
    expect(result.task.last_agent_message).toMatch(/browser automation|packet/i)
    const events = await listTaskEvents(db, result.task.id)
    if (result.task.status === 'waiting_for_review') {
      expect(events.find((event) => /Browser automation skipped/i.test(event.message || ''))).toBeTruthy()
    }
  })

  it('the gate STILL withholds for missing required questions (completeness, not approval)', async () => {
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })
    const { ensureTailoredApplicationsTable } = await import('../services/hamilton/tailoredApplicationStore.js')
    await ensureTailoredApplicationsTable(db)
    await db.prepare(
      `INSERT INTO tailored_applications (id, profile_id, grant_id, status, fields_json, missing_questions_json, funder_requirements_json)
       VALUES ('ta-1', ?, 'g-1', 'pending', '{}', ?, '[]')`,
    ).run(PROFILE, JSON.stringify([{ question: 'Requires a nomination letter — who is the nominator?' }]))

    const result = await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
    const events = await listTaskEvents(db, result.task.id)
    const gateEvent = events.find((e) => e.step === 'auto_submit_gate')
    expect(gateEvent).toBeTruthy()
    expect(gateEvent.message).toMatch(/missing_info/)
  })
})

// ── 3. Submission evidence honesty ─────────────────────────────────────────

describe('submission evidence honesty', () => {
  it('a portal-issued reference is reported as portal-confirmed receipt', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })
    runAutopilot.mockImplementationOnce(async ({ beforeSubmit }) => {
      const boundary = await beforeSubmit()
      expect(boundary.allow).toBe(true)
      return {
        status: 'submitted',
        submission_attempt_started: true,
        submit_clicked: true,
        confirmation_evidence: 'portal_reference',
        confirmation_reference: 'CONF-12345',
        confirmation_reference_is_new: true,
        confirmation_screenshot_path: '/tmp/shot.png',
        filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
        pages_visited: 2,
        trace: [],
      }
    })

    const result = await runSource(db)

    expect(result.task.status).toBe('submitted')
    const events = await listTaskEvents(db, result.task.id)
    const submittedEvent = events.find((e) => e.event_type === 'submitted')
    expect(submittedEvent.message).toMatch(/portal confirmed receipt/i)
    expect(submittedEvent.message).toContain('CONF-12345')
    expect(submittedEvent.details?.confirmation_evidence).toBe('portal_reference')
  })

  it('a screenshot-only capture is submit_unconfirmed and never marks the task submitted', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })
    runAutopilot.mockImplementationOnce(async ({ beforeSubmit }) => {
      const boundary = await beforeSubmit()
      expect(boundary.allow).toBe(true)
      return {
        status: 'submitted',
        submission_attempt_started: true,
        submit_clicked: true,
        confirmation_evidence: 'attempt_evidence',
        confirmation_reference: null,
        confirmation_screenshot_path: '/tmp/shot.png',
        filled_fields: [{ key: 'essay', fid: 'f1', value: 'x' }],
        pages_visited: 2,
        trace: [],
      }
    })

    const result = await runSource(db)

    expect(result.task.status).toBe('submission_verification_required')
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((e) => e.event_type === 'submitted')).toBeFalsy()
    expect(result.autopilot_result.blocker_kind).toBe('submission_verification_required')

    const retry = await runSource(db)
    expect(retry.task.status).toBe('submission_verification_required')
    expect(retry.blocker_kind).toBe('submission_verification_required')
    expect(runAutopilot).toHaveBeenCalledTimes(1)
  })

  it('a legacy engine cannot claim submitted without acquiring the durable submit lease', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedStoredAuthorization(db, { submit: true })
    await seedTaskWith(db, { allowAutoSubmit: true })
    // Deliberately bypasses beforeSubmit, as the retired legacy path did.
    runAutopilot.mockResolvedValueOnce({
      status: 'submitted',
      submit_clicked: true,
      confirmation_evidence: 'portal_reference',
      confirmation_reference: 'SPOOF-12345',
      confirmation_reference_is_new: true,
      filled_fields: [],
      pages_visited: 1,
      trace: [],
    })

    const result = await runSource(db)

    expect(result.task.status).toBe('submission_verification_required')
    expect(result.autopilot_result.blocker_kind).toBe('submission_verification_required')
    expect(result.autopilot_result.blocker_detail).toMatch(/authorization lease/i)
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((event) => event.event_type === 'submitted')).toBeFalsy()
  })

  it('engine: a submit click with NO captured evidence is a blocker, never a submission', () => {
    const { assessSubmissionEvidence } = engineInternal
    expect(assessSubmissionEvidence({ reference: 'CONF-1', screenshot_path: null }))
      .toEqual({ ok: true, confirmation_evidence: 'portal_reference' })
    expect(assessSubmissionEvidence({ reference: null, screenshot_path: '/tmp/s.png' }))
      .toEqual({ ok: false, confirmation_evidence: 'attempt_evidence' })
    expect(assessSubmissionEvidence({
      reference: null,
      screenshot_path: '/tmp/s.png',
      received_acknowledgement: true,
    }, { received_acknowledgement: false }))
      .toEqual({ ok: true, confirmation_evidence: 'portal_acknowledgement' })
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
