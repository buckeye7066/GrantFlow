/**
 * Agent Control Center — distributed lock self-heal.
 *
 * Regression coverage for the recurring production failure:
 *   "Could not acquire lock 'agent_control:agent:<name>'."
 *
 * Root cause was orphaned locks (a run crashed/restarted mid-cycle and never
 * released its row) combined with no retry and a leak-prone release path.
 * These tests pin the fix: TTL'd locks, atomic takeover of an expired holder,
 * owner-token fencing, always-release (withLock), bounded retry, and the
 * graceful "already running" skip for automated/scheduled triggers.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  ensureSchema,
  _resetSchemaCache,
  acquireLock,
  tryAcquireLock,
  releaseLock,
  withLock,
  sweepExpiredLocks,
  getLock,
} from '../../backend/services/agentControl/agentControlStore.js'
import { startRun } from '../../backend/services/agentControl/agentControlOrchestrator.js'
import { agentLockName } from '../../backend/services/agentControl/agentControlTypes.js'

const ADMIN = { email: 'buckeye7066@gmail.com' }
const SAM_LOCK = agentLockName('sam')

function makeDb() {
  const sqlite = new Database(':memory:')
  // `_sqlite` is a test-only escape hatch (plantLock / PRAGMA introspection)
  // that bypasses the wrapper to talk to better-sqlite3 directly.
  return { ...wrapSqlite(sqlite), _sqlite: sqlite }
}

async function freshDb() {
  _resetSchemaCache()
  const db = makeDb()
  await ensureSchema(db)
  return db
}

/** Insert a lock row directly with an explicit expiry — used to simulate an
 *  orphaned holder without waiting out a real TTL. */
