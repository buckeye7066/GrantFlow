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

// Fetch one run for status polling (used by the async/background Anya path).
// Owner-scoped: when a userId is supplied, a run owned by a different user
// returns null rather than leaking another user's reply. Optionally also pins
// to a session id so the /sessions/:id/runs/:runId route can't be used to read
// a run from a different session.
export async function getAnyaRun(db, runId, { userId = null, sessionId = null } = {}) {
  if (!runId) return null
  let row
  try {
    row = await db
      .prepare(
        `
          SELECT id, status, kind, session_id, user_id, response_json, error, completed_at
          FROM anya_runs
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(runId)
  } catch (error) {
    qualityLog.error(`Failed to read Anya run ${runId}:`, error)
    return null
  }
  if (!row) return null
  const provided = (v) => v !== null && v !== undefined
  if (provided(userId) && provided(row.user_id) && String(row.user_id) !== String(userId)) return null
  if (provided(sessionId) && provided(row.session_id) && String(row.session_id) !== String(sessionId)) return null

  let response = null
  try {
    response = row.response_json ? JSON.parse(row.response_json) : null
  } catch {
    response = null
  }

  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    session_id: row.session_id,
    degraded: Boolean(response?.degraded),
    assistant_message_id: response?.assistant_message_id ?? null,
    assistant_text: response?.assistantText ?? null,
    error: row.error ?? null,
    completed_at: row.completed_at ?? null,
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

