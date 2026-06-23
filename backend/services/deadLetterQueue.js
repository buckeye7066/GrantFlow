/**
 * Dead Letter Queue Service
 * 
 * Provides durable logging of crawler job failures for diagnosis and recovery.
 * All failed jobs are logged to the dead_letter_queue table for audit and retry.
 */

import crypto from 'crypto'
import { createLogger } from '../utils/logger.js'
const log = createLogger('deadLetterQueue')

/**
 * Log a failed crawler job to the dead letter queue
 * @param {object} db - Database connection
 * @param {object} options - Failure details
 * @param {string} options.jobId - Crawler job ID
 * @param {string} options.jobType - Type of crawler job
 * @param {string} [options.profileId] - Profile ID if applicable
 * @param {Error|string} options.error - Error object or message
 * @param {object} [options.jobParameters] - Job parameters snapshot
 * @param {object} [options.profileContextSnapshot] - Profile context snapshot
 * @param {string} [options.severity] - Severity level (low, medium, high, critical)
 * @returns {Promise<string>} Dead letter entry ID
 */
export async function logFailedJob(db, options) {
  const {
    jobId,
    jobType,
    profileId = null,
    error,
    jobParameters = null,
    profileContextSnapshot = null,
    severity = 'medium',
  } = options

  // Extract error details
  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorStack = error instanceof Error ? error.stack : null
  const errorCode = error?.code || null

  const id = crypto.randomUUID()
  
  try {
    await db
      .prepare(
        `
        INSERT INTO dead_letter_queue (
          id,
          job_id,
          job_type,
          profile_id,
          error_message,
          error_stack,
          error_code,
          job_parameters,
          profile_context_snapshot,
          severity,
          retry_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      )
      .run(
        id,
        jobId,
        jobType,
        profileId,
        errorMessage,
        errorStack,
        errorCode,
        jobParameters ? JSON.stringify(jobParameters) : null,
        profileContextSnapshot ? JSON.stringify(profileContextSnapshot) : null,
        severity,
      )
    
    log.info('[deadLetterQueue] Logged failed job to dead letter queue', {
      id,
      jobId,
      jobType,
      severity,
      errorMessage: errorMessage.substring(0, 100),
    })
    
    return id
  } catch (err) {
    // Best effort - don't throw if dead letter logging fails
    console.error('[deadLetterQueue] Failed to log to dead letter queue:', err)
    return null
  }
}

/**
 * Get unresolved failures for a specific job type
 * @param {object} db - Database connection
 * @param {string} jobType - Type of crawler job
 * @param {number} [limit=100] - Maximum number of records to return
 * @returns {Promise<Array>} Array of dead letter entries
 */
export async function getUnresolvedFailures(db, jobType, limit = 100) {
  const rows = await db
    .prepare(
      `
      SELECT 
        id,
        created_at,
        job_id,
        job_type,
        profile_id,
        error_message,
        error_code,
        retry_count,
        last_retry_at,
        next_retry_at,
        severity
      FROM dead_letter_queue
      WHERE job_type = ? AND resolved = FALSE
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(jobType, limit)

  return rows
}

/**
 * Get unresolved failures for a specific profile
 * @param {object} db - Database connection
 * @param {string} profileId - Profile ID
 * @param {number} [limit=100] - Maximum number of records to return
 * @returns {Promise<Array>} Array of dead letter entries
 */
export async function getUnresolvedFailuresByProfile(db, profileId, limit = 100) {
  const rows = await db
    .prepare(
      `
      SELECT 
        id,
        created_at,
        job_id,
        job_type,
        error_message,
        error_code,
        retry_count,
        last_retry_at,
        next_retry_at,
        severity
      FROM dead_letter_queue
      WHERE profile_id = ? AND resolved = FALSE
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(profileId, limit)

  return rows
}

/**
 * Mark a dead letter entry as resolved
 * @param {object} db - Database connection
 * @param {string} id - Dead letter entry ID
 * @param {string} resolvedBy - User ID or system identifier
 * @param {string} [resolutionNotes] - Notes about the resolution
 * @returns {Promise<void>}
 */
export async function resolveFailure(db, id, resolvedBy, resolutionNotes = null) {
  await db
    .prepare(
      `
      UPDATE dead_letter_queue
      SET resolved = TRUE,
          resolved_at = CURRENT_TIMESTAMP,
          resolved_by = ?,
          resolution_notes = ?
      WHERE id = ?
    `,
    )
    .run(resolvedBy, resolutionNotes, id)

  log.info('[deadLetterQueue] Resolved dead letter entry', { id, resolvedBy })
}

/**
 * Get failure statistics by job type
 * @param {object} db - Database connection
 * @param {string} [since] - ISO timestamp to filter from
 * @returns {Promise<Array>} Array of statistics by job type
 */
export async function getFailureStatistics(db, since = null) {
  const query = since
    ? `
      SELECT 
        job_type,
        COUNT(*) as total_failures,
        SUM(CASE WHEN resolved = FALSE THEN 1 ELSE 0 END) as unresolved_count,
        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
        MAX(created_at) as last_failure_at
      FROM dead_letter_queue
      WHERE created_at >= ?
      GROUP BY job_type
      ORDER BY total_failures DESC
    `
    : `
      SELECT 
        job_type,
        COUNT(*) as total_failures,
        SUM(CASE WHEN resolved = FALSE THEN 1 ELSE 0 END) as unresolved_count,
        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
        MAX(created_at) as last_failure_at
      FROM dead_letter_queue
      GROUP BY job_type
      ORDER BY total_failures DESC
    `

  // When `since` is null the query has NO bind placeholder — passing
  // `undefined` as a parameter makes better-sqlite3 throw "Too many parameter
  // values were provided". Bind only when the placeholder exists.
  const rows = since ? await db.prepare(query).all(since) : await db.prepare(query).all()
  return rows
}

/**
 * Increment retry count for a dead letter entry
 * @param {object} db - Database connection
 * @param {string} id - Dead letter entry ID
 * @param {Date} [nextRetryAt] - Next scheduled retry time
 * @returns {Promise<void>}
 */
export async function incrementRetryCount(db, id, nextRetryAt = null) {
  await db
    .prepare(
      `
      UPDATE dead_letter_queue
      SET retry_count = retry_count + 1,
          last_retry_at = CURRENT_TIMESTAMP,
          next_retry_at = ?
      WHERE id = ?
    `,
    )
    .run(nextRetryAt ? nextRetryAt.toISOString() : null, id)
}

/**
 * Determine severity based on error type
 * @param {Error|string} error - Error object or message
 * @param {string} jobType - Type of crawler job
 * @returns {string} Severity level (low, medium, high, critical)
 */
export function determineSeverity(error, jobType) {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const lowerError = errorMessage.toLowerCase()

  // Critical errors that prevent system operation
  if (
    lowerError.includes('database') ||
    lowerError.includes('connection refused') ||
    lowerError.includes('econnrefused') ||
    lowerError.includes('fatal')
  ) {
    return 'critical'
  }

  // High severity for auth/config issues
  if (
    lowerError.includes('unauthorized') ||
    lowerError.includes('forbidden') ||
    lowerError.includes('api key') ||
    lowerError.includes('authentication')
  ) {
    return 'high'
  }

  // Medium severity for transient issues
  if (
    lowerError.includes('timeout') ||
    lowerError.includes('rate limit') ||
    lowerError.includes('too many requests')
  ) {
    return 'medium'
  }

  // Low severity for expected failures
  if (
    lowerError.includes('not found') ||
    lowerError.includes('no results') ||
    lowerError.includes('empty')
  ) {
    return 'low'
  }

  // Default to medium severity
  return 'medium'
}
