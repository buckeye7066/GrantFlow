/**
 * Yana Hard-Stop alerting tests.
 *
 * Covers the mandatory dual-notification requirement:
 *   - Every unresolved hard stop creates a `yana_hard_stop` user
 *     notification AND a `yana_admin_hard_stop` admin notification.
 *   - Every blocker row carries the spec'd fields (funding_source_id,
 *     blocker_title, blocker_message, severity, required_action,
 *     resolver_route, admin_required, user_required, deadline_at).
 *   - Resolved/degraded outcomes do NOT create alert notifications.
 *   - resolveOpenBlockersForTask + markNotificationsResolved clears
 *     the alert and writes a resolution audit row.
 *   - listOpenAdminBlockers powers the admin dashboard.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  recordAuthorizations,
  _resetAuthSchemaCache,
} from '../../backend/services/yana/yanaAuthorizationStore.js'
import { _resetCredentialSchemaCache, recordSession } from '../../backend/services/yana/yanaCredentialSessionService.js'
import { _resetPaymentSchemaCache } from '../../backend/services/yana/yanaPaymentAuthorizationService.js'
import { _resetAttestationSchemaCache } from '../../backend/services/yana/yanaAttestationStore.js'
import { _resetPortalPolicySchemaCache } from '../../backend/services/yana/yanaPortalPolicyRegistry.js'
import { _resetResolvedFieldSchemaCache } from '../../backend/services/yana/yanaResolvedFieldStore.js'
import {
  _resetBlockerSchemaCache,
  listOpenAdminBlockers,
  resolveOpenBlockersForTask,
  listBlockersForTask,
} from '../../backend/services/yana/yanaBlockerStore.js'
import { resolveBlocker } from '../../backend/services/yana/yanaHardStopResolver.js'
import {
  _resetNotificationsSchemaCache,
  markNotificationsResolved,
} from '../../backend/services/yana/yanaNotifications.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  // Seed minimal schema for the tables the alerting layer reads.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, organization_name TEXT);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'user');
  `)
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...p) => stmt.get(...p),
        all: async (...p) => stmt.all(...p),
        run: async (...p) => { const r = stmt.run(...p); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid } },
      }
    },
    exec(sql) { sqlite.exec(sql) },
    raw: sqlite,
  }
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
}

async function seed(db) {
  await db.prepare("INSERT INTO profiles (id, user_id, name) VALUES ('p1', 'u_owner', 'Anastasia')").run()
  await db.prepare("INSERT INTO users (id, role) VALUES ('u_owner','user')").run()
  await db.prepare("INSERT INTO users (id, role) VALUES ('u_admin1','admin')").run()
  await db.prepare("INSERT INTO users (id, role) VALUES ('u_admin2','admin')").run()
}

function ctx(overrides = {}) {
  return {
    taskId: 't1', profileId: 'p1', userId: null,
    portalUrl: 'https://aid.mtsu.edu/apply',
    opportunity: { id: 'op1', title: 'MTSU Tuition Aid', deadline: '2099-12-31' },
    profile: { id: 'p1' },
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
    // Table is created lazily on first emit — if no alert ever fires
    // it never exists, which is exactly what the "no alert" tests
    // assert. Return empty.
    return []
  }
}

describe('yana hard-stop alerting', () => {
  beforeEach(resetCaches)

  it('every blocked outcome emits dual notifications and enriched blocker row', async () => {
    const db = makeDb()
    await seed(db)
    const directive = await resolveBlocker(db, ctx(), { kind: '2fa' })
    assert.equal(directive.outcome, 'escalated')
    assert.equal(directive.classification.category, 'two_factor_required')

    // Blocker row has the enriched fields the spec demanded.
    const blockers = await listBlockersForTask(db, 't1', { onlyOpen: true })
    assert.equal(blockers.length, 1)
    const b = blockers[0]
    assert.equal(b.blocker_type, 'two_factor_required')
    assert.equal(b.funding_source_id, 'op1')
    assert.ok(b.blocker_title)
    assert.ok(b.blocker_message)
    assert.equal(b.severity, 'warning')
    assert.equal(b.required_action, 'renew_session')
    assert.match(b.resolver_route || '', /\/yana\/tasks\/t1/)
    assert.equal(b.admin_required, true)
    assert.equal(b.user_required, true)
    assert.ok(b.user_notification_id)
    assert.equal(b.admin_notification_ids.length, 2)

    // Two distinct notification types exist — user + admin.
    const userNotifs  = await readNotifications(db, 'yana_hard_stop')
    const adminNotifs = await readNotifications(db, 'yana_admin_hard_stop')
    assert.equal(userNotifs.length, 1)
    assert.equal(userNotifs[0].user_id, 'u_owner')
    assert.match(userNotifs[0].title, /Yana needs help/)
    assert.equal(userNotifs[0].data.blocker_type, 'two_factor_required')
    assert.equal(userNotifs[0].data.blocker_id, b.id)
    assert.equal(userNotifs[0].data.task_id, 't1')
    assert.equal(userNotifs[0].read, 0)

    assert.equal(adminNotifs.length, 2)
    const adminUsers = new Set(adminNotifs.map((n) => n.user_id))
    assert.deepEqual(adminUsers, new Set(['u_admin1', 'u_admin2']))
    assert.match(adminNotifs[0].title, /Yana hard stop/)
    assert.equal(adminNotifs[0].data.admin_required, true)
  })

  it('resolved (auto-handled) outcomes do NOT emit hard-stop alerts', async () => {
    const db = makeDb()
    await seed(db)
    // Authorize + record a saved session so login/2FA is auto-resolved.
    await recordAuthorizations(db, {
      userId: 'u_owner', profileId: 'p1', scope: 'funding_source',
      fundingSourceIds: ['op1'], authorizationTypes: ['use_saved_session'],
      authorizationText: 'auth',
    })
    delete process.env.YANA_BROWSER_STORAGE_DIR
    await recordSession(db, {
      userId: 'u_owner', profileId: 'p1', portalHost: 'aid.mtsu.edu',
      storageStatePath: '/tmp/x.json',
    })
    const directive = await resolveBlocker(db, ctx({ userId: 'u_owner' }), { kind: 'login' })
    assert.equal(directive.outcome, 'resolved')

    const userNotifs  = await readNotifications(db, 'yana_hard_stop')
    const adminNotifs = await readNotifications(db, 'yana_admin_hard_stop')
    assert.equal(userNotifs.length, 0, 'no user alert for auto-resolved blockers')
    assert.equal(adminNotifs.length, 0, 'no admin alert for auto-resolved blockers')
  })

  it('degraded (lawful fallback) outcomes do NOT emit hard-stop alerts', async () => {
    const db = makeDb()
    await seed(db)
    // Wet signature ALWAYS degrades — never alerts as a hard stop.
    const directive = await resolveBlocker(db, ctx(), { kind: 'signature', text: 'Hand-written signature required' })
    assert.equal(directive.outcome, 'degraded')

    const all = await readNotifications(db)
    assert.equal(all.filter((n) => n.type === 'yana_hard_stop' || n.type === 'yana_admin_hard_stop').length, 0)
  })

  it('admin dashboard sees every open blocker; resolution clears it and notifications', async () => {
    const db = makeDb()
    await seed(db)
    // Two distinct hard stops on the same task.
    await resolveBlocker(db, ctx(), { kind: '2fa' })
    await resolveBlocker(db, ctx(), { kind: 'captcha' })

    const open = await listOpenAdminBlockers(db)
    assert.equal(open.length, 2)
    assert.ok(open.every((b) => b.admin_required === true))

    const userBefore  = await readNotifications(db, 'yana_hard_stop')
    const adminBefore = await readNotifications(db, 'yana_admin_hard_stop')
    assert.equal(userBefore.length, 2)
    assert.equal(adminBefore.length, 4) // 2 admins * 2 blockers
    assert.ok(userBefore.every((n) => n.read === 0))

    // Resolve every open blocker for this task — should also mark
    // every notification read.
    const resolved = await resolveOpenBlockersForTask(db, {
      taskId: 't1', strategy: 'user_action',
      detail: 'User logged in.', resolvedByUserId: 'u_owner',
    })
    assert.equal(resolved.length, 2)

    const idsToClear = resolved.flatMap((b) => [b.user_notification_id, ...(b.admin_notification_ids || [])]).filter(Boolean)
    const cleared = await markNotificationsResolved(db, idsToClear)
    assert.equal(cleared, 6)

    const remainingOpen = await listOpenAdminBlockers(db)
    assert.equal(remainingOpen.length, 0)

    const userAfter  = await readNotifications(db, 'yana_hard_stop')
    const adminAfter = await readNotifications(db, 'yana_admin_hard_stop')
    assert.ok(userAfter.every((n) => n.read === 1))
    assert.ok(adminAfter.every((n) => n.read === 1))

    // An audit row was written per blocker per resolution call:
    //   2 alerts when resolveBlocker raised (each writes one outcome row)
    // + 2 'resolved' rows from resolveOpenBlockersForTask
    const resolutions = await db.prepare('SELECT * FROM yana_blocker_resolutions').all()
    assert.ok(resolutions.length >= 4)
    assert.ok(resolutions.some((r) => r.outcome === 'resolved' && r.strategy === 'user_action'))
  })

  it('payment alert carries the spec\'d fields including funding_source_id', async () => {
    const db = makeDb()
    await seed(db)
    const directive = await resolveBlocker(db, ctx(), {
      kind: 'payment', context: { category: 'application_fee', amount_cents: 5000 },
    })
    assert.equal(directive.outcome, 'escalated')
    const userNotifs = await readNotifications(db, 'yana_hard_stop')
    assert.equal(userNotifs.length, 1)
    const data = userNotifs[0].data
    assert.equal(data.task_id, 't1')
    assert.equal(data.profile_id, 'p1')
    assert.equal(data.user_id, 'u_owner')
    assert.equal(data.funding_source_id, 'op1')
    assert.equal(data.blocker_type, 'payment_required')
    assert.equal(data.required_action, 'approve_payment')
    assert.match(data.route_to_resolve, /\/yana\/tasks\/t1/)
  })

  it('deadline_expired emits alert and the row carries deadline_at', async () => {
    const db = makeDb()
    await seed(db)
    const expiredCtx = ctx({ opportunity: { id: 'op2', title: 'Expired Grant', deadline: '2000-01-01' } })
    const directive = await resolveBlocker(db, expiredCtx, { kind: 'deadline_expired' })
    assert.equal(directive.outcome, 'blocked')

    const blockers = await listBlockersForTask(db, 't1', { onlyOpen: true })
    assert.equal(blockers[0].deadline_at, '2000-01-01T00:00:00.000Z')

    const userNotifs = await readNotifications(db, 'yana_hard_stop')
    assert.equal(userNotifs.length, 1)
    assert.equal(userNotifs[0].data.deadline, '2000-01-01T00:00:00.000Z')
  })
})
