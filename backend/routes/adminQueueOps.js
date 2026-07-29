/**
 * adminQueueOps.js — Admin-guarded maintenance endpoints for the crawler queue.
 *
 * These endpoints provide safe, auditable operations for:
 *   GET  /api/admin/queue/stats            → status/type counts + stale job summary
 *   GET  /api/admin/queue/jobs?status=...  → paginated job listing
 *   GET  /api/admin/queue/production-audit/snapshot → bounded read-only production truth
 *   POST /api/admin/queue/jobs/:id/requeue → re-queue a failed / cancelled / running job
 *   POST /api/admin/queue/jobs/:id/cancel  → cancel a queued / running job
 *   POST /api/admin/queue/recover-stale    → invoke stale-job cleanup on demand
 *
 * All routes require `req.ctx.isAdmin === true`. They log every operation so
 * operators have a trail. They never silently delete evidence: failures are
 * recorded via the crawlerJobState logger and error strings are persisted on
 * the row.
 */

import express from 'express'
import {
  cancelJob,
  requeueJob,
  logJobEvent,
} from '../services/crawlerJobState.js'
import {
  cleanupStaleCrawlers,
  cleanupStaleQueuedJobs,
} from '../services/crawlerConcurrencyGuard.js'
import {
  buildProductionAuditSnapshot,
  normalizeAuditProfileIds,
  normalizeAuditMatchLimit,
} from '../services/productionAuditSnapshot.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:adminQueueOps')

const router = express.Router()

function requireAdmin(req, res) {
  if (req.ctx && req.ctx.isAdmin === true) return true
  res.status(403).json({ error: 'Admin access required' })
  return false
}

// ---------------------------------------------------------------------------
// Queue stats
// ---------------------------------------------------------------------------

router.get('/stats', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const db = req.db
    const isPostgres = db?.dialect === 'postgres'

    const byStatus = await db
      .prepare(
        `
          SELECT status, COUNT(*) AS count
          FROM crawler_jobs
          GROUP BY status
        `,
      )
      .all()

    const byType = await db
      .prepare(
        `
          SELECT type, status, COUNT(*) AS count
          FROM crawler_jobs
          GROUP BY type, status
          ORDER BY type, status
        `,
      )
      .all()

    // Stale = running with no heartbeat in >30 min (Postgres/SQLite safe)
    const staleCutoffIso = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const staleCutoffSqlite = staleCutoffIso
      .replace('T', ' ')
      .replace('Z', '')
      .replace(/\.\d+$/, '')

    const stale = await db
      .prepare(
        isPostgres
          ? `
              SELECT COUNT(*) AS count
              FROM crawler_jobs
              WHERE status = 'running'
                AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)
                AND (started_at IS NULL OR started_at < ?)
            `
          : `
              SELECT COUNT(*) AS count
              FROM crawler_jobs
              WHERE status = 'running'
                AND (last_heartbeat_at IS NULL OR datetime(last_heartbeat_at) < datetime(?))
                AND (started_at IS NULL OR datetime(started_at) < datetime(?))
            `,
      )
      .get(
        isPostgres ? staleCutoffIso : staleCutoffSqlite,
        isPostgres ? staleCutoffIso : staleCutoffSqlite,
      )

    res.json({
      status_counts: Object.fromEntries(
        (byStatus || []).map((r) => [r.status, Number(r.count || 0)]),
      ),
      by_type: byType || [],
      stale_running_count: Number(stale?.count || 0),
      generated_at: new Date().toISOString(),
    })
  } catch (err) {
    routeLogger.error('[adminQueueOps] stats failed:', err?.message || err)
    res.status(500).json({ error: 'Failed to load queue stats', detail: err?.message })
  }
})

// ---------------------------------------------------------------------------
// Permanent production-audit bridge (SELECT-only, sanitized, bounded)
// ---------------------------------------------------------------------------

router.get('/production-audit/snapshot', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const rawProfiles = Array.isArray(req.query?.profile)
      ? req.query.profile
      : (req.query?.profiles ?? req.query?.profile ?? '')
    const profileIds = normalizeAuditProfileIds(rawProfiles)
    const matchLimitPerProfile = normalizeAuditMatchLimit(
      req.query?.match_limit ?? req.query?.matchLimit,
    )
    const snapshot = await buildProductionAuditSnapshot(req.db, {
      profileIds,
      matchLimitPerProfile,
    })
    res.set('Cache-Control', 'no-store')
    return res.json(snapshot)
  } catch (error) {
    const status = Number(error?.status) || 500
    const code = error?.code || 'PRODUCTION_AUDIT_SNAPSHOT_FAILED'
    routeLogger.warn('[adminQueueOps] production audit snapshot failed', {
      code,
      status,
      message: error?.message || String(error),
      request_id: req.requestId || null,
    })
    return res.status(status).json({
      ok: false,
      error: code,
      details_redacted: true,
      request_id: req.requestId || null,
    })
  }
})

// ---------------------------------------------------------------------------
// Paginated job list
// ---------------------------------------------------------------------------

