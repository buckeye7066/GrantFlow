/**
 * Crawler Concurrency Guard
 * 
 * Prevents concurrent crawlers per profile and enforces global concurrency limits.
 * Uses database-backed locking to ensure reliable concurrency control.
 */

import crypto from 'crypto'
import { logFailedJob } from './deadLetterQueue.js'
import { jobHasMeaningfulProgress, markJobPartial } from './crawlerJobState.js'
import { isSupersededCrawlerType } from '../../shared/supersededCrawlerTypes.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('crawlerConcurrencyGuard')

/**
 * Maximum concurrent crawlers globally (prevent system overload)
 */
const MAX_GLOBAL_CONCURRENT_CRAWLERS = parseInt(process.env.MAX_CONCURRENT_CRAWLERS || '10', 10)

/**
 * Maximum number of automatic retries for orphaned jobs.
 * Set to 0 to disable auto-retry.
 */
const MAX_ORPHAN_AUTO_RETRIES = parseInt(process.env.MAX_ORPHAN_AUTO_RETRIES || '2', 10)

/**
 * Hard age cap for orphan auto-retry. An orphaned job older than this is
 * terminally failed and NEVER requeued, regardless of retry_count. Without this
 * bound a job could be resurrected across many process restarts and pile up
 * thousands of "heartbeat stale / worker presumed dead" failures — the exact
 * runaway the Automation Control Center cleanup was created to kill.
 * Default: 24 hours.
 */
const MAX_ORPHAN_RETRY_AGE_MS = parseInt(
  process.env.MAX_ORPHAN_RETRY_AGE_MS || String(24 * 60 * 60 * 1000),
  10,
)

/**
 * Decide whether an orphaned crawler job may be auto-requeued. Terminal (no
 * retry) when: the type is a retired discovery crawler, the retry budget is
 * exhausted, or the job is older than the hard age cap. Centralised so the
 * heartbeat sweep and the started-at sweep apply identical caps.
 *
 * @param {{ type?: string, retry_count?: number, created_at?: string, started_at?: string }} job
 * @returns {{ retry: boolean, reason?: string }}
 */
export function shouldAutoRetryOrphan(job) {
  if (!job) return { retry: false, reason: 'no_job' }
  if (MAX_ORPHAN_AUTO_RETRIES <= 0) return { retry: false, reason: 'auto_retry_disabled' }
  if (isSupersededCrawlerType(job.type)) return { retry: false, reason: 'superseded_type' }

  const retryCount = typeof job.retry_count === 'number' ? job.retry_count : 0
  if (retryCount >= MAX_ORPHAN_AUTO_RETRIES) return { retry: false, reason: 'retry_budget_exhausted' }

  const ageAnchor = job.created_at || job.started_at
  if (ageAnchor) {
    const anchorMs = new Date(ageAnchor).getTime()
    if (Number.isFinite(anchorMs) && Date.now() - anchorMs > MAX_ORPHAN_RETRY_AGE_MS) {
      return { retry: false, reason: 'too_old' }
    }
  }
  return { retry: true }
}

/**
 * Auto-retry one orphaned job by inserting a fresh queued copy (the failed row
 * keeps its audit trail). Shared by BOTH stale sweeps — the 7h started-at
 * fallback AND the 5-minute heartbeat sweep. Before this was shared, only the
 * started-at sweep retried; the heartbeat sweep (the one that actually fires
 * when a deploy kills workers) terminal-failed every orphan, so a deploy
 * mid-ingest permanently lost the work (the 2026-07-01 document_ingest class).
 *
 * Caps, in addition to shouldAutoRetryOrphan (type / retry budget / age):
 *   - non-retryable error patterns (FK violations, missing profile, hard timeouts)
 *   - retry GENERATION carried in parameters.orphan_retry_generation — each
 *     retry row starts with retry_count 0, so without this a job that orphans
 *     on every attempt would chain fresh rows forever (the runaway the budget
 *     was meant to stop).
 *
 * @param {object} db
 * @param {object} job  full row (id, type, profile_id, organization_id,
 *                      parameters, retry_count, created_at, started_at, error,
 *                      result_meta)
 * @returns {Promise<{ retried: boolean, reason?: string, newJobId?: string }>}
 */
