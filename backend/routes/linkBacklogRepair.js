import express from 'express'
import {
  brokenDirectSummary,
  estimateRepairLockTtlMs,
  reclassifyBrokenResources,
  repairBrokenDirectBatch,
  scheduleRetryableBrokenRows,
} from '../services/linkBacklogRepairService.js'
import { runWithSchedulerLock } from '../services/schedulerLock.js'
import { createLogger } from '../utils/logger.js'

const router = express.Router()
const log = createLogger('route:link-backlog-repair')
const LOCK_NAME = 'link-verification'
const RECLASSIFY_LOCK_TTL_MS = 30 * 60 * 1000

function requireAdmin(req, res) {
  if (req.ctx?.isAdmin === true) return true
  res.status(403).json({ ok: false, error: 'Admin access required' })
  return false
}

function cleanCycleId(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, 96)
  return cleaned || null
}

function lockConflict(res, result) {
  return res.status(409).json({
    ok: false,
    error: 'LINK_REPAIR_ALREADY_RUNNING',
    reason: result?.reason || 'lock_held',
    lock_name: result?.lockName || LOCK_NAME,
  })
}

router.get('/status', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: true,
      summary: await brokenDirectSummary(req.db),
      generated_at: new Date().toISOString(),
    })
  } catch (error) {
    log.warn('status_failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'LINK_REPAIR_STATUS_FAILED', details_redacted: true })
  }
})

router.post('/reclassify', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const actor = req.ctx?.email || req.ctx?.userId || 'admin'
    // link_backlog_shared_scheduler_lock: reclassification and repair use the
    // same durable lease as recurring verification, preventing row rewrite races.
    const result = await runWithSchedulerLock(req.db, {
      lockName: LOCK_NAME,
      ttlMs: RECLASSIFY_LOCK_TTL_MS,
      logger: log,
      acquiredBy: `admin-link-reclassify:${actor}`,
    }, async () => {
      const before = await brokenDirectSummary(req.db)
      const reclassified = await reclassifyBrokenResources(req.db)
      const after = await brokenDirectSummary(req.db)
      return { ok: true, before, reclassified, after }
    })
    res.set('Cache-Control', 'no-store')
    if (result?.skipped) return lockConflict(res, result)
    return res.json(result)
  } catch (error) {
    log.error('reclassify_failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'LINK_RESOURCE_RECLASSIFICATION_FAILED', details_redacted: true })
  }
})

router.post('/run', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const cycleId = cleanCycleId(req.body?.cycle_id)
    const actor = req.ctx?.email || req.ctx?.userId || 'admin'
    const repairOptions = {
      limit: req.body?.limit,
      concurrency: req.body?.concurrency,
      timeoutMs: req.body?.timeout_ms,
      pendingRetryAfterMs: req.body?.pending_retry_after_ms,
      cycleId,
      verifiedBy: cycleId
        ? `admin-link-repair:${cycleId}`
        : `admin-link-repair:${actor}`,
    }
    const result = await runWithSchedulerLock(req.db, {
      lockName: LOCK_NAME,
      // link_backlog_runtime_bounded_lock_ttl: derive the lease from the exact
      // bounded batch instead of letting a fixed 30-minute lease expire mid-run.
      ttlMs: estimateRepairLockTtlMs(repairOptions),
      logger: log,
      acquiredBy: cycleId ? `admin-link-repair:${cycleId}` : `admin-link-repair:${actor}`,
    }, () => repairBrokenDirectBatch(req.db, repairOptions))
    res.set('Cache-Control', 'no-store')
    if (result?.skipped) return lockConflict(res, result)
    return res.json(result)
  } catch (error) {
    log.error('repair_failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'LINK_BACKLOG_REPAIR_FAILED', details_redacted: true })
  }
})

router.post('/schedule-retry', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const cyclePrefix = cleanCycleId(req.body?.cycle_prefix)
    if (!cyclePrefix) {
      return res.status(400).json({ ok: false, error: 'cycle_prefix is required' })
    }
    const actor = req.ctx?.email || req.ctx?.userId || 'admin'
    const result = await runWithSchedulerLock(req.db, {
      lockName: LOCK_NAME,
      ttlMs: RECLASSIFY_LOCK_TTL_MS,
      logger: log,
      acquiredBy: `admin-link-schedule-retry:${actor}`,
    }, () => scheduleRetryableBrokenRows(req.db, {
      cyclePrefix,
      minAttempts: req.body?.min_attempts,
      // scheduled_retry_uses_canonical_30_day_window
      retryAfterDays: 30,
      limit: req.body?.limit,
    }))
    res.set('Cache-Control', 'no-store')
    if (result?.skipped) return lockConflict(res, result)
    return res.json(result)
  } catch (error) {
    log.error('schedule_retry_failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'LINK_RETRY_SCHEDULING_FAILED', details_redacted: true })
  }
})

export default router
