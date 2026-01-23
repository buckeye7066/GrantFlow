/**
 * Crawler Job Backpressure Service
 * 
 * Implements retry logic with exponential backoff and maximum retry limits.
 * Prevents infinite retry loops and job runaway.
 */

import { incrementRetryCount } from './deadLetterQueue.js'

/**
 * Maximum number of retries for a crawler job before giving up
 */
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_CRAWLER_RETRIES || '3', 10)

/**
 * Base delay for retry backoff (in seconds)
 */
const RETRY_BASE_DELAY_SECONDS = parseInt(process.env.CRAWLER_RETRY_BASE_DELAY || '60', 10)

/**
 * Maximum delay for retry backoff (in seconds)
 */
const MAX_RETRY_DELAY_SECONDS = parseInt(process.env.CRAWLER_MAX_RETRY_DELAY || '3600', 10)

/**
 * Calculate exponential backoff delay for retry
 * @param {number} retryCount - Number of previous retry attempts
 * @returns {number} Delay in seconds
 */
export function calculateRetryDelay(retryCount) {
  // Exponential backoff: base * 2^retryCount
  const delay = RETRY_BASE_DELAY_SECONDS * Math.pow(2, retryCount)
  return Math.min(delay, MAX_RETRY_DELAY_SECONDS)
}

/**
 * Check if a job should be retried based on retry count and error type
 * @param {object} job - Crawler job object
 * @param {Error|string} error - Error that caused the failure
 * @returns {boolean} True if job should be retried
 */
export function shouldRetryJob(job, error) {
  const retryCount = job.retry_count || 0
  
  // Don't retry if we've exceeded max attempts
  if (retryCount >= MAX_RETRY_ATTEMPTS) {
    console.warn('[backpressure] Job exceeded max retry attempts', {
      jobId: job.id,
      retryCount,
      maxAttempts: MAX_RETRY_ATTEMPTS,
    })
    return false
  }
  
  const errorMessage = error instanceof Error ? error.message : String(error)
  const lowerError = errorMessage.toLowerCase()
  
  // Don't retry permanent failures
  if (
    lowerError.includes('not found') ||
    lowerError.includes('invalid') ||
    lowerError.includes('unhandled crawler type') ||
    lowerError.includes('foreign key constraint')
  ) {
    console.log('[backpressure] Permanent failure, not retrying', {
      jobId: job.id,
      error: errorMessage.substring(0, 100),
    })
    return false
  }
  
  // Don't retry auth failures (need manual intervention)
  if (
    lowerError.includes('unauthorized') ||
    lowerError.includes('forbidden') ||
    lowerError.includes('api key')
  ) {
    console.log('[backpressure] Auth failure, not retrying', {
      jobId: job.id,
      error: errorMessage.substring(0, 100),
    })
    return false
  }
  
  // Retry transient failures
  if (
    lowerError.includes('timeout') ||
    lowerError.includes('rate limit') ||
    lowerError.includes('econnrefused') ||
    lowerError.includes('network') ||
    lowerError.includes('503') ||
    lowerError.includes('502')
  ) {
    console.log('[backpressure] Transient failure, scheduling retry', {
      jobId: job.id,
      retryCount,
      error: errorMessage.substring(0, 100),
    })
    return true
  }
  
  // Default: don't retry unknown failures (to prevent runaway)
  console.warn('[backpressure] Unknown failure type, not retrying by default', {
    jobId: job.id,
    error: errorMessage.substring(0, 100),
  })
  return false
}

/**
 * Schedule a job for retry with exponential backoff
 * @param {object} db - Database connection
 * @param {string} jobId - Crawler job ID
 * @param {object} deadLetterEntryId - Dead letter entry ID
 * @returns {Promise<Date|null>} Next retry time, or null if not scheduled
 */
export async function scheduleJobRetry(db, jobId, deadLetterEntryId) {
  try {
    // Get current retry count
    const job = await db
      .prepare('SELECT id, retry_count, type FROM crawler_jobs WHERE id = ?')
      .get(jobId)
    
    if (!job) {
      console.warn('[backpressure] Job not found for retry', { jobId })
      return null
    }
    
    const retryCount = job.retry_count || 0
    
    // Calculate next retry time
    const delaySeconds = calculateRetryDelay(retryCount)
    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000)
    
    // Update job retry count and reset to queued
    await db
      .prepare(
        `
          UPDATE crawler_jobs
          SET retry_count = retry_count + 1,
              last_retry_at = CURRENT_TIMESTAMP,
              status = 'queued',
              error = NULL
          WHERE id = ?
        `
      )
      .run(jobId)
    
    // Update dead letter entry with retry schedule
    if (deadLetterEntryId) {
      await incrementRetryCount(db, deadLetterEntryId, nextRetryAt)
    }
    
    console.log('[backpressure] Scheduled job retry', {
      jobId,
      retryCount: retryCount + 1,
      delaySeconds,
      nextRetryAt: nextRetryAt.toISOString(),
    })
    
    return nextRetryAt
  } catch (error) {
    console.error('[backpressure] Failed to schedule retry:', error?.message)
    return null
  }
}

/**
 * Get jobs ready for retry
 * @param {object} db - Database connection
 * @param {number} [limit=10] - Maximum number of jobs to return
 * @returns {Promise<Array>} Array of jobs ready for retry
 */
export async function getJobsReadyForRetry(db, limit = 10) {
  const now = new Date().toISOString()
  
  const rows = await db
    .prepare(
      `
        SELECT 
          cj.id,
          cj.type,
          cj.profile_id,
          cj.retry_count,
          dlq.next_retry_at,
          dlq.error_message
        FROM crawler_jobs cj
        INNER JOIN dead_letter_queue dlq ON cj.id = dlq.job_id
        WHERE cj.status = 'queued'
          AND cj.retry_count > 0
          AND dlq.next_retry_at IS NOT NULL
          AND dlq.next_retry_at <= ?
          AND dlq.resolved = FALSE
        ORDER BY dlq.next_retry_at ASC
        LIMIT ?
      `
    )
    .all(now, limit)
  
  return rows
}

/**
 * Mark jobs that have exceeded retry limits as permanently failed
 * @param {object} db - Database connection
 * @returns {Promise<number>} Number of jobs marked as permanently failed
 */
export async function markExhaustedJobs(db) {
  try {
    const result = await db
      .prepare(
        `
          UPDATE crawler_jobs
          SET status = 'failed',
              completed_at = CURRENT_TIMESTAMP,
              error = 'Exceeded maximum retry attempts (' || retry_count || '/' || ? || ')'
          WHERE status IN ('queued', 'failed')
            AND retry_count >= ?
        `
      )
      .run(MAX_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS)
    
    if (result.changes > 0) {
      console.warn('[backpressure] Marked jobs as permanently failed', {
        count: result.changes,
        maxRetries: MAX_RETRY_ATTEMPTS,
      })
    }
    
    return result.changes || 0
  } catch (error) {
    console.error('[backpressure] Failed to mark exhausted jobs:', error?.message)
    return 0
  }
}