export async function autoRetryOrphanedJob(db, job) {
  if (!job?.id) return { retried: false, reason: 'no_job' }

  // Non-retryable error classes (FK violations, missing profiles, hard timeouts).
  let isNonRetryable = false
  try {
    const meta = job.result_meta ? JSON.parse(job.result_meta) : null
    if (meta?.non_retryable) isNonRetryable = true
  } catch { /* ignore parse errors */ }
  if (!isNonRetryable && job.error) {
    const nonRetryablePatterns = [/no longer exists/i, /foreign key/i, /violates foreign key/i, /profile.*not found/i, /timed out after \d+s/i]
    isNonRetryable = nonRetryablePatterns.some(p => p.test(job.error))
  }
  if (isNonRetryable) return { retried: false, reason: 'non_retryable_error' }

  const retryDecision = shouldAutoRetryOrphan(job)
  if (!retryDecision.retry) return { retried: false, reason: retryDecision.reason }

  let originalParameters = {}
  try {
    originalParameters = job.parameters ? JSON.parse(job.parameters) : {}
  } catch {
    originalParameters = {}
  }
  if (!originalParameters || typeof originalParameters !== 'object') originalParameters = {}

  const generation = Number(originalParameters.orphan_retry_generation) || 0
  if (generation >= MAX_ORPHAN_AUTO_RETRIES) {
    return { retried: false, reason: 'generation_budget_exhausted' }
  }

  const currentRetryCount = typeof job.retry_count === 'number' ? job.retry_count : 0
  const retryParameters = {
    ...originalParameters,
    retried_from_job_id: job.id,
    orphan_retry_generation: generation + 1,
  }

  // Include attempt number in hash so each retry gets a unique idempotency key
  // while still being deterministic for the same (job id, attempt).
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(JSON.stringify({ type: job.type, profile_id: job.profile_id, original_job_id: job.id, retry_attempt: currentRetryCount + 1 }))
    .digest('hex')
    .substring(0, 32)

  const newJobId = crypto.randomUUID()
  await db
    .prepare(
      `
        INSERT INTO crawler_jobs (
          id, type, status, profile_id, organization_id,
          parameters, idempotency_key, requested_by
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)
      `,
    )
    .run(
      newJobId,
      job.type,
      job.profile_id ?? null,
      job.organization_id ?? null,
      JSON.stringify(retryParameters),
      idempotencyKey,
      'system:orphan-retry',
    )
  return { retried: true, newJobId }
}

/**
 * Stale running-job cleanup
 *
 * We treat "running" jobs older than a threshold as orphaned (server crash, lost worker, etc).
 * This prevents permanent per-profile locks.
 *
 * Defaults:
 * - stale threshold: 7h (must exceed longest crawler wall time — COMPREHENSIVE_GEO_JOB_TIMEOUT_MS
 *   defaults to 6h in crawlerDispatcher.js — plus a 1h buffer for cleanup/flush overhead)
 * - cleanup interval: 5 minutes (best-effort; throttled per process)
 */
const STALE_RUNNING_MS = parseInt(process.env.CRAWLER_STALE_RUNNING_MS || String(7 * 60 * 60 * 1000), 10)
const STALE_CLEANUP_INTERVAL_MS = parseInt(process.env.CRAWLER_STALE_CLEANUP_INTERVAL_MS || String(5 * 60 * 1000), 10)
// Heartbeat-based staleness: if a worker is alive it stamps last_heartbeat_at every
// HEARTBEAT_INTERVAL_MS (60s — see crawlerDispatcher.js). After 5 missed beats the
// worker is overwhelmingly likely to be dead (deploy, OOM, network split). The old
// 7-hour blanket threshold was wrong here: it required BOTH started_at older than 7h
// AND heartbeat older than 7h, so a worker killed by a deploy left the job locked on
// the per-profile concurrency claim for the remainder of those 7 hours, blocking every
// new job for that profile. Use the dedicated, much shorter heartbeat threshold.
const STALE_HEARTBEAT_MS = parseInt(process.env.CRAWLER_STALE_HEARTBEAT_MS || String(5 * 60 * 1000), 10)
let lastStaleCleanupAtMs = 0

