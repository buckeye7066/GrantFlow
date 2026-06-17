/**
 * applicationTaskStore.js
 *
 * Persistence helpers for `application_tasks`, `application_task_events`,
 * and `application_missing_info`. Used by both the Yana agent and the
 * /api/application-tasks routes.
 *
 * Mission rules:
 *   - Profile-scoped: every read accepts (profileId or admin context) and
 *     callers must verify access before mutating.
 *   - Append-only audit log (mission rule "any new logic must be
 *     traceable / logged / reversible"): event rows are never updated or
 *     deleted; cancellation is a status transition, not a row removal.
 *   - Idempotent schema bootstrap so unit tests using fresh in-memory DBs
 *     don't have to load the migration file.
 */

import crypto from 'crypto'
import { withProfileScope } from '../../middleware/profileContext.js'

export const TASK_STATUSES = Object.freeze([
  'queued',
  'ready',
  'waiting_for_user',
  'waiting_for_admin',
  'blocked_login_required',
  'blocked_missing_info',
  'blocked_2fa',
  'blocked_captcha',
  'blocked_terms_or_policy',
  'in_progress',
  'draft_completed',
  'submitted',
  'failed',
  'cancelled',
])

export const TASK_BLOCKED_STATUSES = Object.freeze([
  'blocked_login_required',
  'blocked_missing_info',
  'blocked_2fa',
  'blocked_captcha',
  'blocked_terms_or_policy',
])

export const TASK_TERMINAL_STATUSES = Object.freeze([
  'submitted',
  'failed',
  'cancelled',
])

export const MISSING_INFO_KINDS = Object.freeze([
  'field',
  'document',
  'login',
  'consent',
  'signature',
  'attestation',
  'admin_review',
  'other',
])

export const TASK_EVENT_TYPES = Object.freeze([
  'created',
  'started',
  'progress',
  'fields_filled',
  'missing_info',
  'blocked',
  'unblocked',
  'draft_completed',
  'submitted',
  'cancelled',
  'failed',
  'note',
])

let ensuredSchema = false

export function _resetSchemaCache() {
  ensuredSchema = false
}

export async function ensureApplicationTaskSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredSchema) return

  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const boolType = isPostgres ? 'BOOLEAN' : 'INTEGER'
  const defFalse = isPostgres ? 'FALSE' : '0'

  await db.exec(`
    CREATE TABLE IF NOT EXISTS application_tasks (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT,
      grant_id TEXT,
      portal_id TEXT,
      application_id TEXT,
      assigned_agent TEXT NOT NULL DEFAULT 'yana',
      status TEXT NOT NULL DEFAULT 'queued',
      current_step TEXT,
      missing_fields_json TEXT NOT NULL DEFAULT '[]',
      missing_documents_json TEXT NOT NULL DEFAULT '[]',
      required_user_actions_json TEXT NOT NULL DEFAULT '[]',
      last_agent_message TEXT,
      auto_submit_enabled ${boolType} NOT NULL DEFAULT ${defFalse},
      submitted_at ${tsType},
      cancelled_at ${tsType},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_application_tasks_profile ON application_tasks(profile_id);
    CREATE INDEX IF NOT EXISTS idx_application_tasks_user    ON application_tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_application_tasks_opp     ON application_tasks(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_application_tasks_grant   ON application_tasks(grant_id);
    CREATE INDEX IF NOT EXISTS idx_application_tasks_status  ON application_tasks(status);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_application_tasks_profile_subject
      ON application_tasks(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));

    CREATE TABLE IF NOT EXISTS application_task_events (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT,
      step TEXT,
      message TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      actor_user_id TEXT,
      actor_role TEXT,
      created_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_application_task_events_task    ON application_task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_application_task_events_type    ON application_task_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_application_task_events_created ON application_task_events(created_at);

    CREATE TABLE IF NOT EXISTS application_missing_info (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT,
      description TEXT,
      required ${boolType} NOT NULL DEFAULT 1,
      resolved ${boolType} NOT NULL DEFAULT ${defFalse},
      resolved_at ${tsType},
      resolved_by TEXT,
      resolved_value_json TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_application_missing_info_task ON application_missing_info(task_id);
    CREATE INDEX IF NOT EXISTS idx_application_missing_info_kind ON application_missing_info(kind);
    CREATE INDEX IF NOT EXISTS idx_application_missing_info_resolved ON application_missing_info(resolved);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_application_missing_info_task_kind_key
      ON application_missing_info(task_id, kind, key);
  `)

  ensuredSchema = true
}

