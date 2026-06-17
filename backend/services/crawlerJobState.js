/**
 * crawlerJobState.js — Centralized, auditable crawler-job state transitions.
 *
 * This module is the single source of truth for how a crawler_jobs row moves
 * between states. All dispatcher code, admin tooling, stale-cleanup, and tests
 * should transition jobs through these helpers so that:
 *
 *   - valid transitions only:  queued -> running -> completed|failed|cancelled
 *   - claims are atomic and can never double-run a job
 *   - worker identity (worker_id) is recorded and enforced on completion/failure
 *   - attempt_count is incremented exactly once per successful claim
 *   - every lifecycle step emits a structured, grep-friendly log line
 *
 * The module is deliberately small and dependency-light. It is used by
 * crawlerDispatcher.js, crawlerConcurrencyGuard.js, and the admin ops route.
 *
 * Structured log format (single line, tagged):
 *   [crawler-job:<event>] message key=val key=val ...
 *
 * Events: enqueue, claim, claim_skipped, heartbeat, complete, fail, cancel,
 *         requeue, stale_recovered.
 */

import os from 'os'
import crypto from 'crypto'
import { createLogger } from '../utils/logger.js'
const log = createLogger('crawlerJobState')

// ---------------------------------------------------------------------------
// Worker identity
// ---------------------------------------------------------------------------

/**
 * Stable identifier for this worker process. Combines hostname, pid, and a
 * short random suffix so that multiple replicas on the same host are
 * distinguishable. Computed once on module load.
 */
export const WORKER_ID = (() => {
  const host = (os.hostname() || 'unknown').slice(0, 32)
  const pid = process.pid
  const rand = crypto.randomBytes(3).toString('hex')
  return `${host}:${pid}:${rand}`
})()

// ---------------------------------------------------------------------------
// Valid state transitions
// ---------------------------------------------------------------------------

const VALID_FROM_STATES_FOR = Object.freeze({
  claim: ['queued'],
  complete: ['running'],
  fail: ['queued', 'running'],
  cancel: ['queued', 'running'],
  requeue: ['failed', 'cancelled', 'running'],
})

/**
 * @param {string} action
 * @param {string} fromStatus
 */
