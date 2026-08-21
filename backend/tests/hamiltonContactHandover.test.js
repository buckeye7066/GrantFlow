/**
 * PHASE 2 of the portal identity policy — the contact handover.
 *
 * `handoverIdentity()` was written, tested and had ZERO callers, so phase 2
 * never happened: Hamilton registered every account under his own email and
 * phone (that is what makes unattended signup possible) and then never handed
 * the contact details back. `resolveIdentityEmail` even carried a comment
 * promising the write-back.
 *
 * These tests cover the driver that now runs from the ONE point where a
 * submission is durably confirmed. They assert the three things that matter:
 * the off-state changes nothing, the debt is DURABLE and VISIBLE rather than
 * silently skipped, and a handover is never CLAIMED as done when no portal edit
 * was performed.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import { HAMILTON_IDENTITY } from '../config/hamiltonIdentity.js'
import {
  runContactHandoverAfterSubmission,
  buildHandoverPlan,
  reviewedPortalProfileEditEnabled,
  NO_EDIT_ADAPTER_BLOCKER,
} from '../services/hamilton/hamiltonContactHandover.js'
import {
  _resetCredentialSchemaCache,
  listCredentialsForProfile,
  listCredentialsAwaitingHandover,
  markContactHandoverComplete,
} from '../services/hamilton/hamiltonPortalCredentialService.js'
import {
  _resetAuthSchemaCache,
  recordAuthorizations,
} from '../services/hamilton/hamiltonAuthorizationStore.js'
import { ensureApplicationTaskSchema, listTaskEvents } from '../services/hamilton/applicationTaskStore.js'

const PROFILE_ID = 'profile-handover-1'
const TASK_ID = 'task-handover-1'
const HOST = 'awardspring.com'
const CONSENT_TEXT = 'I authorize Hamilton to act on my behalf.'

const APPLICANT = {
  basic_information: { first_name: 'Dana', last_name: 'Reyes', email: 'dana.reyes@example.org' },
  email: 'dana.reyes@example.org',
  phone: '(615) 555-0134',
}

let db

async function grantFullAutomation() {
  await recordAuthorizations(db, {
    userId: 'user-owner',
    profileId: PROFILE_ID,
    scope: 'profile',
    authorizationTypes: ['submit_applications', 'use_saved_credentials_reference'],
    authorizationText: CONSENT_TEXT,
    options: { allow_auto_submit: true, require_human_review: false },
    replaceOmittedTypes: true,
  })
}

async function grantWithoutFullAutomation() {
  await recordAuthorizations(db, {
    userId: 'user-owner',
    profileId: PROFILE_ID,
    scope: 'profile',
    authorizationTypes: ['use_saved_credentials_reference'],
    authorizationText: CONSENT_TEXT,
    replaceOmittedTypes: true,
  })
}

async function seedAccount({ pendingRegistration = false } = {}) {
  await db.prepare(
    `INSERT INTO hamilton_portal_credentials
       (id, user_id, profile_id, portal_host, login_url, username, pending_registration, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
  ).run('cred-1', 'user-owner', PROFILE_ID, HOST, `https://${HOST}/login`,
    HAMILTON_IDENTITY.email, pendingRegistration ? 1 : 0)
}

// The production db wrapper is ASYNC: prepare(sql).get(...) returns a Promise.
async function readAccount() {
  return db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get('cred-1')
}

// ONE db for the file. `ensureApplicationTaskSchema` memoizes on a module-level
// boolean with no reset hook, so a fresh :memory: db per test would silently
// skip the CREATE TABLE and every test would die on "no such table".
beforeAll(async () => {
  _resetCredentialSchemaCache()
  _resetAuthSchemaCache()
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, display_name TEXT);
    INSERT INTO profiles (id, user_id) VALUES ('${PROFILE_ID}', 'user-owner');
    INSERT INTO users (id, primary_email) VALUES ('user-owner', 'dana.reyes@example.org');
  `)
  db = wrapSqlite(sqlite)
  await ensureApplicationTaskSchema(db)
  // Touch the credential service so it creates hamilton_portal_credentials WITH
  // the handover_* columns this feature adds.
  await listCredentialsForProfile(db, PROFILE_ID)
})

beforeEach(async () => {
  for (const t of ['application_task_events', 'application_tasks', 'hamilton_portal_credentials', 'hamilton_authorizations']) {
    try { await db.prepare(`DELETE FROM ${t}`).run() } catch { /* table may not exist yet */ }
  }
  await db.prepare(
    `INSERT INTO application_tasks (id, user_id, profile_id, status) VALUES (?, ?, ?, 'submitted')`,
  ).run(TASK_ID, 'user-owner', PROFILE_ID)
  await seedAccount()
})

