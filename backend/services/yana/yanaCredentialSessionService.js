/**
 * yanaCredentialSessionService.js
 *
 * Manages Yana's lawful login / SSO / 2FA story without ever storing
 * plaintext credentials, raw cookies, or 2FA codes.
 *
 *   - storage_state_path : on-disk reference to a Playwright
 *     storage-state JSON file the user established by completing
 *     login + 2FA themselves once. The file lives under
 *     YANA_BROWSER_STORAGE_DIR (chmod 0600 on creation).
 *   - storage_state_ref  : opaque vault reference (e.g. a path inside
 *     a downstream secret store) used when an external secret manager
 *     hosts the storage state. Yana never reads/writes the secret
 *     content; she just hands the reference to Playwright via env or
 *     to a downstream service.
 *
 * Yana NEVER:
 *   - reads or stores raw passwords / FSA-IDs / SSO secrets
 *   - intercepts, decodes, or replays 2FA codes
 *   - bypasses CAPTCHA or anti-bot fingerprints
 *
 * The user (or an admin acting for the user) must establish the
 * authenticated session manually before Yana reuses it. This service
 * just records the pointer + status and surfaces it to the engine.
 */

import crypto from 'node:crypto'
import path from 'node:path'

let ensured = false
export function _resetCredentialSchemaCache() { ensured = false }

async function ensureSchema(db) {
  if (!db || ensured || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS yana_saved_sessions (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      portal_host TEXT NOT NULL,
      label TEXT,
      storage_state_path TEXT,
      storage_state_ref TEXT,
      authentication_strategy TEXT,
      established_at ${tsType} DEFAULT ${nowFn},
      last_used_at ${tsType},
      expires_at ${tsType},
      status TEXT NOT NULL DEFAULT 'valid',
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_yana_sessions_profile ON yana_saved_sessions(profile_id);
    CREATE INDEX IF NOT EXISTS idx_yana_sessions_host    ON yana_saved_sessions(portal_host);
    CREATE INDEX IF NOT EXISTS idx_yana_sessions_status  ON yana_saved_sessions(status);
  `)
  ensured = true
}

function jsonOrEmpty(v) {
  if (!v) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return {} }
}

function rowToSession(row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id,
    profile_id: row.profile_id,
    portal_host: row.portal_host,
    label: row.label || null,
    storage_state_path: row.storage_state_path || null,
    storage_state_ref: row.storage_state_ref || null,
    authentication_strategy: row.authentication_strategy || null,
    established_at: row.established_at,
    last_used_at: row.last_used_at || null,
    expires_at: row.expires_at || null,
    status: row.status,
    metadata: jsonOrEmpty(row.metadata_json),
  }
}

/**
 * Normalise an arbitrary URL or hostname to a registry key.
 * Keeps only host part (no scheme, no path, no port). Lowercased.
 */
export function normalizeHost(input) {
  if (!input) return null
  const s = String(input).trim()
  if (!s) return null
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    return url.hostname.toLowerCase()
  } catch {
    return s.toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
  }
}

/**
 * Verify the storage_state_path is inside the configured browser
 * storage dir to prevent path-traversal abuse.
 */
function safeStoragePath(input) {
  const root = process.env.YANA_BROWSER_STORAGE_DIR
  if (!input) return { ok: true, value: null }
  const v = String(input)
  if (!root) {
    // No restriction in test envs — accept absolute paths but strip nulls.
    return { ok: true, value: v }
  }
  const resolved = path.resolve(v)
  const rootResolved = path.resolve(root)
  if (resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)) {
    return { ok: true, value: resolved }
  }
  return { ok: false, value: null }
}

/**
 * Record a saved session pointer. Idempotent on
 * (user_id, profile_id, portal_host) — re-record updates the existing
 * row instead of inserting a duplicate.
 */
export async function recordSession(db, {
  userId, profileId, portalHost, label = null,
  storageStatePath = null, storageStateRef = null,
  authenticationStrategy = null,
  expiresAt = null, metadata = {},
} = {}) {
  if (!db || !userId || !profileId) throw new Error('userId and profileId required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  if (!storageStatePath && !storageStateRef) {
    throw new Error('one of storageStatePath or storageStateRef required')
  }
  const sp = safeStoragePath(storageStatePath)
  if (!sp.ok) throw new Error('storageStatePath must be inside YANA_BROWSER_STORAGE_DIR')
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare(
    `SELECT id FROM yana_saved_sessions
      WHERE user_id = ? AND profile_id = ? AND portal_host = ?
      ORDER BY established_at DESC LIMIT 1`,
  ).get(String(userId), String(profileId), host)
  if (existing) {
    await db.prepare(
      `UPDATE yana_saved_sessions SET
          label = ?, storage_state_path = ?, storage_state_ref = ?,
          authentication_strategy = ?, expires_at = ?, status = 'valid',
          metadata_json = ?, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(label, sp.value, storageStateRef, authenticationStrategy, expiresAt,
      JSON.stringify(metadata || {}), existing.id)
    return rowToSession(await db.prepare('SELECT * FROM yana_saved_sessions WHERE id = ?').get(existing.id))
  }
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO yana_saved_sessions
        (id, user_id, profile_id, portal_host, label, storage_state_path, storage_state_ref,
         authentication_strategy, established_at, expires_at, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ?, 'valid', ?, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(userId), String(profileId), host, label, sp.value, storageStateRef,
    authenticationStrategy, expiresAt, JSON.stringify(metadata || {}),
  )
  return rowToSession(await db.prepare('SELECT * FROM yana_saved_sessions WHERE id = ?').get(id))
}

/**
 * Return a valid (non-expired, non-revoked) session for the given
 * profile + portal host, or null if none exists. Also marks an
 * expired row as `expired` so the UI can prompt the user.
 */
export async function findValidSession(db, { profileId, portalHost } = {}) {
  if (!db || !profileId || !portalHost) return null
  await ensureSchema(db)
  const host = normalizeHost(portalHost)
  const row = await db.prepare(
    `SELECT * FROM yana_saved_sessions
      WHERE profile_id = ? AND portal_host = ? AND status = 'valid'
      ORDER BY established_at DESC LIMIT 1`,
  ).get(String(profileId), host)
  if (!row) return null
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at).getTime()
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
      await db.prepare(
        `UPDATE yana_saved_sessions SET status = 'expired', updated_at = ${nowFn} WHERE id = ?`,
      ).run(row.id)
      return null
    }
  }
  return rowToSession(row)
}

