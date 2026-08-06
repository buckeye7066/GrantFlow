/**
 * Authorized auto-submit leg (owner addendum 2026-08-03): when auto-submit IS
 * authorized, the application must actually go out through the portal's real
 * submit action — "not just internal to grantflow" — for ANY profile type
 * (org ministries included). And truthfully: "clicked submit" and "portal
 * confirmed receipt" are different facts; the record must say which one we
 * have.
 *
 * Pins:
 *   1. Only the current server-side v2 authorization ledger can authorize a
 *      submit. Persisted task booleans and request options can only narrow it.
 *   2. The profile toggle, global kill switch, and a reviewed fixture-backed
 *      portal adapter must all remain current.
 *   3. A generic reference or screenshot is not durable proof. Receipt state
 *      is projected only through the fenced v2 attempt/outbox contract.
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
const { recordAuthorizations } = await import('../services/hamilton/hamiltonAuthorizationStore.js')
const {
  onboardReviewedSubmissionAdapter,
  SYNTHETIC_REFERENCE_ADAPTER,
} = await import('../services/hamilton/hamiltonSubmissionAdapterRegistry.js')
const { contractSha256, stableContractJson } = await import('../../shared/irreversibleActionContract.js')
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
      portal_application_id TEXT,
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
    .run('opp-1', 'Community Ministry Grant', 'Apply through the portal.', 'https://fixture.hamilton.invalid/apply?applicationId=APP-AUTHORIZED-1')
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

function reviewedFixtures(definition) {
  const applicationIdentity = 'fixture-app-123'
  return [
    {
      case: 'new_receipt_success', application_identity: applicationIdentity,
      receipt_application_identity: applicationIdentity, receipt_container_count: 1,
      pre_click_text: 'Review application',
      post_click_text: 'Your application has been received. Confirmation Number: CONF-123456',
      form_observation: {
        field_contract_sha256: contractSha256(stableContractJson(definition.field_contract)),
        required_answer_keys: definition.field_contract.fields.filter((field) => field.required).map((field) => field.answer_key),
      },
    },
    {
      case: 'preexisting_application_id_negative', application_identity: applicationIdentity,
      pre_click_text: 'Application ID: DRAFT-123456', post_click_text: 'Application ID: DRAFT-123456',
    },
    {
      case: 'unchanged_spa_negative', application_identity: applicationIdentity,
      pre_click_text: 'Your application has been received. Confirmation Number: CONF-123456',
      post_click_text: 'Your application has been received. Confirmation Number: CONF-123456',
    },
    { case: 'screenshot_only_negative', application_identity: applicationIdentity },
    { case: 'ambiguous_timeout_negative', application_identity: applicationIdentity },
    {
      case: 'unrelated_receipt_negative', application_identity: applicationIdentity,
      receipt_application_identity: 'fixture-app-other', receipt_container_count: 1,
      post_click_text: 'Your application has been received. Confirmation Number: CONF-OTHER-123',
    },
    {
      case: 'multiple_application_receipts_negative', application_identity: applicationIdentity,
      receipt_application_identity: applicationIdentity, receipt_container_count: 2,
      post_click_text: 'Your application has been received. Confirmation Number: CONF-AMBIG-123',
    },
    {
      case: 'exact_status_absence', application_identity: applicationIdentity,
      status_lookup: {
        application_identity: applicationIdentity, outcome: 'absent',
        query_parameter: definition.status_query.query_parameter, response_sha256: 'f'.repeat(64),
        path_prefix: definition.status_query.path_prefix,
        container_selector_sha256: contractSha256(definition.status_query.container_selector),
        identity_container_match: true, matching_container_count: 1,
        identity_match_count: 1, status_match_count: 1,
      },
    },
  ]
}

async function runSource(db, extraOptions = {}, {
  authorizationTypes = ['complete_forms'],
  reviewedAdapter = true,
} = {}) {
  const task = await ensureApplicationTask(db, {
    profileId: PROFILE, opportunityId: 'opp-1', grantId: 'g-1', automationType: 'portal',
  })
  await recordAuthorizations(db, {
    userId: 'user-1', profileId: PROFILE,
    scope: authorizationTypes.includes('submit_applications') ? 'task' : 'funding_source',
    taskIds: authorizationTypes.includes('submit_applications') ? [task.id] : [],
    fundingSourceIds: authorizationTypes.includes('submit_applications') ? [] : ['opp-1'],
    authorizationTypes,
    options: authorizationTypes.includes('submit_applications')
      ? { allow_auto_submit: true, require_human_review: false }
      : {},
  })
  if (reviewedAdapter) {
    const onboarded = await onboardReviewedSubmissionAdapter(db, {
      portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
      definition: SYNTHETIC_REFERENCE_ADAPTER,
      fixtures: reviewedFixtures(SYNTHETIC_REFERENCE_ADAPTER),
      reviewedByUserId: 'operator-test',
    })
    expect(onboarded.onboarded, JSON.stringify(onboarded.report?.errors)).toBe(true)
  }
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

describe('server-side auto-submit authorization reaches the submit step', () => {
  it('current v2 submit consent plus every live kill switch authorizes the reviewed adapter', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0' // operational escape hatch: isolate the wiring
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, {})

    await runSource(db, {}, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(runAutopilot).toHaveBeenCalledTimes(1)
    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(true)
  })

  it('persisted task/request booleans cannot mint submit authority when the v2 ledger has none', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, { allowAutoSubmit: true, autoSubmitEnabled: true })

    await runSource(db)

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('current submit consent without the global kill switch stays draft-only', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, {})

    await runSource(db, {}, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('an explicit profile toggle-off stays draft-only even with current submit consent', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await db.prepare("UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = 'automation_preferences'")
      .run(JSON.stringify({ automations: { hamilton_auto_submit: false, hamilton_autopilot: true } }), PROFILE)

    await runSource(db, {}, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  it('stops before the engine when explicit and target-query application identities conflict', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await db.prepare('UPDATE funding_opportunities SET portal_application_id = ?, application_url = ? WHERE id = ?')
      .run('APP-EXPLICIT-A', 'https://fixture.hamilton.invalid/apply?applicationId=APP-TARGET-B', 'opp-1')

    const result = await runSource(db, {}, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(runAutopilot).not.toHaveBeenCalled()
    expect(result.reason).toBe('portal_application_identity_conflict')
    expect(result.task.status).toBe('human_action_required')
  })

  it('an explicit batch denial overrides a stored authorization', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, {})

    await runSource(db, { allow_auto_submit: false }, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
  })

  // OWNER RULE 2026-08-03: "auto submit should mean auto submit. No more, no
  // less." An unapproved (or absent) tailored record no longer withholds an
  // authorized submit; only genuine incompleteness (missing required
  // questions) still does.
  it('an authorized card with NO approved tailored record now SUBMITS (gate default ON)', async () => {
    // No HAMILTON_TAILORED_APPROVAL_GATE override → gate enforced.
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, {})

    const result = await runSource(db, {}, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(true)
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((e) => e.step === 'auto_submit_gate')).toBeFalsy()
  })

  it('the gate STILL withholds for missing required questions (completeness, not approval)', async () => {
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, {})
    const { ensureTailoredApplicationsTable } = await import('../services/hamilton/tailoredApplicationStore.js')
    await ensureTailoredApplicationsTable(db)
    await db.prepare(
      `INSERT INTO tailored_applications (id, profile_id, grant_id, status, fields_json, missing_questions_json, funder_requirements_json)
       VALUES ('ta-1', ?, 'g-1', 'pending', '{}', ?, '[]')`,
    ).run(PROFILE, JSON.stringify([{ question: 'Requires a nomination letter — who is the nominator?' }]))

    const result = await runSource(db, {}, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(runAutopilot.mock.calls[0][0].allowAutoSubmit).toBe(false)
    const events = await listTaskEvents(db, result.task.id)
    const gateEvent = events.find((e) => e.step === 'auto_submit_gate')
    expect(gateEvent).toBeTruthy()
    expect(gateEvent.message).toMatch(/missing_info/)
  })
})

// ── 3. Submission evidence honesty ─────────────────────────────────────────

describe('submission evidence honesty', () => {
  it('a legacy engine "submitted" claim with a generic reference is not projected as externally received', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, {})
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

    const result = await runSource(db, {}, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(result.task.status).not.toBe('submitted')
    expect(result.task.status).not.toBe('externally_received')
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((e) => e.event_type === 'submitted')).toBeFalsy()
  })

  it('a screenshot-only legacy claim is never projected as externally received', async () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    const db = makeDb()
    await seedFixture(db)
    await seedTaskWith(db, {})
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

    const result = await runSource(db, {}, { authorizationTypes: ['complete_forms', 'submit_applications'] })

    expect(result.task.status).not.toBe('submitted')
    expect(result.task.status).not.toBe('externally_received')
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((e) => e.event_type === 'submitted')).toBeFalsy()
  })

  it('engine: only a new typed receipt plus acknowledgement and page change passes', () => {
    const { assessSubmissionEvidence } = engineInternal
    expect(assessSubmissionEvidence({ reference: 'CONF-1', screenshot_path: null }))
      .toEqual({ ok: false, confirmation_evidence: 'none' })
    expect(assessSubmissionEvidence({ reference: null, screenshot_path: '/tmp/s.png' }))
      .toEqual({ ok: false, confirmation_evidence: 'none' })
    expect(assessSubmissionEvidence({ reference: null, screenshot_path: null }))
      .toEqual({ ok: false, confirmation_evidence: 'none' })
    expect(assessSubmissionEvidence({
      reference: 'CONF-123456', reference_kind: 'confirmation',
      extraction_rule: 'adapter_exact_label:confirmation', received_acknowledgement: true,
      page_fingerprint: 'b'.repeat(64),
    }, { page_fingerprint: 'a'.repeat(64) }))
      .toEqual({ ok: true, confirmation_evidence: 'portal_reference' })
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
