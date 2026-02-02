import crypto from 'crypto'
import { logAuditEvent, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js'

function safeJson(value) {
  if (value === undefined) return null
  if (value === null) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { _error: 'unserializable' }
  }
}

function nowSqlLiteral(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

function normalizeActor(actor) {
  const raw = actor && typeof actor === 'object' ? actor : {}
  const actorType = String(raw.type || raw.actor_type || 'system').toLowerCase()
  const allowed = new Set(['user', 'ai', 'system'])
  const type = allowed.has(actorType) ? actorType : 'system'
  const id = raw.id ?? raw.actor_id ?? raw.userId ?? raw.user_id ?? null
  return { actor_type: type, actor_id: id ? String(id) : null }
}

export async function writeAuditEvent(db, {
  actor,
  entity_type,
  entity_id,
  action,
  before,
  after,
  severity = SEVERITY.INFO,
  category = AUDIT_CATEGORIES.SYSTEM,
} = {}) {
  if (!db) return null
  const id = crypto.randomUUID()
  const { actor_type, actor_id } = normalizeActor(actor)

  const beforeJson = safeJson(before)
  const afterJson = safeJson(after)

  try {
    const createdAtExpr = nowSqlLiteral(db)
    if (db.dialect === 'postgres') {
      await db
        .prepare(
          `
            INSERT INTO audit_events (
              id, created_at,
              actor_type, actor_id,
              entity_type, entity_id,
              action, before_json, after_json
            ) VALUES (?, ${createdAtExpr}, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          id,
          actor_type,
          actor_id,
          String(entity_type),
          String(entity_id),
          String(action),
          beforeJson,
          afterJson,
        )
    } else {
      await db
        .prepare(
          `
            INSERT INTO audit_events (
              id, created_at,
              actor_type, actor_id,
              entity_type, entity_id,
              action, before_json, after_json
            ) VALUES (?, ${createdAtExpr}, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          id,
          actor_type,
          actor_id,
          String(entity_type),
          String(entity_id),
          String(action),
          beforeJson ? JSON.stringify(beforeJson) : null,
          afterJson ? JSON.stringify(afterJson) : null,
        )
    }
  } catch (error) {
    // Never throw from audit logging.
    // If audit_events table is missing on older schemas, this should fail softly.
  }

  // Also write a human-queryable summary row to existing audit_logs (admin tooling).
  try {
    logAuditEvent(db, {
      category,
      action: String(action),
      severity,
      userId: actor_type === 'user' ? actor_id : null,
      profileId: null,
      resourceType: String(entity_type),
      resourceId: String(entity_id),
      details: {
        vnext: true,
        actor_type,
        actor_id,
        before: beforeJson,
        after: afterJson,
      },
    })
  } catch {
    // ignore
  }

  return id
}

