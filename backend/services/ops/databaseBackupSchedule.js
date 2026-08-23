/**
 * databaseBackupSchedule.js — the SCHEDULE + freshness gate around
 * `runDatabaseBackup` (backend/services/ops/databaseBackup.js).
 *
 * The backup machinery (epic slice 9) existed and was correct, but NOTHING
 * ever scheduled it: prod `system_kv backup_last_run` was absent for the life
 * of the app, so Sam `ops.backupFreshness` reported "never recorded" and the
 * runbook's "restore from backup" promise was empty. This module is the missing
 * ACTOR — a daily, catch-up-friendly, idempotent trigger.
 *
 * Deliberately DECOUPLED from the heavy nightly maintenance sweep
 * (`runNightlyMaintenanceSweep`): a backup is disaster-recovery and must not
 * inherit the reliability of the self-heal / web-parity / coverage-autoheal
 * chain. The gate reads the SAME `backup_last_run` stamp the backup writes, so
 * a missed day is caught on the next hourly tick and a fresh backup is never
 * re-run — no separate marker, no double-run.
 */

import crypto from 'node:crypto'

import { runDatabaseBackup, BACKUP_LAST_RUN_KEY } from './databaseBackup.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

const DEFAULT_INTERVAL_HOURS = 20

/**
 * The manual-trigger status marker. The manual admin route
 * (POST /api/maintenance/run-backup) is a BACKGROUND job — on the ~4.3GB prod DB
 * `pg_dump` outlasts Railway's HTTP edge timeout, so a synchronous route returned
 * HTTP 504 to the caller even though the dump completed server-side. The route
 * now returns 202 immediately and the dump runs detached; this `system_kv` row is
 * the read-back the caller polls (`running` -> `completed`/`failed`/`skipped`),
 * alongside the durable `backup_last_run` stamp the backup itself writes.
 */
export const MANUAL_BACKUP_STATE_KEY = 'backup_manual_run'

/**
 * The UNATTENDED daily cron is OPT-IN (default off). On this prod DB the backup
 * falls to the pure-SQL JSON path because `pg_dump` is not on the Railway image,
 * and the DB is ~4.3GB (mostly high-churn crawler/geo/audit tables), so an
 * unattended nightly full dump holds a long read transaction and is heavy. The
 * owner enables it (`DB_BACKUP_SCHEDULE_ENABLED=true`) once `pg_dump`
 * (postgresql-client) is added to the image — then it uses the fast compressed
 * custom-format dump. The manual admin route (POST /api/maintenance/run-backup)
 * always works regardless of this flag (it forces).
 */
export function isDatabaseBackupScheduleEnabled() {
  return String(process.env.DB_BACKUP_SCHEDULE_ENABLED ?? 'false').toLowerCase() === 'true'
}

/**
 * Minimum age of the last backup before a new one is due. 20h (not 24h) so a
 * daily run whose clock drifts an hour is never skipped, while a fresh backup
 * from the same day is not re-taken.
 */
export function backupIntervalMs() {
  const h = Number(process.env.DB_BACKUP_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS) || DEFAULT_INTERVAL_HOURS
  return Math.max(1, h) * 60 * 60 * 1000
}

async function readLastBackupAtMs(db) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(BACKUP_LAST_RUN_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    const at = Date.parse(parsed?.at || '')
    return Number.isFinite(at) ? at : null
  } catch {
    // system_kv not migrated / unreadable — treat as "no backup on record" so the
    // caller attempts one; runDatabaseBackup itself surfaces any real failure.
    return null
  }
}

/**
 * Take a verified backup ONLY when one is due (or forced). Returns
 * `{ ran, reason, ... }`; never swallows a backup FAILURE — `runDatabaseBackup`
 * throws on failure and the caller (cron try/catch or admin route) reports it.
 *
 * `backupFn` is injectable for tests so the due-gate can be exercised without
 * writing a real artifact.
 *
 * @param {object} db
 * @param {{ force?: boolean, now?: number, backupFn?: Function }} [opts]
 */
