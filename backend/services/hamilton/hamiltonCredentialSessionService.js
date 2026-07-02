/**
 * hamiltonCredentialSessionService.js
 *
 * Manages Hamilton's lawful login / SSO / 2FA story without ever storing
 * plaintext credentials, raw cookies, or 2FA codes.
 *
 *   - storage_state_path : on-disk reference to a Playwright
 *     storage-state JSON file the user established by completing
 *     login + 2FA themselves once. The file lives under
 *     HAMILTON_BROWSER_STORAGE_DIR (chmod 0600 on creation).
 *   - storage_state_ref  : opaque vault reference (e.g. a path inside
 *     a downstream secret store) used when an external secret manager
 *     hosts the storage state. Hamilton never reads/writes the secret
 *     content; she just hands the reference to Playwright via env or
 *     to a downstream service.
 *
 * Hamilton NEVER:
 *   - reads or stores raw passwords / FSA-IDs / SSO secrets
 *   - intercepts, decodes, or replays 2FA codes
 *   - bypasses CAPTCHA or anti-bot fingerprints
 *
 * The user (or an admin acting for the user) must establish the
 * authenticated session manually before Hamilton reuses it. This service
 * just records the pointer + status and surfaces it to the engine.
 */

import crypto from 'node:crypto'
import path from 'node:path'
import { encryptRuntimeSecret, decryptRuntimeSecret } from '../../utils/runtimeSecrets.js'

// Per-db schema cache (WeakMap), not a process-global boolean: node:test runs a
// file's top-level suites concurrently, each with its own in-memory db, and a
// shared boolean races (one suite marks ready, a sibling's fresh db then skips
// schema creation). Keying by db keeps each db independent; prod (one db) is
// unchanged. Mirrors agentControlStore.
let schemaReady = new WeakMap()
export function _resetCredentialSchemaCache() { schemaReady = new WeakMap() }