export async function maybeCleanupStaleRunningJobs(db) {
  // Throttle cleanup to keep dispatch cheap.
  const now = Date.now()
  if (STALE_CLEANUP_INTERVAL_MS > 0 && now - lastStaleCleanupAtMs < STALE_CLEANUP_INTERVAL_MS) return 0
  lastStaleCleanupAtMs = now

  try {
    // Two passes:
    //   1. Heartbeat-based: aggressive (5 min default) — catches workers killed mid-run by
    //      a deploy, crash, or OOM so their per-profile lock releases quickly.
    //   2. Started-at fallback: lenient (7 hr default) — catches jobs that died before
    //      their first heartbeat ever stamped (e.g. crashed in the handler bootstrap).
    let cleaned = 0
    try {
      cleaned += await cleanupStaleCrawlersByHeartbeat(db, STALE_HEARTBEAT_MS)
    } catch (heartbeatError) {
      console.error('[crawler-concurrency] Heartbeat-based cleanup failed (continuing with started-at fallback)', heartbeatError?.message || String(heartbeatError))
    }
    cleaned += await cleanupStaleCrawlers(db, STALE_RUNNING_MS)
    if (cleaned > 0) {
      console.warn('[crawler-concurrency] Cleaned stale running jobs (unblocked locks)', {
        cleaned,
        stale_heartbeat_ms: STALE_HEARTBEAT_MS,
        stale_running_ms: STALE_RUNNING_MS,
      })
    }
    return cleaned
  } catch (error) {
    console.error('[crawler-concurrency] Stale cleanup failed (ignored)', error?.message || String(error))
    return 0
  }
}

/**
 * Check if a profile already has a running crawler
 * @param {object} db - Database connection
 * @param {string} profileId - Profile ID
 * @returns {Promise<boolean>} True if profile has running crawler
 */
export async function hasRunningCrawler(db, profileId, { excludeJobId } = {}) {
  if (!profileId) return false
  await maybeCleanupStaleRunningJobs(db)
  
  const hasExclude = Boolean(excludeJobId)
  const sql = hasExclude
    ? `
        SELECT id, type, created_at
        FROM crawler_jobs
        WHERE profile_id = ?
          AND status = 'running'
          AND id <> ?
        ORDER BY created_at DESC
        LIMIT 1
      `
    : `
        SELECT id, type, created_at
        FROM crawler_jobs
        WHERE profile_id = ?
          AND status = 'running'
        ORDER BY created_at DESC
        LIMIT 1
      `

  const running = await db.prepare(sql).get(profileId, ...(hasExclude ? [excludeJobId] : []))
  
  return !!running
}

/**
 * Get global running crawler count
 * @param {object} db - Database connection
 * @returns {Promise<number>} Number of currently running crawlers
 */
export async function getRunningCrawlerCount(db) {
  const result = await db
    .prepare(
      `
        SELECT COUNT(*) as count
        FROM crawler_jobs
        WHERE status = 'running'
      `
    )
    .get()
  
  return result?.count || 0
}

/**
 * Acquire crawler lock for a profile
 * Returns existing job if profile already has a running crawler
 * Returns null if global limit reached
 * 
 * @param {object} db - Database connection
 * @param {string} profileId - Profile ID
 * @param {string} jobType - Type of crawler job
 * @returns {Promise<object|null>} { allowed: boolean, reason?: string, existingJobId?: string }
 */
