/**
 * The daily backup SCHEDULE gate (backend/services/ops/databaseBackupSchedule.js):
 * a backup is taken when none is on record or the last one is stale, is SKIPPED
 * when a fresh one exists, and `force` overrides the gate. `backupFn` is injected
 * so the due-logic is exercised without writing a real artifact.
 *
 * Mutation check: delete the `(now - lastAtMs) < backupIntervalMs()` skip and the
 * "fresh backup is not re-taken" test reddens.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupIntervalMs,
  runDatabaseBackupIfDue,
} from '../services/ops/databaseBackupSchedule.js'
import { BACKUP_LAST_RUN_KEY } from '../services/ops/databaseBackup.js'

function fakeDb(lastRunRecord) {
  return {
    prepare(sql) {
      return {
        get: async () => {
          if (/system_kv/.test(sql)) {
            return lastRunRecord === undefined
              ? undefined
              : { value: JSON.stringify(lastRunRecord) }
          }
          return undefined
        },
      }
    },
  }
}

function countingBackup() {
  const calls = []
  const fn = async ({ db }) => {
    calls.push(db)
    return { ok: true, dialect: 'sqlite', path: '/tmp/x.db', bytes: 2048, pruned: [] }
  }
  return { fn, calls }
}

const NOW = Date.parse('2026-08-23T12:00:00.000Z')

afterEach(() => {
  delete process.env.DB_BACKUP_SCHEDULE_ENABLED
  delete process.env.DB_BACKUP_INTERVAL_HOURS
})

describe('runDatabaseBackupIfDue', () => {
  it('is keyed on the SAME stamp the backup writes', () => {
    expect(BACKUP_LAST_RUN_KEY).toBe('backup_last_run')
  })

  it('the unattended schedule is OPT-IN: a non-force call is disabled by default', async () => {
    const { fn, calls } = countingBackup()
    const res = await runDatabaseBackupIfDue(fakeDb(undefined), { now: NOW, backupFn: fn })
    expect(res.ran).toBe(false)
    expect(res.reason).toBe('disabled')
    expect(calls).toHaveLength(0)
  })

  it('takes a backup when opted-in and none has ever been recorded (never_run)', async () => {
    process.env.DB_BACKUP_SCHEDULE_ENABLED = 'true'
    const { fn, calls } = countingBackup()
    const res = await runDatabaseBackupIfDue(fakeDb(undefined), { now: NOW, backupFn: fn })
    expect(res.ran).toBe(true)
    expect(res.reason).toBe('never_run')
    expect(calls).toHaveLength(1)
  })

  it('SKIPS when opted-in but a fresh backup already exists (fresh)', async () => {
    process.env.DB_BACKUP_SCHEDULE_ENABLED = 'true'
    const { fn, calls } = countingBackup()
    const at = new Date(NOW - 60 * 60 * 1000).toISOString() // 1h ago
    const res = await runDatabaseBackupIfDue(fakeDb({ at, path: '/tmp/y.db', bytes: 1, dialect: 'sqlite' }), { now: NOW, backupFn: fn })
    expect(res.ran).toBe(false)
    expect(res.reason).toBe('fresh')
    expect(calls).toHaveLength(0)
  })

  it('takes a backup when opted-in and the last one is stale (older than the interval)', async () => {
    process.env.DB_BACKUP_SCHEDULE_ENABLED = 'true'
    const { fn, calls } = countingBackup()
    const at = new Date(NOW - 30 * 60 * 60 * 1000).toISOString() // 30h ago > 20h
    const res = await runDatabaseBackupIfDue(fakeDb({ at, path: '/tmp/y.db', bytes: 1, dialect: 'sqlite' }), { now: NOW, backupFn: fn })
    expect(res.ran).toBe(true)
    expect(res.reason).toBe('stale')
    expect(calls).toHaveLength(1)
  })

  it('force overrides a fresh backup', async () => {
    const { fn, calls } = countingBackup()
    const at = new Date(NOW).toISOString()
    const res = await runDatabaseBackupIfDue(fakeDb({ at, path: '/tmp/y.db', bytes: 1, dialect: 'sqlite' }), { now: NOW, force: true, backupFn: fn })
    expect(res.ran).toBe(true)
    expect(res.reason).toBe('forced')
    expect(calls).toHaveLength(1)
  })

  it('does not run (without force) when the schedule is disabled', async () => {
    process.env.DB_BACKUP_SCHEDULE_ENABLED = 'false'
    const { fn, calls } = countingBackup()
    const res = await runDatabaseBackupIfDue(fakeDb(undefined), { now: NOW, backupFn: fn })
    expect(res.ran).toBe(false)
    expect(res.reason).toBe('disabled')
    expect(calls).toHaveLength(0)
  })

  it('force runs even when disabled', async () => {
    process.env.DB_BACKUP_SCHEDULE_ENABLED = 'false'
    const { fn, calls } = countingBackup()
    const res = await runDatabaseBackupIfDue(fakeDb(undefined), { now: NOW, force: true, backupFn: fn })
    expect(res.ran).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('a stale (unreadable) stamp interval honors DB_BACKUP_INTERVAL_HOURS', () => {
    process.env.DB_BACKUP_INTERVAL_HOURS = '6'
    expect(backupIntervalMs()).toBe(6 * 60 * 60 * 1000)
  })
})