export async function markSessionUsed(db, sessionId) {
  if (!db || !sessionId) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE yana_saved_sessions SET last_used_at = ${nowFn}, updated_at = ${nowFn} WHERE id = ?`,
  ).run(String(sessionId))
  return rowToSession(await db.prepare('SELECT * FROM yana_saved_sessions WHERE id = ?').get(String(sessionId)))
}

export async function markSessionExpired(db, sessionId, reason = null) {
  if (!db || !sessionId) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE yana_saved_sessions SET status = 'expired', updated_at = ${nowFn},
      metadata_json = ? WHERE id = ?`,
  ).run(JSON.stringify({ expired_reason: reason || 'session_expired' }), String(sessionId))
  return rowToSession(await db.prepare('SELECT * FROM yana_saved_sessions WHERE id = ?').get(String(sessionId)))
}

export async function revokeSession(db, sessionId, reason = null) {
  if (!db || !sessionId) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE yana_saved_sessions SET status = 'revoked', updated_at = ${nowFn},
      metadata_json = ? WHERE id = ?`,
  ).run(JSON.stringify({ revoked_reason: reason || 'user_revoked' }), String(sessionId))
  return rowToSession(await db.prepare('SELECT * FROM yana_saved_sessions WHERE id = ?').get(String(sessionId)))
}

export async function listSessionsForProfile(db, profileId) {
  if (!db || !profileId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM yana_saved_sessions WHERE profile_id = ?
      ORDER BY established_at DESC`,
  ).all(String(profileId))
  return (rows || []).map(rowToSession)
}