export async function acquireCrawlerLock(db, profileId, jobType, { jobId } = {}) {
  await maybeCleanupStaleRunningJobs(db)

  // Check profile-level concurrency
  const hasJobId = Boolean(jobId)
  const sql = hasJobId
    ? `
        SELECT id, type, status, created_at
        FROM crawler_jobs
        WHERE profile_id = ?
          AND status = 'running'
          AND id <> ?
        ORDER BY created_at DESC
        LIMIT 1
      `
    : `
        SELECT id, type, status, created_at
        FROM crawler_jobs
        WHERE profile_id = ?
          AND status = 'running'
        ORDER BY created_at DESC
        LIMIT 1
      `

  const existingJob = await db.prepare(sql).get(profileId, ...(hasJobId ? [jobId] : []))
  
  if (existingJob) {
    log.info('[crawler-concurrency] Profile already has running crawler', {
      profileId,
      existingJobId: existingJob.id,
      existingType: existingJob.type,
      requestedType: jobType,
      requestedJobId: jobId ?? null,
    })
    return {
      allowed: false,
      reason: 'profile_has_running_crawler',
      existingJobId: existingJob.id,
    }
  }
  
  // Check global concurrency limit
  const runningCount = await getRunningCrawlerCount(db)
  if (runningCount >= MAX_GLOBAL_CONCURRENT_CRAWLERS) {
    console.warn('[crawler-concurrency] Global crawler limit reached', {
      runningCount,
      limit: MAX_GLOBAL_CONCURRENT_CRAWLERS,
      profileId,
      jobType,
    })
    return {
      allowed: false,
      reason: 'global_limit_reached',
      runningCount,
      limit: MAX_GLOBAL_CONCURRENT_CRAWLERS,
    }
  }
  
  return { allowed: true }
}

/**
 * Update the heartbeat timestamp for a running job to prove liveness.
 * Call this periodically during long-running jobs so that cleanupStaleCrawlers
 * does not prematurely kill a job that is still actively working.
 *
 * @param {object} db    - Database connection
 * @param {string} jobId - The crawler_jobs.id to update
 * @returns {Promise<void>}
 */
export async function updateJobHeartbeat(db, jobId) {
  if (!db || !jobId) return
  try {
    await db
      .prepare(
        `
          UPDATE crawler_jobs
          SET last_heartbeat_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'running'
        `,
      )
      .run(jobId)
  } catch (error) {
    // Best-effort; heartbeat failure should never crash a running job
    console.warn('[crawler-concurrency] Failed to update job heartbeat:', error?.message)
  }
}

/**
 * Aggressive heartbeat-based cleanup. Marks any 'running' job whose
 * last_heartbeat_at is older than `heartbeatThresholdMs` as failed and
 * releases the per-profile concurrency lock so queued jobs can proceed.
 *
 * Heartbeats are stamped every 60s by `crawlerDispatcher.js`. After ~5 missed
 * stamps the worker is overwhelmingly likely to be dead (deploy, OOM, crash).
 * Without this, the per-profile lock would stay held until the legacy
 * 7-hour `cleanupStaleCrawlers` sweep — long enough that operators see
 * "queued forever" jobs after every deploy. This was the exact symptom that
 * blocked the pipeline_automation force-rerun on 2026-05-13.
 *
 * Jobs that have NEVER stamped a heartbeat are intentionally NOT touched
 * here; they're handled by the started_at fallback in `cleanupStaleCrawlers`,
 * which lets brand-new jobs (started < 1 min ago, no first heartbeat yet)
 * survive their startup race.
 *
 * @param {object} db - Database connection
 * @param {number} heartbeatThresholdMs - Time since last_heartbeat_at after which a job is presumed dead
 * @returns {Promise<number>} Number of jobs marked as failed
 */