function nowSqlLiteral(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

function safeJson(val, fallback) {
  if (val === null || val === undefined) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}

function rowToTask(row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    profile_id: row.profile_id,
    opportunity_id: row.opportunity_id ?? null,
    grant_id: row.grant_id ?? null,
    portal_id: row.portal_id ?? null,
    application_id: row.application_id ?? null,
    assigned_agent: row.assigned_agent ?? 'yana',
    status: row.status,
    current_step: row.current_step ?? null,
    missing_fields: safeJson(row.missing_fields_json, []),
    missing_documents: safeJson(row.missing_documents_json, []),
    required_user_actions: safeJson(row.required_user_actions_json, []),
    last_agent_message: row.last_agent_message ?? null,
    auto_submit_enabled: Boolean(row.auto_submit_enabled),
    submitted_at: row.submitted_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowToEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    task_id: row.task_id,
    event_type: row.event_type,
    status: row.status ?? null,
    step: row.step ?? null,
    message: row.message ?? null,
    details: safeJson(row.details_json, {}),
    actor_user_id: row.actor_user_id ?? null,
    actor_role: row.actor_role ?? null,
    created_at: row.created_at,
  }
}

function rowToMissing(row) {
  if (!row) return null
  return {
    id: row.id,
    task_id: row.task_id,
    kind: row.kind,
    key: row.key,
    label: row.label ?? null,
    description: row.description ?? null,
    required: Boolean(row.required),
    resolved: Boolean(row.resolved),
    resolved_at: row.resolved_at ?? null,
    resolved_by: row.resolved_by ?? null,
    resolved_value: safeJson(row.resolved_value_json, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Create or fetch the existing task for a (profile, opportunity-or-grant).
 * The unique key in the schema makes repeated calls safe — they return
 * the existing row.
 */
export async function ensureApplicationTask(db, {
  profileId,
  userId = null,
  opportunityId = null,
  grantId = null,
  portalId = null,
  applicationId = null,
  initialStatus = 'queued',
  currentStep = null,
} = {}) {
  if (!profileId) throw new Error('profileId required')
  if (!opportunityId && !grantId) throw new Error('opportunityId or grantId required')
  if (!TASK_STATUSES.includes(initialStatus)) {
    throw new Error(`invalid initialStatus: ${initialStatus}`)
  }
  await ensureApplicationTaskSchema(db)

  return await withProfileScope({ bypass: true }, async () => {
    const existing = await db
      .prepare(
        `SELECT * FROM application_tasks
          WHERE profile_id = ? AND COALESCE(opportunity_id,'') = ? AND COALESCE(grant_id,'') = ?
          LIMIT 1`,
      )
      .get(
        String(profileId),
        opportunityId ? String(opportunityId) : '',
        grantId ? String(grantId) : '',
      )
    if (existing) return rowToTask(existing)

    const id = crypto.randomUUID()
    await db
      .prepare(
        `INSERT INTO application_tasks
           (id, user_id, profile_id, opportunity_id, grant_id, portal_id, application_id,
            assigned_agent, status, current_step, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?,
                 'yana', ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})`,
      )
      .run(
        id,
        userId,
        String(profileId),
        opportunityId,
        grantId,
        portalId,
        applicationId,
        initialStatus,
        currentStep,
      )

    await appendTaskEvent(db, {
      taskId: id,
      eventType: 'created',
      status: initialStatus,
      step: currentStep,
      message: 'Application task created',
      actorUserId: userId,
    })

    const row = await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(id)
    return rowToTask(row)
  })
}

export async function getApplicationTask(db, taskId, { profileId = null } = {}) {
  if (!taskId) return null
  await ensureApplicationTaskSchema(db)
  let row
  if (profileId) {
    row = await db
      .prepare('SELECT * FROM application_tasks WHERE id = ? AND profile_id = ?')
      .get(String(taskId), String(profileId))
  } else {
    row = await db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(String(taskId))
  }
  return row ? rowToTask(row) : null
}

export async function listApplicationTasks(db, { profileId, status = null, limit = 100 } = {}) {
  await ensureApplicationTaskSchema(db)
  const params = []
  let sql = 'SELECT * FROM application_tasks WHERE 1=1 '
  if (profileId) {
    sql += ' AND profile_id = ?'
    params.push(String(profileId))
  }
  if (status) {
    sql += ' AND status = ?'
    params.push(String(status))
  }
  sql += ' ORDER BY updated_at DESC LIMIT ?'
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)))
  const rows = await db.prepare(sql).all(...params)
  return (rows || []).map(rowToTask)
}

