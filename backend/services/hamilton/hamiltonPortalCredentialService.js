/**
 * hamiltonPortalCredentialService.js
 *
 * Per-profile saved portal LOGINS that Hamilton can pick up and use to
 * authenticate on a portal (e.g. an MTSU student login, a scholarship
 * portal account). Unlike hamiltonCredentialSessionService (which stores
 * only Playwright storage-state references), this DOES store the actual
 * username + password — because the user explicitly asked to save logins
 * Hamilton can use.
 *
 * SECURITY:
 *   - The password is encrypted at rest with AES-256-GCM via
 *     backend/utils/runtimeSecrets.js (key derived from RUNTIME_SECRETS_KEY
 *     or AUTH_JWT_SECRET). Plaintext is NEVER stored.
 *   - The plaintext password is NEVER returned to any client — list/read
 *     endpoints return a masked view. Only the server-side engine path
 *     (getDecryptedCredential) ever decrypts, and only to type it into the
 *     portal's own login form.
 *   - Every row is profile-scoped; route handlers enforce ownership.
 *   - The username is treated as non-secret (shown masked-ish in the UI so
 *     the user can tell which account it is).
 */

import crypto from 'node:crypto'
import psl from 'psl'
import { encryptRuntimeSecret, decryptRuntimeSecret } from '../../utils/runtimeSecrets.js'
import { normalizeHost } from './hamiltonCredentialSessionService.js'

/**
 * Registrable domain (eTLD+1) via the Public Suffix List. Returns null for
 * public suffixes ('co.uk', 'edu') and invalid hosts. Using PSL — instead of a
 * naive last-two-labels split — is what prevents a credential from being scoped
 * to an entire public suffix (e.g. every '*.co.uk' matching each other) or
 * leaked across unrelated registrable domains.
 */
export function registrableDomain(input) {
  const h = normalizeHost(input)
  if (!h) return null
  try { return psl.get(h) || null } catch { return null }
}

let ensured = false
export function _resetCredentialSchemaCache() { ensured = false }

async function ensureSchema(db) {
  if (!db || ensured || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_portal_credentials (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      portal_host TEXT NOT NULL,
      label TEXT,
      login_url TEXT,
      username TEXT,
      password_ciphertext TEXT,
      password_iv TEXT,
      password_tag TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_used_at ${tsType},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_hamilton_portal_cred_profile_host
      ON hamilton_portal_credentials(profile_id, portal_host);
    CREATE INDEX IF NOT EXISTS idx_hamilton_portal_cred_profile
      ON hamilton_portal_credentials(profile_id);
  `)
  ensured = true
}

// Show only the first character + length so the user can recognise the account
// without exposing it. Never returns the real username verbatim to the client.
function maskUsername(u) {
  const s = String(u || '')
  if (!s) return null
  if (s.includes('@')) {
    const [name, domain] = s.split('@')
    return `${name.slice(0, 1)}***@${domain}`
  }
  return `${s.slice(0, 1)}***${s.length > 4 ? s.slice(-1) : ''}`
}

function rowToMasked(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    portal_host: row.portal_host,
    label: row.label || null,
    login_url: row.login_url || null,
    username_masked: maskUsername(row.username),
    has_password: Boolean(row.password_ciphertext),
    status: row.status,
    last_used_at: row.last_used_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Create or update a saved login for (profile, portal host). Idempotent on
 * (profile_id, portal_host) — re-saving updates the row. Encrypts the password.
 */
export async function saveCredential(db, {
  userId, profileId, portalHost, username, password,
  label = null, loginUrl = null,
} = {}) {
  if (!db || !userId || !profileId) throw new Error('userId and profileId required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  // Must resolve to a real registrable domain — rejects single labels ('edu')
  // and public suffixes ('co.uk') that would over-scope the credential.
  if (!registrableDomain(host)) throw new Error('portalHost must be a full domain (e.g. mtsu.edu)')
  if (!username || !String(username).trim()) throw new Error('username required')
  if (!password || !String(password).trim()) throw new Error('password required')
  await ensureSchema(db)

  const enc = encryptRuntimeSecret(String(password))
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare(
    `SELECT id FROM hamilton_portal_credentials WHERE profile_id = ? AND portal_host = ? LIMIT 1`,
  ).get(String(profileId), host)

  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_credentials SET
         user_id = ?, label = ?, login_url = ?, username = ?,
         password_ciphertext = ?, password_iv = ?, password_tag = ?,
         status = 'active', updated_at = ${nowFn}
       WHERE id = ?`,
    ).run(String(userId), label, loginUrl, String(username),
      enc.value_ciphertext, enc.iv, enc.tag, existing.id)
    return rowToMasked(await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get(existing.id))
  }

  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_portal_credentials
       (id, user_id, profile_id, portal_host, label, login_url, username,
        password_ciphertext, password_iv, password_tag, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ${nowFn}, ${nowFn})`,
  ).run(id, String(userId), String(profileId), host, label, loginUrl, String(username),
    enc.value_ciphertext, enc.iv, enc.tag)
  return rowToMasked(await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get(id))
}

export async function listCredentialsForProfile(db, profileId) {
  if (!db || !profileId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_portal_credentials WHERE profile_id = ? ORDER BY created_at DESC`,
  ).all(String(profileId))
  return (rows || []).map(rowToMasked)
}