export async function cleanupStaleCrawlersByHeartbeat(db, heartbeatThresholdMs = 5 * 60 * 1000) {
  const thresholdDate = new Date(Date.now() - heartbeatThresholdMs)
  const thresholdIso = thresholdDate.toISOString()
  const thresholdSqlite = thresholdIso.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')

  const isPostgres = db?.dialect === 'postgres'
  const threshold = isPostgres ? thresholdIso : thresholdSqlite

  const staleJobs = await db
    .prepare(
      isPostgres
        ? `
            SELECT id, type, profile_id, organization_id, parameters,
                   retry_count, created_at, started_at, error,
                   result_count, result_meta
            FROM crawler_jobs
            WHERE status = 'running'
              AND last_heartbeat_at IS NOT NULL
              AND last_heartbeat_at < ?
          `
        : `
            SELECT id, type, profile_id, organization_id, parameters,
                   retry_count, created_at, started_at, error,
                   result_count, result_meta
            FROM crawler_jobs
            WHERE status = 'running'
              AND last_heartbeat_at IS NOT NULL
              AND datetime(last_heartbeat_at) < datetime(?)
          `,
    )
    .all(threshold)

  if (!staleJobs || staleJobs.length === 0) return 0

  let cleaned = 0
  for (const job of staleJobs) {
    // Worker died, but if the job had already flushed real, durable progress
    // (e.g. a geo crawl that processed 3,891 ZIPs and inserted 93,384 sources
    // before the deploy/OOM killed it), classifying it `failed` would silently
    // bury successful work. Mark it partial-complete instead — the data lives
    // in funding_opportunities and is queryable.
    if (jobHasMeaningfulProgress(job)) {
      try {
        const result = await markJobPartial(db, job.id, {
          reason: 'heartbeat_stale',
          error: `Worker presumed dead — last heartbeat > ${heartbeatThresholdMs}ms ago`,
        }, { force: true })
        if (result.ok) {
          cleaned += 1
          console.warn('[crawler-concurrency] Marked orphan as partial-complete (real progress preserved)', {
            jobId: job.id,
            type: job.type,
            profileId: job.profile_id,
            heartbeatThresholdMs,
          })
          continue
        }
      } catch (partialErr) {
        console.warn('[crawler-concurrency] Partial-mark failed; falling back to failed', {
          jobId: job.id,
          error: partialErr?.message || String(partialErr),
        })
      }
    }
    const errorMessage = `Job orphaned - heartbeat stale > ${heartbeatThresholdMs}ms (worker presumed dead)`
    try {
      const res = await db
        .prepare(
          `
            UPDATE crawler_jobs
            SET status = 'failed',
                completed_at = CURRENT_TIMESTAMP,
                error = ?,
                retry_count = COALESCE(retry_count, 0) + 1,
                last_retry_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = 'running'
          `,
        )
        .run(errorMessage, job.id)
      const changes = Number(res?.changes ?? res?.rowCount ?? 0)
      if (changes === 0) continue // raced: someone else already transitioned it
      cleaned += 1
      console.warn('[crawler-concurrency] Released per-profile lock for orphaned job', {
        jobId: job.id,
        type: job.type,
        profileId: job.profile_id,
        heartbeatThresholdMs,
      })

      // Deploy/OOM-killed work must not be silently lost: requeue a fresh copy
      // under the same hard caps the started-at sweep applies (type retirement,
      // retry budget, age, retry generation, non-retryable error classes).
      try {
        const retry = await autoRetryOrphanedJob(db, job)
        if (retry.retried) {
          console.warn('[crawler-concurrency] Auto-requeued heartbeat-orphaned job', {
            originalJobId: job.id,
            newJobId: retry.newJobId,
            type: job.type,
            profileId: job.profile_id,
          })
        } else if (retry.reason && retry.reason !== 'non_retryable_error') {
          console.warn('[crawler-concurrency] Not auto-retrying heartbeat-orphaned job (terminal)', {
            jobId: job.id, type: job.type, profileId: job.profile_id, reason: retry.reason,
          })
        }
      } catch (retryErr) {
        console.warn('[crawler-concurrency] Failed to auto-requeue heartbeat-orphaned job:', retryErr?.message)
      }
    } catch (updateError) {
      console.warn('[crawler-concurrency] Failed to mark heartbeat-stale job as failed', {
        jobId: job.id,
        error: updateError?.message || String(updateError),
      })
    }
  }
  return cleaned
}

/**
 * Mark stale crawlers as failed (cleanup orphaned jobs)
 * Jobs stuck in 'running' for > staleThresholdMs are considered orphaned,
 * UNLESS their last_heartbeat_at is recent (within staleThresholdMs), in which
 * case they are still alive and should not be killed.
 * 
 * @param {object} db - Database connection
 * @param {number} staleThresholdMs - Time in ms before a job is considered stale
 * @returns {Promise<number>} Number of jobs marked as failed
 */
