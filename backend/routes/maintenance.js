/**
 * maintenance.js — mounted at /api/maintenance.
 *   GET  /status    : public — current maintenance phase (drives the frontend gate).
 *   POST /schedule  : admin  — start a window (grace warning -> down).
 *   POST /end        : admin  — reopen the app.
 *   POST /run-nightly-sweep : admin — run the Sam nightly maintenance now.
 */

import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { formatError } from '../middleware/errorHandler.js'
import { getMaintenanceStatus, scheduleMaintenance, endMaintenance } from '../services/maintenance/maintenanceMode.js'

const router = express.Router()

// PUBLIC: the frontend polls this even when signed out (so the login screen can
// show "down for maintenance"). Never throws — degrades to "open".
router.get('/status', async (req, res) => {
  try {
    res.json(await getMaintenanceStatus(req.db))
  } catch {
    res.json({ phase: 'open', active: false })
  }
})

router.post('/schedule', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const by = req.user?.email ?? req.user?.userId ?? 'admin'
    const result = await scheduleMaintenance(req.db, {
      graceMinutes: req.body?.graceMinutes,
      estimatedMinutes: req.body?.estimatedMinutes,
      reason: req.body?.reason || 'deploy',
      message: req.body?.message || null,
      by,
    })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/end', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const by = req.user?.email ?? req.user?.userId ?? 'admin'
    res.json(await endMaintenance(req.db, { by }))
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/run-nightly-sweep', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { runNightlyMaintenanceSweep } = await import('../services/maintenance/nightlySweep.js')
    const result = await runNightlyMaintenanceSweep(req.db, { force: true })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Admin — take a VERIFIED database backup now as a BACKGROUND JOB.
//
// WHY 202, not a synchronous result: on the ~4.3GB prod DB `pg_dump` runs longer
// than Railway's HTTP edge timeout, so awaiting the dump inside the request
// returned HTTP 504 to the caller even though the backup completed server-side.
// The route now kicks the dump off detached (under the shared 'database-backup'
// scheduler lock, so it can never stack with the daily cron or a second manual
// run) and returns immediately; the caller polls GET /backup-status for the
// outcome. `req.db` is the shared app handle, so it stays valid after we respond.
router.post('/run-backup', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { startManualBackup } = await import('../services/ops/databaseBackupSchedule.js')
    const { runId, startedAt, done } = startManualBackup(req.db, { logger: console })
    // Fire-and-forget: swallow a background rejection so it never becomes an
    // unhandled promise. The failure is durably recorded on the status marker
    // the caller polls; also surface it in the logs for operators.
    done.catch((error) => {
      console.error('[db-backup] manual background backup failed:', error?.message || error)
    })
    res.status(202).json({
      accepted: true,
      state: 'running',
      run_id: runId,
      started_at: startedAt,
      poll: '/api/maintenance/backup-status',
      note: 'Backup started in the background; poll backup-status for completion.',
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Admin — poll the manual backup job + the durable last-run stamp.
// `manual_run` reflects the most recent background trigger
// (running/completed/failed/skipped); `last_run` is the same `backup_last_run`
// stamp Sam `ops.backupFreshness` reads (written only after an artifact passes
// its integrity check).
router.get('/backup-status', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { readManualBackupState } = await import('../services/ops/databaseBackupSchedule.js')
    const { BACKUP_LAST_RUN_KEY } = await import('../services/ops/databaseBackup.js')
    const manualRun = await readManualBackupState(req.db)
    let lastRun = null
    try {
      const lastRunRow = await req.db.prepare('SELECT value FROM system_kv WHERE key = ?').get(BACKUP_LAST_RUN_KEY)
      if (lastRunRow?.value) lastRun = JSON.parse(lastRunRow.value)
    } catch { /* no stamp yet / unreadable — report null */ }
    res.json({ manual_run: manualRun, last_run: lastRun })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

export default router
