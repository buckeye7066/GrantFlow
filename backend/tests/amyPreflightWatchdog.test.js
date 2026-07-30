import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

import { boundedAmyPreflight } from '../services/amy/amyPreflight.js'
import {
  AMY_SCHEDULER_LOCK_NAME,
  getAmyRunState,
  recoverStaleAmyRunLock,
} from '../services/amy/amyRunner.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE agent_control_locks (
      id TEXT PRIMARY KEY,
      lock_name TEXT NOT NULL UNIQUE,
      control_run_id TEXT NOT NULL,
      owner_token TEXT,
      acquired_by TEXT,
      acquired_at TEXT,
      expires_at TEXT
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      created_by TEXT,
      created_at TEXT
    );
    CREATE TABLE agent_activity_events (
      id TEXT PRIMARY KEY,
      agent_name TEXT,
      created_at TEXT
    );
  `)
  return db
}

function insertLock(db, {
  controlRunId = 'scheduler:amy:training:old',
  acquiredAt = '2026-07-30T00:20:14.765Z',
  expiresAt = '2026-07-30T02:20:14.765Z',
} = {}) {
  db.prepare(`
    INSERT INTO agent_control_locks
      (id, lock_name, control_run_id, owner_token, acquired_by, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('lock-1', AMY_SCHEDULER_LOCK_NAME, controlRunId, 'owner-1', 'amy:admin', acquiredAt, expiresAt)
  return controlRunId
}

describe('Amy preflight watchdog', () => {
  it('returns a fallback when a pre-profile dependency hangs', async () => {
    const logger = { warn: vi.fn() }
    const started = Date.now()
    const result = await boundedAmyPreflight(
      'hung_dependency',
      () => new Promise(() => {}),
      { timeoutMs: 100, fallback: { degraded: true }, logger },
    )

    expect(result).toEqual({ degraded: true })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(logger.warn).toHaveBeenCalledWith(
      'Amy preflight step degraded; continuing with fallback',
      expect.objectContaining({ step: 'hung_dependency', timed_out: true }),
    )
  })

  it('also fails open on a rejected preflight task', async () => {
    const logger = { warn: vi.fn() }
    const result = await boundedAmyPreflight(
      'failed_dependency',
      async () => { throw new Error('provider down') },
      { timeoutMs: 500, fallback: [], logger },
    )
    expect(result).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      'Amy preflight step degraded; continuing with fallback',
      expect.objectContaining({ step: 'failed_dependency', timed_out: false, error: 'provider down' }),
    )
  })
})

describe('Amy orphaned scheduler-lock recovery', () => {
  it('releases the exact old zero-activity lease after a process restart', async () => {
    const db = makeDb()
    const controlRunId = insertLock(db)
    const logger = { warn: vi.fn() }

    const result = await recoverStaleAmyRunLock({
      db,
      controlRunId,
      logger,
      minAgeMs: 60_000,
      now: new Date('2026-07-30T01:00:00.000Z'),
    })

    expect(result).toMatchObject({
      recovered: true,
      reason: 'orphaned_zero_activity_lock_released',
      released: 1,
      profiles_created: 0,
      events_recorded: 0,
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_control_locks').get().n).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      'amy.orphaned_scheduler_lock_recovered',
      expect.objectContaining({ control_run_id: controlRunId }),
    )
    db.close()
  })

  it('refuses a control-run mismatch', async () => {
    const db = makeDb()
    insertLock(db, { controlRunId: 'actual-holder' })
    const result = await recoverStaleAmyRunLock({
      db,
      controlRunId: 'wrong-holder',
      minAgeMs: 60_000,
      now: new Date('2026-07-30T01:00:00.000Z'),
    })
    expect(result).toMatchObject({ recovered: false, reason: 'control_run_id_mismatch' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_control_locks').get().n).toBe(1)
    db.close()
  })

  it('refuses to erase a lease that produced durable Amy evidence', async () => {
    const db = makeDb()
    const controlRunId = insertLock(db)
    db.prepare('INSERT INTO profiles (id, created_by, created_at) VALUES (?, ?, ?)')
      .run('amy-profile-1', 'agent:amy', '2026-07-30T00:21:00.000Z')

    const result = await recoverStaleAmyRunLock({
      db,
      controlRunId,
      minAgeMs: 60_000,
      now: new Date('2026-07-30T01:00:00.000Z'),
    })

    expect(result).toMatchObject({
      recovered: false,
      reason: 'durable_activity_detected',
      profiles_created: 1,
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_control_locks').get().n).toBe(1)
    db.close()
  })

  it('fails closed when durable activity cannot be read', async () => {
    const db = makeDb()
    const controlRunId = insertLock(db)
    db.exec('DROP TABLE agent_activity_events')

    await expect(recoverStaleAmyRunLock({
      db,
      controlRunId,
      minAgeMs: 60_000,
      now: new Date('2026-07-30T01:00:00.000Z'),
    })).rejects.toThrow(/agent_activity_events|no such table/i)

    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_control_locks').get().n).toBe(1)
    db.close()
  })

  it('refuses a lease acquired by the current process lifetime', async () => {
    const db = makeDb()
    const processStartedAt = getAmyRunState().process_started_at
    const acquiredAt = new Date(Date.parse(processStartedAt) + 60_000).toISOString()
    const controlRunId = insertLock(db, {
      acquiredAt,
      expiresAt: new Date(Date.parse(acquiredAt) + 2 * 60 * 60 * 1000).toISOString(),
    })

    const result = await recoverStaleAmyRunLock({
      db,
      controlRunId,
      minAgeMs: 60_000,
      now: new Date(Date.parse(acquiredAt) + 10 * 60 * 1000),
    })

    expect(result).toMatchObject({ recovered: false, reason: 'lock_does_not_predate_process' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_control_locks').get().n).toBe(1)
    db.close()
  })
})
