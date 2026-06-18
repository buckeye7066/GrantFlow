/**
 * Hamilton Hard-Stop alerting tests.
 *
 * Covers the mandatory dual-notification requirement and the
 * "single canonical admin" routing rule:
 *
 *   - Every unresolved hard stop creates a per-category user
 *     notification AND a per-category admin notification.
 *   - The admin notification ALWAYS goes to the single canonical
 *     operator (buckeye7066@gmail.com); multi-admin fan-out is not
 *     the primary path.
 *   - If no admin row exists yet, resolveAdminUserId creates one.
 *   - Per-category type derivation works for every blocker family.
 *   - Resolved/degraded outcomes do NOT create alerts.
 *   - resolveOpenBlockersForTask + markNotificationsResolved clears
 *     the alert and writes a resolution audit row.
 *   - listOpenAdminBlockers powers the admin dashboard.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  recordAuthorizations,
  _resetAuthSchemaCache,
} from '../../backend/services/hamilton/hamiltonAuthorizationStore.js'
import { _resetCredentialSchemaCache, recordSession } from '../../backend/services/hamilton/hamiltonCredentialSessionService.js'
import { _resetPaymentSchemaCache } from '../../backend/services/hamilton/hamiltonPaymentAuthorizationService.js'
import { _resetAttestationSchemaCache } from '../../backend/services/hamilton/hamiltonAttestationStore.js'
import { _resetPortalPolicySchemaCache } from '../../backend/services/hamilton/hamiltonPortalPolicyRegistry.js'
import { _resetResolvedFieldSchemaCache } from '../../backend/services/hamilton/hamiltonResolvedFieldStore.js'
import {
  _resetBlockerSchemaCache,
  listOpenAdminBlockers,
  resolveOpenBlockersForTask,
  listBlockersForTask,
} from '../../backend/services/hamilton/hamiltonBlockerStore.js'
import { resolveBlocker } from '../../backend/services/hamilton/hamiltonHardStopResolver.js'
import {
  _resetNotificationsSchemaCache,
  _resetAdminAccountCache,
  markNotificationsResolved,
  userTypeForCategory,
  adminTypeForCategory,
} from '../../backend/services/hamilton/hamiltonNotifications.js'
import {
  resolveAdminUserId,
  isAdminUser,
  HAMILTON_ADMIN_EMAIL,
} from '../../backend/services/hamilton/hamiltonAdminAccount.js'

const ADMIN_EMAIL = 'buckeye7066@gmail.com'

function makeDb({ seedAdmin = true } = {}) {
  const sqlite = new Database(':memory:')
  // Match production users schema (id, primary_email, is_admin, display_name)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT, organization_name TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_email TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      role TEXT
    );
  `)
  if (seedAdmin) {
    sqlite.prepare(
      'INSERT INTO users (id, primary_email, is_admin, role) VALUES (?, ?, 1, ?)',
    ).run('u_admin', ADMIN_EMAIL, 'admin')
  }
  return wrapSqlite(sqlite)
}

function resetCaches() {
  _resetAuthSchemaCache()
  _resetCredentialSchemaCache()
  _resetPaymentSchemaCache()
  _resetAttestationSchemaCache()
  _resetPortalPolicySchemaCache()
  _resetResolvedFieldSchemaCache()
  _resetBlockerSchemaCache()
  _resetNotificationsSchemaCache()
  _resetAdminAccountCache()
}

async function seedProfile(db) {
  await db.prepare("INSERT INTO profiles (id, user_id, name) VALUES ('p1', 'u_owner', 'Anastasia')").run()
  await db.prepare("INSERT INTO users (id, primary_email, is_admin, role) VALUES ('u_owner', 'owner@example.com', 0, 'user')").run()
}

function ctx(overrides = {}) {
  return {
    taskId: 't1', profileId: 'p1', userId: null,
    portalUrl: 'https://aid.mtsu.edu/apply',
    opportunity: { id: 'op1', title: 'MTSU Tuition Aid', deadline: '2099-12-31' },
    profile: { id: 'p1', name: 'Anastasia' },
    classification: { automation_type: 'portal' },
    ...overrides,
  }
}

async function readNotifications(db, type = null) {
  try {
    const rows = type
      ? await db.prepare('SELECT * FROM notifications WHERE type = ? ORDER BY created_at').all(type)
      : await db.prepare('SELECT * FROM notifications ORDER BY created_at').all()
    return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : {} }))
  } catch {
    return []
  }
}

describe('hamilton hard-stop alerting (single canonical admin)', () => {
  beforeEach(resetCaches)

  it('every blocked outcome emits per-category dual notifications and enriched blocker row', async () => {
    const db = makeDb()
    await seedProfile(db)
    const directive = await resolveBlocker(db, ctx(), { kind: '2fa' })
    assert.equal(directive.outcome, 'escalated')
    assert.equal(directive.classification.category, 'two_factor_required')

    // Per-category type derivation: 2fa → login_required family.
    assert.equal(userTypeForCategory('two_factor_required'),  'hamilton_login_required')
    assert.equal(adminTypeForCategory('two_factor_required'), 'hamilton_admin_login_required')

    const blockers = await listBlockersForTask(db, 't1', { onlyOpen: true })
    assert.equal(blockers.length, 1)
    const b = blockers[0]
    assert.equal(b.blocker_type, 'two_factor_required')
    assert.equal(b.funding_source_id, 'op1')
    assert.ok(b.blocker_title)
    assert.ok(b.blocker_message)
    assert.equal(b.severity, 'warning')
    assert.equal(b.required_action, 'renew_session')
    assert.match(b.resolver_route || '', /\/hamilton\/tasks\/t1/)
    assert.equal(b.admin_required, true)
    assert.equal(b.user_required, true)
    assert.ok(b.user_notification_id)
    assert.equal(b.admin_notification_ids.length, 1, 'single admin → exactly one admin notification')

    // Per-category notification types — NOT the generic hamilton_hard_stop.
    const userNotifs  = await readNotifications(db, 'hamilton_login_required')
    const adminNotifs = await readNotifications(db, 'hamilton_admin_login_required')
    assert.equal(userNotifs.length, 1)
    assert.equal(userNotifs[0].user_id, 'u_owner')
    assert.match(userNotifs[0].title, /Hamilton needs help/)
    assert.equal(userNotifs[0].data.blocker_type, 'two_factor_required')
    assert.equal(userNotifs[0].data.profile_name, 'Anastasia')
    assert.equal(userNotifs[0].data.funding_source_title, 'MTSU Tuition Aid')
    assert.equal(userNotifs[0].data.blocker_id, b.id)
    assert.equal(userNotifs[0].data.task_id, 't1')
    assert.equal(userNotifs[0].read, 0)
    assert.match(userNotifs[0].data.route_to_resolve, /\/hamilton\/tasks\/t1/)
    assert.match(userNotifs[0].data.route_to_resume,  /\/hamilton\/tasks\/t1\/resume/)

    assert.equal(adminNotifs.length, 1, 'admin alerts go to single canonical operator only')
    assert.equal(adminNotifs[0].user_id, 'u_admin')
    assert.match(adminNotifs[0].title, /Hamilton hard stop/)
    assert.match(adminNotifs[0].title, /Anastasia/)
    assert.equal(adminNotifs[0].data.admin_email, ADMIN_EMAIL)
    assert.equal(adminNotifs[0].data.admin_required, true)
    assert.equal(adminNotifs[0].data.profile_name, 'Anastasia')
  })

  it('admin notification is routed to buckeye7066@gmail.com regardless of how many admins exist', async () => {
    const db = makeDb()
    await seedProfile(db)
    // Seed a second is_admin=1 user that is NOT the canonical operator.
    // The new routing must ignore them.
    await db.prepare(
      "INSERT INTO users (id, primary_email, is_admin, role) VALUES ('u_other_admin', 'someone@else.com', 1, 'admin')",
    ).run()

    await resolveBlocker(db, ctx(), { kind: '2fa' })
    const adminNotifs = await readNotifications(db, 'hamilton_admin_login_required')
    assert.equal(adminNotifs.length, 1)
    assert.equal(adminNotifs[0].user_id, 'u_admin')
    assert.equal(adminNotifs[0].data.admin_email, ADMIN_EMAIL)

    // The other "admin" got nothing.
    const others = await db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'u_other_admin'",
    ).get()
    assert.equal(others.n, 0)
  })

  it('auto-creates the admin user if no row exists for buckeye7066@gmail.com', async () => {
    const db = makeDb({ seedAdmin: false }) // intentionally no admin row
    await seedProfile(db)

    const directive = await resolveBlocker(db, ctx(), { kind: '2fa' })
    assert.equal(directive.outcome, 'escalated')

    const adminRow = await db.prepare(
      'SELECT id, primary_email, is_admin FROM users WHERE LOWER(primary_email) = ?',
    ).get(ADMIN_EMAIL)
    assert.ok(adminRow, 'admin row created on demand')
    assert.equal(adminRow.is_admin, 1)
    assert.equal(adminRow.primary_email, ADMIN_EMAIL)

    const adminNotifs = await readNotifications(db, 'hamilton_admin_login_required')
    assert.equal(adminNotifs.length, 1)
    assert.equal(adminNotifs[0].user_id, adminRow.id)
  })

  it('every category gets the right per-category admin type', async () => {
    const cases = [
      ['missing_required_information', 'hamilton_admin_missing_info'],
      ['ambiguous_required_field',     'hamilton_admin_missing_info'],
      ['missing_required_document',    'hamilton_admin_document_required'],
      ['login_required',               'hamilton_admin_login_required'],
      ['sso_required',                 'hamilton_admin_login_required'],
      ['two_factor_required',          'hamilton_admin_login_required'],
      ['captcha_required',             'hamilton_admin_login_required'],
      ['payment_required',             'hamilton_admin_payment_required'],
      ['wet_signature_required',       'hamilton_admin_attestation_required'],
      ['legal_attestation_required',   'hamilton_admin_attestation_required'],
      ['portal_terms_block',           'hamilton_admin_portal_blocked'],
      ['portal_anti_bot_block',        'hamilton_admin_portal_blocked'],
      ['deadline_expired',             'hamilton_admin_task_failed'],
      ['unknown_application_method',   'hamilton_admin_task_failed'],
      ['final_review_screen',          'hamilton_admin_hard_stop'],
      ['unknown_thing',                'hamilton_admin_hard_stop'],
    ]
    for (const [cat, expected] of cases) {
      assert.equal(adminTypeForCategory(cat), expected, `admin type for ${cat}`)
    }
    assert.equal(userTypeForCategory('payment_required'),         'hamilton_payment_required')
    assert.equal(userTypeForCategory('legal_attestation_required'), 'hamilton_attestation_required')
    assert.equal(userTypeForCategory('missing_required_document'), 'hamilton_document_required')
  })

  it('isAdminUser returns true for canonical email even without is_admin flag', () => {
    assert.equal(isAdminUser({ email: ADMIN_EMAIL }), true)
    assert.equal(isAdminUser({ primary_email: 'BUCKEYE7066@GMAIL.com' }), true)
    assert.equal(isAdminUser({ is_admin: true }), true)
    assert.equal(isAdminUser({ role: 'admin' }), true)
    assert.equal(isAdminUser({ email: 'someone@example.com' }), false)
    assert.equal(isAdminUser({}), false)
    assert.equal(isAdminUser(null), false)
  })

  it('HAMILTON_ADMIN_EMAIL is the canonical admin', () => {
    assert.equal(HAMILTON_ADMIN_EMAIL, ADMIN_EMAIL)
  })

  it('resolveAdminUserId is idempotent — second call returns the same id', async () => {
    const db = makeDb()
    await seedProfile(db)
    const id1 = await resolveAdminUserId(db)
    const id2 = await resolveAdminUserId(db)
    assert.equal(id1, id2)
    assert.equal(id1, 'u_admin')
  })

  it('resolved (auto-handled) outcomes do NOT emit hard-stop alerts', async () => {
    const db = makeDb()
    await seedProfile(db)
    await recordAuthorizations(db, {
      userId: 'u_owner', profileId: 'p1', scope: 'funding_source',
      fundingSourceIds: ['op1'], authorizationTypes: ['use_saved_session'],
      authorizationText: 'auth',
    })
    delete process.env.HAMILTON_BROWSER_STORAGE_DIR
    await recordSession(db, {
      userId: 'u_owner', profileId: 'p1', portalHost: 'aid.mtsu.edu',
      storageStatePath: '/tmp/x.json',
    })
    const directive = await resolveBlocker(db, ctx({ userId: 'u_owner' }), { kind: 'login' })
    assert.equal(directive.outcome, 'resolved')

    const all = await readNotifications(db)
    const hardStopAlerts = all.filter((n) => n.type.startsWith('hamilton_hard_stop')
      || n.type.startsWith('hamilton_admin_'))
    assert.equal(hardStopAlerts.length, 0)
  })

  it('degraded (lawful fallback) outcomes do NOT emit hard-stop alerts', async () => {
    const db = makeDb()
    await seedProfile(db)
    const directive = await resolveBlocker(db, ctx(), { kind: 'signature', text: 'Hand-written signature required' })
    assert.equal(directive.outcome, 'degraded')

    const all = await readNotifications(db)
    assert.equal(all.filter((n) => n.type.startsWith('hamilton_admin_')).length, 0)
  })

  it('admin dashboard sees every open blocker; resolution clears it and notifications', async () => {
    const db = makeDb()
    await seedProfile(db)
    await resolveBlocker(db, ctx(), { kind: '2fa' })
    await resolveBlocker(db, ctx(), { kind: 'captcha' })

    const open = await listOpenAdminBlockers(db)
    assert.equal(open.length, 2)
    assert.ok(open.every((b) => b.admin_required === true))

    // Both 2fa and captcha map to the login_required family.
    const userBefore  = await readNotifications(db, 'hamilton_login_required')
    const adminBefore = await readNotifications(db, 'hamilton_admin_login_required')
    assert.equal(userBefore.length, 2)
    assert.equal(adminBefore.length, 2) // single admin × 2 blockers
    assert.ok(userBefore.every((n) => n.read === 0))
    assert.ok(adminBefore.every((n) => n.user_id === 'u_admin'))

    const resolved = await resolveOpenBlockersForTask(db, {
      taskId: 't1', strategy: 'user_action',
      detail: 'User logged in.', resolvedByUserId: 'u_owner',
    })
    assert.equal(resolved.length, 2)

    const idsToClear = resolved.flatMap((b) => [b.user_notification_id, ...(b.admin_notification_ids || [])]).filter(Boolean)
    const cleared = await markNotificationsResolved(db, idsToClear)
    assert.equal(cleared, 4) // 2 user + 2 admin

    const remainingOpen = await listOpenAdminBlockers(db)
    assert.equal(remainingOpen.length, 0)

    const userAfter  = await readNotifications(db, 'hamilton_login_required')
    const adminAfter = await readNotifications(db, 'hamilton_admin_login_required')
    assert.ok(userAfter.every((n) => n.read === 1))
    assert.ok(adminAfter.every((n) => n.read === 1))

    const resolutions = await db.prepare('SELECT * FROM hamilton_blocker_resolutions').all()
    assert.ok(resolutions.length >= 4)
    assert.ok(resolutions.some((r) => r.outcome === 'resolved' && r.strategy === 'user_action'))
  })

  it('payment alert uses hamilton_payment_required and includes funding context', async () => {
    const db = makeDb()
    await seedProfile(db)
    const directive = await resolveBlocker(db, ctx(), {
      kind: 'payment', context: { category: 'application_fee', amount_cents: 5000 },
    })
    assert.equal(directive.outcome, 'escalated')

    const userNotifs = await readNotifications(db, 'hamilton_payment_required')
    assert.equal(userNotifs.length, 1)
    const data = userNotifs[0].data
    assert.equal(data.task_id, 't1')
    assert.equal(data.profile_id, 'p1')
    assert.equal(data.user_id, 'u_owner')
    assert.equal(data.funding_source_id, 'op1')
    assert.equal(data.funding_source_title, 'MTSU Tuition Aid')
    assert.equal(data.blocker_type, 'payment_required')
    assert.equal(data.required_action, 'approve_payment')
    assert.match(data.route_to_resolve, /\/hamilton\/tasks\/t1/)

    const adminNotifs = await readNotifications(db, 'hamilton_admin_payment_required')
    assert.equal(adminNotifs.length, 1)
    assert.equal(adminNotifs[0].user_id, 'u_admin')
    assert.equal(adminNotifs[0].data.admin_email, ADMIN_EMAIL)
  })

  it('deadline_expired emits hamilton_admin_task_failed and the row carries deadline_at', async () => {
    const db = makeDb()
    await seedProfile(db)
    const expiredCtx = ctx({ opportunity: { id: 'op2', title: 'Expired Grant', deadline: '2000-01-01' } })
    const directive = await resolveBlocker(db, expiredCtx, { kind: 'deadline_expired' })
    assert.equal(directive.outcome, 'blocked')

    const blockers = await listBlockersForTask(db, 't1', { onlyOpen: true })
    assert.equal(blockers[0].deadline_at, '2000-01-01T00:00:00.000Z')

    const userNotifs = await readNotifications(db, 'hamilton_hard_stop')
    assert.equal(userNotifs.length, 1)
    assert.equal(userNotifs[0].data.deadline, '2000-01-01T00:00:00.000Z')

    const adminNotifs = await readNotifications(db, 'hamilton_admin_task_failed')
    assert.equal(adminNotifs.length, 1)
    assert.equal(adminNotifs[0].user_id, 'u_admin')
  })
})
