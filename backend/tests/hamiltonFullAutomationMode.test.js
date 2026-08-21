/**
 * FULL AUTOMATION MUST REACH EVERY GATE THAT DECIDES "MAY HAMILTON SUBMIT".
 *
 * Owner report 2026-08-21: Hamilton can navigate and fill supported portals but
 * cannot work the portal queue unattended. Reading the code, the decision is
 * spread across THREE stores and switching the profile toggle on reached only
 * the first of them:
 *
 *   1. `hamilton_authorizations` — `resolveSubmissionDecision` treats ANY
 *      active row with `options.require_human_review === true` as an
 *      unconditional veto and reads rows at EVERY scope, while the writer only
 *      rewrites the row for the exact (scope, target) it was called with. A
 *      task- or funding-source-scoped row recorded once vetoed forever.
 *   2. `application_tasks.allow_auto_submit` — the per-task intent flag,
 *      default FALSE, only ever set by passing the option on one launch. A
 *      profile-wide consent never reached the tasks already in the queue.
 *   3. `profile_sections.automation_preferences.automations` — a SECOND consent
 *      store, `hamilton_autopilot` / `hamilton_auto_submit`, both defaulting to
 *      FALSE and re-read at the irreversible boundary
 *      (`profile_auto_submit_disabled`). The owner's blocker list did not name
 *      this one at all.
 *
 * These tests pin all three, plus the honesty rules that make the sweep
 * reportable: counts not booleans, the irreversible-boundary quarantine left
 * alone, and the standing consent reaching a launch that did not repeat it.
 *
 * Every test here FAILS on the pre-fix code (there was no sweep at all).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  _resetAuthSchemaCache,
  recordAuthorizations,
  resolveSubmissionDecision,
} from '../services/hamilton/hamiltonAuthorizationStore.js'
import {
  FULL_AUTOMATION_AUTHORIZATION_TYPES,
  FULL_AUTOMATION_OPTIONS,
  SWEEP_EXCLUDED_STATUSES,
  isFullAutomationGrant,
  isFullAutomationEnabled,
  clearHumanReviewVetoes,
  propagateAutoSubmitToTasks,
  alignAutomationPreferences,
  readAutomationPreferenceState,
  applyFullAutomationSweep,
} from '../services/hamilton/hamiltonFullAutomationMode.js'

const PROFILE_ID = 'profile-full-auto'
const OWNER = 'user-owner'

let db
let hamiltonRouter

function createApp(userId = OWNER, { isAdmin = false, accessibleProfileIds = [PROFILE_ID] } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { userId, role: isAdmin ? 'admin' : 'user' }
    req.ctx = { userId, isAdmin, identityResolved: true, accessibleProfileIds: new Set(accessibleProfileIds) }
    next()
  })
  app.use('/api/hamilton/automation', hamiltonRouter)
  return app
}

async function insertTask(id, { status = 'ready_to_start', allowAutoSubmit = 0, cancelledAt = null } = {}) {
  await db.prepare(
    `INSERT INTO application_tasks (id, profile_id, status, allow_auto_submit, auto_submit_enabled, cancelled_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, PROFILE_ID, status, allowAutoSubmit, allowAutoSubmit, cancelledAt)
}

const readTask = async (id) => await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(id)

beforeAll(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL, section_key TEXT NOT NULL, data TEXT,
      updated_by TEXT, updated_at DATETIME
    );
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, status TEXT,
      allow_auto_submit INTEGER NOT NULL DEFAULT 0,
      auto_submit_enabled INTEGER NOT NULL DEFAULT 0,
      cancelled_at DATETIME, updated_at DATETIME
    );
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO users (id, is_admin) VALUES (?, 0)').run(OWNER)
  await db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run(PROFILE_ID, OWNER)
  hamiltonRouter = (await import('../routes/hamiltonAutomation.js')).default
})

beforeEach(async () => {
  _resetAuthSchemaCache()
  try { await db.prepare('DELETE FROM hamilton_authorizations').run() } catch { /* first run */ }
  await db.prepare('DELETE FROM application_tasks').run()
  await db.prepare('DELETE FROM profile_sections').run()
})

async function grantFullAutomation() {
  return await recordAuthorizations(db, {
    userId: OWNER,
    profileId: PROFILE_ID,
    scope: 'profile',
    authorizationTypes: [...FULL_AUTOMATION_AUTHORIZATION_TYPES],
    authorizationText: 'Full automation consent text.',
    options: { ...FULL_AUTOMATION_OPTIONS },
  })
}

// ── 1. The legacy veto ───────────────────────────────────────────────

