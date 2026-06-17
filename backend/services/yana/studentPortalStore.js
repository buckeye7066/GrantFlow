/**
 * studentPortalStore.js
 *
 * Lightweight CRUD helpers around the `student_portals` table introduced
 * by SQLite migration 085 / Postgres migration 0081.
 *
 * Mission rules satisfied:
 *   - All queries are profile-scoped (mission goal #11). The caller must
 *     pass `profileId`; the store never returns rows from a different
 *     profile.
 *   - Schema is ensured at runtime (idempotent CREATE) so smoke tests and
 *     unit tests using in-memory better-sqlite3 don't have to load the
 *     migration file.
 *   - Reasons + confidence + source are stored verbatim so the UI can
 *     show "why this portal record exists" without re-running the linker.
 */

import crypto from 'crypto'
import { withProfileScope } from '../../middleware/profileContext.js'

export const PORTAL_TYPES = Object.freeze([
  'financial_aid',
  'scholarship',
  'admissions',
  'student_account',
  'bursar',
  'department',
  'graduate_school',
  'program_specific',
  'external_application',
  'manual_or_offline',
])

export const PORTAL_SOURCES = Object.freeze([
  'profile',
  'knownSchools',
  'crawler',
  'user_entered',
  'inferred',
])

export const CREDENTIAL_STATES = Object.freeze([
  'unknown',
  'needed',
  'stored_reference',
  'user_session_required',
  'unavailable',
])

let ensuredSchema = false
let ensureSchemaPromise = null

/**
 * Ensure the `student_portals` table exists. Replays the SQLite portion
 * of migration 085 — the migration runner is the source of truth, but
 * unit tests using a fresh in-memory DB call this directly.
 */
export async function ensureStudentPortalsSchema(db) {
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
    const defTrue = isPostgres ? 'TRUE' : '1'

    await db.exec(`
      CREATE TABLE IF NOT EXISTS student_portals (
        id TEXT PRIMARY KEY DEFAULT ${idDefault},
        profile_id TEXT NOT NULL,
        user_id TEXT,
        school_id TEXT,
        school_normalized TEXT,
        school_display_name TEXT,
        portal_type TEXT NOT NULL,
        portal_name TEXT,
        portal_url TEXT,
        login_url TEXT,
        application_url TEXT,
        sso_required ${boolType} NOT NULL DEFAULT ${defFalse},
        credentials_required ${boolType} NOT NULL DEFAULT ${defFalse},
        credentials_status TEXT NOT NULL DEFAULT 'unknown',
        last_checked_at ${tsType},
        last_check_status TEXT,
        source TEXT NOT NULL DEFAULT 'inferred',
        confidence REAL NOT NULL DEFAULT 0.5,
        reason TEXT,
        metadata_json TEXT DEFAULT '{}',
        active ${boolType} NOT NULL DEFAULT ${defTrue},
        created_at ${tsType} DEFAULT ${nowFn},
        updated_at ${tsType} DEFAULT ${nowFn}
      );
      CREATE INDEX IF NOT EXISTS idx_student_portals_profile_id ON student_portals(profile_id);
      CREATE INDEX IF NOT EXISTS idx_student_portals_user_id    ON student_portals(user_id);
      CREATE INDEX IF NOT EXISTS idx_student_portals_school     ON student_portals(school_normalized);
      CREATE INDEX IF NOT EXISTS idx_student_portals_type       ON student_portals(portal_type);
      CREATE INDEX IF NOT EXISTS idx_student_portals_active     ON student_portals(active);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_student_portals_profile_school_type
        ON student_portals(profile_id, COALESCE(school_normalized,''), portal_type);
    `)
    ensuredSchema = true
  })()
  try {
    await ensureSchemaPromise
  } finally {
    ensureSchemaPromise = null
  }
}

/** Reset cached "ensured" flag — used by tests to allow per-DB re-init. */
export function _resetSchemaCache() {
  ensuredSchema = false
  ensureSchemaPromise = null
}

