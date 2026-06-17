/**
 * yanaBlockerStore.js
 *
 * Persistence for `yana_blockers` and `yana_blocker_resolutions`.
 * Every detected blocker — preflight, engine, or classifier — gets
 * a row here, and every attempted resolution writes a child row, so
 * the audit trail is complete.
 */

import crypto from 'node:crypto'

let ensured = false
export function _resetBlockerSchemaCache() { ensured = false }

async function ensureSchema(db) {
  if (!db || ensured || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  const boolType = isPostgres ? 'BOOLEAN' : 'INTEGER'
  const falseDef = isPostgres ? 'FALSE' : '0'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS yana_blockers (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      task_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      user_id TEXT,
      blocker_type TEXT NOT NULL,
      blocker_source TEXT,
      blocker_text TEXT,
      detected_at ${tsType} DEFAULT ${nowFn},
      resolution_strategy TEXT,
      resolved_at ${tsType},
      unresolved_reason TEXT,
      requires_user_action ${boolType} NOT NULL DEFAULT ${falseDef},
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_yana_blockers_task    ON yana_blockers(task_id);
    CREATE INDEX IF NOT EXISTS idx_yana_blockers_type    ON yana_blockers(blocker_type);
    CREATE INDEX IF NOT EXISTS idx_yana_blockers_open    ON yana_blockers(task_id, resolved_at);

    CREATE TABLE IF NOT EXISTS yana_blocker_resolutions (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      blocker_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempted_at ${tsType} DEFAULT ${nowFn},
      strategy TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT,
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      resolved_by_user_id TEXT,
      created_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_yana_blocker_res_blocker ON yana_blocker_resolutions(blocker_id);
    CREATE INDEX IF NOT EXISTS idx_yana_blocker_res_task    ON yana_blocker_resolutions(task_id);
  `)
  ensured = true
}

function safeJson(v) {
  if (v === null || v === undefined) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return {} }
}

export function rowToBlocker(row) {
  if (!row) return null
  return {
    id: row.id,
    task_id: row.task_id,
    profile_id: row.profile_id,
    user_id: row.user_id || null,
    blocker_type: row.blocker_type,
    blocker_source: row.blocker_source || null,
    blocker_text: row.blocker_text || null,
    detected_at: row.detected_at,
    resolution_strategy: row.resolution_strategy || null,
    resolved_at: row.resolved_at || null,
    unresolved_reason: row.unresolved_reason || null,
    requires_user_action: !!row.requires_user_action,
    metadata: safeJson(row.metadata_json),
  }
}

export async function recordBlocker(db, {
  taskId, profileId, userId = null,
  blockerType, blockerSource = 'engine',
  blockerText = null, requiresUserAction = false, metadata = {},
} = {}) {
  if (!db || !taskId || !profileId || !blockerType) {
    throw new Error('taskId, profileId, blockerType required')
  }
  await ensureSchema(db)
  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO yana_blockers
        (id, task_id, profile_id, user_id, blocker_type, blocker_source, blocker_text,
         detected_at, requires_user_action, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${nowFn}, ?, ?, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(taskId), String(profileId), userId, blockerType, blockerSource,
    blockerText, requiresUserAction ? 1 : 0,
    JSON.stringify(metadata || {}),
  )
  return rowToBlocker(await db.prepare('SELECT * FROM yana_blockers WHERE id = ?').get(id))
}

export async function recordResolution(db, {
  blockerId, taskId, strategy, outcome,
  detail = null, metadata = {}, resolvedByUserId = null,
} = {}) {
  if (!db || !blockerId || !taskId || !strategy || !outcome) {
    throw new Error('blockerId, taskId, strategy, outcome required')
  }
  await ensureSchema(db)
  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO yana_blocker_resolutions
        (id, blocker_id, task_id, attempted_at, strategy, outcome, detail, metadata_json, resolved_by_user_id, created_at)
      VALUES (?, ?, ?, ${nowFn}, ?, ?, ?, ?, ?, ${nowFn})`,
  ).run(
    id, String(blockerId), String(taskId), strategy, outcome, detail,
    JSON.stringify(metadata || {}), resolvedByUserId,
  )
  if (outcome === 'resolved') {
    await db.prepare(
      `UPDATE yana_blockers SET resolved_at = ${nowFn}, resolution_strategy = ?, updated_at = ${nowFn} WHERE id = ?`,
    ).run(strategy, String(blockerId))
  } else if (outcome === 'blocked' || outcome === 'escalated') {
    await db.prepare(
      `UPDATE yana_blockers SET unresolved_reason = ?, requires_user_action = 1, updated_at = ${nowFn} WHERE id = ?`,
    ).run(detail || strategy, String(blockerId))
  }
  return await db.prepare('SELECT * FROM yana_blocker_resolutions WHERE id = ?').get(id)
}

export async function listBlockersForTask(db, taskId, { onlyOpen = false } = {}) {
  if (!db || !taskId) return []
  await ensureSchema(db)
  const sql = onlyOpen
    ? `SELECT * FROM yana_blockers WHERE task_id = ? AND resolved_at IS NULL ORDER BY detected_at DESC`
    : `SELECT * FROM yana_blockers WHERE task_id = ? ORDER BY detected_at DESC`
  const rows = await db.prepare(sql).all(String(taskId))
  return (rows || []).map(rowToBlocker)
}

export async function getBlocker(db, id) {
  if (!db || !id) return null
  const row = await db.prepare('SELECT * FROM yana_blockers WHERE id = ?').get(String(id))
  return rowToBlocker(row)
}
