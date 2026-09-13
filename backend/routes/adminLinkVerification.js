import crypto from 'node:crypto'
import express from 'express'
import { runLinkVerification } from '../services/linkVerificationService.js'
import { runWithSchedulerLock } from '../services/schedulerLock.js'
import { createLogger } from '../utils/logger.js'

export const LINK_VERIFICATION_JOB_STATE_KEY = 'link_verification_admin_job'
const LOCK_NAME = 'link-verification'
const STATUS_URL = '/api/admin/verify-links/status'
const log = createLogger('route:admin-link-verification')
const STAT_KEYS = ['checked', 'ok', 'broken', 'skipped', 'redirect', 'suspicious', 'unverified', 'deactivated', 'expired', 'quarantined', 'restored']

function sumStats(previous, next) {
  return Object.fromEntries(STAT_KEYS.map(key => {
    const value = Number(next?.[key] ?? 0)
    return [key, Number(previous?.[key] || 0) + (Number.isFinite(value) && value >= 0 ? value : 0)]
  }))
}

/** Return only the durable latest run and whether its worker still holds a lease. */
export async function readLinkVerificationRun(db) {
  const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(LINK_VERIFICATION_JOB_STATE_KEY)
  let run = row?.value ? JSON.parse(row.value) : null
  // Unlike the best-effort diagnostics helper, this lookup must not hide DB errors.
  const lease = await db.prepare('SELECT acquired_by, expires_at FROM agent_control_locks WHERE lock_name = ? LIMIT 1').get(`scheduler:${LOCK_NAME}`)
  const active = Boolean(lease && Date.parse(lease.expires_at) > Date.now())
  if (run?.status === 'running' && (!active || lease.acquired_by !== `admin:${run.run_id}`)) {
    run = { ...run, status: 'interrupted', error: 'worker_lease_unavailable' }
  }
  return { ok: true, run, active, status_url: STATUS_URL }
}

/** Acknowledge only after durable admission; never tie worker lifetime to HTTP. */
export function launchLinkVerificationJob(db, { maxBatches = 1, logger = log } = {}) {
  let acknowledge
  const accepted = new Promise(resolve => { acknowledge = resolve })
  let run = null
  let expected = null
  let workerSignal = null
  const runId = `link-verify-${crypto.randomUUID()}`
  const save = async next => {
    const value = JSON.stringify(next)
    const result = await db.prepare(
      'UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?',
    ).run(value, new Date().toISOString(), LINK_VERIFICATION_JOB_STATE_KEY, expected)
    if (Number(result?.changes ?? result?.rowCount ?? 0) === 0) {
      throw Object.assign(new Error('job state superseded'), { code: 'STATE_SUPERSEDED' })
    }
    expected = value; run = next
  }
  const completion = (async () => {
    try {
      const result = await runWithSchedulerLock(db, {
        lockName: LOCK_NAME, ttlMs: 5 * 60 * 1000, heartbeat: true,
        acquiredBy: `admin:${runId}`, logger,
      }, async (lease = {}) => {
        const signals = [AbortSignal.timeout(60 * 60 * 1000), lease.signal].filter(Boolean)
        workerSignal = AbortSignal.any(signals)
        const passes = Math.min(10, Math.max(1, Number.isInteger(maxBatches) ? maxBatches : 1))
        run = {
          run_id: runId, status: 'running', started_at: new Date().toISOString(),
          finished_at: null, max_batches: passes, batches_completed: 0,
          stats: sumStats(null, null), error: null,
        }
        const value = JSON.stringify(run)
        await db.prepare(`INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(LINK_VERIFICATION_JOB_STATE_KEY, value, run.started_at)
        expected = value
        acknowledge({ accepted: true, run_id: runId, status_url: STATUS_URL })
        for (let index = 0; index < passes; index += 1) {
          workerSignal.throwIfAborted()
          const stats = await runLinkVerification(db, { limit: 200, verifiedBy: `admin:${runId}`, signal: workerSignal })
          workerSignal.throwIfAborted()
          if (!Number.isFinite(stats?.checked) || stats.checked < 0) throw new Error('invalid verifier result')
          await save({ ...run, batches_completed: index + 1, stats: sumStats(run.stats, stats) })
          if (stats.checked === 0) break
        }
        return { ran: true }
      })
      if (result?.skipped) {
        acknowledge({ accepted: false, error: 'link_verification_already_running', status_url: STATUS_URL, http_status: 409 })
        return { skipped: true }
      }
      workerSignal?.throwIfAborted()
      await save({ ...run, status: 'completed', finished_at: new Date().toISOString() })
      return { completed: true, run_id: runId }
    } catch (error) {
      const interrupted = workerSignal?.aborted || error?.code === 'LOCK_LEASE_LOST'
      const code = interrupted ? 'link_verification_interrupted' : 'link_verification_failed'
      if (expected !== null) {
        try { await save({ ...run, status: interrupted ? 'interrupted' : 'failed', error: code, finished_at: new Date().toISOString() }) }
        catch { logger?.error?.('link_verification_state_not_updated', { run_id: runId }) }
      }
      logger?.error?.('link_verification_job_failed', { run_id: runId, error: code })
      acknowledge({ accepted: false, error: 'link_verification_unavailable', status_url: STATUS_URL, http_status: 503 })
      return { completed: false, error: code }
    }
  })()
  // The HTTP handler observes admission; the worker handles its own failures.
  completion.catch(() => acknowledge({ accepted: false, error: 'link_verification_unavailable', http_status: 503 }))
  return { accepted, completion }
}

/** Mount beneath the existing admin router and retain its explicit guard. */
export function createAdminLinkVerificationRouter({ ensureAdminRequest, logger = log } = {}) {
  if (typeof ensureAdminRequest !== 'function') throw new TypeError('An admin authorization guard is required')
  const router = express.Router()
  router.get('/status', async (req, res) => {
    if (!(await ensureAdminRequest(req, res))) return
    res.set('Cache-Control', 'no-store')
    try { return res.json(await readLinkVerificationRun(req.db)) }
    catch { return res.status(503).json({ ok: false, error: 'link_verification_status_unavailable' }) }
  })
  router.post('/', async (req, res) => {
    if (!(await ensureAdminRequest(req, res))) return
    const maxBatches = req.body?.max_batches === undefined ? 1 : req.body.max_batches
    if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 10) {
      return res.status(400).json({ ok: false, error: 'max_batches_must_be_integer_1_to_10' })
    }
    res.set('Cache-Control', 'no-store')
    const { accepted } = launchLinkVerificationJob(req.db, { maxBatches, logger })
    const { http_status, ...result } = await accepted
    if (http_status === 409) res.set('Retry-After', '30')
    return res.status(result.accepted ? 202 : http_status || 503).json({ success: result.accepted, ...result })
  })
  return router
}
