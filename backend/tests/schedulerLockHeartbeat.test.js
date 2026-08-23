import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  ensureSchema,
  _resetSchemaCache,
  acquireLock,
  renewLock,
  getLock,
} from '../services/agentControl/agentControlStore.js'
import { runWithSchedulerLock } from '../services/schedulerLock.js'

// Pins the 2026-08-23 fix for the frozen nightly-maintenance sweep: a
// deploy-killed run that held a long, FUTURE-dated lock wedged every subsequent
// scheduler tick until the fixed TTL lapsed (up to 2h), and frequent deploys
// re-future-dated it, so the sweep froze for days. The fix is a SHORT TTL that a
// live holder RENEWS on a heartbeat (renewLock) — so a long run keeps the lock
// while a dead run frees it within one TTL.

function makeDb() {
  _resetSchemaCache()
  const db = new Database(':memory:')
  return db
}

describe('renewLock — fenced heartbeat extension', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })

  it('extends expires_at for the lock the process still owns', async () => {
    const lockName = 'scheduler:nightly-maintenance'
    const lease = await acquireLock(db, { lockName, controlRunId: 'run-1', ttlMs: 60_000 })
    expect(lease.acquired).toBe(true)
    const before = await getLock(db, lockName)

    // A later heartbeat with a bigger TTL pushes the deadline out.
    const ok = await renewLock(db, { lockName, ownerToken: lease.ownerToken, ttlMs: 120_000 })
    expect(ok).toBe(true)
    const after = await getLock(db, lockName)
    expect(new Date(after.expires_at).getTime()).toBeGreaterThan(new Date(before.expires_at).getTime())
    // Ownership is unchanged — a renew is not a takeover.
    expect(after.owner_token).toBe(lease.ownerToken)
    expect(after.control_run_id).toBe('run-1')
  })

  it('refuses to renew with a stale/foreign token (fencing)', async () => {
    const lockName = 'scheduler:nightly-maintenance'
    const lease = await acquireLock(db, { lockName, controlRunId: 'run-1', ttlMs: 60_000 })
    const before = await getLock(db, lockName)

    const ok = await renewLock(db, { lockName, ownerToken: 'not-the-owner', ttlMs: 120_000 })
    expect(ok).toBe(false)
    const after = await getLock(db, lockName)
    expect(after.expires_at).toBe(before.expires_at) // untouched
  })

  it('is a no-op with missing args', async () => {
    expect(await renewLock(db, {})).toBe(false)
    expect(await renewLock(db, { lockName: 'x' })).toBe(false)
    expect(await renewLock(null, { lockName: 'x', ownerToken: 't' })).toBe(false)
  })
})

describe('runWithSchedulerLock heartbeat', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renews a SHORT-TTL lease while the critical section runs, then releases', async () => {
    vi.useFakeTimers()
    const ttlMs = 60_000 // floor; heartbeat period = ttl/3 = 20s

    let release
    const gate = new Promise((resolve) => { release = resolve })
    let seenExpiresAt = null

    const p = runWithSchedulerLock(db, { lockName: 'nightly-maintenance', ttlMs, heartbeat: true, logger: { info() {}, warn() {} } }, async () => {
      const held = await getLock(db, 'scheduler:nightly-maintenance')
      seenExpiresAt = held.expires_at
      await gate
      return 'done'
    })

    // Let the acquire + fn-entry microtasks settle.
    await vi.advanceTimersByTimeAsync(0)
    expect(seenExpiresAt).not.toBeNull()

    // Advance past one heartbeat period (period = max(30s, ttl/3)) — the
    // interval must renew the lease.
    await vi.advanceTimersByTimeAsync(35_000)
    const midRun = await getLock(db, 'scheduler:nightly-maintenance')
    expect(midRun).not.toBeNull()
    expect(new Date(midRun.expires_at).getTime()).toBeGreaterThan(new Date(seenExpiresAt).getTime())

    // Finish the critical section — the lock must be released in finally.
    release()
    const result = await p
    expect(result).toBe('done')
    expect(await getLock(db, 'scheduler:nightly-maintenance')).toBeNull()
  })

  it('a second tick is SKIPPED while the first holds the lock (no concurrent heavy sweep)', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const first = runWithSchedulerLock(db, { lockName: 'nightly-maintenance', ttlMs: 60_000, heartbeat: true, logger: { info() {}, warn() {} } }, async () => {
      await gate
      return 'first'
    })
    // Give the first call time to acquire.
    await new Promise((r) => setTimeout(r, 20))
    const second = await runWithSchedulerLock(db, { lockName: 'nightly-maintenance', ttlMs: 60_000, heartbeat: true, logger: { info() {}, warn() {} } }, async () => 'second')
    expect(second).toEqual({ skipped: true, reason: 'lock_held', lockName: 'nightly-maintenance' })
    release()
    expect(await first).toBe('first')
  })
})