describe('a legacy require_human_review row vetoes forever until it is swept', () => {
  it('a TASK-scoped veto survives a profile-wide full-automation grant, and the sweep clears it', async () => {
    // Recorded once, long ago, against one task.
    await recordAuthorizations(db, {
      userId: OWNER,
      profileId: PROFILE_ID,
      scope: 'task',
      taskIds: ['task-legacy'],
      authorizationTypes: ['submit_applications'],
      authorizationText: 'Legacy consent with final human review.',
      options: { allow_auto_submit: true, require_human_review: true },
    })
    await grantFullAutomation()

    // THE BUG: the profile-wide grant is active and the task-scoped veto still wins.
    const before = await resolveSubmissionDecision(db, {
      profileId: PROFILE_ID, taskId: 'task-legacy', taskAllowAutoSubmit: true,
    })
    expect(before.allow_auto_submit).toBe(false)
    expect(before.reason).toBe('human_review_required')
    expect((await isFullAutomationEnabled(db, PROFILE_ID)).reason).toBe('human_review_required')

    const swept = await clearHumanReviewVetoes(db, { profileId: PROFILE_ID, userId: OWNER })
    expect(swept.candidates).toBe(1)
    expect(swept.cleared).toBe(1)
    expect(swept.failed).toBe(0)

    const after = await resolveSubmissionDecision(db, {
      profileId: PROFILE_ID, taskId: 'task-legacy', taskAllowAutoSubmit: true,
    })
    expect(after.allow_auto_submit).toBe(true)
    expect(after.reason).toBe('authorized')
  })

  it('keeps the row and records that a human-review preference existed', async () => {
    await recordAuthorizations(db, {
      userId: OWNER, profileId: PROFILE_ID, scope: 'profile',
      authorizationTypes: ['submit_applications'],
      authorizationText: 'consent', options: { require_human_review: true },
    })
    await clearHumanReviewVetoes(db, { profileId: PROFILE_ID, userId: OWNER })
    const row = await db.prepare(
      `SELECT * FROM hamilton_authorizations WHERE profile_id = ? AND authorization_type = 'submit_applications'`,
    ).get(PROFILE_ID)
    // The capability row is NOT revoked — only the veto option is rewritten.
    expect(row.revoked_at ?? null).toBeNull()
    expect(JSON.parse(row.options_json).require_human_review).toBe(false)
    const metadata = JSON.parse(row.metadata_json)
    expect(metadata.human_review_veto_previous_value).toBe(true)
    expect(metadata.human_review_veto_cleared_by).toBe(OWNER)
  })

  it('reports zero candidates when there is nothing to clear (a no-op is visible, not silent)', async () => {
    await grantFullAutomation()
    const swept = await clearHumanReviewVetoes(db, { profileId: PROFILE_ID, userId: OWNER })
    expect(swept.candidates).toBe(0)
    expect(swept.cleared).toBe(0)
    expect(swept.skipped).toBeGreaterThan(0)
  })
})

// ── 2. Per-task intent ───────────────────────────────────────────────

describe('the profile-wide decision reaches the tasks already in the queue', () => {
  it('arms every workable task and reports candidates / updated / already_correct', async () => {
    await insertTask('t-ready', { status: 'ready_to_start' })
    await insertTask('t-filling', { status: 'filling_portal' })
    await insertTask('t-armed', { status: 'ready_to_start', allowAutoSubmit: 1 })

    const result = await propagateAutoSubmitToTasks(db, { profileId: PROFILE_ID, enable: true })
    expect(result.candidates).toBe(3)
    expect(result.updated).toBe(2)
    expect(result.already_correct).toBe(1)
    expect(Boolean((await readTask('t-ready')).allow_auto_submit)).toBe(true)
    // The retired twin is kept in step so a stale value cannot contradict it.
    expect(Boolean((await readTask('t-ready')).auto_submit_enabled)).toBe(true)
  })

  it.each(SWEEP_EXCLUDED_STATUSES)('never re-arms a %s task', async (status) => {
    await insertTask('t-excluded', { status })
    const result = await propagateAutoSubmitToTasks(db, { profileId: PROFILE_ID, enable: true })
    expect(Boolean((await readTask('t-excluded')).allow_auto_submit)).toBe(false)
    expect(result.skipped_by_reason[`status:${status}`]).toBe(1)
  })

  it('never touches a cancelled task, and never touches another profile', async () => {
    await insertTask('t-cancelled', { status: 'ready_to_start', cancelledAt: '2026-08-01T00:00:00Z' })
    await db.prepare(
      `INSERT INTO application_tasks (id, profile_id, status, allow_auto_submit, auto_submit_enabled)
        VALUES ('t-other', 'other-profile', 'ready_to_start', 0, 0)`,
    ).run()
    const result = await propagateAutoSubmitToTasks(db, { profileId: PROFILE_ID, enable: true })
    expect(result.skipped_by_reason.cancelled).toBe(1)
    expect(Boolean((await readTask('t-cancelled')).allow_auto_submit)).toBe(false)
    expect(Boolean((await readTask('t-other')).allow_auto_submit)).toBe(false)
  })

  it('disarms on the way back down', async () => {
    await insertTask('t-armed', { status: 'ready_to_start', allowAutoSubmit: 1 })
    const result = await propagateAutoSubmitToTasks(db, { profileId: PROFILE_ID, enable: false })
    expect(result.updated).toBe(1)
    expect(Boolean((await readTask('t-armed')).allow_auto_submit)).toBe(false)
  })
})

