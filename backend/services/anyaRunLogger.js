/**
 * Anya Run Logging Service
 * 
 * Tracks Anya autonomous operations with run_id, mode, and tool usage.
 * Provides audit trail for all Anya operations.
 */

import crypto from 'crypto'

/**
 * Anya operation modes
 */
export const ANYA_MODES = {
  COPILOT: 'copilot',           // Read-only user assistant
  ADMIN_OPS: 'admin_ops',       // Admin operations (requires req.ctx.isAdmin)
  CODE_ADVISOR: 'code_advisor', // Code fixes/patches (generates diffs, no silent edits)
}

/**
 * Create an Anya run entry
 * @param {object} db - Database connection
 * @param {object} options - Run options
 * @param {string} options.runId - Unique run ID
 * @param {string} options.mode - Anya mode (copilot, admin_ops, code_advisor)
 * @param {string} options.operationType - Type of operation
 * @param {string} [options.userId] - User ID if applicable
 * @param {string} [options.profileId] - Profile ID if applicable
 * @param {string} [options.requestedBy] - User who requested the operation
 * @param {boolean} [options.authorized=false] - Whether operation was authorized
 * @returns {Promise<string>} Run entry ID
 */
export async function createAnyaRun(db, options) {
  const {
    runId,
    mode,
    operationType,
    userId = null,
    profileId = null,
    requestedBy = null,
    authorized = false,
  } = options
  
  // Validate mode
  if (!Object.values(ANYA_MODES).includes(mode)) {
    throw new Error(`Invalid Anya mode: ${mode}. Must be one of: ${Object.values(ANYA_MODES).join(', ')}`)
  }
  
  const id = crypto.randomUUID()
  
  try {
    await db
      .prepare(
        `
          INSERT INTO anya_runs (
            id,
            run_id,
            mode,
            operation_type,
            status,
            user_id,
            profile_id,
            requested_by,
            authorized,
            created_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `
      )
      .run(id, runId, mode, operationType, userId, profileId, requestedBy, authorized ? 1 : 0)
    
    console.log('[anya-runs] Created Anya run entry', {
      id,
      runId,
      mode,
      operationType,
      authorized,
    })
    
    return id
  } catch (error) {
    console.error('[anya-runs] Failed to create Anya run entry:', error)
    throw error
  }
}

/**
 * Update Anya run status
 * @param {object} db - Database connection
 * @param {string} id - Run entry ID
 * @param {string} status - New status (queued, running, completed, failed, cancelled)
 * @returns {Promise<void>}
 */
export async function updateAnyaRunStatus(db, id, status) {
  const VALID_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled']
  
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`)
  }
  
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status)
  const setClause = isTerminal
    ? 'status = ?, completed_at = CURRENT_TIMESTAMP'
    : 'status = ?'
  const values = [status]
  
  try {
    await db
      .prepare(`UPDATE anya_runs SET ${setClause} WHERE id = ?`)
      .run(...values, id)

    console.log('[anya-runs] Updated Anya run status', { id, status })
  } catch (error) {
    console.error('[anya-runs] Failed to update Anya run status', { id, status, error })
    throw error
  }
}

/**
 * Complete an Anya run with results
 * @param {object} db - Database connection
 * @param {string} id - Run entry ID
 * @param {object} results - Run results
 * @param {Array<string>} [results.toolsUsed] - List of tool names used
 * @param {number} [results.inputTokens] - Input token count
 * @param {number} [results.outputTokens] - Output token count
 * @param {number} [results.durationMs] - Duration in milliseconds
 * @returns {Promise<void>}
 */
export async function completeAnyaRun(db, id, results = {}) {
  const {
    toolsUsed = [],
    inputTokens = 0,
    outputTokens = 0,
    durationMs = 0,
  } = results
  
  await db
    .prepare(
      `
        UPDATE anya_runs
        SET status = 'completed',
            completed_at = CURRENT_TIMESTAMP,
            tools_used = ?,
            input_tokens = ?,
            output_tokens = ?,
            duration_ms = ?
        WHERE id = ?
      `
    )
    .run(JSON.stringify(toolsUsed), inputTokens, outputTokens, durationMs, id)
  
  console.log('[anya-runs] Completed Anya run', {
    id,
    toolsUsed: toolsUsed.length,
    inputTokens,
    outputTokens,
    durationMs,
  })
}

/**
 * Fail an Anya run with error details
 * @param {object} db - Database connection
 * @param {string} id - Run entry ID
 * @param {Error|string} error - Error object or message
 * @returns {Promise<void>}
 */
export async function failAnyaRun(db, id, error) {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorStack = error instanceof Error ? error.stack : null
  
  await db
    .prepare(
      `
        UPDATE anya_runs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error_message = ?,
            error_stack = ?
        WHERE id = ?
      `
    )
    .run(errorMessage, errorStack, id)
  
  console.error('[anya-runs] Failed Anya run', {
    id,
    error: errorMessage,
  })
}

/**
 * Get Anya runs for a user
 * @param {object} db - Database connection
 * @param {string} userId - User ID
 * @param {number} [limit=50] - Maximum number of runs to return
 * @returns {Promise<Array>} Array of run entries
 */
export async function getAnyaRunsByUser(db, userId, limit = 50) {
  const rows = await db
    .prepare(
      `
        SELECT 
          id,
          run_id,
          mode,
          operation_type,
          status,
          created_at,
          completed_at
        FROM anya_runs
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(userId, limit)
  
  return rows
}

/**
 * Get Anya runs by mode
 * @param {object} db - Database connection
 * @param {string} mode - Anya mode
 * @param {number} [limit=50] - Maximum number of runs to return
 * @returns {Promise<Array>} Array of run entries
 */
export async function getAnyaRunsByMode(db, mode, limit = 50) {
  const rows = await db
    .prepare(
      `
        SELECT 
          id,
          run_id,
          mode,
          operation_type,
          status,
          user_id,
          created_at,
          completed_at
        FROM anya_runs
        WHERE mode = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(mode, limit)
  
  return rows
}

/**
 * Get Anya run statistics
 * @param {object} db - Database connection
 * @param {string} [since] - ISO timestamp to filter from
 * @returns {Promise<object>} Statistics by mode and status
 */
export async function getAnyaRunStatistics(db, since = null) {
  const query = since
    ? `
      SELECT 
        mode,
        status,
        COUNT(*) as count
      FROM anya_runs
      WHERE created_at >= ?
      GROUP BY mode, status
      ORDER BY mode, status
    `
    : `
      SELECT 
        mode,
        status,
        COUNT(*) as count
      FROM anya_runs
      GROUP BY mode, status
      ORDER BY mode, status
    `
  
  try {
    const stmt = db.prepare(query)
    const rows = since ? await stmt.all(since) : await stmt.all()
    return rows
  } catch (error) {
    console.error('[anya-runs] Failed to fetch Anya run statistics', { since, error })
    throw error
  }
}
