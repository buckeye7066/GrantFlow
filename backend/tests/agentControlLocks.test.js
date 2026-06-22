import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  ensureSchema,
  _resetSchemaCache,
  acquireLock,
  releaseLock,
  withLock,
  getLock,
  sweepExpiredLocks,
} from '../services/agentControl/agentControlStore.js'

// These pin the lock correctness fixes called out by the owner's dry-run:
//   - a crashed/overlapping run left a stale lock that wedged the agent
//     ("Could not acquire lock 'agent_control:agent:sam'"), and
//   - locks must always be released, even when the critical section throws.
//
// The store bootstraps agent_control_locks itself via ensureSchema(), so we
// don't need the full production schema — a bare in-memory DB is enough.

function makeDb() {
  _resetSchemaCache()
  const db = new Database(':memory:')
  return db
}

describe('agentControlStore locks — stale-lock takeover', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })

  it('reclaims an EXPIRED lock so a crashed run cannot wedge the agent forever', async () => {
    const lockName = 'agent_control:agent:sam'

    // Simulate a prior run that acquired the lock and then crashed without
    // releasing it — but its TTL has already lapsed. Insert a row with an
    // expires_at in the past directly (the floor in acquireLock would prevent
    // a too-short TTL otherwise).
    db.prepare(`
      INSERT INTO agent_control_locks (id, lock_name, control_run_id, owner_token, acquired_by, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'crashed-lock-1',
      lockName,
      'crashed-run',
      'crashed-token',
      'crashed@run',
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 60 * 60 * 1000).toISOString(), // expired 1h ago
    )

    const lease = await acquireLock(db, {
      lockName,
      controlRunId: 'fresh-run',
      ttlMs: 60_000,
      retries: 0,
    })

    expect(lease.acquired).toBe(true)
    // Reclaimed the wedged lock — either swept-then-inserted or atomic takeover.
    const held = await getLock(db, lockName)
    expect(held.control_run_id).toBe('fresh-run')
    expect(held.owner_token).toBe(lease.ownerToken)
  })

  it('does NOT take over a lock that is still live (genuine contention)', async () => {
    const lockName = 'agent_control:full_cycle'

    const first = await acquireLock(db, {
      lockName,
      controlRunId: 'run-a',
      ttlMs: 60 * 60 * 1000, // 1h, still valid
      retries: 0,
    })
    expect(first.acquired).toBe(true)

    const second = await acquireLock(db, {
      lockName,
      controlRunId: 'run-b',
      ttlMs: 60 * 60 * 1000,
      retries: 0,
    })
    expect(second.acquired).toBe(false)
    expect(second.reason).toBe('held')
    expect(second.heldBy).toBe('run-a')

    // The live holder is untouched.
    const held = await getLock(db, lockName)
    expect(held.control_run_id).toBe('run-a')
    expect(held.owner_token).toBe(first.ownerToken)
  })

  it('sweepExpiredLocks removes only expired rows', async () => {
    db.prepare(`
      INSERT INTO agent_control_locks (id, lock_name, control_run_id, owner_token, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('expired', 'lock:expired', 'r1', 't1', new Date().toISOString(), new Date(Date.now() - 1000).toISOString())
    db.prepare(`
      INSERT INTO agent_control_locks (id, lock_name, control_run_id, owner_token, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('live', 'lock:live', 'r2', 't2', new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())

    const swept = await sweepExpiredLocks(db)
    expect(swept).toBe(1)
    expect(await getLock(db, 'lock:expired')).toBeNull()
    expect(await getLock(db, 'lock:live')).not.toBeNull()
  })
})

describe('agentControlStore locks — release on error (finally path)', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })

  it('withLock releases the lock even when the critical section throws', async () => {
    const lockName = 'agent_control:agent:robert'

    await expect(
      withLock(db, { lockName, controlRunId: 'run-throw', ttlMs: 60_000 }, async () => {
        throw new Error('boom inside critical section')
      }),
    ).rejects.toThrow(/boom inside critical section/)

    // The lock must NOT be left behind — a subsequent run can acquire it.
    expect(await getLock(db, lockName)).toBeNull()
    const next = await acquireLock(db, { lockName, controlRunId: 'run-after', ttlMs: 60_000 })
    expect(next.acquired).toBe(true)
  })

  it('withLock releases the lock on the happy path too', async () => {
    const lockName = 'agent_control:agent:yana'
    const result = await withLock(db, { lockName, controlRunId: 'run-ok', ttlMs: 60_000 }, async () => 'done')
    expect(result).toBe('done')
    expect(await getLock(db, lockName)).toBeNull()
  })

  it('release is fenced by owner token so a stale late-release cannot free a successor lock', async () => {
    const lockName = 'agent_control:agent:john'

    // First holder acquires, then we forcibly expire it and let a second run
    // take over (new owner token).
    const first = await acquireLock(db, { lockName, controlRunId: 'run-1', ttlMs: 60_000 })
    db.prepare('UPDATE agent_control_locks SET expires_at = ? WHERE lock_name = ?')
      .run(new Date(Date.now() - 1000).toISOString(), lockName)
    const second = await acquireLock(db, { lockName, controlRunId: 'run-2', ttlMs: 60_000 })
    expect(second.acquired).toBe(true)
    expect(second.ownerToken).not.toBe(first.ownerToken)

    // The FIRST run's late release (its own stale token) must not free run-2's lock.
    const released = await releaseLock(db, { ownerToken: first.ownerToken })
    expect(released).toBe(0)
    const held = await getLock(db, lockName)
    expect(held.control_run_id).toBe('run-2')
  })
})