// Includes profile_id so route handlers can enforce ownership before delete.
export async function getCredentialById(db, id) {
  if (!db || !id) return null
  await ensureSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get(String(id))
  return rowToMasked(row)
}

export async function deleteCredential(db, id) {
  if (!db || !id) return false
  await ensureSchema(db)
  const res = await db.prepare('DELETE FROM hamilton_portal_credentials WHERE id = ?').run(String(id))
  return (res?.changes ?? res?.rowCount ?? 0) > 0
}

/**
 * SERVER-SIDE ONLY. Returns the decrypted login for a profile + portal host so
 * the autopilot engine can type it into the portal's own login form. Returns
 * null when none exists. NEVER expose the result to a client.
 */
export async function getDecryptedCredential(db, { profileId, portalHost } = {}) {
  if (!db || !profileId || !portalHost) return null
  await ensureSchema(db)
  const host = normalizeHost(portalHost)
  if (!host) return null
  // Match the exact host or a parent registrable host (e.g. login.mtsu.edu
  // should pick up an mtsu.edu credential).
  const rows = await db.prepare(
    `SELECT * FROM hamilton_portal_credentials
       WHERE profile_id = ? AND status = 'active' ORDER BY length(portal_host) DESC`,
  ).all(String(profileId))
  // Match ONLY when the visited host and the saved host share the same
  // registrable domain (eTLD+1) computed via the Public Suffix List. So a login
  // saved for any mtsu.edu host works across mtsu.edu portals, but never leaks
  // across unrelated domains or public suffixes ('foo.co.uk' ≠ 'bar.co.uk').
  const wantDomain = registrableDomain(host)
  if (!wantDomain) return null
  const match = (rows || []).find((r) => registrableDomain(r.portal_host) === wantDomain)
  if (!match || !match.password_ciphertext) return null
  let password = null
  try {
    password = decryptRuntimeSecret({
      value_ciphertext: match.password_ciphertext,
      iv: match.password_iv,
      tag: match.password_tag,
    })
  } catch {
    return null
  }
  return {
    id: match.id,
    portal_host: match.portal_host,
    login_url: match.login_url || null,
    username: match.username || null,
    password,
  }
}

export async function markCredentialUsed(db, id) {
  if (!db || !id) return
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  try {
    await db.prepare(`UPDATE hamilton_portal_credentials SET last_used_at = ${nowFn}, updated_at = ${nowFn} WHERE id = ?`).run(String(id))
  } catch { /* best-effort */ }
}
