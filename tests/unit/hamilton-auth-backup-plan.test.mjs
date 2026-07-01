/**
 * Hamilton auth backup plan — "automation is king" for login challenges.
 *
 *   1. planAuthBackup: classifies auth blockers, schedules exponential-backoff
 *      retries, and exhausts to a human after MAX_ATTEMPTS.
 *   2. application_tasks persists next_retry_at / retry_count.
 *   3. The runner's due-retry query re-picks waiting_for_* tasks whose timer is
 *      due, and ignores ones scheduled in the future.
 *   4. getAuthWatchSummary reports pending auth help for the login toast.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  planAuthBackup, isAuthBlocker, AUTH_BACKOFF_MINUTES, AUTH_MAX_ATTEMPTS,
} from '../../backend/services/hamilton/hamiltonAuthBackupPlan.js'
import {
  ensureApplicationTaskSchema, ensureApplicationTask, updateApplicationTask, getApplicationTask,
  _resetSchemaCache,
} from '../../backend/services/hamilton/applicationTaskStore.js'
import { getAuthWatchSummary } from '../../backend/services/hamilton/hamiltonAuthWatchService.js'

before(() => {
  if (!process.env.RUNTIME_SECRETS_KEY && !process.env.AUTH_JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret-do-not-use-in-prod'
  }
})

function makeDb() {
  _resetSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

describe('planAuthBackup', () => {
  it('recognises auth blocker kinds (engine + classifier forms)', () => {
    for (const k of ['login', '2fa', 'captcha', 'sso', 'two_factor_required', 'login_required', 'captcha_required']) {
      assert.equal(isAuthBlocker(k), true, k)
    }
    for (const k of ['missing_required_document', 'payment_required', 'deadline_expired', '']) {
      assert.equal(isAuthBlocker(k), false, k)
    }
  })

  it('non-auth blocker returns isAuth=false', () => {
    assert.equal(planAuthBackup({ blockerKind: 'payment_required' }).isAuth, false)
  })

  it('maps kinds to the right waiting status', () => {
    assert.equal(planAuthBackup({ blockerKind: 'login' }).status, 'waiting_for_login')
    assert.equal(planAuthBackup({ blockerKind: 'sso' }).status, 'waiting_for_login')
    assert.equal(planAuthBackup({ blockerKind: '2fa' }).status, 'waiting_for_2fa')
    assert.equal(planAuthBackup({ blockerKind: 'captcha' }).status, 'waiting_for_captcha')
    // Email verification is treated as an auth backup (auto-resuming), not a wall.
    assert.equal(planAuthBackup({ blockerKind: 'email_verification' }).status, 'waiting_for_email_verification')
    assert.equal(planAuthBackup({ blockerKind: 'verification_pending' }).status, 'waiting_for_email_verification')
    assert.equal(isAuthBlocker('email_verification'), true)
  })

  it('email-verification message is the "your one step" copy', () => {
    const p = planAuthBackup({ blockerKind: 'email_verification', retryCount: 0 })
    assert.equal(p.status, 'waiting_for_email_verification')
    assert.match(p.message, /verification link/i)
  })

  it('schedules exponential backoff and increments the attempt', () => {
    const now = 1_000_000_000_000
    for (let prior = 0; prior < AUTH_MAX_ATTEMPTS; prior += 1) {
      const p = planAuthBackup({ blockerKind: 'login', retryCount: prior, now })
      assert.equal(p.exhausted, false)
      assert.equal(p.retryInMinutes, AUTH_BACKOFF_MINUTES[prior])
      assert.equal(p.attempt, prior + 1)
      assert.equal(new Date(p.nextRetryAt).getTime(), now + AUTH_BACKOFF_MINUTES[prior] * 60_000)
    }
  })

  it('exhausts to a human after MAX_ATTEMPTS', () => {
    const p = planAuthBackup({ blockerKind: 'login', retryCount: AUTH_MAX_ATTEMPTS })
    assert.equal(p.isAuth, true)
    assert.equal(p.exhausted, true)
    assert.equal(p.status, 'blocked')
    assert.equal(p.nextRetryAt, null)
  })
})

describe('application_tasks retry persistence', () => {
  it('round-trips next_retry_at and retry_count', async () => {
    const db = makeDb()
    await ensureApplicationTaskSchema(db)
    const t = await ensureApplicationTask(db, { profileId: 'p1', opportunityId: 'opp1', userId: 'u1' })
    const when = new Date(Date.now() + 60_000).toISOString()
    await updateApplicationTask(db, t.id, { status: 'waiting_for_2fa', nextRetryAt: when, retryCount: 2 })
    const got = await getApplicationTask(db, t.id)
    assert.equal(got.status, 'waiting_for_2fa')
    assert.equal(got.next_retry_at, when)
    assert.equal(got.retry_count, 2)
  })

  it('accepts the waiting_for_email_verification status (in TASK_STATUSES)', async () => {
    const db = makeDb()
    await ensureApplicationTaskSchema(db)
    const t = await ensureApplicationTask(db, { profileId: 'pv', opportunityId: 'oppv', userId: 'u1' })
    const when = new Date(Date.now() + 60_000).toISOString()
    // Would throw "invalid status" if the status weren't registered.
    await updateApplicationTask(db, t.id, { status: 'waiting_for_email_verification', nextRetryAt: when })
    const got = await getApplicationTask(db, t.id)
    assert.equal(got.status, 'waiting_for_email_verification')
  })
})

describe('runner due-retry selection', () => {
  // Mirrors the SELECT in hamiltonAgentAdapter so a regression in either is caught.
  const DUE_QUERY = `
    SELECT id, status FROM application_tasks
     WHERE status IN ('queued','ready','analyzing','ready_to_start')
        OR (status IN ('waiting_for_login','waiting_for_2fa','waiting_for_captcha','waiting_for_email_verification')
            AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
     ORDER BY updated_at ASC`

  it('re-picks due waiting tasks, skips future ones', async () => {
    const db = makeDb()
    await ensureApplicationTaskSchema(db)
    const due = await ensureApplicationTask(db, { profileId: 'p1', opportunityId: 'due', userId: 'u1' })
    const future = await ensureApplicationTask(db, { profileId: 'p1', opportunityId: 'future', userId: 'u1' })
    const queued = await ensureApplicationTask(db, { profileId: 'p1', opportunityId: 'queued', userId: 'u1' })
    await updateApplicationTask(db, due.id, { status: 'waiting_for_login', nextRetryAt: new Date(Date.now() - 60_000).toISOString() })
    await updateApplicationTask(db, future.id, { status: 'waiting_for_login', nextRetryAt: new Date(Date.now() + 3_600_000).toISOString() })
    // queued stays 'queued'

    const rows = await db.prepare(DUE_QUERY).all(new Date().toISOString())
    const ids = new Set(rows.map((r) => r.id))
    assert.ok(ids.has(due.id), 'due retry picked')
    assert.ok(ids.has(queued.id), 'queued picked')
    assert.ok(!ids.has(future.id), 'future retry skipped')
  })
})

describe('getAuthWatchSummary', () => {
  it('counts waiting tasks for the user and notifications', async () => {
    const db = makeDb()
    await ensureApplicationTaskSchema(db)
    // Minimal profiles + notifications tables for the join/count.
    await db.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);`)
    await db.exec(`CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, read INTEGER DEFAULT 0);`)
    await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?,?,?)').run('p1', 'u1', 'Mine')
    await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?,?,?)').run('p2', 'someone-else', 'Theirs')
    await db.prepare('INSERT INTO notifications (id, user_id, type, read) VALUES (?,?,?,0)').run('n1', 'u1', 'hamilton_2fa_required')
    await db.prepare('INSERT INTO notifications (id, user_id, type, read) VALUES (?,?,?,1)').run('n2', 'u1', 'hamilton_login_required')

    const mine = await ensureApplicationTask(db, { profileId: 'p1', opportunityId: 'opp1', userId: 'u1' })
    await updateApplicationTask(db, mine.id, { status: 'waiting_for_login', portalUrl: 'https://login.mtsu.edu/x', nextRetryAt: new Date().toISOString() })
    const theirs = await ensureApplicationTask(db, { profileId: 'p2', opportunityId: 'opp2', userId: 'someone-else' })
    await updateApplicationTask(db, theirs.id, { status: 'waiting_for_login', nextRetryAt: new Date().toISOString() })

    const s = await getAuthWatchSummary(db, { userId: 'u1' })
    assert.equal(s.has_any, true)
    assert.equal(s.pending_notifications, 1, 'only unread auth notifs')
    assert.equal(s.waiting_tasks, 1, 'only my profiles')
    assert.equal(s.items[0].host, 'login.mtsu.edu')
  })

  it('returns empty for a user with nothing pending', async () => {
    const db = makeDb()
    await ensureApplicationTaskSchema(db)
    await db.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);`)
    await db.exec(`CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, read INTEGER DEFAULT 0);`)
    const s = await getAuthWatchSummary(db, { userId: 'nobody' })
    assert.equal(s.has_any, false)
    assert.equal(s.waiting_tasks, 0)
  })
})