async function ensureSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_saved_sessions (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      portal_host TEXT NOT NULL,
      label TEXT,
      storage_state_path TEXT,
      storage_state_ref TEXT,
      storage_state_encrypted ${jsonType},
      authentication_strategy TEXT,
      established_at ${tsType} DEFAULT ${nowFn},
      last_used_at ${tsType},
      expires_at ${tsType},
      status TEXT NOT NULL DEFAULT 'valid',
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_profile ON hamilton_saved_sessions(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_host    ON hamilton_saved_sessions(portal_host);
    CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_status  ON hamilton_saved_sessions(status);
  `)
  // Idempotently add storage_state_encrypted to pre-existing tables (CREATE
  // TABLE IF NOT EXISTS won't alter a table that already exists in prod). This
  // column holds the durable, AES-256-GCM-encrypted Playwright storageState so
  // an imported session survives Railway's ephemeral-filesystem wipe (a path on
  // disk would not). Stored as ciphertext JSON: { value_ciphertext, iv, tag }.
  try {
    await db.exec(`ALTER TABLE hamilton_saved_sessions ADD COLUMN storage_state_encrypted ${jsonType}`)
  } catch { /* already present — fine */ }
  schemaReady.set(db, true)
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
    // Never expose the ciphertext itself — just signal durable state exists so
    // the engine knows to call getSessionStorageState() and the UI can show
    // "session saved".
    has_storage_state: !!row.storage_state_encrypted,
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
  const root = process.env.HAMILTON_BROWSER_STORAGE_DIR
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
  if (!sp.ok) throw new Error('storageStatePath must be inside HAMILTON_BROWSER_STORAGE_DIR')
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare(
    `SELECT id FROM hamilton_saved_sessions
      WHERE user_id = ? AND profile_id = ? AND portal_host = ?
      ORDER BY established_at DESC LIMIT 1`,
  ).get(String(userId), String(profileId), host)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_saved_sessions SET
          label = ?, storage_state_path = ?, storage_state_ref = ?,
          authentication_strategy = ?, expires_at = ?, status = 'valid',
          metadata_json = ?, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(label, sp.value, storageStateRef, authenticationStrategy, expiresAt,
      JSON.stringify(metadata || {}), existing.id)
    return rowToSession(await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(existing.id))
  }
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_saved_sessions
        (id, user_id, profile_id, portal_host, label, storage_state_path, storage_state_ref,
         authentication_strategy, established_at, expires_at, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ?, 'valid', ?, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(userId), String(profileId), host, label, sp.value, storageStateRef,
    authenticationStrategy, expiresAt, JSON.stringify(metadata || {}),
  )
  return rowToSession(await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(id))
}

function looksLikeStorageState(obj) {
  // Playwright storageState shape: { cookies: [...], origins: [...] }.
  return obj && typeof obj === 'object' &&
    (Array.isArray(obj.cookies) || Array.isArray(obj.origins))
}

/**
 * Import a session the USER established themselves: they completed login + 2FA
 * in their own browser, exported the Playwright storageState (cookies + origin
 * localStorage), and we store it — encrypted at rest with AES-256-GCM — so
 * Hamilton can reuse it to act inside the real portal. This is the durable,
 * ephemeral-filesystem-proof counterpart to recordSession's on-disk path.
 *
 * The storageState is multi-domain (an SSO login spans e.g.
 * login.microsoftonline.com + the school host), so one row keyed on the portal
 * host we drive carries the whole state.
 *
 * Idempotent on (user_id, profile_id, portal_host): re-import refreshes the
 * existing row (expected, since sessions expire and get re-captured).
 */
export async function importSession(db, {
  userId, profileId, portalHost, storageState,
  label = null, authenticationStrategy = null, expiresAt = null, metadata = {},
} = {}) {
  if (!db || !userId || !profileId) throw new Error('userId and profileId required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  if (!looksLikeStorageState(storageState)) {
    throw new Error('storageState must be a Playwright storage state object ({ cookies, origins }).')
  }
  await ensureSchema(db)
  // Encrypt the JSON-serialised storage state; never persist it in the clear.
  const encrypted = JSON.stringify(encryptRuntimeSecret(JSON.stringify(storageState)))
  // Don't keep raw cookie values in metadata — only non-sensitive counts.
  const safeMeta = {
    ...(metadata || {}),
    cookie_count: Array.isArray(storageState.cookies) ? storageState.cookies.length : 0,
    origin_count: Array.isArray(storageState.origins) ? storageState.origins.length : 0,
    imported_via: (metadata && metadata.imported_via) || 'browser_export',
  }
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare(
    `SELECT id FROM hamilton_saved_sessions
      WHERE user_id = ? AND profile_id = ? AND portal_host = ?
      ORDER BY established_at DESC LIMIT 1`,
  ).get(String(userId), String(profileId), host)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_saved_sessions SET
          label = ?, storage_state_encrypted = ?, authentication_strategy = ?,
          expires_at = ?, status = 'valid', established_at = ${nowFn},
          metadata_json = ?, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(label, encrypted, authenticationStrategy, expiresAt, JSON.stringify(safeMeta), existing.id)
    return rowToSession(await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(existing.id))
  }
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_saved_sessions
        (id, user_id, profile_id, portal_host, label, storage_state_encrypted,
         authentication_strategy, established_at, expires_at, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${nowFn}, ?, 'valid', ?, ${nowFn}, ${nowFn})`,
  ).run(id, String(userId), String(profileId), host, label, encrypted,
    authenticationStrategy, expiresAt, JSON.stringify(safeMeta))
  return rowToSession(await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(id))
}

/**
 * Decrypt and return the Playwright storageState OBJECT for a saved session, or
 * null if the row has no encrypted state. Pass the result straight to
 * `browser.newContext({ storageState })`. Marks the session used.
 */
export async function getSessionStorageState(db, sessionId) {
  if (!db || !sessionId) return null
  await ensureSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(String(sessionId))
  if (!row || !row.storage_state_encrypted) return null
  try {
    const enc = typeof row.storage_state_encrypted === 'string'
      ? JSON.parse(row.storage_state_encrypted)
      : row.storage_state_encrypted
    const plaintext = decryptRuntimeSecret(enc)
    const storageState = JSON.parse(plaintext)
    await markSessionUsed(db, sessionId)
    return storageState
  } catch {
    return null
  }
}

