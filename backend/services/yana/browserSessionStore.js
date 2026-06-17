/**
 * browserSessionStore.js
 *
 * Persistence layer for `yana_browser_sessions`. Schema is auto-ensured
 * on first call so unit tests using in-memory SQLite don't have to load
 * migration 086 manually.
 *
 * Profile scoping is enforced: every read/write is filtered by
 * `profile_id`, every public function accepts a profile id, and the
 * cross-profile guard inside `getActiveSessionForTask` rejects if a
 * caller passes a profile that doesn't own the task's session.
 */

import crypto from 'crypto'

export const BROWSER_SESSION_STATUSES = Object.freeze([
  'not_started',
  'launching_browser',
  'waiting_for_user_login',
  'waiting_for_2fa',
  'waiting_for_captcha',
  'inspecting_form',
  'mapping_fields',
  'filling_fields',
  'missing_info_required',
  'waiting_for_user_review',
  'ready_for_submit',
  'submitted',
  'blocked',
  'failed',
  'cancelled',
])

export const BROWSER_SESSION_TERMINAL = Object.freeze([
  'submitted', 'cancelled', 'failed',
])

let ensuredSchema = false
let ensureSchemaPromise = null

export function _resetBrowserSessionSchemaCache() {
  ensuredSchema = false
  ensureSchemaPromise = null
}

export async function ensureBrowserSessionSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredSchema) return
  if (ensureSchemaPromise) return ensureSchemaPromise
  ensureSchemaPromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'
    const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
    const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
    const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
    const boolType = isPostgres ? 'BOOLEAN' : 'INTEGER'
    const defFalse = isPostgres ? 'FALSE' : '0'
    await db.exec(`
      CREATE TABLE IF NOT EXISTS yana_browser_sessions (
        id TEXT PRIMARY KEY DEFAULT ${idDefault},
        task_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        user_id TEXT,
        status TEXT NOT NULL DEFAULT 'not_started',
        portal_url TEXT,
        login_url TEXT,
        application_url TEXT,
        current_url TEXT,
        page_title TEXT,
        storage_state_path TEXT,
        headless ${boolType} NOT NULL DEFAULT ${defFalse},
        field_map_json TEXT NOT NULL DEFAULT '{}',
        filled_fields_json TEXT NOT NULL DEFAULT '{}',
        missing_fields_json TEXT NOT NULL DEFAULT '[]',
        required_actions_json TEXT NOT NULL DEFAULT '[]',
        pre_submit_snapshot_path TEXT,
        last_screenshot_path TEXT,
        confirmation_reference TEXT,
        approved_to_submit ${boolType} NOT NULL DEFAULT ${defFalse},
        last_activity_at ${tsType},
        metadata_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at ${tsType} DEFAULT ${nowFn},
        updated_at ${tsType} DEFAULT ${nowFn}
      );
      CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_task    ON yana_browser_sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_profile ON yana_browser_sessions(profile_id);
      CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_status  ON yana_browser_sessions(status);
    `)
    ensuredSchema = true
  })()
  try { await ensureSchemaPromise } finally { ensureSchemaPromise = null }
}

