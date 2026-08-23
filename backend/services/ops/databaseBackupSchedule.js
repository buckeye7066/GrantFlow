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

import { runDatabaseBackup, BACKUP_LAST_RUN_KEY } from './databaseBackup.js'

const DEFAULT_INTERVAL_HOURS = 20

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

export default {
  isDatabaseBackupScheduleEnabled,
  backupIntervalMs,
  runDatabaseBackupIfDue,
}
