import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  ensureSchema,
  _resetSchemaCache,
  acquireLock,
  getLock,
  getInstance,
  heartbeatInstance,
} from '../services/agentControl/agentControlStore.js'

// Pins the 2026-09-12 stale-lock-reclaim fix: a redeploy/restart that kills a
// lock's holding process must not wedge a scheduler lock (e.g.
// scheduler:amy:training) for the remainder of its TTL. acquireLock() may now
// take over a lock whose recorded holder instance has gone silent (no
// heartbeat) even while the lock's own expires_at is still in the future — a
// LIVE holder (fresh heartbeat) must never be touched, so mutual exclusion
// across concurrently-running instances is unaffected.

function makeDb() {
  _resetSchemaCache()
  const db = new Database(':memory:')
  return db
}

function backdateHeartbeat(db, instanceId, ageMs) {
  db.prepare('UPDATE agent_control_instances SET last_heartbeat_at = ? WHERE instance_id = ?')
    .run(new Date(Date.now() - ageMs).toISOString(), instanceId)
}

const LONG_TTL_MS = 15 * 60 * 1000 // mirrors Amy's real scheduler lock TTL

describe('agentControlStore locks — dead-holder-instance reclaim', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })

  it('takes over a lock whose holder instance has gone silent, even though its TTL has NOT expired', async () => {
    const lockName = 'scheduler:amy:training'

    const first = await acquireLock(db, {
      lockName,
      controlRunId: 'amy-run-old',
      ttlMs: LONG_TTL_MS,
      instanceId: 'instance-dead',
    })
    expect(first.acquired).toBe(true)

    // The old holder's heartbeat row exists (acquireLock registered it) but
    // has not been refreshed in a long time — simulating a process killed by
    // a Railway redeploy well before its lock's 15-minute TTL lapsed.
    backdateHeartbeat(db, 'instance-dead', 5 * 60 * 1000) // 5 minutes stale

    const before = await getLock(db, lockName)
    expect(new Date(before.expires_at).getTime()).toBeGreaterThan(Date.now()) // NOT ttl-expired

    const second = await acquireLock(db, {
      lockName,
      controlRunId: 'amy-run-new',
      ttlMs: LONG_TTL_MS,
      instanceId: 'instance-alive',
    })

    expect(second.acquired).toBe(true)
    expect(second.tookOver).toBe(true)
    expect(second.reclaimReason).toBe('dead_holder_instance')

    const held = await getLock(db, lockName)
    expect(held.control_run_id).toBe('amy-run-new')
    expect(held.holder_instance_id).toBe('instance-alive')
    expect(held.owner_token).toBe(second.ownerToken)
  })

  it('also reclaims when the holder instance row does not exist at all (pruned or never registered)', async () => {
    const lockName = 'scheduler:amy:training'
    const farFuture = new Date(Date.now() + LONG_TTL_MS).toISOString()

    // Simulate a lock whose holder_instance_id points at an instance row that
    // was already pruned (or a lock written by an older process before the
    // instance ever heartbeated).
    db.prepare(`
      INSERT INTO agent_control_locks (id, lock_name, control_run_id, owner_token, acquired_by, acquired_at, expires_at, holder_instance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lock-ghost', lockName, 'run-ghost', 'token-ghost', 'ghost@run', new Date().toISOString(), farFuture, 'instance-never-registered')

    const result = await acquireLock(db, {
      lockName,
      controlRunId: 'amy-run-new',
      ttlMs: LONG_TTL_MS,
      instanceId: 'instance-alive',
    })

    expect(result.acquired).toBe(true)
    expect(result.tookOver).toBe(true)
    expect(result.reclaimReason).toBe('dead_holder_instance')
  })

  it('does NOT take over a lock whose holder instance is still heartbeating (genuine live contention)', async () => {
    const lockName = 'scheduler:amy:training'

    const first = await acquireLock(db, {
      lockName,
      controlRunId: 'amy-run-a',
      ttlMs: LONG_TTL_MS,
      instanceId: 'instance-a',
    })
    expect(first.acquired).toBe(true)

    // instance-a's heartbeat is fresh (acquireLock just registered it) — a
    // second, different instance must be refused, not allowed to reclaim.
    const second = await acquireLock(db, {
      lockName,
      controlRunId: 'amy-run-b',
      ttlMs: LONG_TTL_MS,
      instanceId: 'instance-b',
      retries: 0,
    })

    expect(second.acquired).toBe(false)
    expect(second.reason).toBe('held')
    expect(second.heldBy).toBe('amy-run-a')

    const held = await getLock(db, lockName)
    expect(held.control_run_id).toBe('amy-run-a')
    expect(held.holder_instance_id).toBe('instance-a')
  })

  it('a lock with NO recorded holder_instance_id (legacy/opt-out) is reclaimable only via TTL, never via the dead-instance path', async () => {
    const lockName = 'agent_control:full_cycle'
    const farFuture = new Date(Date.now() + LONG_TTL_MS).toISOString()

    db.prepare(`
      INSERT INTO agent_control_locks (id, lock_name, control_run_id, owner_token, acquired_by, acquired_at, expires_at, holder_instance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run('lock-legacy', lockName, 'run-legacy', 'token-legacy', 'legacy@run', new Date().toISOString(), farFuture)

    const attempt = await acquireLock(db, {
      lockName,
      controlRunId: 'run-new',
      ttlMs: LONG_TTL_MS,
      instanceId: 'instance-new',
      retries: 0,
    })

    // Not expired and holder_instance_id is NULL -> must stay genuinely held.
    expect(attempt.acquired).toBe(false)
    expect(attempt.reason).toBe('held')
    const held = await getLock(db, lockName)
    expect(held.control_run_id).toBe('run-legacy')
  })

  it('two competing instances: contention while both are alive, reclaim once the holder dies, then contention resumes for a third', async () => {
    const lockName = 'scheduler:amy:training'

    const a = await acquireLock(db, { lockName, controlRunId: 'run-a', ttlMs: LONG_TTL_MS, instanceId: 'instance-a' })
    expect(a.acquired).toBe(true)

    // B contends while A is alive.
    const bContended = await acquireLock(db, { lockName, controlRunId: 'run-b', ttlMs: LONG_TTL_MS, instanceId: 'instance-b', retries: 0 })
    expect(bContended.acquired).toBe(false)

    // A dies (heartbeat goes stale); B now reclaims.
    backdateHeartbeat(db, 'instance-a', 5 * 60 * 1000)
    const bReclaims = await acquireLock(db, { lockName, controlRunId: 'run-b', ttlMs: LONG_TTL_MS, instanceId: 'instance-b', retries: 0 })
    expect(bReclaims.acquired).toBe(true)
    expect(bReclaims.reclaimReason).toBe('dead_holder_instance')

    // C contends against the now-live B and must be refused.
    const cContended = await acquireLock(db, { lockName, controlRunId: 'run-c', ttlMs: LONG_TTL_MS, instanceId: 'instance-c', retries: 0 })
    expect(cContended.acquired).toBe(false)
    expect(cContended.heldBy).toBe('run-b')
  })

  it('heartbeatInstance upserts a fresh liveness row usable by getInstance', async () => {
    const ok = await heartbeatInstance(db, 'instance-manual')
    expect(ok).toBe(true)
    const inst = await getInstance(db, 'instance-manual')
    expect(inst).not.toBeNull()
    expect(inst.instance_id).toBe('instance-manual')
    expect(inst.last_heartbeat_at).toBeTruthy()
  })
})