export function normalizeSchoolName(value) {
  if (!value || typeof value !== 'string') return null
  return value
    .toLowerCase()
    .replace(/\b(university|college|institute|school|of|the|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
}

function toBoolInt(v) {
  if (v === null || v === undefined) return 0
  return v ? 1 : 0
}

function safeStringifyJson(value) {
  try {
    if (value === null || value === undefined) return '{}'
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function rowToPortal(row) {
  if (!row) return null
  let metadata = {}
  try {
    metadata = row.metadata_json
      ? typeof row.metadata_json === 'string'
        ? JSON.parse(row.metadata_json)
        : row.metadata_json
      : {}
  } catch {
    metadata = {}
  }
  return {
    id: row.id,
    profile_id: row.profile_id,
    user_id: row.user_id ?? null,
    school_id: row.school_id ?? null,
    school_normalized: row.school_normalized ?? null,
    school_display_name: row.school_display_name ?? null,
    portal_type: row.portal_type,
    portal_name: row.portal_name ?? null,
    portal_url: row.portal_url ?? null,
    login_url: row.login_url ?? null,
    application_url: row.application_url ?? null,
    sso_required: Boolean(row.sso_required),
    credentials_required: Boolean(row.credentials_required),
    credentials_status: row.credentials_status ?? 'unknown',
    last_checked_at: row.last_checked_at ?? null,
    last_check_status: row.last_check_status ?? null,
    source: row.source ?? 'inferred',
    confidence: Number(row.confidence ?? 0),
    reason: row.reason ?? null,
    metadata,
    active: Boolean(row.active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function nowSqlLiteral(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

/**
 * List active portal records for a profile.
 */
export async function listStudentPortals(db, profileId, { includeInactive = false } = {}) {
  if (!profileId) return []
  await ensureStudentPortalsSchema(db)
  const sql = includeInactive
    ? 'SELECT * FROM student_portals WHERE profile_id = ? ORDER BY school_display_name, portal_type'
    : `SELECT * FROM student_portals WHERE profile_id = ? AND active = ${db?.dialect === 'postgres' ? 'TRUE' : 1} ORDER BY school_display_name, portal_type`
  const rows = await db.prepare(sql).all(String(profileId))
  return (rows || []).map(rowToPortal)
}

export async function getStudentPortal(db, profileId, portalId) {
  if (!profileId || !portalId) return null
  await ensureStudentPortalsSchema(db)
  const row = await db
    .prepare('SELECT * FROM student_portals WHERE id = ? AND profile_id = ?')
    .get(String(portalId), String(profileId))
  return row ? rowToPortal(row) : null
}

/**
 * Insert or update a portal record. The unique key is
 * (profile_id, school_normalized, portal_type) — repeated calls update
 * the existing row instead of creating duplicates.
 */
export async function upsertStudentPortal(db, profileId, input = {}) {
  if (!profileId) throw new Error('profileId required')
  await ensureStudentPortalsSchema(db)

  const portal_type = String(input.portal_type || '').trim()
  if (!PORTAL_TYPES.includes(portal_type)) {
    const err = new Error(`invalid portal_type: ${portal_type}`)
    err.status = 400
    throw err
  }

  const source = PORTAL_SOURCES.includes(input.source) ? input.source : 'inferred'
  const credentials_status = CREDENTIAL_STATES.includes(input.credentials_status)
    ? input.credentials_status
    : 'unknown'

  const schoolDisplay = input.school_display_name ? String(input.school_display_name) : null
  const schoolNormalized = input.school_normalized
    ? String(input.school_normalized)
    : normalizeSchoolName(schoolDisplay)

  const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? 0.5)))

  const lookupKey = schoolNormalized ?? ''

  return withProfileScope({ bypass: true }, async () => {
    const existing = await db
      .prepare(
        `SELECT * FROM student_portals
         WHERE profile_id = ? AND COALESCE(school_normalized,'') = ? AND portal_type = ?
         LIMIT 1`,
      )
      .get(String(profileId), lookupKey, portal_type)

    if (existing) {
      await db
        .prepare(
          `UPDATE student_portals
           SET updated_at = ${nowSqlLiteral(db)},
               user_id = COALESCE(?, user_id),
               school_id = COALESCE(?, school_id),
               school_display_name = COALESCE(?, school_display_name),
               portal_name = COALESCE(?, portal_name),
               portal_url = COALESCE(?, portal_url),
               login_url = COALESCE(?, login_url),
               application_url = COALESCE(?, application_url),
               sso_required = COALESCE(?, sso_required),
               credentials_required = COALESCE(?, credentials_required),
               credentials_status = ?,
               source = ?,
               confidence = ?,
               reason = COALESCE(?, reason),
               metadata_json = COALESCE(?, metadata_json),
               active = COALESCE(?, active)
           WHERE id = ?`,
        )
        .run(
          input.user_id ?? null,
          input.school_id ?? null,
          schoolDisplay,
          input.portal_name ?? null,
          input.portal_url ?? null,
          input.login_url ?? null,
          input.application_url ?? null,
          input.sso_required === undefined ? null : toBoolInt(input.sso_required),
          input.credentials_required === undefined ? null : toBoolInt(input.credentials_required),
          credentials_status,
          source,
          confidence,
          input.reason ?? null,
          input.metadata === undefined ? null : safeStringifyJson(input.metadata),
          input.active === undefined ? null : toBoolInt(input.active),
          existing.id,
        )
      const row = await db.prepare('SELECT * FROM student_portals WHERE id = ?').get(existing.id)
      return rowToPortal(row)
    }

    const id = crypto.randomUUID()
    await db
      .prepare(
        `INSERT INTO student_portals
           (id, profile_id, user_id, school_id, school_normalized, school_display_name,
            portal_type, portal_name, portal_url, login_url, application_url,
            sso_required, credentials_required, credentials_status,
            source, confidence, reason, metadata_json, active,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})`,
      )
      .run(
        id,
        String(profileId),
        input.user_id ?? null,
        input.school_id ?? null,
        schoolNormalized,
        schoolDisplay,
        portal_type,
        input.portal_name ?? null,
        input.portal_url ?? null,
        input.login_url ?? null,
        input.application_url ?? null,
        toBoolInt(input.sso_required),
        toBoolInt(input.credentials_required),
        credentials_status,
        source,
        confidence,
        input.reason ?? null,
        safeStringifyJson(input.metadata ?? {}),
        input.active === undefined ? 1 : toBoolInt(input.active),
      )

    const row = await db.prepare('SELECT * FROM student_portals WHERE id = ?').get(id)
    return rowToPortal(row)
  })
}

export async function setStudentPortalActive(db, profileId, portalId, active) {
  await ensureStudentPortalsSchema(db)
  const result = await db
    .prepare(
      `UPDATE student_portals
         SET active = ?, updated_at = ${nowSqlLiteral(db)}
       WHERE id = ? AND profile_id = ?`,
    )
    .run(toBoolInt(active), String(portalId), String(profileId))
  return Number(result?.changes ?? result?.rowCount ?? 0) > 0
}

export async function recordPortalCheck(db, profileId, portalId, { status, checkedAt = null } = {}) {
  await ensureStudentPortalsSchema(db)
  const ts = checkedAt
    ? (typeof checkedAt === 'string' ? checkedAt : checkedAt.toISOString())
    : new Date().toISOString()
  await db
    .prepare(
      `UPDATE student_portals
         SET last_checked_at = ?, last_check_status = ?, updated_at = ${nowSqlLiteral(db)}
       WHERE id = ? AND profile_id = ?`,
    )
    .run(ts, status ? String(status) : null, String(portalId), String(profileId))
}

export { rowToPortal as _rowToPortal }
