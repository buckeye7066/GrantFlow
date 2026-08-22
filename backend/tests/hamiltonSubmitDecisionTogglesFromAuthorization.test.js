/**
 * The submit gate honors the PROFILE-WIDE toggle, not only the per-task mirror.
 *
 * Live evidence 2026-08-21 (a real applicant's run): the "Full automation is on"
 * card was showing enabled, yet 100+ tasks sat at `waiting_for_review`
 * ("waiting for me before proceeding"). Root cause: `resolveSubmissionDecision`
 * read auto-submit INTENT only from `application_tasks.allow_auto_submit` — a
 * column the #1312 sweep maintains — while the readiness card
 * (`isFullAutomationEnabled`) reads intent from the AUTHORIZATION row's
 * `allow_auto_submit` option. Any task the sweep never reached (a stale backlog
 * row, or one created after the toggle flipped on) therefore drafted forever
 * while the card said "on".
 *
 * The gate now reads intent from the active authorization too, so the two
 * predicates agree by construction. Every veto still refuses: a
 * `require_human_review` option at any scope, a missing `submit_applications`
 * grant, and (in the caller) the global env kill switch.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  _resetAuthSchemaCache,
  recordAuthorizations,
  resolveSubmissionDecision,
} = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-toggle-intent'
const OWNER = 'user-owner'
const TASK = 't-backlog' // a task whose per-task allow_auto_submit column is FALSE

let db

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, status TEXT,
      allow_auto_submit INTEGER NOT NULL DEFAULT 0,
      auto_submit_enabled INTEGER NOT NULL DEFAULT 0,
      cancelled_at DATETIME, updated_at DATETIME
    );
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run(PROFILE, OWNER)
  _resetAuthSchemaCache()
})

async function grantFullAutomation({ requireHumanReview = false } = {}) {
  return await recordAuthorizations(db, {
    userId: OWNER,
    profileId: PROFILE,
    scope: 'profile',
    authorizationTypes: ['submit_applications', 'complete_forms'],
    authorizationText: 'Full automation consent text.',
    options: { allow_auto_submit: true, require_human_review: requireHumanReview },
  })
}

const decide = () => resolveSubmissionDecision(db, {
  profileId: PROFILE,
  taskId: TASK,
  taskAllowAutoSubmit: false, // the stale backlog case — column never swept
})

describe('resolveSubmissionDecision — the toggle is authoritative intent', () => {
  it('ARMS submission from the authorization even when the per-task column is false', async () => {
    await grantFullAutomation()
    const decision = await decide()
    expect(decision.allow_auto_submit).toBe(true)
    expect(decision.reason).toBe('authorized')
  })

  it('still REFUSES when a require_human_review veto is present at the profile scope', async () => {
    await grantFullAutomation({ requireHumanReview: true })
    const decision = await decide()
    expect(decision.allow_auto_submit).toBe(false)
    expect(decision.reason).toBe('human_review_required')
  })

  it('still REFUSES when there is no submit_applications grant at all', async () => {
    // An authorization that grants allow_auto_submit but NOT submit_applications
    // is not full automation — the submit authority is missing.
    await recordAuthorizations(db, {
      userId: OWNER,
      profileId: PROFILE,
      scope: 'profile',
      authorizationTypes: ['complete_forms'],
      authorizationText: 'Forms only.',
      options: { allow_auto_submit: true },
    })
    const decision = await decide()
    expect(decision.allow_auto_submit).toBe(false)
    expect(decision.reason).toBe('missing_submit_authorization')
  })

  it('REFUSES a profile with no authorization at all (defaults stay OFF)', async () => {
    const decision = await decide()
    expect(decision.allow_auto_submit).toBe(false)
    expect(decision.reason).toBe('not_requested')
  })

  it('still ARMS from the per-task column alone (back-compat with the sweep)', async () => {
    await grantFullAutomation()
    const decision = await resolveSubmissionDecision(db, {
      profileId: PROFILE,
      taskId: TASK,
      taskAllowAutoSubmit: true,
    })
    expect(decision.allow_auto_submit).toBe(true)
  })
})
