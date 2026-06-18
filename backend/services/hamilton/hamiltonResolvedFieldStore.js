/**
 * hamiltonResolvedFieldStore.js
 *
 * "Resolve once, reuse forever." When Hamilton asks the user for a
 * missing or ambiguous field, the answer is saved here and reused
 * whenever the same key shows up on a different portal.
 *
 * Field keys are normalised lowercase tokens — `first_name`,
 * `fafsa_efc`, `expected_graduation`. The orchestrator and the
 * field mapper agree on the same keyset, so a value resolved once
 * is automatically picked up on the next portal.
 */

import crypto from 'node:crypto'

// Per-db schema cache (WeakMap), not a process-global boolean: node:test runs a
// file's top-level suites concurrently, each with its own in-memory db, and a
// shared boolean races (one suite marks ready, a sibling's fresh db then skips
// schema creation). Keying by db keeps each db independent; prod (one db) is
// unchanged. Mirrors agentControlStore.
let schemaReady = new WeakMap()
export function _resetResolvedFieldSchemaCache() { schemaReady = new WeakMap() }

async function ensureSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_resolved_fields (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      profile_id TEXT NOT NULL,
      user_id TEXT,
      field_key TEXT NOT NULL,
      field_value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      source TEXT,
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      resolved_at ${tsType} DEFAULT ${nowFn},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_resolved_profile ON hamilton_resolved_fields(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_resolved_key     ON hamilton_resolved_fields(profile_id, field_key);
  `)
  schemaReady.set(db, true)
}

function normaliseKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
}

function rowToField(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    user_id: row.user_id || null,
    field_key: row.field_key,
    field_value: row.field_value,
    confidence: Number(row.confidence || 1.0),
    source: row.source || null,
    resolved_at: row.resolved_at,
  }
}

/**
 * Save a resolved field. Idempotent on (profile_id, field_key) —
 * re-saving updates the existing row.
 */
export async function saveResolvedField(db, {
  profileId, userId = null, fieldKey, fieldValue,
  confidence = 1.0, source = 'user', metadata = {},
} = {}) {
  if (!db || !profileId || !fieldKey) throw new Error('profileId and fieldKey required')
  if (fieldValue === null || fieldValue === undefined || String(fieldValue).trim() === '') {
    throw new Error('fieldValue required (Hamilton never stores empty values)')
  }
  await ensureSchema(db)
  const key = normaliseKey(fieldKey)
  if (!key) throw new Error('fieldKey is empty after normalisation')
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare(
    `SELECT id FROM hamilton_resolved_fields WHERE profile_id = ? AND field_key = ? LIMIT 1`,
  ).get(String(profileId), key)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_resolved_fields SET field_value = ?, confidence = ?, source = ?,
          metadata_json = ?, resolved_at = ${nowFn}, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(String(fieldValue), Number(confidence), source, JSON.stringify(metadata || {}), existing.id)
    return rowToField(await db.prepare('SELECT * FROM hamilton_resolved_fields WHERE id = ?').get(existing.id))
  }
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_resolved_fields
        (id, profile_id, user_id, field_key, field_value, confidence, source, metadata_json, resolved_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(profileId), userId, key, String(fieldValue),
    Number(confidence), source, JSON.stringify(metadata || {}),
  )
  return rowToField(await db.prepare('SELECT * FROM hamilton_resolved_fields WHERE id = ?').get(id))
}

export async function getResolvedField(db, { profileId, fieldKey } = {}) {
  if (!db || !profileId || !fieldKey) return null
  await ensureSchema(db)
  const key = normaliseKey(fieldKey)
  const row = await db.prepare(
    `SELECT * FROM hamilton_resolved_fields WHERE profile_id = ? AND field_key = ? LIMIT 1`,
  ).get(String(profileId), key)
  return rowToField(row)
}

export async function getResolvedFieldsAsMap(db, profileId) {
  if (!db || !profileId) return {}
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_resolved_fields WHERE profile_id = ?`,
  ).all(String(profileId))
  const out = {}
  for (const r of rows || []) out[r.field_key] = r.field_value
  return out
}

export async function listResolvedFields(db, profileId) {
  if (!db || !profileId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_resolved_fields WHERE profile_id = ? ORDER BY field_key`,
  ).all(String(profileId))
  return (rows || []).map(rowToField)
}
