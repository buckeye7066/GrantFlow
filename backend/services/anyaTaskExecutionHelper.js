/**
 * Anya Task Execution Helper
 * 
 * Provides basic task execution tracking and logging.
 * This is a minimal implementation that tracks when tasks are "executed"
 * by logging the action and updating task status.
 * 
 * NOTE: This does not implement a full task execution engine.
 * Tasks must still be executed manually or through other systems.
 * This service only provides execution tracking and audit trails.
 */

import { updateTask } from './anyaOrchestrator.js'
import { appendAnyaRunLog } from './anyaRuns.js'

/**
 * Mark a task as executed and log the action
 * @param {Object} params
 * @param {Object} params.db - Database connection
 * @param {Object} params.user - User context
 * @param {string} params.sessionId - Anya session ID
 * @param {string} params.taskId - Task ID to mark as executed
 * @param {string} params.executionNotes - Notes about the execution
 * @param {Object} params.executionResult - Structured result data
 * @returns {Promise<Object>} Updated task
 */
export async function markTaskExecuted({
  db,
  user,
  sessionId,
  taskId,
  executionNotes = null,
  executionResult = null,
}) {
  try {
    // Get current task metadata
    const task = await db
      .prepare('SELECT * FROM anya_tasks WHERE id = ? AND session_id = ?')
      .get(taskId, sessionId)

    if (!task) {
      throw new Error('Task not found')
    }

    // Parse existing metadata
    let metadata = {}
    try {
      metadata = JSON.parse(task.metadata || '{}')
    } catch (parseError) {
      console.warn('[Task Execution] Failed to parse task metadata', {
        taskId,
        error: parseError?.message,
      })
      metadata = {}
    }

    // Add execution tracking to metadata
    metadata.executed_at = new Date().toISOString()
    metadata.execution_notes = executionNotes || null
    metadata.execution_result = executionResult || null
    metadata.execution_count = (metadata.execution_count || 0) + 1

    // Build notes with execution log
    const executionLog = `[Executed at ${new Date().toISOString()}]${executionNotes ? ': ' + executionNotes : ''}`
    const existingNotes = task.notes || ''
    const updatedNotes = existingNotes
      ? `${existingNotes}\n\n${executionLog}`
      : executionLog

    // Update task to in_progress or completed based on result
    const newStatus = executionResult?.completed ? 'completed' : 'in_progress'

    const updatedTask = await updateTask(db, user, sessionId, taskId, {
      status: newStatus,
      notes: updatedNotes,
      metadata,
    })

    return {
      success: true,
      task: updatedTask,
      execution_logged: true,
    }
  } catch (error) {
    console.error('[Task Execution] Failed to mark task as executed', {
      taskId,
      error: error?.message || String(error),
    })
    throw error
  }
}

/**
 * List tasks that need execution (open or in_progress status)
 * @param {Object} db - Database connection
 * @param {Object} options - Query options
 * @param {string} options.profileId - Filter by profile ID
 * @param {number} options.limit - Maximum results (default: 50)
 * @returns {Promise<Array>} Array of executable tasks
 */
export async function listExecutableTasks(db, { profileId = null, limit = 50 } = {}) {
  try {
    let query = `
      SELECT 
        t.*,
        s.profile_id as session_profile_id
      FROM anya_tasks t
      LEFT JOIN anya_sessions s ON t.session_id = s.id
      WHERE t.status IN ('open', 'in_progress')
    `
    const params = []

    if (profileId) {
      query += ' AND (t.profile_id = ? OR s.profile_id = ?)'
      params.push(profileId, profileId)
    }

    query += ' ORDER BY t.priority DESC, t.due_date ASC, t.created_at ASC LIMIT ?'
    params.push(limit)

    const tasks = await db.prepare(query).all(...params)

    return tasks.map((task) => ({
      ...task,
      metadata: task.metadata ? JSON.parse(task.metadata) : {},
      is_overdue: task.due_date && new Date(task.due_date) < new Date(),
    }))
  } catch (error) {
    console.error('[Task Execution] Failed to list executable tasks', error)
    return []
  }
}

/**
 * Log task execution attempt to Anya runs
 * @param {Object} params
 * @param {Object} params.db - Database connection
 * @param {string} params.runId - Anya run ID
 * @param {string} params.taskId - Task ID
 * @param {boolean} params.success - Whether execution succeeded
 * @param {string} params.message - Execution result message
 */
export async function logTaskExecution({ db, runId, taskId, success, message }) {
  try {
    await appendAnyaRunLog(db, runId, {
      level: success ? 'info' : 'error',
      message: `Task ${taskId}: ${message}`,
      data: { task_id: taskId, success },
    })
  } catch (error) {
    console.error('[Task Execution] Failed to log execution', error)
  }
}

/**
 * Get execution history for a task from its metadata
 * @param {Object} db - Database connection
 * @param {string} taskId - Task ID
 * @returns {Promise<Object>} Execution history
 */
export async function getTaskExecutionHistory(db, taskId) {
  try {
    const task = await db.prepare('SELECT metadata FROM anya_tasks WHERE id = ?').get(taskId)

    if (!task) {
      return { found: false, executions: [] }
    }

    const metadata = task.metadata ? JSON.parse(task.metadata) : {}

    return {
      found: true,
      execution_count: metadata.execution_count || 0,
      last_executed_at: metadata.executed_at || null,
      last_execution_notes: metadata.execution_notes || null,
      last_execution_result: metadata.execution_result || null,
    }
  } catch (error) {
    console.error('[Task Execution] Failed to get execution history', error)
    return { found: false, error: error?.message }
  }
}
