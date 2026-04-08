/**
 * Crawler Concurrency Guard
 * 
 * Prevents concurrent crawlers per profile and enforces global concurrency limits.
 * Uses database-backed locking to ensure reliable concurrency control.
 */

import crypto from 'crypto'
import { logFailedJob } from './deadLetterQueue.js'

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
 * Stale running-job cleanup
 *
 * We treat "running" jobs older than a threshold as orphaned (server crash, lost worker, etc).
 * This prevents permanent per-profile locks.
 *
 * Defaults:
 * - stale threshold: 8h (must exceed longest crawler wall time, e.g. comprehensive geo via
 *   COMPREHENSIVE_GEO_JOB_TIMEOUT_MS in crawlerDispatcher.js; otherwise real jobs get reset mid-run)
 * - cleanup interval: 5 minutes (best-effort; throttled per process)
 */
const STALE_RUNNING_MS = parseInt(process.env.CRAWLER_STALE_RUNNING_MS || String(8 * 60 * 60 * 1000), 10)
const STALE_CLEANUP_INTERVAL_MS = parseInt(process.env.CRAWLER_STALE_CLEANUP_INTERVAL_MS || String(5 * 60 * 1000), 10)
let lastStaleCleanupAtMs = 0

export async function maybeCleanupStaleRunningJobs(db) {
  // Throttle cleanup to keep dispatch cheap.
  const now = Date.now()
  if (STALE_CLEANUP_INTERVAL_MS > 0 && now - lastStaleCleanupAtMs < STALE_CLEANUP_INTERVAL_MS) return 0
  lastStaleCleanupAtMs = now

  try {
    const cleaned = await cleanupStaleCrawlers(db, STALE_RUNNING_MS)
    if (cleaned > 0) {
      console.warn('[crawler-concurrency] Cleaned stale running jobs (unblocked locks)', {
        cleaned,
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
    console.log('[crawler-concurrency] Profile already has running crawler', {
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
                     started_at, created_at, last_heartbeat_at
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
                     started_at, created_at, last_heartbeat_at
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

      // Auto-retry if below the configured threshold.
      if (MAX_ORPHAN_AUTO_RETRIES > 0 && currentRetryCount < MAX_ORPHAN_AUTO_RETRIES) {
        try {
          // parameters is already in the SELECT result — no extra query needed.
          let originalParameters = {}
          try {
            originalParameters = job.parameters ? JSON.parse(job.parameters) : {}
          } catch {
            originalParameters = {}
          }

          const retryParameters = {
            ...(originalParameters && typeof originalParameters === 'object' ? originalParameters : {}),
            retried_from_job_id: job.id,
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

          console.warn('[crawler-concurrency] Auto-requeued orphaned job', {
            originalJobId: job.id,
            newJobId,
            type: job.type,
            profileId: job.profile_id,
            retryAttempt: currentRetryCount + 1,
            maxRetries: MAX_ORPHAN_AUTO_RETRIES,
          })
        } catch (retryErr) {
          console.warn('[crawler-concurrency] Failed to auto-requeue orphaned job:', retryErr?.message)
        }
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