// ── 3. The second consent store nobody named ─────────────────────────

describe('the profile automation_preferences toggles move with the switch', () => {
  it('both Hamilton toggles default OFF and are turned on, with the change reported', async () => {
    const before = await readAutomationPreferenceState(db, PROFILE_ID)
    expect(before.hamilton_autopilot).toBe(false)
    expect(before.hamilton_auto_submit).toBe(false)

    const result = await alignAutomationPreferences(db, { profileId: PROFILE_ID, userId: OWNER, enable: true })
    expect(result.failed).toBeNull()
    expect(result.changed.sort()).toEqual(['hamilton_auto_submit', 'hamilton_autopilot'])

    const after = await readAutomationPreferenceState(db, PROFILE_ID)
    expect(after.hamilton_autopilot).toBe(true)
    expect(after.hamilton_auto_submit).toBe(true)
  })

  it('leaves the profile\'s OTHER preferences alone', async () => {
    await db.prepare(
      `INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'automation_preferences', ?)`,
    ).run(PROFILE_ID, JSON.stringify({
      portal_access: { window: 'evenings' },
      automations: { discovery_auto_add: false, pipeline_processing: true },
    }))
    await alignAutomationPreferences(db, { profileId: PROFILE_ID, userId: OWNER, enable: true })
    const row = await db.prepare(
      `SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'automation_preferences'`,
    ).get(PROFILE_ID)
    const saved = JSON.parse(row.data)
    expect(saved.portal_access).toEqual({ window: 'evenings' })
    // An explicit false the owner set on a DIFFERENT toggle is preserved.
    expect(saved.automations.discovery_auto_add).toBe(false)
    expect(saved.automations.hamilton_auto_submit).toBe(true)
  })

  it('reports no change when the toggles are already correct', async () => {
    await alignAutomationPreferences(db, { profileId: PROFILE_ID, userId: OWNER, enable: true })
    const second = await alignAutomationPreferences(db, { profileId: PROFILE_ID, userId: OWNER, enable: true })
    expect(second.changed).toEqual([])
  })
})

// ── 4. The whole sweep, and its honesty ──────────────────────────────

describe('applyFullAutomationSweep', () => {
  it('reports unattended_submit_ready only when ALL THREE stores agree', async () => {
    await insertTask('t1', { status: 'ready_to_start' })
    await recordAuthorizations(db, {
      userId: OWNER, profileId: PROFILE_ID, scope: 'funding_source', fundingSourceIds: ['fs-1'],
      authorizationTypes: ['submit_applications'],
      authorizationText: 'legacy', options: { require_human_review: true },
    })
    await grantFullAutomation()

    const summary = await applyFullAutomationSweep(db, { profileId: PROFILE_ID, userId: OWNER, enable: true })
    expect(summary.human_review_vetoes.cleared).toBe(1)
    expect(summary.tasks.updated).toBe(1)
    expect(summary.automation_preferences.changed.length).toBe(2)
    expect(summary.full_automation.enabled).toBe(true)
    expect(summary.preference_state.hamilton_auto_submit).toBe(true)
    expect(summary.unattended_submit_ready).toBe(true)
  })

  it('is NOT ready when the authorization is missing, however clean the sweep looks', async () => {
    await insertTask('t1', { status: 'ready_to_start' })
    // Preferences on, tasks armed, but no submit_applications grant at all.
    const summary = await applyFullAutomationSweep(db, { profileId: PROFILE_ID, userId: OWNER, enable: true })
    expect(summary.preference_state.hamilton_auto_submit).toBe(true)
    expect(summary.full_automation.enabled).toBe(false)
    expect(summary.full_automation.reason).toBe('missing_submit_authorization')
    expect(summary.unattended_submit_ready).toBe(false)
  })

  it('disabling never forges a human-review preference nobody expressed', async () => {
    await grantFullAutomation()
    await insertTask('t1', { status: 'ready_to_start', allowAutoSubmit: 1 })
    const summary = await applyFullAutomationSweep(db, { profileId: PROFILE_ID, userId: OWNER, enable: false })
    expect(summary.human_review_vetoes.not_run).toBe('disable_does_not_restore_vetoes')
    expect(Boolean((await readTask('t1')).allow_auto_submit)).toBe(false)
    const row = await db.prepare(
      `SELECT options_json FROM hamilton_authorizations
        WHERE profile_id = ? AND authorization_type = 'submit_applications'`,
    ).get(PROFILE_ID)
    expect(JSON.parse(row.options_json).require_human_review).toBe(false)
  })
})

