import { randomUUID } from 'crypto'

function safeJson(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return fallback
  }
}

export async function createAnyaRun(db, { mode, kind, sessionId, userId, profileId, toolName, request } = {}) {
  const id = randomUUID()
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
  } catch {
    // best-effort
  }
}

export async function completeAnyaRun(db, runId, { status, response, error } = {}) {
  if (!runId) return
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
    .run(status || 'completed', response ? safeJson(response) : null, error ? String(error) : null, runId)
}

