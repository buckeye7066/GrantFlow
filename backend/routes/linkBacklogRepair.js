import express from 'express'
import {
  brokenDirectSummary,
  reclassifyBrokenResources,
  repairBrokenDirectBatch,
} from '../services/linkBacklogRepairService.js'
import { createLogger } from '../utils/logger.js'

const router = express.Router()
const log = createLogger('route:link-backlog-repair')

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
    const before = await brokenDirectSummary(req.db)
    const reclassified = await reclassifyBrokenResources(req.db)
    const after = await brokenDirectSummary(req.db)
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, before, reclassified, after })
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
    const result = await repairBrokenDirectBatch(req.db, {
      limit: req.body?.limit,
      concurrency: req.body?.concurrency,
      timeoutMs: req.body?.timeout_ms,
      cycleId,
      verifiedBy: cycleId
        ? `admin-link-repair:${cycleId}`
        : `admin-link-repair:${actor}`,
    })
    res.set('Cache-Control', 'no-store')
    return res.json(result)
  } catch (error) {
    log.error('repair_failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'LINK_BACKLOG_REPAIR_FAILED', details_redacted: true })
  }
})

export default router