router.get('/jobs', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const db = req.db
    const statusParam = String(req.query.status || '').trim()
    const typeParam = String(req.query.type || '').trim()
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? 50, 10) || 50))
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? 0, 10) || 0)

    const VALID_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled'])

    const clauses = []
    const params = []
    if (statusParam && VALID_STATUSES.has(statusParam)) {
      clauses.push('status = ?')
      params.push(statusParam)
    }
    if (typeParam) {
      clauses.push('type = ?')
      params.push(typeParam)
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

    const rows = await db
      .prepare(
        `
          SELECT id, type, status, profile_id, organization_id,
                 worker_id, attempt_count, retry_count, dispatch_attempts,
                 created_at, claimed_at, started_at, completed_at,
                 last_heartbeat_at, next_dispatch_at,
                 result_count, error
          FROM crawler_jobs
          ${whereSql}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...params, limit, offset)

    const totalRow = await db
      .prepare(`SELECT COUNT(*) AS count FROM crawler_jobs ${whereSql}`)
      .get(...params)

    res.json({
      total: Number(totalRow?.count || 0),
      limit,
      offset,
      rows: rows || [],
    })
  } catch (err) {
    routeLogger.error('[adminQueueOps] list failed:', err?.message || err)
    res.status(500).json({ error: 'Failed to list jobs', detail: err?.message })
  }
})

// ---------------------------------------------------------------------------
// Requeue a job
// ---------------------------------------------------------------------------

router.post('/jobs/:id/requeue', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const db = req.db
    const jobId = String(req.params.id || '').trim()
    if (!jobId) return res.status(400).json({ error: 'job id required' })

    const reason = String(req.body?.reason || 'requeued_by_admin').slice(0, 200)
    const resetAttempts = Boolean(req.body?.reset_attempts)

    const before = await db.prepare('SELECT status FROM crawler_jobs WHERE id = ?').get(jobId)
    if (!before) return res.status(404).json({ error: 'job not found' })

    const result = await requeueJob(db, jobId, { reason, resetAttempts })
    logJobEvent('requeue', 'admin requeue endpoint', {
      jobId,
      actor: req.ctx?.email || req.ctx?.userId || 'admin',
      reason,
      resetAttempts,
      beforeStatus: before.status,
      ok: result.ok,
    })

    if (!result.ok) {
      return res.status(409).json({
        error: 'requeue failed (job not in a requeueable state)',
        current_status: before.status,
      })
    }

    const after = await db
      .prepare(
        `SELECT id, status, attempt_count, dispatch_attempts, retry_count, worker_id
         FROM crawler_jobs WHERE id = ?`,
      )
      .get(jobId)
    res.json({ ok: true, job: after })
  } catch (err) {
    routeLogger.error('[adminQueueOps] requeue failed:', err?.message || err)
    res.status(500).json({ error: 'Failed to requeue job', detail: err?.message })
  }
})

// ---------------------------------------------------------------------------
// Cancel a job
// ---------------------------------------------------------------------------

router.post('/jobs/:id/cancel', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const db = req.db
    const jobId = String(req.params.id || '').trim()
    if (!jobId) return res.status(400).json({ error: 'job id required' })

    const reason = String(req.body?.reason || 'cancelled_by_admin').slice(0, 200)

    const before = await db.prepare('SELECT status FROM crawler_jobs WHERE id = ?').get(jobId)
    if (!before) return res.status(404).json({ error: 'job not found' })

    const result = await cancelJob(db, jobId, { reason })
    logJobEvent('cancel', 'admin cancel endpoint', {
      jobId,
      actor: req.ctx?.email || req.ctx?.userId || 'admin',
      reason,
      beforeStatus: before.status,
      ok: result.ok,
    })

    if (!result.ok) {
      return res.status(409).json({
        error: 'cancel failed (job is already in a terminal state)',
        current_status: before.status,
      })
    }

    const after = await db
      .prepare(`SELECT id, status, error FROM crawler_jobs WHERE id = ?`)
      .get(jobId)
    res.json({ ok: true, job: after })
  } catch (err) {
    routeLogger.error('[adminQueueOps] cancel failed:', err?.message || err)
    res.status(500).json({ error: 'Failed to cancel job', detail: err?.message })
  }
})

// ---------------------------------------------------------------------------
// Force stale recovery (admin-triggered)
// ---------------------------------------------------------------------------

router.post('/recover-stale', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const db = req.db
    const runningMs = Math.max(
      60_000,
      Number.parseInt(req.body?.running_stale_ms, 10) || 30 * 60 * 1000,
    )
    const queuedMs = Math.max(
      60_000,
      Number.parseInt(req.body?.queued_stale_ms, 10) || 24 * 60 * 60 * 1000,
    )
    const cleanedRunning = await cleanupStaleCrawlers(db, runningMs)
    const cleanedQueued = await cleanupStaleQueuedJobs(db, queuedMs)
    logJobEvent('stale_recovered', 'admin stale recovery endpoint', {
      actor: req.ctx?.email || req.ctx?.userId || 'admin',
      cleanedRunning,
      cleanedQueued,
      runningMs,
      queuedMs,
    })
    res.json({
      ok: true,
      cleaned_running: cleanedRunning,
      cleaned_queued: cleanedQueued,
      running_stale_ms: runningMs,
      queued_stale_ms: queuedMs,
    })
  } catch (err) {
    routeLogger.error('[adminQueueOps] recover-stale failed:', err?.message || err)
    res.status(500).json({ error: 'Failed to recover stale jobs', detail: err?.message })
  }
})

export default router
