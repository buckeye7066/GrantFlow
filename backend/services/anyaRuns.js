import { randomUUID } from 'crypto'
import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('services:anyaRuns')

function safeJson(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return fallback
  }
}

export async function createAnyaRun(db, { mode, kind, sessionId, userId, profileId, toolName, request } = {}) {
  const id = randomUUID()
  try {
    await db
      .prepare(
        `
          INSERT INTO anya_runs (
            id,
            status,
            mode,
            kind,
            session_id,
            user_id,
            profile_id,
            tool_name,
            request_json
          ) VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        mode || 'copilot',
        kind,
        sessionId ?? null,
        userId ?? null,
        profileId ?? null,
        toolName ?? null,
        safeJson(request),
      )
    return id
  } catch (error) {
    qualityLog.error('Failed to create Anya run:', error)
    throw new Error(`Cannot create Anya run: ${error.message}`)
  }
}

export async function appendAnyaRunLog(db, runId, level, message, meta) {
  if (!runId) return
  try {
    await db
      .prepare(
        `
          INSERT INTO anya_run_logs (id, run_id, level, message, meta_json)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(randomUUID(), runId, level || 'info', String(message || ''), safeJson(meta))
  } catch (error) {
    qualityLog.error(`Failed to log Anya run ${runId}:`, error)
  }
}

export async function completeAnyaRun(db, runId, { status, response, error } = {}) {
  if (!runId) return
  try {
    await db
      .prepare(
        `
          UPDATE anya_runs
          SET status = ?,
              completed_at = CURRENT_TIMESTAMP,
              response_json = COALESCE(?, response_json),
              error = COALESCE(?, error)
          WHERE id = ?
        `,
      )
      .run(
        status || 'completed',
        response !== undefined ? safeJson(response) : null,
        error !== undefined ? String(error) : null,
        runId,
      )
  } catch (dbError) {
    qualityLog.error(`Failed to complete Anya run ${runId}:`, dbError)
    // Do NOT re-throw: the Anya computation already succeeded.
    // The DB write failure is an observability loss (Goal 8) but must not
    // surface as a workflow error to the caller (Goal 13).
    // Operators should monitor console errors for anya_runs write failures.
  }
}