function safeParse(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function rowToSession(row) {
  if (!row) return null
  return {
    id: row.id,
    task_id: row.task_id,
    profile_id: row.profile_id,
    user_id: row.user_id ?? null,
    status: row.status,
    portal_url: row.portal_url ?? null,
    login_url: row.login_url ?? null,
    application_url: row.application_url ?? null,
    current_url: row.current_url ?? null,
    page_title: row.page_title ?? null,
    storage_state_path: row.storage_state_path ?? null,
    headless: Boolean(row.headless),
    field_map: safeParse(row.field_map_json, {}),
    filled_fields: safeParse(row.filled_fields_json, {}),
    missing_fields: safeParse(row.missing_fields_json, []),
    required_actions: safeParse(row.required_actions_json, []),
    pre_submit_snapshot_path: row.pre_submit_snapshot_path ?? null,
    last_screenshot_path: row.last_screenshot_path ?? null,
    confirmation_reference: row.confirmation_reference ?? null,
    approved_to_submit: Boolean(row.approved_to_submit),
    last_activity_at: row.last_activity_at ?? null,
    metadata: safeParse(row.metadata_json, {}),
    error: row.error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function getBrowserSessionById(db, id, { profileId = null } = {}) {
  if (!db || !id) return null
  await ensureBrowserSessionSchema(db)
  const row = await db.prepare('SELECT * FROM yana_browser_sessions WHERE id = ? LIMIT 1').get(String(id))
  if (!row) return null
  if (profileId && String(row.profile_id) !== String(profileId)) return null
  return rowToSession(row)
}

export async function getActiveSessionForTask(db, taskId, { profileId = null } = {}) {
  if (!db || !taskId) return null
  await ensureBrowserSessionSchema(db)
  const row = await db
    .prepare(
      `SELECT * FROM yana_browser_sessions
       WHERE task_id = ?
         AND status NOT IN ('submitted','cancelled','failed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(String(taskId))
  if (!row) return null
  if (profileId && String(row.profile_id) !== String(profileId)) {
    const err = new Error('profile mismatch — browser session does not belong to profile')
    err.status = 403
    throw err
  }
  return rowToSession(row)
}

export async function listSessionsForTask(db, taskId, { profileId, limit = 20 } = {}) {
  if (!db || !taskId || !profileId) return []
  await ensureBrowserSessionSchema(db)
  const rows = await db
    .prepare(
      `SELECT * FROM yana_browser_sessions
       WHERE task_id = ? AND profile_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(String(taskId), String(profileId), Math.max(1, Math.min(200, Number(limit) || 20)))
  return (rows || []).map(rowToSession)
}

export async function createBrowserSession(db, {
  taskId, profileId, userId = null, portalUrl = null,
  loginUrl = null, applicationUrl = null, headless = false,
  storageStatePath = null, metadata = {},
} = {}) {
  if (!db) throw new Error('db required')
  if (!taskId || !profileId) throw new Error('taskId and profileId required')
  await ensureBrowserSessionSchema(db)
  const id = crypto.randomUUID()
  const isPostgres = db?.dialect === 'postgres'
  const truthy = isPostgres
    ? (v) => Boolean(v)
    : (v) => (v ? 1 : 0)
  await db
    .prepare(
      `INSERT INTO yana_browser_sessions (
        id, task_id, profile_id, user_id, status, portal_url, login_url,
        application_url, headless, storage_state_path, metadata_json,
        last_activity_at
      ) VALUES (?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ${isPostgres ? 'now()' : "datetime('now')"})`,
    )
    .run(
      id,
      String(taskId),
      String(profileId),
      userId ? String(userId) : null,
      portalUrl,
      loginUrl,
      applicationUrl,
      truthy(headless),
      storageStatePath,
      JSON.stringify(metadata || {}),
    )
  return getBrowserSessionById(db, id)
}

export async function updateBrowserSession(db, sessionId, patch = {}) {
  if (!db || !sessionId) throw new Error('db and sessionId required')
  await ensureBrowserSessionSchema(db)
  const isPostgres = db?.dialect === 'postgres'
  const sets = []
  const params = []
  function set(col, value) {
    sets.push(`${col} = ?`)
    params.push(value)
  }
  if (patch.status !== undefined) {
    if (!BROWSER_SESSION_STATUSES.includes(patch.status)) {
      throw new Error(`invalid browser session status: ${patch.status}`)
    }
    set('status', patch.status)
  }
  if (patch.currentUrl !== undefined) set('current_url', patch.currentUrl)
  if (patch.pageTitle !== undefined) set('page_title', patch.pageTitle)
  if (patch.storageStatePath !== undefined) set('storage_state_path', patch.storageStatePath)
  if (patch.fieldMap !== undefined) set('field_map_json', JSON.stringify(patch.fieldMap || {}))
  if (patch.filledFields !== undefined) set('filled_fields_json', JSON.stringify(patch.filledFields || {}))
  if (patch.missingFields !== undefined) set('missing_fields_json', JSON.stringify(patch.missingFields || []))
  if (patch.requiredActions !== undefined) set('required_actions_json', JSON.stringify(patch.requiredActions || []))
  if (patch.preSubmitSnapshotPath !== undefined) set('pre_submit_snapshot_path', patch.preSubmitSnapshotPath)
  if (patch.lastScreenshotPath !== undefined) set('last_screenshot_path', patch.lastScreenshotPath)
  if (patch.confirmationReference !== undefined) set('confirmation_reference', patch.confirmationReference)
  if (patch.approvedToSubmit !== undefined) set('approved_to_submit', patch.approvedToSubmit ? (isPostgres ? true : 1) : (isPostgres ? false : 0))
  if (patch.metadata !== undefined) set('metadata_json', JSON.stringify(patch.metadata || {}))
  if (patch.error !== undefined) set('error', patch.error)

  if (sets.length === 0) return getBrowserSessionById(db, sessionId)

  sets.push(`updated_at = ${isPostgres ? 'now()' : "datetime('now')"}`)
  sets.push(`last_activity_at = ${isPostgres ? 'now()' : "datetime('now')"}`)

  const sql = `UPDATE yana_browser_sessions SET ${sets.join(', ')} WHERE id = ?`
  params.push(String(sessionId))
  await db.prepare(sql).run(...params)
  return getBrowserSessionById(db, sessionId)
}