describe('agentControlStore locks — schema self-heal for the stale-holder-reclaim columns', () => {
  it('ensureSchema adds holder_instance_id and agent_control_instances to a pre-migration DB', async () => {
    _resetSchemaCache()
    const db = new Database(':memory:')
    // Simulate a prod DB created before this fix: the ORIGINAL agent_control_locks
    // shape (with owner_token, per migration 099, but no holder_instance_id) and
    // no agent_control_instances table at all.
    db.exec(`
      CREATE TABLE agent_control_locks (
        id TEXT PRIMARY KEY,
        lock_name TEXT NOT NULL UNIQUE,
        control_run_id TEXT NOT NULL,
        owner_token TEXT,
        acquired_by TEXT,
        acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      );
    `)

    await ensureSchema(db)

    const cols = db.prepare('PRAGMA table_info(agent_control_locks)').all().map((c) => c.name)
    expect(cols).toContain('holder_instance_id')

    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_control_instances'`).all()
    expect(tables.length).toBe(1)

    // And the self-healed schema is immediately usable for a real acquire +
    // dead-holder reclaim, not just structurally present.
    const first = await acquireLock(db, { lockName: 'agent_control:agent:sam', controlRunId: 'run-1', ttlMs: LONG_TTL_MS, instanceId: 'inst-1' })
    expect(first.acquired).toBe(true)
    backdateHeartbeat(db, 'inst-1', 5 * 60 * 1000)
    const second = await acquireLock(db, { lockName: 'agent_control:agent:sam', controlRunId: 'run-2', ttlMs: LONG_TTL_MS, instanceId: 'inst-2' })
    expect(second.acquired).toBe(true)
    expect(second.reclaimReason).toBe('dead_holder_instance')
  })

  it('re-running ensureSchema on an already-healed DB is a harmless no-op', async () => {
    _resetSchemaCache()
    const db = new Database(':memory:')
    await ensureSchema(db)
    _resetSchemaCache()
    await expect(ensureSchema(db)).resolves.not.toThrow()
    const cols = db.prepare('PRAGMA table_info(agent_control_locks)').all().map((c) => c.name)
    expect(cols).toContain('holder_instance_id')
  })
})