function plantLock(db, { lockName, runId, token = 'tok', expiresAt }) {
  db._sqlite
    .prepare(`INSERT INTO agent_control_locks
      (id, lock_name, control_run_id, owner_token, acquired_by, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`id-${runId}`, lockName, runId, token, 'tester', new Date().toISOString(), expiresAt)
}

test('owner_token column is present after ensureSchema', async () => {
  const db = await freshDb()
  const cols = db._sqlite.prepare(`PRAGMA table_info(agent_control_locks)`).all()
  assert.ok(cols.some((c) => c.name === 'owner_token'), 'owner_token column missing')
})

test('normal acquire then release', async () => {
  const db = await freshDb()
  const lease = await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'run-1' })
  assert.equal(lease.acquired, true)
  assert.ok(lease.ownerToken, 'lease should carry an owner token')
  assert.ok(await getLock(db, SAM_LOCK), 'lock row should exist')

  const released = await releaseLock(db, { lockName: SAM_LOCK, controlRunId: 'run-1', ownerToken: lease.ownerToken })
  assert.equal(released, 1)
  assert.equal(await getLock(db, SAM_LOCK), null, 'lock row should be gone')

  // Re-acquire after release works.
  const again = await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'run-2' })
  assert.equal(again.acquired, true)
})

test('second live acquirer is denied (single-flight), no retry', async () => {
  const db = await freshDb()
  const a = await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'run-A' })
  assert.equal(a.acquired, true)

  const b = await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'run-B', retries: 0 })
  assert.equal(b.acquired, false)
  assert.equal(b.reason, 'held')
  assert.equal(b.heldBy, 'run-A', 'should report the live holder')

  // tryAcquireLock boolean wrapper agrees.
  assert.equal(await tryAcquireLock(db, { lockName: SAM_LOCK, controlRunId: 'run-C', retries: 0 }), false)
})

test('TTL expiry: an orphaned (expired) lock is taken over by the next acquirer', async () => {
  const db = await freshDb()
  // Simulate a crashed run that left a lock whose deadline has already passed.
  plantLock(db, {
    lockName: SAM_LOCK,
    runId: 'dead-run',
    token: 'dead-token',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
  assert.ok(await getLock(db, SAM_LOCK), 'orphaned lock should be present')

  const lease = await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'live-run', retries: 0 })
  assert.equal(lease.acquired, true, 'expired lock must self-heal and allow acquisition')

  const holder = await getLock(db, SAM_LOCK)
  assert.equal(holder.control_run_id, 'live-run', 'the live run should now own the lock')
  assert.notEqual(holder.owner_token, 'dead-token', 'owner token must be rotated on takeover')
})

test('sweepExpiredLocks reclaims only expired rows', async () => {
  const db = await freshDb()
  plantLock(db, { lockName: 'agent_control:agent:robert', runId: 'old', expiresAt: new Date(Date.now() - 1_000).toISOString() })
  plantLock(db, { lockName: 'agent_control:agent:john', runId: 'fresh', expiresAt: new Date(Date.now() + 600_000).toISOString() })

  const swept = await sweepExpiredLocks(db)
  assert.equal(swept, 1, 'only the expired lock should be swept')
  assert.equal(await getLock(db, 'agent_control:agent:robert'), null)
  assert.ok(await getLock(db, 'agent_control:agent:john'), 'live lock must survive')
})

test('owner-token fence: a stale owner cannot release a successor\'s lock', async () => {
  const db = await freshDb()
  // run-A acquires, then expires; run-B takes over.
  const a = await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'run-A' })
  // Force A's lock to look expired, then B takes over.
  db._sqlite.prepare(`UPDATE agent_control_locks SET expires_at = ? WHERE lock_name = ?`)
    .run(new Date(Date.now() - 1_000).toISOString(), SAM_LOCK)
  const b = await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'run-B', retries: 0 })
  assert.equal(b.acquired, true)

  // A (the stale, dead owner) tries to release using its own identity. It must
  // NOT free B's freshly-acquired lock.
  const releasedByToken = await releaseLock(db, { ownerToken: a.ownerToken })
  assert.equal(releasedByToken, 0, 'stale owner token must not match the successor')
  const releasedByRun = await releaseLock(db, { lockName: SAM_LOCK, controlRunId: 'run-A' })
  assert.equal(releasedByRun, 0, 'stale run id must not match the successor')

  const holder = await getLock(db, SAM_LOCK)
  assert.ok(holder, 'B should still hold the lock')
  assert.equal(holder.control_run_id, 'run-B')
})

test('withLock always releases — even when the body throws', async () => {
  const db = await freshDb()
  await assert.rejects(
    withLock(db, { lockName: SAM_LOCK, controlRunId: 'run-x' }, async () => {
      assert.ok(await getLock(db, SAM_LOCK), 'lock held inside the critical section')
      throw new Error('boom')
    }),
    /boom/,
  )
  // The finally must have run despite the exception.
  assert.equal(await getLock(db, SAM_LOCK), null, 'lock must be released after a throwing body')

  // And the lock is immediately re-acquirable.
  assert.equal(await tryAcquireLock(db, { lockName: SAM_LOCK, controlRunId: 'run-y', retries: 0 }), true)
})

test('withLock throws LOCK_NOT_ACQUIRED when the lock is held', async () => {
  const db = await freshDb()
  await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'holder' })
  let ran = false
  await assert.rejects(
    withLock(db, { lockName: SAM_LOCK, controlRunId: 'contender', retries: 0 }, async () => { ran = true }),
    (err) => err.code === 'LOCK_NOT_ACQUIRED',
  )
  assert.equal(ran, false, 'body must not run when the lock is unavailable')
})

test('contention: only one of two concurrent acquirers wins', async () => {
  const db = await freshDb()
  const [r1, r2] = await Promise.all([
    acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'w1', retries: 0 }),
    acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'w2', retries: 0 }),
  ])
  const winners = [r1, r2].filter((r) => r.acquired)
  assert.equal(winners.length, 1, 'exactly one acquirer may win')
  const holder = await getLock(db, SAM_LOCK)
  assert.ok(holder, 'a holder must exist')
})

test('bounded retry eventually gives up on a live lock', async () => {
  const db = await freshDb()
  await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'long-runner' })
  const t0 = Date.now()
  const lease = await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'waiter', retries: 2, backoffMs: 10 })
  assert.equal(lease.acquired, false, 'still held → give up after the retry budget')
  assert.ok(Date.now() - t0 >= 10, 'should have backed off at least once before giving up')
})

test('graceful skip: a scheduled run whose agent lock is held is cancelled, not failed', async () => {
  const db = await freshDb()
  // Pre-hold sam's per-agent lock with a live (far-future) deadline.
  await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'already-running', ttlMs: 600_000 })

  const result = await startRun(db, {
    runType: 'sam_only',
    agents: ['sam'],
    options: { skip_if_locked: true, lock_acquire_retries: 0 },
    user: ADMIN,
  })

  assert.equal(result.skipped, true, 'held lock on an automated trigger is a graceful skip')
  assert.equal(result.run.status, 'cancelled', 'skipped run is terminal-cancelled, never failed')
  assert.deepEqual(result.steps, [], 'no steps run when skipped')

  // Crucially: it must NOT have produced a `failed` run (the dashboard noise we are killing).
  const failed = db._sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_control_runs WHERE status = 'failed'`).get()
  assert.equal(failed.n, 0, 'a contended scheduled run must not be recorded as failed')

  // The original holder still owns the lock.
  const holder = await getLock(db, SAM_LOCK)
  assert.equal(holder.control_run_id, 'already-running')
})

test('manual start on a held lock surfaces 409 but is recorded as cancelled (not failed)', async () => {
  const db = await freshDb()
  await acquireLock(db, { lockName: SAM_LOCK, controlRunId: 'already-running', ttlMs: 600_000 })

  await assert.rejects(
    startRun(db, {
      runType: 'sam_only',
      agents: ['sam'],
      options: { lock_acquire_retries: 0 }, // manual: no skip_if_locked
      user: ADMIN,
    }),
    (err) => err.status === 409,
  )

  const failed = db._sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_control_runs WHERE status = 'failed'`).get()
  assert.equal(failed.n, 0, 'even a manual 409 must not pollute the failure dashboard')
  const cancelled = db._sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_control_runs WHERE status = 'cancelled'`).get()
  assert.equal(cancelled.n, 1, 'the no-op run is recorded as cancelled')
})
