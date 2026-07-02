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
import { launchAmyRun, getAmyRunState } from '../services/amy/amyRunner.js'
import { getAmyConfig } from '../services/amy/amyScheduler.js'

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
    // Reflect the REAL effective config (Amy is ON by default) instead of a raw
    // env read that defaulted to false — otherwise the panel shows "OFF" even
    // when the daily scheduler is running.
    const cfg = getAmyConfig()
    const run = getAmyRunState()
    return res.json({
      ok: true,
      status: {
        enabled: cfg.enabled,
        run_on_schedule: cfg.runOnSchedule,
        daily_target: cfg.dailyTarget,
        slider_floor: latest?.slider_floor ?? null,
        last_run_at: latest?.completed_at ?? null,
        last_run_id: latest?.run_id ?? null,
        improve_enabled: latest?.improve_enabled ?? null,
        cohort: latest?.cohort ?? null,
        tuning: latest?.tuning ? { changed: latest.tuning.change, from: latest.tuning.from, to: latest.tuning.to, applied: latest.tuning.applied?.applied ?? false } : null,
        approval_queue_size: Array.isArray(latest?.approval_queue) ? latest.approval_queue.length : 0,
        // Live run state so the panel can show progress and poll to completion.
        running: run.running,
        running_run_id: run.run_id,
        running_source: run.source,
        running_started_at: run.started_at,
        last_run_ok: run.ok,
        last_run_error: run.error,
        // Honesty: a run deduped by the scheduler lock records ok:true with
        // summary {skipped:true, reason:'lock_held'} — without the summary the
        // panel cannot tell a skipped run from a real training run.
        last_run_summary: run.summary ?? null,
        last_run_skipped: run.summary?.skipped === true,
        last_run_skip_reason: run.summary?.skipped === true ? (run.summary?.reason ?? null) : null,
        last_run_finished_at: run.finished_at,
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
 * Trigger an on-demand run. FIRE-AND-FORGET: a real run crawls many profiles and
 * runs the Anya→Sam pipeline (minutes), which would 504 at the edge proxy if we
 * awaited it. So we start it in the background and return 202 immediately; the
 * panel polls GET /status (running → false) and GET /report/latest for results.
 *   body: { count?, improve?, applyTuning?, applyWeights?, applyCoverage?,
 *           anyaApply?, samApply?, keepProfiles?, persist? }
 */
router.post('/run', (req, res) => {
  try {
    const body = req.body || {}
    const count = Math.max(1, Math.min(100, Number(body.count) || 12))
    const launch = launchAmyRun({
      db: req.db,
      logger: log,
      source: 'admin',
      opts: {
        targetCount: count,
        dryRunDiscovery: body.persist !== true,
        improve: body.improve !== false, // admin runs default to the full improvement loop
        applyTuning: body.applyTuning === true, // writing the floor change is opt-in from the UI
        applyWeights: body.applyWeights === true,
        applyCoverage: body.applyCoverage === true,
        // Archetype query-steering lessons are additive-only (extra bounded web
        // queries), so they default ON like the rest of the improvement loop.
        applyLearning: body.applyLearning !== false,
        anyaApply: body.anyaApply === true,
        samApply: body.samApply === true,
        keepProfiles: body.keepProfiles === true,
      },
    })
    return res.status(202).json({
      ok: true,
      accepted: true,
      running: true,
      already_running: launch.already_running,
      run_id: launch.run_id,
      message: launch.already_running
        ? 'An Amy run is already in progress; poll /status.'
        : 'Amy run started in the background; poll /status for completion.',
    })
  } catch (err) {
    log.error(`run failed: ${err?.message}`)
    return res.status(500).json({ ok: false, error: 'amy_run_failed', message: err?.message })
  }
})

export default router
