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
  startManualBackup,
  readManualBackupState,
  MANUAL_BACKUP_STATE_KEY,
} from '../services/ops/databaseBackupSchedule.js'
import { BACKUP_LAST_RUN_KEY } from '../services/ops/databaseBackup.js'

// A minimal system_kv store: honors the UPDATE-then-INSERT upsert the marker
// writer uses and the SELECT the reader uses. Everything is async, mirroring the
// prod Postgres shim.
function kvDb() {
  const store = new Map()
  return {
    store,
    prepare(sql) {
      return {
        run: async (...args) => {
          if (/UPDATE system_kv/.test(sql)) {
            const [value, updated, key] = args
            if (!store.has(key)) return { changes: 0, rowCount: 0 }
            store.set(key, { value, updated_at: updated })
            return { changes: 1, rowCount: 1 }
          }
          if (/INSERT INTO system_kv/.test(sql)) {
            const [key, value, updated] = args
            store.set(key, { value, updated_at: updated })
            return { changes: 1, rowCount: 1 }
          }
          return { changes: 0, rowCount: 0 }
        },
        get: async (key) => {
          if (/SELECT value FROM system_kv/.test(sql)) {
            const row = store.get(key)
            return row ? { value: row.value } : undefined
          }
          return undefined
        },
      }
    },
  }
}

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

describe('startManualBackup (background job)', () => {
  // A lock runner that just runs the critical section (no real lock) — the point
  // of the manual-backup tests is the marker lifecycle, not the lock internals.
  const passthroughLock = (_db, _opts, fn) => fn()

  it('returns a run marker SYNCHRONOUSLY without awaiting the dump', () => {
    const db = kvDb()
    let dumpStarted = false
    const backupRunner = async () => { dumpStarted = true; return { ran: true, result: { path: '/x.dump', bytes: 5 } } }
    const handle = startManualBackup(db, { lockRunner: passthroughLock, backupRunner })
    // The dump has NOT run yet — startManualBackup handed back control immediately.
    expect(dumpStarted).toBe(false)
    expect(handle.runId).toMatch(/^manual-backup-/)
    expect(typeof handle.done.then).toBe('function')
    return handle.done // let the background work settle so vitest sees no dangling promise
  })

  it('records running -> completed with the backup artifact on success', async () => {
    const db = kvDb()
    const backupRunner = async () => ({ ran: true, reason: 'forced', result: { path: '/data/backups/x.dump', bytes: 4321, dialect: 'postgres' } })
    const { runId, done } = startManualBackup(db, { lockRunner: passthroughLock, backupRunner })
    await done
    const state = await readManualBackupState(db)
    expect(state.state).toBe('completed')
    expect(state.run_id).toBe(runId)
    expect(state.path).toBe('/data/backups/x.dump')
    expect(state.bytes).toBe(4321)
    expect(state.dialect).toBe('postgres')
    expect(state.finished_at).toBeTruthy()
  })

  it('records skipped when the shared lock is already held (no stacking with the cron)', async () => {
    const db = kvDb()
    const heldLock = async () => ({ skipped: true, reason: 'lock_held' })
    let dumpRan = false
    const backupRunner = async () => { dumpRan = true; return { ran: true } }
    const { done } = startManualBackup(db, { lockRunner: heldLock, backupRunner })
    await done
    const state = await readManualBackupState(db)
    expect(state.state).toBe('skipped')
    expect(state.reason).toBe('lock_held')
    // The backup body never ran because the lock refused it.
    expect(dumpRan).toBe(false)
  })

  it('records failed and rejects `done` when the dump throws', async () => {
    const db = kvDb()
    const backupRunner = async () => { throw new Error('pg_dump exited 1: boom') }
    const { done } = startManualBackup(db, { lockRunner: passthroughLock, backupRunner })
    await expect(done).rejects.toThrow(/boom/)
    const state = await readManualBackupState(db)
    expect(state.state).toBe('failed')
    expect(state.error).toMatch(/boom/)
  })

  it('writes the marker under the canonical system_kv key', async () => {
    const db = kvDb()
    const backupRunner = async () => ({ ran: true, result: { path: '/x', bytes: 1 } })
    const { done } = startManualBackup(db, { lockRunner: passthroughLock, backupRunner })
    await done
    expect(db.store.has(MANUAL_BACKUP_STATE_KEY)).toBe(true)
    expect(MANUAL_BACKUP_STATE_KEY).toBe('backup_manual_run')
  })
})