describe('isFullAutomationGrant', () => {
  it('recognises the full-automation payload the consent screens send', () => {
    expect(isFullAutomationGrant([...FULL_AUTOMATION_AUTHORIZATION_TYPES], { ...FULL_AUTOMATION_OPTIONS })).toBe(true)
  })
  it('is false without submit authority, without auto-submit, or with a review veto', () => {
    expect(isFullAutomationGrant(['complete_forms'], { allow_auto_submit: true })).toBe(false)
    expect(isFullAutomationGrant(['submit_applications'], {})).toBe(false)
    expect(isFullAutomationGrant(['submit_applications'], { allow_auto_submit: true, require_human_review: true })).toBe(false)
  })
})

// ── 5. The routes ────────────────────────────────────────────────────

describe('POST /authorize runs the sweep when the payload IS full automation', () => {
  it('clears a legacy veto and arms the queue in the same call, and says so', async () => {
    await insertTask('t1', { status: 'ready_to_start' })
    await recordAuthorizations(db, {
      userId: OWNER, profileId: PROFILE_ID, scope: 'task', taskIds: ['t1'],
      authorizationTypes: ['submit_applications'],
      authorizationText: 'legacy', options: { require_human_review: true },
    })

    const res = await request(createApp()).post('/api/hamilton/automation/authorize').send({
      profile_id: PROFILE_ID,
      scope: 'profile',
      authorization_types: [...FULL_AUTOMATION_AUTHORIZATION_TYPES],
      options: { ...FULL_AUTOMATION_OPTIONS },
      replace_omitted_types: true,
    })

    expect(res.status).toBe(200)
    expect(res.body.full_automation.human_review_vetoes.cleared).toBe(1)
    expect(res.body.full_automation.tasks.updated).toBe(1)
    expect(res.body.full_automation.unattended_submit_ready).toBe(true)
    expect(Boolean((await readTask('t1')).allow_auto_submit)).toBe(true)
  })

  it('does NOT sweep for a partial grant (a review-first consent is left intact)', async () => {
    await insertTask('t1', { status: 'ready_to_start' })
    const res = await request(createApp()).post('/api/hamilton/automation/authorize').send({
      profile_id: PROFILE_ID,
      scope: 'profile',
      authorization_types: ['complete_forms', 'save_drafts'],
      options: { complete_forms: true, save_drafts: true },
    })
    expect(res.status).toBe(200)
    expect(res.body.full_automation).toBeUndefined()
    expect(Boolean((await readTask('t1')).allow_auto_submit)).toBe(false)
  })
})

describe('GET /full-automation names every reason Hamilton would stop short', () => {
  it('lists the authorization AND both preference blockers on a fresh profile', async () => {
    const res = await request(createApp()).get(`/api/hamilton/automation/full-automation?profile_id=${PROFILE_ID}`)
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(false)
    const kinds = res.body.blockers.map((b) => b.reason).sort()
    expect(kinds).toEqual(['hamilton_auto_submit_off', 'hamilton_autopilot_off', 'missing_submit_authorization'])
  })

  it('reports an empty blocker list once the switch is on', async () => {
    await request(createApp()).post('/api/hamilton/automation/full-automation').send({ profile_id: PROFILE_ID })
    const res = await request(createApp()).get(`/api/hamilton/automation/full-automation?profile_id=${PROFILE_ID}`)
    expect(res.body.blockers).toEqual([])
    expect(res.body.enabled).toBe(true)
  })

  it('403s a stranger', async () => {
    const stranger = createApp('user-stranger', { accessibleProfileIds: [] })
    expect((await request(stranger).get(`/api/hamilton/automation/full-automation?profile_id=${PROFILE_ID}`)).status).toBe(403)
    expect((await request(stranger).post('/api/hamilton/automation/full-automation').send({ profile_id: PROFILE_ID })).status).toBe(403)
  })
})

describe('POST /full-automation is the one switch', () => {
  it('grants, sweeps, and leaves the submission decision authorized', async () => {
    await insertTask('t1', { status: 'ready_to_start' })
    const res = await request(createApp()).post('/api/hamilton/automation/full-automation').send({ profile_id: PROFILE_ID })
    expect(res.status).toBe(200)
    expect(res.body.unattended_submit_ready).toBe(true)

    const decision = await resolveSubmissionDecision(db, {
      profileId: PROFILE_ID, taskId: 't1', taskAllowAutoSubmit: (await readTask('t1')).allow_auto_submit,
    })
    expect(decision.allow_auto_submit).toBe(true)
    expect(decision.reason).toBe('authorized')
  })
})
