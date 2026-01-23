/**
 * Crawler Concurrency Guard
 * 
 * Prevents concurrent crawlers per profile and enforces global concurrency limits.
 * Uses database-backed locking to ensure reliable concurrency control.
 */

import { logFailedJob } from './deadLetterQueue.js'

/**
 * Maximum concurrent crawlers globally (prevent system overload)
 */
const MAX_GLOBAL_CONCURRENT_CRAWLERS = parseInt(process.env.MAX_CONCURRENT_CRAWLERS || '10', 10)

/**
 * Check if a profile already has a running crawler
 * @param {object} db - Database connection
 * @param {string} profileId - Profile ID
 * @returns {Promise<boolean>} True if profile has running crawler
 */
export async function hasRunningCrawler(db, profileId, { excludeJobId } = {}) {
  if (!profileId) return false
  
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
 * Mark stale crawlers as failed (cleanup orphaned jobs)
 * Jobs stuck in 'running' for > staleThresholdMs are considered orphaned
 * 
 * @param {object} db - Database connection
 * @param {number} staleThresholdMs - Time in ms before a job is considered stale (default: 30 minutes)
 * @returns {Promise<number>} Number of jobs marked as failed
 */
export async function cleanupStaleCrawlers(db, staleThresholdMs = 30 * 60 * 1000) {
  const staleThreshold = new Date(Date.now() - staleThresholdMs).toISOString()
  
  try {
    const staleJobs = await db
      .prepare(
        `
          SELECT id, type, profile_id, started_at, created_at
          FROM crawler_jobs
          WHERE status = 'running'
            AND (
              (started_at IS NOT NULL AND started_at < ?)
              OR (started_at IS NULL AND created_at < ?)
            )
        `
      )
      .all(staleThreshold, staleThreshold)
    
    let cleaned = 0
    for (const job of staleJobs) {
      const errorMessage = `Job orphaned - no heartbeat for ${staleThresholdMs}ms`
      
      // Mark job as failed
      await db
        .prepare(
          `
            UPDATE crawler_jobs
            SET status = 'failed',
                completed_at = CURRENT_TIMESTAMP,
                error = ?
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
    }
    
    return cleaned
  } catch (error) {
    console.error('[crawler-concurrency] Failed to cleanup stale crawlers:', error?.message)
    return 0
  }
}
