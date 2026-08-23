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

// Admin — take a VERIFIED database backup now (forces past the daily freshness
// gate). Stamps `system_kv backup_last_run` only after the artifact passes its
// integrity check; Sam `ops.backupFreshness` reads the same stamp.
router.post('/run-backup', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { runDatabaseBackupIfDue } = await import('../services/ops/databaseBackupSchedule.js')
    const result = await runDatabaseBackupIfDue(req.db, { force: true })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

export default router
