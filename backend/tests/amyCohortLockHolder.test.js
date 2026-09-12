/**
 * amyCohortLockHolder.test.js — amy-cohort-8: a refused lock NAMES its holder.
 *
 * acquireLock stored acquired_by + holder_instance_id on the row but its
 * not-acquired descriptor carried only control_run_id (a minted
 * `scheduler:amy:training:<ts>:<uuid>`), so the '[scheduler-lock] skipped;
 * lock held' log, amyRunner's `{skipped:true, reason:'lock_held'}` summary and
 * /status could never say whether admin, scheduler, or which instance held it.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureSchema,
  _resetSchemaCache,
  acquireLock,
  withLock,
} from '../services/agentControl/agentControlStore.js'
import { runWithSchedulerLock } from '../services/schedulerLock.js'

function makeDb() {
  _resetSchemaCache()
  return new Database(':memory:')
}

describe('amy-cohort-8 — the contended lease descriptor names the holder', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })

  it('acquireLock reports acquired_by + holder_instance_id of the live holder', async () => {
    const lockName = 'scheduler:amy:training'
    const first = await acquireLock(db, { lockName, controlRunId: 'scheduler:amy:training:1:aaa', acquiredBy: 'amy:scheduler', instanceId: 'instance-A', ttlMs: 60 * 60 * 1000 })
    expect(first.acquired).toBe(true)
    const second = await acquireLock(db, { lockName, controlRunId: 'scheduler:amy:training:2:bbb', acquiredBy: 'amy:admin', instanceId: 'instance-B', ttlMs: 60 * 60 * 1000 })
    expect(second.acquired).toBe(false)
    expect(second.heldBy).toBe('scheduler:amy:training:1:aaa')
    expect(second.acquiredBy).toBe('amy:scheduler')
    expect(second.holderInstanceId).toBe('instance-A')
    expect(second.acquiredAt).toBeTruthy()
    expect(second.expiresAt).toBeTruthy()
  })

  it('withLock\'s contended error names the holder identity, not only the minted run id', async () => {
    const lockName = 'scheduler:amy:training'
    await acquireLock(db, { lockName, controlRunId: 'run-a', acquiredBy: 'amy:scheduler', instanceId: 'instance-A', ttlMs: 60 * 60 * 1000 })
    let caught = null
    try {
      await withLock(db, { lockName, controlRunId: 'run-b', acquiredBy: 'amy:admin', instanceId: 'instance-B' }, async () => 'never')
    } catch (err) {
      caught = err
    }
    expect(caught?.code).toBe('LOCK_NOT_ACQUIRED')
    expect(caught.message).toMatch(/amy:scheduler/)
    expect(caught.message).toMatch(/instance-A/)
    expect(caught.lease).toMatchObject({ acquiredBy: 'amy:scheduler', holderInstanceId: 'instance-A' })
  })

  it('runWithSchedulerLock\'s lock_held result carries the holder so amyRunner/status can name it', async () => {
    await acquireLock(db, { lockName: 'scheduler:amy:training', controlRunId: 'run-a', acquiredBy: 'amy:scheduler', instanceId: 'instance-A', ttlMs: 60 * 60 * 1000 })
    const logs = []
    const result = await runWithSchedulerLock(db, { lockName: 'amy:training', logger: { info: (...a) => logs.push(a) } }, async () => 'ran')
    expect(result).toMatchObject({ skipped: true, reason: 'lock_held', heldBy: 'run-a', acquiredBy: 'amy:scheduler', holderInstanceId: 'instance-A' })
    const skipped = logs.find((l) => String(l[0]).includes('lock held'))
    expect(skipped?.[1]).toMatchObject({ acquiredBy: 'amy:scheduler', holderInstanceId: 'instance-A' })
  })
})