export function isValidTransition(action, fromStatus) {
  const allowed = VALID_FROM_STATES_FOR[action]
  return Array.isArray(allowed) && allowed.includes(String(fromStatus))
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function formatPairs(pairs) {
  const parts = []
  for (const [k, v] of Object.entries(pairs)) {
    if (v === undefined || v === null) continue
    const sv = typeof v === 'string' ? v : JSON.stringify(v)
    // Collapse whitespace so the log line stays grep-friendly.
    parts.push(`${k}=${String(sv).replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  return parts.join(' ')
}

/**
 * Emit a structured, grep-friendly lifecycle log line.
 *
 * @param {'enqueue'|'claim'|'claim_skipped'|'heartbeat'|'complete'|'fail'|'cancel'|'requeue'|'stale_recovered'} event
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
export function logJobEvent(event, message, fields = {}) {
  const base = {
    worker: WORKER_ID,
    ...fields,
  }
  const line = `[crawler-job:${event}] ${message} ${formatPairs(base)}`.trim()
  const severe = event === 'fail' || event === 'stale_recovered'
  if (severe) {
    console.warn(line)
  } else {
    log.info(line)
  }
}

// ---------------------------------------------------------------------------
// Claim (queued -> running), atomic
// ---------------------------------------------------------------------------

/**
 * Atomically claim a queued job for this worker.
 *
 * Uses a conditional UPDATE guarded by `status = 'queued'` AND (`worker_id IS NULL`
 * OR `worker_id = ?`) so the DB row itself is the lock. The optional
 * `extraWhereSql` + `extraWhereParams` let callers layer on per-profile /
 * global-concurrency guards without duplicating the state-transition SQL.
 *
 * Returns { claimed: boolean, job?: row }. On success, the returned row
 * reflects the post-UPDATE state (status='running', worker_id set,
 * attempt_count incremented, claimed_at / started_at filled in).
 *
 * @param {object} db
 * @param {string} jobId
 * @param {object} [opts]
 * @param {string} [opts.workerId]      - override worker identity (tests)
 * @param {string} [opts.extraWhereSql] - additional AND-clause (no leading AND)
 * @param {unknown[]} [opts.extraWhereParams]
 * @returns {Promise<{ claimed: boolean, job?: object, reason?: string }>}
 */
export async function claimJob(db, jobId, opts = {}) {
  if (!db || !jobId) {
    return { claimed: false, reason: 'missing_db_or_job_id' }
  }
  const workerId = opts.workerId || WORKER_ID
  const extraWhereSql = opts.extraWhereSql ? ` AND ${opts.extraWhereSql}` : ''
  const extraParams = Array.isArray(opts.extraWhereParams) ? opts.extraWhereParams : []

  const sql = `
    UPDATE crawler_jobs
    SET status = 'running',
        worker_id = ?,
        claimed_at = CURRENT_TIMESTAMP,
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        last_heartbeat_at = CURRENT_TIMESTAMP,
        attempt_count = COALESCE(attempt_count, 0) + 1,
        error = NULL,
        parameters = COALESCE(parameters, '{}'),
        next_dispatch_at = NULL
    WHERE id = ?
      AND status = 'queued'
      AND (worker_id IS NULL OR worker_id = ?)
      ${extraWhereSql}
  `
  let res
  try {
    res = await db.prepare(sql).run(workerId, jobId, workerId, ...extraParams)
  } catch (err) {
    logJobEvent('claim_skipped', 'atomic claim SQL failed', {
      jobId,
      error: err?.message,
    })
    return { claimed: false, reason: 'sql_error' }
  }
  const changes = Number(res?.changes ?? res?.rowCount ?? 0)
  if (changes === 0) {
    return { claimed: false, reason: 'not_claimable' }
  }

  const job = await db
    .prepare('SELECT * FROM crawler_jobs WHERE id = ? LIMIT 1')
    .get(jobId)

  logJobEvent('claim', 'job claimed', {
    jobId,
    type: job?.type,
    profileId: job?.profile_id,
    attempt: job?.attempt_count,
  })
  return { claimed: true, job }
}

// ---------------------------------------------------------------------------
// Completion (running -> completed)
// ---------------------------------------------------------------------------

/**
 * Mark a running job as completed. Only the worker that currently owns the job
 * may complete it — this prevents a stale worker from overwriting a reclaimed
 * job's result.
 *
 * @param {object} db
 * @param {string} jobId
 * @param {object} [opts]
 * @param {string} [opts.workerId]
 * @param {number|null} [opts.resultCount]
 * @param {object|null} [opts.resultMeta]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function completeJob(db, jobId, opts = {}) {
  if (!db || !jobId) return { ok: false, reason: 'missing_db_or_job_id' }
  const workerId = opts.workerId || WORKER_ID
  const resultCountValue =
    typeof opts.resultCount === 'number' && Number.isFinite(opts.resultCount)
      ? opts.resultCount
      : null
  const resultMetaJson =
    opts.resultMeta && typeof opts.resultMeta === 'object'
      ? JSON.stringify(opts.resultMeta)
      : null

  const res = await db
    .prepare(
      `
        UPDATE crawler_jobs
        SET status = 'completed',
            completed_at = CURRENT_TIMESTAMP,
            result_count = COALESCE(?, result_count),
            result_meta = COALESCE(?, result_meta),
            error = NULL
        WHERE id = ?
          AND status = 'running'
          AND (worker_id IS NULL OR worker_id = ?)
      `,
    )
    .run(resultCountValue, resultMetaJson, jobId, workerId)

  const changes = Number(res?.changes ?? res?.rowCount ?? 0)
  if (changes === 0) {
    logJobEvent('complete', 'no-op (already finished or claimed by another worker)', {
      jobId,
      workerId,
    })
    return { ok: false, reason: 'not_running_or_owner_mismatch' }
  }

  logJobEvent('complete', 'job completed', {
    jobId,
    resultCount: resultCountValue,
  })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Failure (queued/running -> failed)
// ---------------------------------------------------------------------------

/**
 * Mark a job as failed. If the caller passes `workerId`, the fail is scoped to
 * the owning worker (so a stale worker cannot corrupt a reclaimed job's state).
 * Admin/stale-cleanup callers pass `{ force: true }` to skip that scoping.
 *
 * @param {object} db
 * @param {string} jobId
 * @param {string|Error} error
 * @param {object} [opts]
 * @param {string}  [opts.workerId]
 * @param {boolean} [opts.force]
 * @param {object}  [opts.resultMeta]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function failJob(db, jobId, error, opts = {}) {
  if (!db || !jobId) return { ok: false }
  const errorMsg =
    error instanceof Error ? (error.message || String(error)) : String(error || 'unknown')

  const workerId = opts.workerId || WORKER_ID
  const force = !!opts.force

  const resultMetaJson =
    opts.resultMeta && typeof opts.resultMeta === 'object'
      ? JSON.stringify(opts.resultMeta)
      : null

  const sql = force
    ? `
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?,
            result_meta = COALESCE(?, result_meta)
        WHERE id = ?
          AND status IN ('queued', 'running')
      `
    : `
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?,
            result_meta = COALESCE(?, result_meta)
        WHERE id = ?
          AND status IN ('queued', 'running')
          AND (worker_id IS NULL OR worker_id = ?)
      `

  const args = force
    ? [errorMsg, resultMetaJson, jobId]
    : [errorMsg, resultMetaJson, jobId, workerId]

  const res = await db.prepare(sql).run(...args)
  const changes = Number(res?.changes ?? res?.rowCount ?? 0)
  logJobEvent('fail', 'job failed', {
    jobId,
    force,
    error: errorMsg.slice(0, 200),
    changes,
  })
  return { ok: changes > 0 }
}

// ---------------------------------------------------------------------------
// Partial completion (running -> completed, with result_meta.partial = true)
// ---------------------------------------------------------------------------

/**
 * Decide whether a job's currently-flushed result_count / result_meta represent
 * real, durable progress that must NOT be reclassified as a failure.
 *
 * A geo / comprehensive crawl flushes its per-state progress to
 * crawler_jobs.result_count and crawler_jobs.result_meta after every state
 * (see backend/services/comprehensiveCrawlerOptimized.js). When a worker is
 * killed by a deploy/OOM/withTimeout abort partway through state N+1, the
 * orphan-cleanup or dispatcher catch must NOT lose those committed totals
 * by stamping the row `failed` — the data the run produced is already in
 * funding_opportunities and is queryable; the run simply did not finish
 * every state.
 *
 * Per mission-goals.mdc: "If total_found > 0 and included === 0, log why,
 * relax constraints, re-score." The same principle applies to job-level
 * status: real, persisted output is success; the run just stopped early.
 *
 * @param {{ result_count?: number|null, result_meta?: string|object|null }} row
 * @returns {boolean}
 */
export function jobHasMeaningfulProgress(row) {
  if (!row) return false
  const count = Number(row.result_count ?? 0)
  if (Number.isFinite(count) && count > 0) return true
  let meta = row.result_meta
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) } catch { meta = null }
  }
  if (!meta || typeof meta !== 'object') return false
  const sources = Number(meta.sources ?? 0)
  const processed = Number(meta.processed ?? 0)
  const inserted = Number(meta.inserted ?? meta.inserted_new ?? 0)
  return (
    (Number.isFinite(sources) && sources > 0) ||
    (Number.isFinite(processed) && processed > 0) ||
    (Number.isFinite(inserted) && inserted > 0)
  )
}

/**
 * Mark a job as partially completed. Sets `status = 'completed'` so existing
 * UI/consumers continue to treat the row as a successful run (the data is
 * real and persisted), and sets `result_meta.partial = true` plus a
 * `partial_reason` so finer-grained UIs and resume tooling can detect that
 * the run stopped before covering every input.
 *
 * Use this from the dispatcher catch when withTimeout aborts a long-running
 * job that has already flushed real progress, and from orphan-cleanup when
 * a stale-heartbeat job has real progress.
 *
 * @param {object} db
 * @param {string} jobId
 * @param {object} info
 * @param {string} info.reason       - short label (e.g. 'withTimeout',
 *                                      'heartbeat_stale', 'started_stale')
 * @param {string} [info.error]      - underlying error message (preserved)
 * @param {number} [info.durationSeconds]
 * @param {object} [opts]
 * @param {string}  [opts.workerId]
 * @param {boolean} [opts.force]     - skip worker_id ownership check
 *                                      (orphan-cleanup must use force=true)
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function markJobPartial(db, jobId, info = {}, opts = {}) {
  if (!db || !jobId) return { ok: false, reason: 'missing_db_or_job_id' }

  // Pull live counters so we preserve whatever the running handler flushed.
  let row = null
  try {
    row = await db
      .prepare('SELECT result_count, result_meta FROM crawler_jobs WHERE id = ?')
      .get(jobId)
  } catch { /* fall through; we'll persist whatever we have */ }

  let liveMeta = {}
  if (row?.result_meta) {
    try {
      liveMeta = typeof row.result_meta === 'string'
        ? JSON.parse(row.result_meta)
        : row.result_meta
    } catch { liveMeta = {} }
  }

  const partialMeta = {
    ...(liveMeta && typeof liveMeta === 'object' ? liveMeta : {}),
    partial: true,
    partial_reason: String(info.reason || 'unknown').slice(0, 80),
    ...(info.error ? { partial_error: String(info.error).slice(0, 400) } : {}),
    ...(typeof info.durationSeconds === 'number'
      ? { duration_seconds: info.durationSeconds }
      : {}),
  }
  const partialMetaJson = JSON.stringify(partialMeta)

  const force = !!opts.force
  const workerId = opts.workerId || WORKER_ID

  const sql = force
    ? `
        UPDATE crawler_jobs
        SET status = 'completed',
            completed_at = CURRENT_TIMESTAMP,
            result_meta = ?,
            error = NULL
        WHERE id = ?
          AND status IN ('queued', 'running')
      `
    : `
        UPDATE crawler_jobs
        SET status = 'completed',
            completed_at = CURRENT_TIMESTAMP,
            result_meta = ?,
            error = NULL
        WHERE id = ?
          AND status = 'running'
          AND (worker_id IS NULL OR worker_id = ?)
      `

  const args = force
    ? [partialMetaJson, jobId]
    : [partialMetaJson, jobId, workerId]

  const res = await db.prepare(sql).run(...args)
  const changes = Number(res?.changes ?? res?.rowCount ?? 0)
  logJobEvent('complete', 'job marked partial-complete', {
    jobId,
    reason: partialMeta.partial_reason,
    sources: liveMeta?.sources ?? null,
    processed: liveMeta?.processed ?? null,
    states_completed: liveMeta?.states_completed ?? null,
    states_total: liveMeta?.states_total ?? null,
    force,
    changes,
  })
  if (changes === 0) return { ok: false, reason: 'not_running_or_owner_mismatch' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Cancel (admin action)
// ---------------------------------------------------------------------------

/**
 * Admin cancel: move a queued/running job to cancelled. Does not require
 * worker ownership because this is an operator override.
 */
export async function cancelJob(db, jobId, opts = {}) {
  if (!db || !jobId) return { ok: false }
  const reason = String(opts.reason || 'cancelled_by_admin').slice(0, 200)

  const res = await db
    .prepare(
      `
        UPDATE crawler_jobs
        SET status = 'cancelled',
            completed_at = CURRENT_TIMESTAMP,
            error = ?
        WHERE id = ?
          AND status IN ('queued', 'running')
      `,
    )
    .run(reason, jobId)

  const changes = Number(res?.changes ?? res?.rowCount ?? 0)
  logJobEvent('cancel', 'job cancelled', { jobId, reason, changes })
  return { ok: changes > 0 }
}

// ---------------------------------------------------------------------------
// Requeue (admin / stale recovery)
// ---------------------------------------------------------------------------

/**
 * Put a failed / cancelled / running job back into the queued state so the
 * poller or drain interval can dispatch it again.
 *
 * @param {object} db
 * @param {string} jobId
 * @param {object} [opts]
 * @param {string} [opts.reason] - stored in `error` for audit trail
 * @param {boolean} [opts.resetAttempts] - zero out attempt counters
 */
export async function requeueJob(db, jobId, opts = {}) {
  if (!db || !jobId) return { ok: false }
  const reason = String(opts.reason || 'requeued_by_admin').slice(0, 200)
  const resetSql = opts.resetAttempts
    ? ', attempt_count = 0, dispatch_attempts = 0, retry_count = 0, next_dispatch_at = NULL'
    : ', dispatch_attempts = 0, next_dispatch_at = NULL'

  const res = await db
    .prepare(
      `
        UPDATE crawler_jobs
        SET status = 'queued',
            error = ?,
            worker_id = NULL,
            claimed_at = NULL,
            completed_at = NULL
            ${resetSql}
        WHERE id = ?
          AND status IN ('failed', 'cancelled', 'running')
      `,
    )
    .run(reason, jobId)

  const changes = Number(res?.changes ?? res?.rowCount ?? 0)
  logJobEvent('requeue', 'job re-queued', {
    jobId,
    reason,
    resetAttempts: !!opts.resetAttempts,
    changes,
  })
  return { ok: changes > 0 }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Stamp a liveness heartbeat on a running job. Only succeeds if the running
 * row is still owned by this worker (or ownership is NULL on very old data).
 */
export async function heartbeatJob(db, jobId, opts = {}) {
  if (!db || !jobId) return { ok: false }
  const workerId = opts.workerId || WORKER_ID

  try {
    const res = await db
      .prepare(
        `
          UPDATE crawler_jobs
          SET last_heartbeat_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'running'
            AND (worker_id IS NULL OR worker_id = ?)
        `,
      )
      .run(jobId, workerId)
    const changes = Number(res?.changes ?? res?.rowCount ?? 0)
    return { ok: changes > 0 }
  } catch (err) {
    // Heartbeat is best-effort: never crash a running job because of a
    // transient DB blip, but log loudly so operators see it.
    logJobEvent('heartbeat', 'heartbeat write failed', {
      jobId,
      error: err?.message,
    })
    return { ok: false }
  }
}