/**
 * Patch a task. Only whitelisted columns are written.
 */
export async function updateApplicationTask(db, taskId, {
  status,
  currentStep,
  missingFields,
  missingDocuments,
  requiredUserActions,
  lastAgentMessage,
  autoSubmitEnabled,
  applicationId,
  portalId,
  submittedAt,
  cancelledAt,
} = {}) {
  if (!taskId) throw new Error('taskId required')
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`)
  }
  await ensureApplicationTaskSchema(db)

  const sets = [`updated_at = ${nowSqlLiteral(db)}`]
  const params = []
  if (status !== undefined) { sets.push('status = ?'); params.push(status) }
  if (currentStep !== undefined) { sets.push('current_step = ?'); params.push(currentStep ?? null) }
  if (missingFields !== undefined) { sets.push('missing_fields_json = ?'); params.push(JSON.stringify(missingFields ?? [])) }
  if (missingDocuments !== undefined) { sets.push('missing_documents_json = ?'); params.push(JSON.stringify(missingDocuments ?? [])) }
  if (requiredUserActions !== undefined) { sets.push('required_user_actions_json = ?'); params.push(JSON.stringify(requiredUserActions ?? [])) }
  if (lastAgentMessage !== undefined) { sets.push('last_agent_message = ?'); params.push(lastAgentMessage ?? null) }
  if (autoSubmitEnabled !== undefined) { sets.push('auto_submit_enabled = ?'); params.push(autoSubmitEnabled ? 1 : 0) }
  if (applicationId !== undefined) { sets.push('application_id = ?'); params.push(applicationId ?? null) }
  if (portalId !== undefined) { sets.push('portal_id = ?'); params.push(portalId ?? null) }
  if (submittedAt !== undefined) { sets.push('submitted_at = ?'); params.push(submittedAt ?? null) }
  if (cancelledAt !== undefined) { sets.push('cancelled_at = ?'); params.push(cancelledAt ?? null) }

  if (sets.length === 1) return await getApplicationTask(db, taskId)

  params.push(String(taskId))
  await db.prepare(`UPDATE application_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return await getApplicationTask(db, taskId)
}

export async function cancelApplicationTask(db, taskId, { actorUserId = null, actorRole = null, reason = null } = {}) {
  await ensureApplicationTaskSchema(db)
  const ts = new Date().toISOString()
  await db
    .prepare(
      `UPDATE application_tasks
         SET status = 'cancelled', cancelled_at = ?, updated_at = ${nowSqlLiteral(db)}
       WHERE id = ?`,
    )
    .run(ts, String(taskId))
  await appendTaskEvent(db, {
    taskId,
    eventType: 'cancelled',
    status: 'cancelled',
    message: reason || 'task cancelled',
    actorUserId,
    actorRole,
  })
  return await getApplicationTask(db, taskId)
}

// ── Events ─────────────────────────────────────────────────────────