export async function cleanupStaleCrawlers(db, staleThresholdMs = 30 * 60 * 1000) {
  const thresholdDate = new Date(Date.now() - staleThresholdMs)
  const thresholdIso = thresholdDate.toISOString()
  const thresholdSqlite = thresholdIso.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')
  
  try {
    const isPostgres = db?.dialect === 'postgres'
    const threshold = isPostgres ? thresholdIso : thresholdSqlite
    const staleJobs = await db
      .prepare(
        isPostgres
          ? `
              SELECT id, type, profile_id, organization_id, parameters, retry_count,
                     started_at, created_at, last_heartbeat_at, error, result_count, result_meta
              FROM crawler_jobs
              WHERE status = 'running'
                AND (
                  (started_at IS NOT NULL AND started_at < ?)
                  OR (started_at IS NULL AND created_at < ?)
                )
                AND (
                  last_heartbeat_at IS NULL
                  OR last_heartbeat_at < ?
                )
            `
          : `
              SELECT id, type, profile_id, organization_id, parameters, retry_count,
                     started_at, created_at, last_heartbeat_at, error, result_count, result_meta
              FROM crawler_jobs
              WHERE status = 'running'
                AND (
                  (started_at IS NOT NULL AND datetime(started_at) < datetime(?))
                  OR (started_at IS NULL AND datetime(created_at) < datetime(?))
                )
                AND (
                  last_heartbeat_at IS NULL
                  OR datetime(last_heartbeat_at) < datetime(?)
                )
            `,
      )
      .all(threshold, threshold, threshold)
    
    let cleaned = 0
    for (const job of staleJobs) {
      // Worker died, but if the job had already flushed real, durable progress
      // (e.g. a 6-hour geo crawl that processed thousands of ZIPs and inserted
      // tens of thousands of sources before the deploy/OOM killed it),
      // classifying the row `failed` would silently bury successful work.
      // Mark it partial-complete instead.
      if (jobHasMeaningfulProgress(job)) {
        try {
          const result = await markJobPartial(db, job.id, {
            reason: 'started_stale',
            error: `Worker presumed dead — no heartbeat for ${staleThresholdMs}ms`,
          }, { force: true })
          if (result.ok) {
            cleaned++
            console.warn('[crawler-concurrency] Marked started-stale orphan as partial-complete (real progress preserved)', {
              jobId: job.id,
              type: job.type,
              profileId: job.profile_id,
              startedAt: job.started_at,
              createdAt: job.created_at,
            })
            continue
          }
        } catch (partialErr) {
          console.warn('[crawler-concurrency] Partial-mark failed for started-stale job; falling back to failed', {
            jobId: job.id,
            error: partialErr?.message || String(partialErr),
          })
        }
      }
      const errorMessage = `Job orphaned - no heartbeat for ${staleThresholdMs}ms`

      // retry_count is now included in the SELECT, no extra DB roundtrip needed.
      const currentRetryCount = typeof job.retry_count === 'number' ? job.retry_count : 0

      // Mark job as failed and increment retry counter.
      await db
        .prepare(
          `
            UPDATE crawler_jobs
            SET status = 'failed',
                completed_at = CURRENT_TIMESTAMP,
                error = ?,
                retry_count = COALESCE(retry_count, 0) + 1,
                last_retry_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
        )
        .run(errorMessage, job.id)

      // Log to dead letter queue
      await logFailedJob(db, {
        jobId: job.id,
        jobType: job.type,
        profileId: job.profile_id,
        error: errorMessage,
        severity: 'medium',
      }).catch(err => {
        console.warn('[crawler-concurrency] Failed to create dead letter entry:', err?.message)
      })

      cleaned++
      console.warn('[crawler-concurrency] Cleaned stale crawler job', {
        jobId: job.id,
        type: job.type,
        profileId: job.profile_id,
        startedAt: job.started_at,
        createdAt: job.created_at,
      })

      // Auto-retry under the shared hard caps (retired types are NEVER retried;
      // budget / age / generation caps stop the "worker presumed dead → requeue
      // → orphan again" runaway that flooded the panel with thousands of failures).
      try {
        const retry = await autoRetryOrphanedJob(db, job)
        if (retry.retried) {
          console.warn('[crawler-concurrency] Auto-requeued orphaned job', {
            originalJobId: job.id,
            newJobId: retry.newJobId,
            type: job.type,
            profileId: job.profile_id,
            retryAttempt: currentRetryCount + 1,
            maxRetries: MAX_ORPHAN_AUTO_RETRIES,
          })
        } else if (retry.reason === 'non_retryable_error') {
          console.warn('[crawler-concurrency] Skipping auto-retry for non-retryable error', {
            jobId: job.id, type: job.type, profileId: job.profile_id,
          })
        } else {
          console.warn('[crawler-concurrency] Not auto-retrying orphaned job (terminal)', {
            jobId: job.id, type: job.type, profileId: job.profile_id, reason: retry.reason,
          })
        }
      } catch (retryErr) {
        console.warn('[crawler-concurrency] Failed to auto-requeue orphaned job:', retryErr?.message)
      }
    }
    
    return cleaned
  } catch (error) {
    console.error('[crawler-concurrency] Failed to cleanup stale crawlers:', error?.message)
    return 0
  }
}

/**
 * Mark stale queued jobs as failed.
 * Jobs stuck in 'queued' for longer than staleThresholdMs are considered permanently lost
 * (e.g. the process restarted and the dispatch loop never picked them up, or they exceeded
 * all retry cycles).  This prevents queued jobs from accumulating indefinitely.
 *
 * Default threshold: 24 hours.
 *
 * @param {object} db - Database connection
 * @param {number} staleThresholdMs - Time in ms before a queued job is considered stale (default 24h)
 * @returns {Promise<number>} Number of queued jobs marked as failed
 */
export async function cleanupStaleQueuedJobs(db, staleThresholdMs = 24 * 60 * 60 * 1000) {
  const thresholdDate = new Date(Date.now() - staleThresholdMs)
  const thresholdIso = thresholdDate.toISOString()
  const thresholdSqlite = thresholdIso.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')

  try {
    const isPostgres = db?.dialect === 'postgres'
    const threshold = isPostgres ? thresholdIso : thresholdSqlite

    const staleJobs = await db
      .prepare(
        isPostgres
          ? `
              SELECT id, type, profile_id, created_at
              FROM crawler_jobs
              WHERE status = 'queued'
                AND created_at < ?
            `
          : `
              SELECT id, type, profile_id, created_at
              FROM crawler_jobs
              WHERE status = 'queued'
                AND datetime(created_at) < datetime(?)
            `,
      )
      .all(threshold)

    let cleaned = 0
    for (const job of staleJobs) {
      const staleHours = Math.round(staleThresholdMs / (60 * 60 * 1000))
      const errorMessage = `Job timed out in queue after ${staleHours > 0 ? `${staleHours}h` : `${staleThresholdMs}ms`}`

      await db
        .prepare(
          `
            UPDATE crawler_jobs
            SET status = 'failed',
                completed_at = CURRENT_TIMESTAMP,
                error = ?
            WHERE id = ?
          `,
        )
        .run(errorMessage, job.id)

      await logFailedJob(db, {
        jobId: job.id,
        jobType: job.type,
        profileId: job.profile_id,
        error: errorMessage,
        severity: 'medium',
      }).catch(err => {
        console.warn('[crawler-concurrency] Failed to create dead letter entry for stale queued job:', err?.message)
      })

      cleaned++
      console.warn('[crawler-concurrency] Cleaned stale queued job', {
        jobId: job.id,
        type: job.type,
        profileId: job.profile_id,
        createdAt: job.created_at,
      })
    }

    return cleaned
  } catch (error) {
    console.error('[crawler-concurrency] Failed to cleanup stale queued jobs:', error?.message)
    return 0
  }
}
