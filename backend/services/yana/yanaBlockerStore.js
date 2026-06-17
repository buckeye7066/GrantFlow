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
  const trueDef = isPostgres ? 'TRUE' : '1'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS yana_blockers (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      task_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      user_id TEXT,
      funding_source_id TEXT,
      blocker_type TEXT NOT NULL,
      blocker_source TEXT,
      blocker_title TEXT,
      blocker_message TEXT,
      blocker_text TEXT,
      severity TEXT NOT NULL DEFAULT 'warning',
      required_action TEXT,
      resolver_route TEXT,
      admin_required ${boolType} NOT NULL DEFAULT ${falseDef},
      user_required ${boolType} NOT NULL DEFAULT ${trueDef},
      deadline_at ${tsType},
      detected_at ${tsType} DEFAULT ${nowFn},
      resolution_strategy TEXT,
      resolved_at ${tsType},
      resolved_by_user_id TEXT,
      unresolved_reason TEXT,
      user_notification_id TEXT,
      admin_notification_ids TEXT,
      requires_user_action ${boolType} NOT NULL DEFAULT ${falseDef},
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_yana_blockers_task    ON yana_blockers(task_id);
    CREATE INDEX IF NOT EXISTS idx_yana_blockers_type    ON yana_blockers(blocker_type);
    CREATE INDEX IF NOT EXISTS idx_yana_blockers_open    ON yana_blockers(task_id, resolved_at);
    CREATE INDEX IF NOT EXISTS idx_yana_blockers_admin   ON yana_blockers(admin_required, resolved_at);

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
  // Idempotent ALTER TABLE for existing dev databases that ran an
  // earlier version of migration 089. SQLite ignores duplicate column
  // errors here, Postgres uses ADD COLUMN IF NOT EXISTS.
  const addColumns = [
    ['funding_source_id', 'TEXT'],
    ['blocker_title', 'TEXT'],
    ['blocker_message', 'TEXT'],
    ['severity', "TEXT NOT NULL DEFAULT 'warning'"],
    ['required_action', 'TEXT'],
    ['resolver_route', 'TEXT'],
    ['admin_required', `${boolType} NOT NULL DEFAULT ${falseDef}`],
    ['user_required', `${boolType} NOT NULL DEFAULT ${trueDef}`],
    ['deadline_at', tsType],
    ['resolved_by_user_id', 'TEXT'],
    ['user_notification_id', 'TEXT'],
    ['admin_notification_ids', 'TEXT'],
  ]
  for (const [name, type] of addColumns) {
    try {
      if (isPostgres) {
        await db.exec(`ALTER TABLE yana_blockers ADD COLUMN IF NOT EXISTS ${name} ${type}`)
      } else {
        await db.exec(`ALTER TABLE yana_blockers ADD COLUMN ${name} ${type}`)
      }
    } catch (err) {
      // SQLite throws "duplicate column" — ignore.
      if (!/duplicate column|already exists/i.test(err?.message || '')) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[yanaBlockerStore] ALTER skipped:', name, err?.message)
        }
      }
    }
  }
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
    funding_source_id: row.funding_source_id || null,
    blocker_type: row.blocker_type,
    blocker_source: row.blocker_source || null,
    blocker_title: row.blocker_title || null,
    blocker_message: row.blocker_message || null,
    blocker_text: row.blocker_text || null,
    severity: row.severity || 'warning',
    required_action: row.required_action || null,
    resolver_route: row.resolver_route || null,
    admin_required: !!row.admin_required,
    user_required: !!row.user_required,
    deadline_at: row.deadline_at || null,
    detected_at: row.detected_at,
    resolution_strategy: row.resolution_strategy || null,
    resolved_at: row.resolved_at || null,
    resolved_by_user_id: row.resolved_by_user_id || null,
    unresolved_reason: row.unresolved_reason || null,
    user_notification_id: row.user_notification_id || null,
    admin_notification_ids: row.admin_notification_ids
      ? String(row.admin_notification_ids).split(',').filter(Boolean)
      : [],
    requires_user_action: !!row.requires_user_action,
    metadata: safeJson(row.metadata_json),
  }
}

export async function recordBlocker(db, {
  taskId, profileId, userId = null,
  fundingSourceId = null,
  blockerType, blockerSource = 'engine',
  blockerTitle = null, blockerMessage = null,
  blockerText = null,
  severity = 'warning',
  requiredAction = null, resolverRoute = null,
  adminRequired = true, userRequired = true,
  deadlineAt = null,
  requiresUserAction = false, metadata = {},
} = {}) {
  if (!db || !taskId || !profileId || !blockerType) {
    throw new Error('taskId, profileId, blockerType required')
  }
  await ensureSchema(db)
  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO yana_blockers
        (id, task_id, profile_id, user_id, funding_source_id,
         blocker_type, blocker_source, blocker_title, blocker_message, blocker_text,
         severity, required_action, resolver_route,
         admin_required, user_required, deadline_at,
         detected_at, requires_user_action, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ?, ?, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(taskId), String(profileId), userId, fundingSourceId,
    blockerType, blockerSource, blockerTitle, blockerMessage, blockerText,
    severity, requiredAction, resolverRoute,
    adminRequired ? 1 : 0, userRequired ? 1 : 0, deadlineAt,
    requiresUserAction ? 1 : 0, JSON.stringify(metadata || {}),
  )
  return rowToBlocker(await db.prepare('SELECT * FROM yana_blockers WHERE id = ?').get(id))
}

/**
 * Attach the persistent notification ids that were created when this
 * blocker was raised, so resolving the blocker can also clear them.
 */
export async function attachBlockerNotifications(db, blockerId, { userNotificationId = null, adminNotificationIds = [] } = {}) {
  if (!db || !blockerId) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const adminCsv = Array.isArray(adminNotificationIds) ? adminNotificationIds.filter(Boolean).join(',') : null
  await db.prepare(
    `UPDATE yana_blockers
        SET user_notification_id = ?, admin_notification_ids = ?, updated_at = ${nowFn}
      WHERE id = ?`,
  ).run(userNotificationId || null, adminCsv || null, String(blockerId))
  return rowToBlocker(await db.prepare('SELECT * FROM yana_blockers WHERE id = ?').get(String(blockerId)))
}

/**
 * Mark all open blockers for a task as resolved with the given strategy.
 * Returns the rows that were just resolved (so callers can clear
 * related notifications, write audit events, and resume Yana).
 */
export async function resolveOpenBlockersForTask(db, {
  taskId, strategy = 'user_action', detail = null, resolvedByUserId = null,
} = {}) {
  if (!db || !taskId) return []
  await ensureSchema(db)
  const open = await listBlockersForTask(db, taskId, { onlyOpen: true })
  if (open.length === 0) return []
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  for (const b of open) {
    await db.prepare(
      `UPDATE yana_blockers
          SET resolved_at = ${nowFn}, resolution_strategy = ?, resolved_by_user_id = ?,
              updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(strategy, resolvedByUserId, b.id)
    await recordResolution(db, {
      blockerId: b.id, taskId, strategy, outcome: 'resolved',
      detail, resolvedByUserId,
    })
  }
  return open
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

/**
 * Return every unresolved blocker across the system. Used by the
 * admin "Yana hard stops" dashboard.
 */
export async function listOpenAdminBlockers(db, { limit = 200 } = {}) {
  if (!db) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM yana_blockers
      WHERE resolved_at IS NULL
      ORDER BY detected_at DESC
      LIMIT ?`,
  ).all(Number(limit) || 200)
  return (rows || []).map(rowToBlocker)
}