export async function runDatabaseBackupIfDue(db, { force = false, now = Date.now(), backupFn = runDatabaseBackup } = {}) {
  if (!db?.prepare) return { ran: false, reason: 'no_db' }
  if (!force && !isDatabaseBackupScheduleEnabled()) return { ran: false, reason: 'disabled' }

  const lastAtMs = await readLastBackupAtMs(db)
  if (!force && lastAtMs !== null && (now - lastAtMs) < backupIntervalMs()) {
    return { ran: false, reason: 'fresh', last_at: new Date(lastAtMs).toISOString() }
  }

  const result = await backupFn({ db })
  const reason = force ? 'forced' : (lastAtMs === null ? 'never_run' : 'stale')
  return { ran: true, reason, result }
}

async function writeManualBackupState(db, value) {
  if (!db?.prepare) return
  const now = new Date().toISOString()
  const json = JSON.stringify(value)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(json, now, MANUAL_BACKUP_STATE_KEY)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(MANUAL_BACKUP_STATE_KEY, json, now)
  }
}

/**
 * Read the manual-trigger status marker (the poll target for the admin route's
 * background job). Returns null when nothing has ever been triggered.
 */
export async function readManualBackupState(db) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(MANUAL_BACKUP_STATE_KEY)
    return row?.value ? JSON.parse(row.value) : null
  } catch {
    return null
  }
}

/**
 * Kick off a manual (forced) backup as a BACKGROUND job and return immediately.
 *
 * The dump on the ~4.3GB prod DB outlives Railway's HTTP edge timeout, so the
 * admin route must NOT await it (that returned 504 while the backup actually
 * completed server-side). This writes a `running` marker (awaited, so a poll
 * right after the 202 sees it), then runs the backup under the SHARED
 * `database-backup` scheduler lock — the SAME lock the daily cron uses, so a
 * manual trigger can never stack with the cron or a second manual run — updating
 * the marker to `completed`/`failed`/`skipped` when the detached work settles.
 *
 * @param {object} db  the shared app db handle (stays valid after the HTTP response)
 * @param {{ logger?: object, lockRunner?: Function, backupRunner?: Function }} [deps]
 * @returns {{ runId: string, startedAt: string, done: Promise<void> }}
 *   `done` resolves/rejects when the detached work settles — for tests; the route
 *   ignores it (fire-and-forget) but attaches a `.catch` so a rejection never
 *   becomes an unhandled promise.
 */
export function startManualBackup(db, {
  logger = console,
  lockRunner = runWithSchedulerLock,
  backupRunner = runDatabaseBackupIfDue,
} = {}) {
  const runId = `manual-backup-${Date.now()}-${crypto.randomUUID()}`
  const startedAt = new Date().toISOString()

  const done = (async () => {
    await writeManualBackupState(db, { state: 'running', run_id: runId, started_at: startedAt })
    try {
      const outcome = await lockRunner(db, {
        lockName: 'database-backup',
        ttlMs: 60 * 60 * 1000,
        heartbeat: true,
        logger,
      }, () => backupRunner(db, { force: true }))

      if (outcome?.skipped) {
        await writeManualBackupState(db, {
          state: 'skipped',
          reason: outcome.reason || 'lock_held',
          run_id: runId,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        })
      } else {
        await writeManualBackupState(db, {
          state: 'completed',
          run_id: runId,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          ran: Boolean(outcome?.ran),
          reason: outcome?.reason || null,
          path: outcome?.result?.path || null,
          bytes: outcome?.result?.bytes ?? null,
          dialect: outcome?.result?.dialect || null,
        })
      }
    } catch (error) {
      await writeManualBackupState(db, {
        state: 'failed',
        run_id: runId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: String(error?.message || error),
      }).catch(() => { /* the marker write is best-effort; never mask the real error */ })
      throw error
    }
  })()

  return { runId, startedAt, done }
}

export default {
  isDatabaseBackupScheduleEnabled,
  backupIntervalMs,
  runDatabaseBackupIfDue,
  MANUAL_BACKUP_STATE_KEY,
  readManualBackupState,
  startManualBackup,
}
