/**
 * routes/amy.js — Agent Amy admin API.
 *
 * Surfaces Amy's crawler-improvement reports to the admin panel and lets an
 * admin trigger an on-demand training+improvement run. Admin-only.
 */

import express from 'express'
import { createLogger } from '../utils/logger.js'
import {
  readLatestAmyReport,
  readAmyHistory,
  readAmyApprovalQueue,
} from '../services/amy/amyReportStore.js'

const log = createLogger('route:amy')
const router = express.Router()

function adminOnly(req, res, next) {
  if (req.ctx?.isAdmin === true) return next()
  return res.status(403).json({ ok: false, error: 'admin_required' })
}

router.use(adminOnly)

/** Lightweight status + last-run headline for the panel header. */
router.get('/status', async (req, res) => {
  try {
    const latest = await readLatestAmyReport(req.db)
    const enabled = String(process.env.AMY_ENABLED ?? 'false').toLowerCase() === 'true'
    return res.json({
      ok: true,
      status: {
        enabled,
        daily_target: Number(process.env.AMY_DAILY_PROFILE_TARGET) || 100,
        slider_floor: latest?.slider_floor ?? null,
        last_run_at: latest?.completed_at ?? null,
        last_run_id: latest?.run_id ?? null,
        improve_enabled: latest?.improve_enabled ?? null,
        cohort: latest?.cohort ?? null,
        tuning: latest?.tuning ? { changed: latest.tuning.change, from: latest.tuning.from, to: latest.tuning.to, applied: latest.tuning.applied?.applied ?? false } : null,
        approval_queue_size: Array.isArray(latest?.approval_queue) ? latest.approval_queue.length : 0,
      },
    })
  } catch (err) {
    log.warn(`status failed: ${err?.message}`)
    return res.status(500).json({ ok: false, error: 'amy_status_failed' })
  }
})

/** The full latest combined crawler-improvement report. */
router.get('/report/latest', async (req, res) => {
  try {
    const report = await readLatestAmyReport(req.db)
    return res.json({ ok: true, report: report || null })
  } catch (err) {
    log.warn(`report/latest failed: ${err?.message}`)
    return res.status(500).json({ ok: false, error: 'amy_report_failed' })
  }
})

/** Capped history of recent run summaries. */
router.get('/reports', async (req, res) => {
  try {
    const history = await readAmyHistory(req.db)
    return res.json({ ok: true, runs: history })
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'amy_history_failed' })
  }
})

/** Open deeper-improvement proposals awaiting human approval. */
router.get('/approvals', async (req, res) => {
  try {
    const queue = await readAmyApprovalQueue(req.db)
    return res.json({ ok: true, ...queue })
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'amy_approvals_failed' })
  }
})

/**
 * Trigger an on-demand run. Synchronous but small/capped so it returns to the
 * panel. The daily 100-profile run is the scheduler's job.
 *   body: { count?, improve?, applyTuning?, anyaApply?, samApply?, keepProfiles? }
 */
router.post('/run', async (req, res) => {
  try {
    const body = req.body || {}
    const count = Math.max(1, Math.min(25, Number(body.count) || 8))
    const { runAmyTraining } = await import('../services/amy/amyAgent.js')
    const out = await runAmyTraining({
      db: req.db,
      targetCount: count,
      dryRunDiscovery: body.persist !== true,
      improve: body.improve !== false, // admin runs default to the full improvement loop
      applyTuning: body.applyTuning === true, // writing the floor change is opt-in from the UI
      applyWeights: body.applyWeights === true,
      applyCoverage: body.applyCoverage === true,
      anyaApply: body.anyaApply === true,
      samApply: body.samApply === true,
      keepProfiles: body.keepProfiles === true,
    })
    return res.json({
      ok: true,
      run_id: out.run_id,
      summary: out.summary,
      crawler_events: out.combined?.crawler_events,
      metrics: out.combined?.metrics ? { before: out.combined.metrics.before, after: out.combined.metrics.after, best: out.combined.metrics.best } : null,
      tuning: out.combined?.tuning ? { changed: out.combined.tuning.change, from: out.combined.tuning.from, to: out.combined.tuning.to, applied: out.combined.tuning.applied?.applied ?? false, reason: out.combined.tuning.reason } : null,
      approval_queue_size: out.combined?.approval_queue?.length ?? 0,
      cleaned: out.cleanup?.deleted ?? 0,
    })
  } catch (err) {
    log.error(`run failed: ${err?.message}`)
    return res.status(500).json({ ok: false, error: 'amy_run_failed', message: err?.message })
  }
})

export default router
