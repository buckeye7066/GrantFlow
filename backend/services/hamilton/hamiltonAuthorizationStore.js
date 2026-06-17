/**
 * hamiltonAuthorizationStore.js
 *
 * Persistence layer for Hamilton Autopilot's standing authorizations.
 *
 * The user grants Hamilton authority once per (profile, selected funding
 * sources) and we persist:
 *   - the exact text shown on the authorization screen
 *   - which authorization options the user ticked
 *   - the authorization version
 *   - timestamp + IP + user-agent
 *
 * Lookups never delete — revocation is a status transition
 * (`revoked_at IS NOT NULL`) so the audit trail is complete.
 */

import crypto from 'node:crypto'

export const HAMILTON_AUTHORIZATION_TYPES = Object.freeze([
  'complete_forms',
  'upload_documents',
  'generate_narratives',
  'save_drafts',
  'submit_applications',
  'use_saved_session',
  'use_saved_credentials_reference',
  'use_standing_attestation',
])

export const HAMILTON_AUTHORIZATION_SCOPES = Object.freeze(['profile', 'task', 'funding_source'])

let ensuredAuthSchema = false

export function _resetAuthSchemaCache() {
  ensuredAuthSchema = false
}

export async function ensureHamiltonAuthorizationSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredAuthSchema) return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonbType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_authorizations (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      authorization_type TEXT NOT NULL,
      funding_source_id TEXT,
      task_id TEXT,
      authorization_text TEXT NOT NULL,
      authorization_version TEXT NOT NULL DEFAULT 'hamilton-autopilot-v1',
      options_json ${jsonbType} NOT NULL DEFAULT ${emptyObj},
      metadata_json ${jsonbType} NOT NULL DEFAULT ${emptyObj},
      accepted_at ${tsType} DEFAULT ${nowFn},
      revoked_at ${tsType},
      revoked_reason TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_auth_user    ON hamilton_authorizations(user_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_auth_profile ON hamilton_authorizations(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_auth_type    ON hamilton_authorizations(authorization_type);
    CREATE INDEX IF NOT EXISTS idx_hamilton_auth_funding ON hamilton_authorizations(funding_source_id);

    CREATE TABLE IF NOT EXISTS hamilton_autopilot_runs (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      task_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      user_id TEXT,
      authorization_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      blocker_kind TEXT,
      blocker_detail TEXT,
      preflight_json ${jsonbType} NOT NULL DEFAULT ${emptyObj},
      result_json ${jsonbType} NOT NULL DEFAULT ${emptyObj},
      confirmation_reference TEXT,
      confirmation_screenshot_path TEXT,
      started_at ${tsType},
      finished_at ${tsType},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_task     ON hamilton_autopilot_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_profile  ON hamilton_autopilot_runs(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_status   ON hamilton_autopilot_runs(status);
  `)
  ensuredAuthSchema = true
}

function safeJson(val, fallback) {
  if (val === null || val === undefined) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}

function rowToAuth(row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id,
    profile_id: row.profile_id,
    scope: row.scope,
    authorization_type: row.authorization_type,
    funding_source_id: row.funding_source_id ?? null,
    task_id: row.task_id ?? null,
    authorization_text: row.authorization_text,
    authorization_version: row.authorization_version,
    options: safeJson(row.options_json, {}),
    metadata: safeJson(row.metadata_json, {}),
    accepted_at: row.accepted_at,
    revoked_at: row.revoked_at ?? null,
    revoked_reason: row.revoked_reason ?? null,
  }
}

function rowToRun(row) {
  if (!row) return null
  return {
    id: row.id,
    task_id: row.task_id,
    profile_id: row.profile_id,
    user_id: row.user_id ?? null,
    authorization_id: row.authorization_id ?? null,
    status: row.status,
    blocker_kind: row.blocker_kind ?? null,
    blocker_detail: row.blocker_detail ?? null,
    preflight: safeJson(row.preflight_json, {}),
    result: safeJson(row.result_json, {}),
    confirmation_reference: row.confirmation_reference ?? null,
    confirmation_screenshot_path: row.confirmation_screenshot_path ?? null,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Record one or more authorization rows in a single batch. Returns the
 * inserted authorization ids. Idempotency: if an active (non-revoked)
 * authorization for the same (user_id, profile_id, scope, type, target)
 * already exists, we re-stamp `accepted_at`/`options`/`metadata`
 * instead of inserting a duplicate.
 */
export async function recordAuthorizations(db, {
  userId,
  profileId,
  scope = 'task',
  fundingSourceIds = [],
  taskIds = [],
  authorizationTypes = [],
  authorizationText,
  authorizationVersion = 'hamilton-autopilot-v1',
  options = {},
  metadata = {},
} = {}) {
  if (!db) throw new Error('db required')
  if (!userId) throw new Error('userId required')
  if (!profileId) throw new Error('profileId required')
  if (!authorizationText) throw new Error('authorizationText required')
  if (!Array.isArray(authorizationTypes) || authorizationTypes.length === 0) {
    throw new Error('authorizationTypes required')
  }
  for (const t of authorizationTypes) {
    if (!HAMILTON_AUTHORIZATION_TYPES.includes(t)) throw new Error(`invalid authorization_type: ${t}`)
  }
  if (!HAMILTON_AUTHORIZATION_SCOPES.includes(scope)) throw new Error(`invalid scope: ${scope}`)
  await ensureHamiltonAuthorizationSchema(db)

  const ids = []
  const targets = scope === 'funding_source' && fundingSourceIds.length > 0
    ? fundingSourceIds.map((id) => ({ funding_source_id: id, task_id: null }))
    : scope === 'task' && taskIds.length > 0
      ? taskIds.map((id) => ({ funding_source_id: null, task_id: id }))
      : [{ funding_source_id: null, task_id: null }]

  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'

  for (const target of targets) {
    for (const type of authorizationTypes) {
      const existing = await db.prepare(
        `SELECT id FROM hamilton_authorizations
          WHERE user_id = ? AND profile_id = ? AND scope = ? AND authorization_type = ?
            AND COALESCE(funding_source_id,'') = COALESCE(?, '')
            AND COALESCE(task_id,'') = COALESCE(?, '')
            AND revoked_at IS NULL
          LIMIT 1`,
      ).get(
        String(userId), String(profileId), scope, type,
        target.funding_source_id, target.task_id,
      )
      if (existing) {
        await db.prepare(
          `UPDATE hamilton_authorizations SET
              authorization_text = ?, authorization_version = ?,
              options_json = ?, metadata_json = ?,
              accepted_at = ${nowFn}, updated_at = ${nowFn}
            WHERE id = ?`,
        ).run(
          authorizationText, authorizationVersion,
          JSON.stringify(options || {}), JSON.stringify(metadata || {}),
          existing.id,
        )
        ids.push(existing.id)
        continue
      }
      const id = crypto.randomUUID()
      await db.prepare(
        `INSERT INTO hamilton_authorizations
            (id, user_id, profile_id, scope, authorization_type, funding_source_id, task_id,
             authorization_text, authorization_version, options_json, metadata_json,
             accepted_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})`,
      ).run(
        id, String(userId), String(profileId), scope, type,
        target.funding_source_id, target.task_id,
        authorizationText, authorizationVersion,
        JSON.stringify(options || {}), JSON.stringify(metadata || {}),
      )
      ids.push(id)
    }
  }
  return ids
}

/**
 * Check whether a given (profile, type) authorization is active. Looks
 * for any non-revoked row at scope=profile OR scope=funding_source
 * matching `fundingSourceId` OR scope=task matching `taskId`.
 */
export async function isAuthorizationActive(db, {
  profileId,
  authorizationType,
  fundingSourceId = null,
  taskId = null,
} = {}) {
  if (!db || !profileId || !authorizationType) return false
  await ensureHamiltonAuthorizationSchema(db)
  const row = await db.prepare(
    `SELECT id FROM hamilton_authorizations
      WHERE profile_id = ? AND authorization_type = ? AND revoked_at IS NULL
        AND (
          scope = 'profile'
          OR (scope = 'funding_source' AND funding_source_id = ?)
          OR (scope = 'task' AND task_id = ?)
        )
      ORDER BY accepted_at DESC LIMIT 1`,
  ).get(String(profileId), authorizationType, fundingSourceId, taskId)
  return Boolean(row)
}

export async function listActiveAuthorizations(db, { profileId, fundingSourceId = null, taskId = null } = {}) {
  if (!db || !profileId) return []
  await ensureHamiltonAuthorizationSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_authorizations
      WHERE profile_id = ? AND revoked_at IS NULL
        AND (
          scope = 'profile'
          OR (scope = 'funding_source' AND funding_source_id = ?)
          OR (scope = 'task' AND task_id = ?)
        )
      ORDER BY accepted_at DESC`,
  ).all(String(profileId), fundingSourceId, taskId)
  return (rows || []).map(rowToAuth)
}

export async function revokeAuthorization(db, { id, reason = null } = {}) {
  if (!db || !id) return null
  await ensureHamiltonAuthorizationSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_authorizations
        SET revoked_at = ${nowFn}, revoked_reason = ?, updated_at = ${nowFn}
      WHERE id = ?`,
  ).run(reason ?? null, String(id))
  const row = await db.prepare('SELECT * FROM hamilton_authorizations WHERE id = ?').get(String(id))
  return rowToAuth(row)
}

// ── Autopilot run ledger ────────────────────────────────────────────

export async function createAutopilotRun(db, {
  taskId, profileId, userId = null, authorizationId = null,
  preflight = {}, status = 'queued',
} = {}) {
  if (!db || !taskId || !profileId) throw new Error('taskId and profileId required')
  await ensureHamiltonAuthorizationSchema(db)
  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO hamilton_autopilot_runs
        (id, task_id, profile_id, user_id, authorization_id, status, preflight_json, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(taskId), String(profileId), userId, authorizationId, status,
    JSON.stringify(preflight || {}),
  )
  const row = await db.prepare('SELECT * FROM hamilton_autopilot_runs WHERE id = ?').get(id)
  return rowToRun(row)
}

export async function updateAutopilotRun(db, runId, patch = {}) {
  if (!db || !runId) return null
  await ensureHamiltonAuthorizationSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const sets = [`updated_at = ${nowFn}`]
  const params = []
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.blockerKind !== undefined) { sets.push('blocker_kind = ?'); params.push(patch.blockerKind ?? null) }
  if (patch.blockerDetail !== undefined) { sets.push('blocker_detail = ?'); params.push(patch.blockerDetail ?? null) }
  if (patch.preflight !== undefined) { sets.push('preflight_json = ?'); params.push(JSON.stringify(patch.preflight ?? {})) }
  if (patch.result !== undefined) { sets.push('result_json = ?'); params.push(JSON.stringify(patch.result ?? {})) }
  if (patch.confirmationReference !== undefined) { sets.push('confirmation_reference = ?'); params.push(patch.confirmationReference ?? null) }
  if (patch.confirmationScreenshotPath !== undefined) { sets.push('confirmation_screenshot_path = ?'); params.push(patch.confirmationScreenshotPath ?? null) }
  if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); params.push(patch.finishedAt ?? null) }
  if (sets.length === 1) return await getAutopilotRun(db, runId)
  params.push(String(runId))
  await db.prepare(`UPDATE hamilton_autopilot_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return await getAutopilotRun(db, runId)
}

export async function getAutopilotRun(db, runId) {
  if (!db || !runId) return null
  const row = await db.prepare('SELECT * FROM hamilton_autopilot_runs WHERE id = ?').get(String(runId))
  return rowToRun(row)
}

export async function listAutopilotRuns(db, { profileId = null, taskId = null, limit = 100 } = {}) {
  await ensureHamiltonAuthorizationSchema(db)
  let sql = 'SELECT * FROM hamilton_autopilot_runs WHERE 1=1'
  const params = []
  if (profileId) { sql += ' AND profile_id = ?'; params.push(String(profileId)) }
  if (taskId) { sql += ' AND task_id = ?'; params.push(String(taskId)) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)))
  const rows = await db.prepare(sql).all(...params)
  return (rows || []).map(rowToRun)
}