export async function appendTaskEvent(db, {
  taskId,
  eventType,
  status = null,
  step = null,
  message = null,
  details = null,
  actorUserId = null,
  actorRole = null,
} = {}) {
  if (!taskId) throw new Error('taskId required')
  if (!eventType) throw new Error('eventType required')
  await ensureApplicationTaskSchema(db)
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO application_task_events
         (id, task_id, event_type, status, step, message, details_json, actor_user_id, actor_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowSqlLiteral(db)})`,
    )
    .run(
      id,
      String(taskId),
      String(eventType),
      status ?? null,
      step ?? null,
      message ?? null,
      JSON.stringify(details ?? {}),
      actorUserId ?? null,
      actorRole ?? null,
    )
  return id
}

export async function listTaskEvents(db, taskId, { limit = 200 } = {}) {
  if (!taskId) return []
  await ensureApplicationTaskSchema(db)
  const rows = await db
    .prepare(
      `SELECT * FROM application_task_events
        WHERE task_id = ? ORDER BY created_at ASC LIMIT ?`,
    )
    .all(String(taskId), Math.max(1, Math.min(1000, Number(limit) || 200)))
  return (rows || []).map(rowToEvent)
}

// ── Missing info ───────────────────────────────────────────────────

export async function setMissingInfo(db, taskId, items = []) {
  await ensureApplicationTaskSchema(db)
  if (!Array.isArray(items)) items = []
  for (const item of items) {
    if (!item || !item.kind || !item.key) continue
    if (!MISSING_INFO_KINDS.includes(item.kind)) continue
    const existing = await db
      .prepare(`SELECT id FROM application_missing_info WHERE task_id = ? AND kind = ? AND key = ? LIMIT 1`)
      .get(String(taskId), item.kind, String(item.key))
    if (existing) {
      await db
        .prepare(
          `UPDATE application_missing_info
             SET label = COALESCE(?, label),
                 description = COALESCE(?, description),
                 required = COALESCE(?, required),
                 updated_at = ${nowSqlLiteral(db)}
           WHERE id = ?`,
        )
        .run(item.label ?? null, item.description ?? null, item.required === undefined ? null : (item.required ? 1 : 0), existing.id)
    } else {
      await db
        .prepare(
          `INSERT INTO application_missing_info
             (id, task_id, kind, key, label, description, required, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})`,
        )
        .run(
          crypto.randomUUID(),
          String(taskId),
          item.kind,
          String(item.key),
          item.label ?? null,
          item.description ?? null,
          item.required === false ? 0 : 1,
        )
    }
  }
}

export async function listMissingInfo(db, taskId, { includeResolved = true } = {}) {
  if (!taskId) return []
  await ensureApplicationTaskSchema(db)
  const sql = includeResolved
    ? 'SELECT * FROM application_missing_info WHERE task_id = ? ORDER BY created_at ASC'
    : 'SELECT * FROM application_missing_info WHERE task_id = ? AND resolved = 0 ORDER BY created_at ASC'
  const rows = await db.prepare(sql).all(String(taskId))
  return (rows || []).map(rowToMissing)
}

export async function resolveMissingInfoItem(db, taskId, { kind, key, value, resolvedBy = null } = {}) {
  if (!taskId || !kind || !key) throw new Error('taskId/kind/key required')
  await ensureApplicationTaskSchema(db)
  const ts = new Date().toISOString()
  const result = await db
    .prepare(
      `UPDATE application_missing_info
         SET resolved = 1, resolved_at = ?, resolved_by = ?,
             resolved_value_json = ?, updated_at = ${nowSqlLiteral(db)}
       WHERE task_id = ? AND kind = ? AND key = ?`,
    )
    .run(
      ts,
      resolvedBy ?? null,
      JSON.stringify(value ?? null),
      String(taskId),
      String(kind),
      String(key),
    )
  return Number(result?.changes ?? result?.rowCount ?? 0) > 0
}

export { rowToTask as _rowToTask, rowToEvent as _rowToEvent, rowToMissing as _rowToMissing }