describe('the handover PLAN', () => {
  it('makes the applicant primary and KEEPS Hamilton as secondary', () => {
    const plan = buildHandoverPlan({
      profile: APPLICANT,
      account: { username: HAMILTON_IDENTITY.email, pending_registration: 0 },
      fullAutomation: true,
    })
    expect(plan.ready).toBe(true)
    expect(plan.primary.email).toBe('dana.reyes@example.org')
    expect(plan.primary.phone).toBe('(615) 555-0134')
    // Losing Hamilton's contact would lose his submission access — the whole
    // reason the handover keeps him on as secondary rather than replacing him.
    expect(plan.secondary.email).toBe(HAMILTON_IDENTITY.email)
    expect(plan.secondary.phone).toBe(HAMILTON_IDENTITY.phone)
    expect(plan.secondary.role).toBe('secondary_contact')
  })

  it('is NOT ready while the account is still unregistered', () => {
    const plan = buildHandoverPlan({
      profile: APPLICANT,
      account: { username: HAMILTON_IDENTITY.email, pending_registration: 1 },
      fullAutomation: true,
    })
    expect(plan.ready).toBe(false)
    expect(plan.blockers.join(' ')).toMatch(/not been created/)
  })
})

describe('the handover DRIVER at a confirmed submission', () => {
  it('OFF-STATE: with full automation off, nothing runs and nothing is written', async () => {
    await grantWithoutFullAutomation()
    const out = await runContactHandoverAfterSubmission(db, {
      profileId: PROFILE_ID, taskId: TASK_ID, userId: 'user-owner',
      portalUrl: `https://${HOST}/apply`, profile: APPLICANT,
    })
    expect(out.ran).toBe(false)
    expect(out.reason).toMatch(/full automation is not enabled/)
    expect((await readAccount()).handover_status).toBeNull()
    expect(await listCredentialsAwaitingHandover(db)).toHaveLength(0)
    expect(await listTaskEvents(db, TASK_ID)).toHaveLength(0)
  })

  it('records an EXPLICIT, VISIBLE pending state — never a silent skip', async () => {
    await grantFullAutomation()
    const out = await runContactHandoverAfterSubmission(db, {
      profileId: PROFILE_ID, taskId: TASK_ID, userId: 'user-owner',
      portalUrl: `https://${HOST}/apply`, profile: APPLICANT,
    })
    expect(out.ran).toBe(true)
    expect(out.state).toBe('pending')
    expect(out.applied).toBe(false)

    // DURABLE: the debt is on the account row, with the plan preserved.
    const row = await readAccount()
    expect(row.handover_status).toBe('pending')
    expect(row.handover_blocker).toBe(NO_EDIT_ADAPTER_BLOCKER)
    const plan = JSON.parse(row.handover_plan_json)
    expect(plan.primary.email).toBe('dana.reyes@example.org')
    expect(plan.secondary.email).toBe(HAMILTON_IDENTITY.email)

    // VISIBLE: enumerable as owed work, and on the task timeline.
    const owed = await listCredentialsAwaitingHandover(db, { profileId: PROFILE_ID })
    expect(owed).toHaveLength(1)
    expect(owed[0].handover_plan.primary.email).toBe('dana.reyes@example.org')

    const events = await listTaskEvents(db, TASK_ID)
    expect(events).toHaveLength(1)
    expect(events[0].step).toBe('contact_handover')
    const details = events[0].details
    expect(details.handover_state).toBe('pending')
    expect(details.primary_email).toBe('dana.reyes@example.org')
    expect(details.secondary_email).toBe(HAMILTON_IDENTITY.email)
  })

  it('NEVER claims the handover happened while no edit adapter exists', async () => {
    // The honest state of this release: Hamilton can create a portal account but
    // cannot yet edit one. If this flips to true, a reviewed per-host adapter
    // and a controlled-beta boundary permitting the host must exist first.
    expect(reviewedPortalProfileEditEnabled()).toBe(false)
    await grantFullAutomation()
    await runContactHandoverAfterSubmission(db, {
      profileId: PROFILE_ID, taskId: TASK_ID, portalUrl: `https://${HOST}/apply`, profile: APPLICANT,
    })
    const row = await readAccount()
    expect(row.handover_status).not.toBe('completed')
    expect(row.handover_completed_at).toBeNull()
  })

  it('records a BLOCKED debt with a stated cause when the plan cannot be built', async () => {
    await grantFullAutomation()
    // A profile with no email has nothing to hand the account over TO.
    const out = await runContactHandoverAfterSubmission(db, {
      profileId: PROFILE_ID, taskId: TASK_ID, portalUrl: `https://${HOST}/apply`,
      profile: { basic_information: { first_name: 'Dana' } },
    })
    expect(out.state).toBe('blocked')
    const row = await readAccount()
    expect(row.handover_status).toBe('blocked')
    expect(row.handover_blocker).toMatch(/no email/)
    // Still enumerable — a blocked debt is owed work, not a dropped one.
    expect(await listCredentialsAwaitingHandover(db)).toHaveLength(1)
  })

  it('drives a reviewed adapter and completes when one really applies the edit', async () => {
    await grantFullAutomation()
    const editPortalProfile = vi.fn(async () => ({ applied: true }))
    const out = await runContactHandoverAfterSubmission(db, {
      profileId: PROFILE_ID, taskId: TASK_ID, portalUrl: `https://${HOST}/apply`,
      profile: APPLICANT, editPortalProfile,
    })
    if (reviewedPortalProfileEditEnabled()) {
      expect(out.applied).toBe(true)
      expect(editPortalProfile).toHaveBeenCalledOnce()
      expect((await readAccount()).handover_status).toBe('completed')
    } else {
      // The seam is present but the gate is shut, so the adapter is NOT driven
      // and nothing is claimed. This is the release's honest state.
      expect(editPortalProfile).not.toHaveBeenCalled()
      expect(out.applied).toBe(false)
      expect(out.state).toBe('pending')
    }
  })

  it('is idempotent and never re-opens a COMPLETED handover', async () => {
    await grantFullAutomation()
    await runContactHandoverAfterSubmission(db, {
      profileId: PROFILE_ID, taskId: TASK_ID, portalUrl: `https://${HOST}/apply`, profile: APPLICANT,
    })
    await markContactHandoverComplete(db, 'cred-1')
    const out = await runContactHandoverAfterSubmission(db, {
      profileId: PROFILE_ID, taskId: TASK_ID, portalUrl: `https://${HOST}/apply`, profile: APPLICANT,
    })
    expect(out.ran).toBe(false)
    expect(out.reason).toMatch(/already completed/)
    expect((await readAccount()).handover_status).toBe('completed')
    expect(await listCredentialsAwaitingHandover(db)).toHaveLength(0)
  })

  it('says so plainly when there is no Hamilton-managed account on the host', async () => {
    await grantFullAutomation()
    const out = await runContactHandoverAfterSubmission(db, {
      profileId: PROFILE_ID, taskId: TASK_ID, portalUrl: 'https://some-other-portal.org/apply', profile: APPLICANT,
    })
    expect(out.ran).toBe(false)
    expect(out.reason).toMatch(/no Hamilton-managed portal account/)
  })

  it('NEVER throws — a handover problem cannot un-confirm a real submission', async () => {
    await grantFullAutomation()
    const brokenDb = { prepare: () => { throw new Error('db gone') } }
    const out = await runContactHandoverAfterSubmission(brokenDb, {
      profileId: PROFILE_ID, taskId: TASK_ID, portalUrl: `https://${HOST}/apply`, profile: APPLICANT,
    })
    expect(out.ran).toBe(false)
    expect(typeof out.reason).toBe('string')
  })
})