/**
 * Return a valid (non-expired, non-revoked) session for the given
 * profile + portal host, or null if none exists. Also marks an
 * expired row as `expired` so the UI can prompt the user.
 *
 * Matching is by REGISTRABLE DOMAIN (eTLD+1), exact host preferred — the same
 * rule the credential vault uses (getDecryptedCredential). A session the user
 * captured on `mtsu.edu` must be found when the run lands on `login.mtsu.edu`
 * (and vice versa); exact-host-only matching silently hid working sessions and
 * hard-stopped runs the vault could satisfy.
 */
export async function findValidSession(db, { profileId, portalHost } = {}) {
  if (!db || !profileId || !portalHost) return null
  await ensureSchema(db)
  const host = normalizeHost(portalHost)
  if (!host) return null
  const rows = await db.prepare(
    `SELECT * FROM hamilton_saved_sessions
      WHERE profile_id = ? AND status = 'valid'
      ORDER BY established_at DESC`,
  ).all(String(profileId))
  if (!rows || rows.length === 0) return null
  // Exact host first, then any session sharing the registrable domain. PSL-based
  // (via registrableDomain) so 'foo.co.uk' never matches 'bar.co.uk'. Lazy import
  // avoids a hard load-order dependency in the credential-service import cycle.
  const { registrableDomain } = await import('./hamiltonPortalCredentialService.js')
  const wantDomain = registrableDomain(host)
  const candidates = [
    ...rows.filter((r) => normalizeHost(r.portal_host) === host),
    ...(wantDomain
      ? rows.filter((r) => normalizeHost(r.portal_host) !== host
          && registrableDomain(normalizeHost(r.portal_host)) === wantDomain)
      : []),
  ]
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  for (const row of candidates) {
    if (row.expires_at) {
      const expiresAt = new Date(row.expires_at).getTime()
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        await db.prepare(
          `UPDATE hamilton_saved_sessions SET status = 'expired', updated_at = ${nowFn} WHERE id = ?`,
        ).run(row.id)
        continue // an expired exact-host session must not mask a valid domain match
      }
    }
    return rowToSession(row)
  }
  return null
}

export async function markSessionUsed(db, sessionId) {
  if (!db || !sessionId) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_saved_sessions SET last_used_at = ${nowFn}, updated_at = ${nowFn} WHERE id = ?`,
  ).run(String(sessionId))
  return rowToSession(await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(String(sessionId)))
}

export async function markSessionExpired(db, sessionId, reason = null) {
  if (!db || !sessionId) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_saved_sessions SET status = 'expired', updated_at = ${nowFn},
      metadata_json = ? WHERE id = ?`,
  ).run(JSON.stringify({ expired_reason: reason || 'session_expired' }), String(sessionId))
  return rowToSession(await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(String(sessionId)))
}

export async function revokeSession(db, sessionId, reason = null) {
  if (!db || !sessionId) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_saved_sessions SET status = 'revoked', updated_at = ${nowFn},
      metadata_json = ? WHERE id = ?`,
  ).run(JSON.stringify({ revoked_reason: reason || 'user_revoked' }), String(sessionId))
  return rowToSession(await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(String(sessionId)))
}

// Fetch a single saved session by id (includes profile_id so route handlers
// can enforce profile-scoped ownership before revoking/expiring). Null when
// not found.
export async function getSessionById(db, id) {
  if (!db || !id) return null
  await ensureSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_saved_sessions WHERE id = ?').get(String(id))
  return row ? rowToSession(row) : null
}

export async function listSessionsForProfile(db, profileId) {
  if (!db || !profileId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_saved_sessions WHERE profile_id = ?
      ORDER BY established_at DESC`,
  ).all(String(profileId))
  return (rows || []).map(rowToSession)
}
