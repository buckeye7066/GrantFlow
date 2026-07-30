import crypto from 'node:crypto'
import express from 'express'

import {
  readWebParityBenchmark,
  readWebParityGapQueue,
  runWebParityBenchmark,
} from '../services/webParityBenchmark.js'
import { runWithSchedulerLock } from '../services/schedulerLock.js'
import { createLogger } from '../utils/logger.js'

const router = express.Router()
const log = createLogger('route:web-parity-admin')
const LOCK_NAME = 'web-parity-benchmark'
const LOCK_TTL_MS = 45 * 60 * 1000

const state = {
  running: false,
  run_id: null,
  started_at: null,
  finished_at: null,
  ok: null,
  error: null,
  summary: null,
}
let launchClaimed = false

function requireAdmin(req, res) {
  if (req.ctx?.isAdmin === true) return true
  res.status(403).json({ ok: false, error: 'admin_required' })
  return false
}

function snapshotState() {
  return { ...state }
}

function pendingWebParity(queue = []) {
  return (Array.isArray(queue) ? queue : []).filter(
    (entry) => String(entry?.source || '') === 'web_parity_benchmark' &&
      String(entry?.status || 'candidate') === 'candidate',
  )
}

/**
 * Synchronously claim the single in-process launch slot. There is deliberately
 * no await between inspecting and setting the claim; a re-entrant caller sees
 * launchClaimed immediately, while the durable scheduler lock fences instances.
 */
function claimParityLaunch() {
  if (launchClaimed || state.running) return null
  launchClaimed = true
  try {
    const runId = `web-parity-${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`
    Object.assign(state, {
      running: true,
      run_id: runId,
      started_at: new Date().toISOString(),
      finished_at: null,
      ok: null,
      error: null,
      summary: null,
    })
    return runId
  } finally {
    launchClaimed = false
  }
}

function launchParityRun({ db, profileIds = null, logger = log } = {}) {
  const runId = claimParityLaunch()
  if (!runId) {
    return { already_running: true, run_id: state.run_id }
  }

  const promise = (async () => {
    try {
      const result = await runWithSchedulerLock(db, {
        lockName: LOCK_NAME,
        ttlMs: LOCK_TTL_MS,
        logger,
        acquiredBy: `admin:${runId}`,
      }, () => runWebParityBenchmark(db, {
        profileIds: Array.isArray(profileIds) && profileIds.length ? profileIds : null,
        persist: true,
      }))

      if (result?.skipped) {
        state.ok = true
        state.summary = { skipped: true, reason: result.reason || 'lock_held' }
        return result
      }

      state.ok = result?.ran === true
      state.summary = {
        ran: result?.ran === true,
        reason: result?.reason || null,
        generated_at: result?.generated_at || null,
        fleet_parity: result?.fleet_parity ?? null,
        profiles: Array.isArray(result?.per_profile) ? result.per_profile.length : 0,
        gap_queue: result?.gap_queue || null,
      }
      if (!state.ok) state.error = String(result?.reason || 'benchmark_did_not_run')
      return result
    } catch (error) {
      state.ok = false
      state.error = String(error?.message || error)
      logger?.error?.('web_parity_background_failed', { run_id: runId, error: state.error })
      return { ran: false, error: state.error }
    } finally {
      state.running = false
      state.finished_at = new Date().toISOString()
    }
  })()
  promise.catch(() => {})
  return { already_running: false, run_id: runId, promise }
}

router.get('/status', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const [benchmark, queue] = await Promise.all([
      readWebParityBenchmark(req.db),
      readWebParityGapQueue(req.db),
    ])
    const pending = pendingWebParity(queue)
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: true,
      run: snapshotState(),
      latest: benchmark?.latest || null,
      generated_at: benchmark?.generated_at || benchmark?.latest?.generated_at || null,
      queue: {
        total: Array.isArray(queue) ? queue.length : 0,
        pending_web_parity: pending.length,
        pending_top: pending.slice(0, 50),
      },
    })
  } catch (error) {
    log.warn('web_parity_status_failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'web_parity_status_failed' })
  }
})

router.post('/run', (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const profileIds = Array.isArray(req.body?.profile_ids)
      ? req.body.profile_ids.map(String).filter(Boolean).slice(0, 20)
      : null
    const launch = launchParityRun({ db: req.db, profileIds, logger: log })
    return res.status(202).json({
      ok: true,
      accepted: true,
      running: true,
      already_running: launch.already_running,
      run_id: launch.run_id,
    })
  } catch (error) {
    log.error('web_parity_launch_failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'web_parity_launch_failed' })
  }
})

export { claimParityLaunch, launchParityRun, pendingWebParity, snapshotState }
export default router
