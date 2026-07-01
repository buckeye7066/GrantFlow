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
import {
  ensureUnlocked,
  wrapSecretWithKey,
  unwrapSecretWithKey,
} from './hamiltonPortalMasterVault.js'

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
      totp_secret_ciphertext TEXT,
      totp_secret_iv TEXT,
      totp_secret_tag TEXT,
      -- Portal Autopilot Identity (password-manager layer): when Hamilton
      -- auto-provisions a login under the master passphrase, the password is
      -- additionally wrapped with the scrypt-derived master key BEFORE the
      -- server-vault layer. has_master_wrap=1 marks such rows; the wrapped_*
      -- columns hold the doubly-encrypted secret. password_ciphertext stays the
      -- server-vault-only copy (NULL for master-wrapped rows so a leaked vault key
      -- alone never recovers the password).
      has_master_wrap ${isPostgres ? 'BOOLEAN' : 'INTEGER'} NOT NULL DEFAULT ${isPostgres ? 'FALSE' : '0'},
      wrapped_ciphertext TEXT,
      wrapped_iv TEXT,
      wrapped_tag TEXT,
      -- An auto-provisioned login's password is written BEFORE the headless signup
      -- completes. pending_registration=1 marks a row whose account was NOT yet
      -- confirmed-registered on the portal (the signup was handed off to a
      -- side-by-side login). It is cleared once registration completes. The
      -- dashboard + a merge re-run must NOT report such a row as a working login
      -- ("merged only when truly merged").
      pending_registration ${isPostgres ? 'BOOLEAN' : 'INTEGER'} NOT NULL DEFAULT ${isPostgres ? 'FALSE' : '0'},
      -- Email-verification lifecycle for an auto-provisioned account. When the
      -- portal created the account but still needs the email verified,
      -- verification_status='pending' and Hamilton re-checks (polling John's
      -- mailbox to auto-click the link, or on the backoff cadence) until the
      -- user clicks the link. Cleared to NULL once the account is verified /
      -- registered. verification_attempts + verification_next_retry_at drive the
      -- exponential backoff, and exhaustion falls back to a side-by-side login.
      verification_status TEXT,
      verification_attempts INTEGER NOT NULL DEFAULT 0,
      verification_next_retry_at ${tsType},
      status TEXT NOT NULL DEFAULT 'active',
      last_used_at ${tsType},
      generated_by TEXT,
      generation_reason TEXT,
      generated_at ${tsType},
      password_revealed_once_at ${tsType},
      managed_by TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    -- Uniqueness on (profile, host, username) so multiple logins per site are
    -- kept. The legacy (profile, host) index collapsed multi-account sites.
    DROP INDEX IF EXISTS ux_hamilton_portal_cred_profile_host;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_hamilton_portal_cred_profile_host_user
      ON hamilton_portal_credentials(profile_id, portal_host, username);
    CREATE INDEX IF NOT EXISTS idx_hamilton_portal_cred_profile
      ON hamilton_portal_credentials(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_portal_cred_managed_by
      ON hamilton_portal_credentials(managed_by);
  `)
  // Self-heal older deployments where the table existed before these columns
  // were introduced. ALTER TABLE ADD COLUMN is portable; we probe the table
  // first so we don't issue redundant ALTERs (and don't rely on the
  // dialect-dependent "IF NOT EXISTS" form).
  try {
    const cols = await db.prepare(`SELECT name FROM pragma_table_info('hamilton_portal_credentials')`).all()
    const have = new Set((cols || []).map((c) => String(c?.name || '')))
    const wanted = [
      ['generated_by', 'TEXT'],
      ['generation_reason', 'TEXT'],
      ['generated_at', tsType],
      ['password_revealed_once_at', tsType],
      ['managed_by', 'TEXT'],
      ['totp_secret_ciphertext', 'TEXT'],
      ['totp_secret_iv', 'TEXT'],
      ['totp_secret_tag', 'TEXT'],
      ['has_master_wrap', 'INTEGER'],
      ['wrapped_ciphertext', 'TEXT'],
      ['wrapped_iv', 'TEXT'],
      ['wrapped_tag', 'TEXT'],
      ['pending_registration', 'INTEGER'],
      ['verification_status', 'TEXT'],
      ['verification_attempts', 'INTEGER'],
      ['verification_next_retry_at', tsType],
    ]
    for (const [name, type] of wanted) {
      if (have.has(name)) continue
      try { await db.exec(`ALTER TABLE hamilton_portal_credentials ADD COLUMN ${name} ${type};`) }
      catch { /* benign on dialects that don't expose pragma_table_info — fresh CREATE above already has the columns */ }
    }
  } catch { /* pragma_table_info unavailable on Postgres — that path uses ADD COLUMN below */ }
  if (isPostgres) {
    for (const col of [
      'generated_by TEXT',
      'generation_reason TEXT',
      `generated_at ${tsType}`,
      `password_revealed_once_at ${tsType}`,
      'managed_by TEXT',
      'totp_secret_ciphertext TEXT',
      'totp_secret_iv TEXT',
      'totp_secret_tag TEXT',
      'has_master_wrap BOOLEAN NOT NULL DEFAULT FALSE',
      'wrapped_ciphertext TEXT',
      'wrapped_iv TEXT',
      'wrapped_tag TEXT',
      'pending_registration BOOLEAN NOT NULL DEFAULT FALSE',
      'verification_status TEXT',
      'verification_attempts INTEGER NOT NULL DEFAULT 0',
      `verification_next_retry_at ${tsType}`,
    ]) {
      try { await db.exec(`ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS ${col};`) }
      catch { /* benign */ }
    }
  }
  schemaReady.set(db, true)
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
    has_password: Boolean(row.password_ciphertext || row.wrapped_ciphertext),
    // MFA automation is disabled by policy. Legacy rows may still carry old
    // ciphertext columns, but Hamilton must never advertise or use them.
    has_totp: false,
    // Whether this login was auto-provisioned under the profile's master
    // passphrase (its password is wrapped with the master key, not just the
    // server vault). The wrapped secret itself is NEVER returned.
    has_master_wrap: Boolean(row.has_master_wrap),
    // True while an auto-provisioned login's account has not yet been
    // confirmed-registered on the portal (signup handed off to side-by-side).
    // Surfaced so the dashboard renders "provisioned — finish sign-in" rather
    // than a green "ready" tile.
    pending_registration: Boolean(row.pending_registration),
    status: row.status,
    last_used_at: row.last_used_at || null,
    // Hamilton-generated logins (he created the account on the user's behalf
    // because no saved login existed). The frontend uses these to render a
    // "Generated by Hamilton" badge and to gate the one-time password reveal
    // on the row.
    generated_by: row.generated_by || null,
    generation_reason: row.generation_reason || null,
    generated_at: row.generated_at || null,
    password_revealed_once_at: row.password_revealed_once_at || null,
    // Provenance: 'admin' | 'user' | 'hamilton'. Admin management surfaces show
    // only managed_by='admin' rows so an admin never sees a profile user's own
    // self-entered logins. Defaults to 'user' for legacy rows.
    managed_by: row.managed_by || 'user',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Cryptographically random portal password. Mixes upper, lower, digit, and
 * a small symbol set portals reliably accept. Default 28 chars — high
 * entropy and short enough to retype if a portal blocks paste.
 */
export function generateStrongPassword(length = 28) {
  const len = Math.max(16, Math.min(64, Number(length) || 28))
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const digit = '23456789'
  const symbol = '!@#$%^&*-_=+'
  const all = upper + lower + digit + symbol
  // Guarantee one of each class so portals with policy filters accept it.
  const required = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digit[crypto.randomInt(digit.length)],
    symbol[crypto.randomInt(symbol.length)],
  ]
  const rest = []
  for (let i = required.length; i < len; i += 1) rest.push(all[crypto.randomInt(all.length)])
  // Fisher-Yates shuffle so the four required chars don't sit at the start.
  const out = required.concat(rest)
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out.join('')
}

/**
 * Create or update a saved login for (profile, portal host). Idempotent on
 * (profile_id, portal_host) — re-saving updates the row. Encrypts the password.
 */
export async function saveCredential(db, {
  userId, profileId, portalHost, username, password,
  label = null, loginUrl = null, managedBy = 'user', totpSecret = null,
} = {}) {
  if (!db || !userId || !profileId) throw new Error('userId and profileId required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  // Must resolve to a real registrable domain — rejects single labels ('edu')
  // and public suffixes ('co.uk') that would over-scope the credential.
  if (!registrableDomain(host)) throw new Error('portalHost must be a full domain (e.g. mtsu.edu)')
  if (!username || !String(username).trim()) throw new Error('username required')
  if (!password || !String(password).trim()) throw new Error('password required')
  const provenance = ['admin', 'user', 'hamilton'].includes(managedBy) ? managedBy : 'user'
  await ensureSchema(db)

  const totp = totpSecret && String(totpSecret).trim() ? String(totpSecret).trim() : null
  if (totp) {
    throw new Error('TOTP seed storage is disabled by Hamilton policy. Ask the user to clear 2FA and save a trusted browser session instead.')
  }

  const enc = encryptRuntimeSecret(String(password))
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  // Idempotent on (profile, host, username) — multiple logins per host coexist,
  // but re-saving the SAME login updates it in place rather than duplicating.
  const existing = await db.prepare(
    `SELECT id FROM hamilton_portal_credentials WHERE profile_id = ? AND portal_host = ? AND username = ? LIMIT 1`,
  ).get(String(profileId), host, String(username))

  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_credentials SET
         user_id = ?, label = ?, login_url = ?, username = ?,
         password_ciphertext = ?, password_iv = ?, password_tag = ?,
         totp_secret_ciphertext = NULL, totp_secret_iv = NULL, totp_secret_tag = NULL,
         managed_by = ?, status = 'active', updated_at = ${nowFn}
       WHERE id = ?`,
    ).run(String(userId), label, loginUrl, String(username),
      enc.value_ciphertext, enc.iv, enc.tag, provenance, existing.id)
    return rowToMasked(await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get(existing.id))
  }

  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_portal_credentials
       (id, user_id, profile_id, portal_host, label, login_url, username,
        password_ciphertext, password_iv, password_tag,
        totp_secret_ciphertext, totp_secret_iv, totp_secret_tag,
        managed_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ${nowFn}, ${nowFn})`,
  ).run(id, String(userId), String(profileId), host, label, loginUrl, String(username),
    enc.value_ciphertext, enc.iv, enc.tag,
    null, null, null, provenance)
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
 * Drop every MASTER-WRAPPED (auto-provisioned) credential for a profile.
 *
 * The wrapped_* secret is encrypted with the profile's scrypt-derived master
 * key. When the master passphrase is RESET (a new salt+verifier, no re-wrap),
 * those secrets become permanently unreadable — and saveAutoProvisionedCredential
 * short-circuits on `already_existed`, so they would never regenerate either.
 * Purging them lets autopilot recreate fresh logins under the new passphrase.
 *
 * Only has_master_wrap rows are removed; user-entered / server-vault-only
 * credentials (has_master_wrap falsy) do NOT depend on the passphrase and are
 * left untouched. The `has_master_wrap` predicate is dialect-agnostic: nonzero
 * INTEGER (sqlite) and TRUE (postgres) both satisfy a bare truthiness check.
 */
export async function purgeMasterWrappedCredentials(db, profileId) {
  if (!db || !profileId) return { deleted: 0 }
  await ensureSchema(db)
  const res = await db
    .prepare('DELETE FROM hamilton_portal_credentials WHERE profile_id = ? AND has_master_wrap')
    .run(String(profileId))
  return { deleted: res?.changes ?? res?.rowCount ?? 0 }
}

// --- Admin vault management ----------------------------------------------
// These power the admin's ability to move logins in/out of profiles. They all
// operate ONLY on managed_by='admin' rows: an admin can never list, move, copy,
// or delete a credential a profile user entered themselves (managed_by='user')
// or that Hamilton generated (managed_by='hamilton').

/**
 * List credentials the admin manages (managed_by='admin'), optionally scoped to
 * one profile. Returns masked rows enriched with the owning profile's display
 * name so the admin panel can group "what I placed where". Never decrypts.
 */
export async function listManagedCredentials(db, { managedBy = 'admin', profileId = null } = {}) {
  if (!db) return []
  await ensureSchema(db)
  const params = [managedBy]
  let where = 'c.managed_by = ?'
  if (profileId) { where += ' AND c.profile_id = ?'; params.push(String(profileId)) }
  let rows
  try {
    rows = await db.prepare(
      `SELECT c.*, p.display_name AS profile_display_name
         FROM hamilton_portal_credentials c
         LEFT JOIN profiles p ON p.id = c.profile_id
        WHERE ${where}
        ORDER BY c.portal_host ASC, c.created_at DESC`,
    ).all(...params)
  } catch {
    // profiles join unavailable (e.g. isolated test db) — fall back to flat list.
    rows = await db.prepare(
      `SELECT c.* FROM hamilton_portal_credentials c WHERE ${where} ORDER BY c.portal_host ASC, c.created_at DESC`,
    ).all(...params)
  }
  return (rows || []).map((r) => ({ ...rowToMasked(r), profile_display_name: r.profile_display_name || null }))
}

// Internal: fetch the raw row (incl. ciphertext + provenance). Not exported to
// clients — used only to copy/move within the server.
async function getRawCredential(db, id) {
  return db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get(String(id))
}

/**
 * Move an admin-managed credential from its current profile into another. This
 * is the "take a login OUT of one profile and put it IN another" operation.
 * Refuses non-admin-managed rows. If the destination already has the same
 * (host, username), the moved row is merged into it (source deleted).
 *
 * @returns {Promise<{moved:boolean, reason?:string, credential?:object}>}
 */
export async function moveManagedCredential(db, { id, toProfileId } = {}) {
  if (!db || !id || !toProfileId) return { moved: false, reason: 'id_and_toProfileId_required' }
  await ensureSchema(db)
  const row = await getRawCredential(db, id)
  if (!row) return { moved: false, reason: 'not_found' }
  if ((row.managed_by || 'user') !== 'admin') return { moved: false, reason: 'not_admin_managed' }
  const dest = String(toProfileId)
  if (dest === String(row.profile_id)) {
    return { moved: false, reason: 'already_in_profile', credential: rowToMasked(row) }
  }
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const clash = await db.prepare(
    `SELECT id FROM hamilton_portal_credentials WHERE profile_id = ? AND portal_host = ? AND username = ? LIMIT 1`,
  ).get(dest, row.portal_host, row.username)
  if (clash) {
    // Destination already has this exact login — drop the source, keep the dest.
    await db.prepare('DELETE FROM hamilton_portal_credentials WHERE id = ?').run(String(id))
    return { moved: true, reason: 'merged_into_existing', credential: rowToMasked(await getRawCredential(db, clash.id)) }
  }
  await db.prepare(
    `UPDATE hamilton_portal_credentials SET profile_id = ?, updated_at = ${nowFn} WHERE id = ?`,
  ).run(dest, String(id))
  return { moved: true, credential: rowToMasked(await getRawCredential(db, id)) }
}

/**
 * Copy an admin-managed credential INTO another profile while leaving the
 * original in place (e.g. keep it in the admin vault AND grant it to a
 * profile). The password ciphertext is copied verbatim — encryption is keyed
 * globally, not per profile — so no decrypt happens. Idempotent on
 * (toProfile, host, username).
 *
 * @returns {Promise<{copied:boolean, reason?:string, credential?:object}>}
 */
export async function copyManagedCredentialToProfile(db, { id, toProfileId, actorUserId = 'system_admin_token' } = {}) {
  if (!db || !id || !toProfileId) return { copied: false, reason: 'id_and_toProfileId_required' }
  await ensureSchema(db)
  const row = await getRawCredential(db, id)
  if (!row) return { copied: false, reason: 'not_found' }
  if ((row.managed_by || 'user') !== 'admin') return { copied: false, reason: 'not_admin_managed' }
  const dest = String(toProfileId)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare(
    `SELECT id FROM hamilton_portal_credentials WHERE profile_id = ? AND portal_host = ? AND username = ? LIMIT 1`,
  ).get(dest, row.portal_host, row.username)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_credentials SET
         label = ?, login_url = ?, password_ciphertext = ?, password_iv = ?, password_tag = ?,
         managed_by = 'admin', status = 'active', updated_at = ${nowFn}
       WHERE id = ?`,
    ).run(row.label, row.login_url, row.password_ciphertext, row.password_iv, row.password_tag, existing.id)
    return { copied: true, reason: 'updated_existing', credential: rowToMasked(await getRawCredential(db, existing.id)) }
  }
  const newId = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_portal_credentials
       (id, user_id, profile_id, portal_host, label, login_url, username,
        password_ciphertext, password_iv, password_tag, managed_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', 'active', ${nowFn}, ${nowFn})`,
  ).run(newId, String(actorUserId), dest, row.portal_host, row.label, row.login_url, row.username,
    row.password_ciphertext, row.password_iv, row.password_tag)
  return { copied: true, credential: rowToMasked(await getRawCredential(db, newId)) }
}

/**
 * Delete a credential ONLY if it is admin-managed. Guards the admin remove
 * action so it can never delete a profile user's own login.
 * @returns {Promise<{deleted:boolean, reason?:string}>}
 */
export async function deleteManagedCredential(db, id) {
  if (!db || !id) return { deleted: false, reason: 'id_required' }
  await ensureSchema(db)
  const row = await getRawCredential(db, id)
  if (!row) return { deleted: false, reason: 'not_found' }
  if ((row.managed_by || 'user') !== 'admin') return { deleted: false, reason: 'not_admin_managed' }
  const res = await db.prepare('DELETE FROM hamilton_portal_credentials WHERE id = ?').run(String(id))
  return { deleted: (res?.changes ?? res?.rowCount ?? 0) > 0 }
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
  if (!match) return null
  if (!match.password_ciphertext && !match.wrapped_ciphertext) return null
  let password = null
  if (match.has_master_wrap && match.wrapped_ciphertext) {
    // Auto-provisioned login: the password is wrapped with the profile's master
    // key. We can only recover it when the vault is UNLOCKED (the key is held in
    // the runtime cache). When locked we return a sentinel so the caller surfaces
    // a clear "unlock vault" status instead of decrypting silently. When the
    // owner enabled autonomous unlock, ensureUnlocked transparently unlocks from
    // the escrowed key so scheduled/background logins work without a human.
    const key = await ensureUnlocked(db, String(profileId))
    if (!key) {
      return { id: match.id, portal_host: match.portal_host, login_url: match.login_url || null, username: match.username || null, password: null, totp_secret: null, vault_locked: true }
    }
    try {
      password = unwrapSecretWithKey({
        wrapped_ciphertext: match.wrapped_ciphertext,
        wrapped_iv: match.wrapped_iv,
        wrapped_tag: match.wrapped_tag,
      }, key)
    } catch {
      return { id: match.id, portal_host: match.portal_host, login_url: match.login_url || null, username: match.username || null, password: null, totp_secret: null, vault_locked: true }
    }
  } else {
    try {
      password = decryptRuntimeSecret({
        value_ciphertext: match.password_ciphertext,
        iv: match.password_iv,
        tag: match.password_tag,
      })
    } catch {
      return null
    }
  }
  return {
    id: match.id,
    portal_host: match.portal_host,
    login_url: match.login_url || null,
    username: match.username || null,
    password,
    totp_secret: null,
    // Provisioned-but-not-yet-registered: the engine uses this to avoid claiming
    // a working account when only the vault password exists.
    pending_registration: Boolean(match.pending_registration),
    // Email-verification lifecycle (see markCredentialAwaitingVerification). The
    // autopilot brain uses these to re-check + backoff rather than jumping to a
    // side-by-side handoff on the first verify-email wall.
    verification_status: match.verification_status || null,
    verification_attempts: Number(match.verification_attempts) || 0,
    verification_next_retry_at: match.verification_next_retry_at || null,
  }
}

/**
 * The shared "admin vault" profile that holds owner-imported logins (e.g. the
 * Chrome password export). Configured via HAMILTON_ADMIN_VAULT_PROFILE_ID so a
 * profile without its own saved login can still authenticate to a portal the
 * owner has a credential for. Empty → no fallback.
 */
export function adminVaultProfileId() {
  const v = String(process.env.HAMILTON_ADMIN_VAULT_PROFILE_ID || '').trim()
  return v || null
}

/**
 * Like getDecryptedCredential, but if the profile has no saved login for the
 * host it falls back to the shared admin vault. This is what lets Hamilton log
 * in to any portal the OWNER has provisioned a credential for — using the
 * profile's own login when present, otherwise the admin vault — instead of
 * hard-stopping at the login gate. `source` tells the caller which vault matched.
 */
export async function getDecryptedCredentialWithFallback(db, { profileId, portalHost } = {}) {
  const own = await getDecryptedCredential(db, { profileId, portalHost })
  if (own) return { ...own, source: 'profile' }
  const adminId = adminVaultProfileId()
  if (adminId && String(adminId) !== String(profileId)) {
    // SAFEGUARD (multi-tenant portal): only reuse the shared owner vault when
    // THIS profile is the only real user of the portal. If any OTHER profile
    // already has its own credential or captured session for the same
    // registrable domain, the portal is shared by multiple users (e.g. two
    // MTSU students) and silently applying the owner's login to this profile
    // would risk acting in the wrong account. In that case we refuse the
    // fallback and force a per-profile login/session instead.
    const sharedHost = await hostHasOtherProfileIdentity(db, { profileId, portalHost, excludeProfileId: adminId })
    if (sharedHost) {
      console.warn('[credentialVault] admin-vault fallback suppressed — shared portal host', String(profileId), portalHost)
      return null
    }
    const shared = await getDecryptedCredential(db, { profileId: adminId, portalHost })
    if (shared) return { ...shared, source: 'admin_vault' }
  }
  return null
}

/**
 * Does any profile OTHER than `profileId` (and `excludeProfileId`, the admin
 * vault) hold an active credential or a valid saved session for the same
 * registrable domain as `portalHost`? Used to detect a portal that's shared by
 * multiple distinct users so we never cross-apply one user's owner-vault login.
 * Best-effort: any query failure returns false (don't block the normal path).
 */
async function hostHasOtherProfileIdentity(db, { profileId, portalHost, excludeProfileId = null } = {}) {
  try {
    await ensureSchema(db)
    const wantDomain = registrableDomain(normalizeHost(portalHost))
    if (!wantDomain) return false
    const exclude = new Set([String(profileId), excludeProfileId ? String(excludeProfileId) : null].filter(Boolean))

    const matchesOther = (rows) => {
      for (const r of rows || []) {
        const pid = (r?.profile_id !== null && r?.profile_id !== undefined) ? String(r.profile_id) : null
        if (!pid || exclude.has(pid)) continue
        if (registrableDomain(normalizeHost(r.portal_host)) === wantDomain) return true
      }
      return false
    }

    const credRows = await db
      .prepare(`SELECT DISTINCT profile_id, portal_host FROM hamilton_portal_credentials WHERE status = 'active'`)
      .all()
    if (matchesOther(credRows)) return true

    let sessRows = []
    try {
      sessRows = await db
        .prepare(`SELECT DISTINCT profile_id, portal_host FROM hamilton_saved_sessions WHERE status = 'valid'`)
        .all()
    } catch {
      sessRows = [] // sessions table may not exist on older deploys — non-fatal
    }
    if (matchesOther(sessRows)) return true

    return false
  } catch {
    return false
  }
}

/**
 * The set of registrable domains (eTLD+1) we hold an ACTIVE login for — the
 * profile's own vault plus the shared admin vault. The browser-automation guard
 * uses this to treat "we have the owner's credential for this portal" as an
 * implicit authorization to drive it, so profile-required portals don't hard-stop.
 */
export async function listCredentialedDomains(db, profileId) {
  if (!db) return new Set()
  await ensureSchema(db)
  const ids = [profileId, adminVaultProfileId()].filter(Boolean).map(String)
  if (ids.length === 0) return new Set()
  const out = new Set()
  for (const pid of [...new Set(ids)]) {
    let rows = []
    try {
      rows = await db.prepare(
        `SELECT portal_host FROM hamilton_portal_credentials WHERE profile_id = ? AND status = 'active'`,
      ).all(pid)
    } catch { rows = [] }
    for (const r of rows || []) {
      const d = registrableDomain(normalizeHost(r.portal_host))
      if (d) out.add(d)
    }
  }
  return out
}

export async function markCredentialUsed(db, id) {
  if (!db || !id) return
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  try {
    await db.prepare(`UPDATE hamilton_portal_credentials SET last_used_at = ${nowFn}, updated_at = ${nowFn} WHERE id = ?`).run(String(id))
  } catch { /* best-effort */ }
}

/**
 * Clear pending_registration once an auto-provisioned login's account is
 * confirmed-registered on the portal (the autopilot engine calls this when the
 * signup adapter returns 'registered', or when the account already existed). From
 * then on the row is a real "has existing credentials" login. Best-effort.
 */
export async function markCredentialRegistered(db, id) {
  if (!db || !id) return false
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const falseVal = db?.dialect === 'postgres' ? 'FALSE' : '0'
  try {
    // Clearing pending_registration also ends any email-verification wait — the
    // account is now real, so verification_status/next_retry are reset.
    const res = await db.prepare(
      `UPDATE hamilton_portal_credentials
         SET pending_registration = ${falseVal},
             verification_status = NULL, verification_next_retry_at = NULL,
             updated_at = ${nowFn}
       WHERE id = ?`,
    ).run(String(id))
    return (res?.changes ?? res?.rowCount ?? 0) > 0
  } catch { return false }
}

/**
 * Mark an auto-provisioned login as AWAITING EMAIL VERIFICATION: the account was
 * created on the portal but the portal still needs the email verified (the
 * user's one click). Sets verification_status='pending' and the first re-check
 * time. pending_registration stays true (it is not a working account until
 * verified). Optionally seeds the attempt count. Best-effort.
 */
export async function markCredentialAwaitingVerification(db, id, { nextRetryAt = null, attempts = null } = {}) {
  if (!db || !id) return false
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const sets = [`verification_status = 'pending'`, `verification_next_retry_at = ?`, `updated_at = ${nowFn}`]
  const params = [nextRetryAt ?? null]
  if (attempts !== null && Number.isFinite(Number(attempts))) {
    sets.push('verification_attempts = ?'); params.push(Number(attempts))
  }
  params.push(String(id))
  try {
    const res = await db.prepare(
      `UPDATE hamilton_portal_credentials SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params)
    return (res?.changes ?? res?.rowCount ?? 0) > 0
  } catch { return false }
}

/**
 * Record one email-verification RE-CHECK that did not yet confirm: bumps
 * verification_attempts and schedules the next re-check. Returns the new attempt
 * count (0 on failure). Best-effort.
 */
export async function recordVerificationRecheck(db, id, { nextRetryAt = null } = {}) {
  if (!db || !id) return 0
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  try {
    await db.prepare(
      `UPDATE hamilton_portal_credentials
         SET verification_attempts = COALESCE(verification_attempts, 0) + 1,
             verification_next_retry_at = ?, updated_at = ${nowFn}
       WHERE id = ?`,
    ).run(nextRetryAt ?? null, String(id))
    const row = await db.prepare('SELECT verification_attempts FROM hamilton_portal_credentials WHERE id = ?').get(String(id))
    return Number(row?.verification_attempts) || 0
  } catch { return 0 }
}

/**
 * Give up on auto-verifying an account (backoff exhausted): clears the pending
 * verification wait so the brain routes to a side-by-side login. Keeps
 * pending_registration=true (the account is still unverified). Best-effort.
 */
export async function clearVerificationPending(db, id) {
  if (!db || !id) return false
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  try {
    const res = await db.prepare(
      `UPDATE hamilton_portal_credentials
         SET verification_status = NULL, verification_next_retry_at = NULL, updated_at = ${nowFn}
       WHERE id = ?`,
    ).run(String(id))
    return (res?.changes ?? res?.rowCount ?? 0) > 0
  } catch { return false }
}

/**
 * Rows awaiting email verification whose re-check is due (or unscheduled). Used
 * by the periodic re-check driver so accounts finish the moment the user clicks
 * the verification link (or Hamilton auto-clicks it from John's mailbox).
 * Returns raw rows (id, profile_id, portal_host, login_url, username,
 * verification_attempts). Best-effort — returns [] on any error.
 */
export async function listCredentialsAwaitingVerification(db, { nowIso = new Date().toISOString(), limit = 50 } = {}) {
  if (!db) return []
  await ensureSchema(db)
  const cap = Math.max(1, Math.min(500, Number(limit) || 50))
  try {
    const rows = await db.prepare(
      `SELECT id, user_id, profile_id, portal_host, login_url, username, verification_attempts
         FROM hamilton_portal_credentials
        WHERE verification_status = 'pending'
          AND (verification_next_retry_at IS NULL OR verification_next_retry_at <= ?)
        ORDER BY verification_next_retry_at ASC
        LIMIT ${cap}`,
    ).all(nowIso)
    return Array.isArray(rows) ? rows : []
  } catch { return [] }
}

/**
 * Save a credential Hamilton GENERATED for a portal that didn't have one yet.
 * Generates a strong password, encrypts it, persists the row, and returns
 * BOTH the masked row AND the plaintext password so the caller can show it
 * to the user exactly once.
 *
 * Idempotent on (profile_id, portal_host): if an active credential exists
 * for that pair we DO NOT overwrite it — we return it as-is with
 * `already_existed: true` so callers don't accidentally rotate a working
 * password the user already has.
 */
export async function saveGeneratedCredential(db, {
  userId, profileId, portalHost, username,
  label = null, loginUrl = null,
  reason = null, generatedBy = 'hamilton',
  passwordLength = 28,
} = {}) {
  if (!db || !userId || !profileId) throw new Error('userId and profileId required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  if (!registrableDomain(host)) throw new Error('portalHost must be a full domain (e.g. mtsu.edu)')
  if (!username || !String(username).trim()) throw new Error('username required')
  await ensureSchema(db)

  const existing = await db.prepare(
    `SELECT * FROM hamilton_portal_credentials
       WHERE profile_id = ? AND portal_host = ? AND status = 'active' LIMIT 1`,
  ).get(String(profileId), host)

  if (existing) {
    return {
      credential: rowToMasked(existing),
      already_existed: true,
      password_one_time_view: null,
    }
  }

  const password = generateStrongPassword(passwordLength)
  const enc = encryptRuntimeSecret(password)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_portal_credentials
       (id, user_id, profile_id, portal_host, label, login_url, username,
        password_ciphertext, password_iv, password_tag, status,
        generated_by, generation_reason, generated_at, managed_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ${nowFn}, 'hamilton', ${nowFn}, ${nowFn})`,
  ).run(
    id, String(userId), String(profileId), host,
    label || `Generated by ${generatedBy} for ${host}`,
    loginUrl,
    String(username),
    enc.value_ciphertext, enc.iv, enc.tag,
    String(generatedBy), reason ? String(reason) : null,
  )
  const row = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get(id)
  return {
    credential: rowToMasked(row),
    already_existed: false,
    // The ONE TIME this is ever returned. The route handler returns it
    // directly to the user so they can record it elsewhere; from then on
    // only the server-side engine path (getDecryptedCredential) ever sees
    // the plaintext.
    password_one_time_view: password,
  }
}

/**
 * Auto-provision a login under the profile's MASTER PASSPHRASE (Portal Autopilot
 * Identity). Generates a UNIQUE crypto-random password (never reused), wraps it
 * with the supplied master wrapping key (inner layer) on top of the server vault
 * (outer layer), and stores it. password_ciphertext is left NULL — the password
 * is recoverable only with BOTH the server vault key AND the master passphrase.
 *
 * Requires a non-null `masterKey` (the caller obtains it from the unlocked
 * vault). Idempotent on (profile_id, portal_host): an existing active credential
 * is returned untouched with already_existed:true so a working login is never
 * rotated out from under the user.
 *
 * Returns BOTH the masked row AND the plaintext password ONCE so the caller can
 * show it to the user. From then on only the server-side engine path
 * (getDecryptedCredential, with the vault unlocked) ever sees the plaintext.
 */
export async function saveAutoProvisionedCredential(db, {
  userId, profileId, portalHost, username, masterKey,
  label = null, loginUrl = null, reason = null, passwordLength = 28,
} = {}) {
  if (!db || !userId || !profileId) throw new Error('userId and profileId required')
  if (!masterKey) throw new Error('masterKey required (vault must be unlocked)')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  if (!registrableDomain(host)) throw new Error('portalHost must be a full domain (e.g. mtsu.edu)')
  if (!username || !String(username).trim()) throw new Error('username required')
  await ensureSchema(db)

  const existing = await db.prepare(
    `SELECT * FROM hamilton_portal_credentials
       WHERE profile_id = ? AND portal_host = ? AND status = 'active' LIMIT 1`,
  ).get(String(profileId), host)
  if (existing) {
    return { credential: rowToMasked(existing), already_existed: true, password_one_time_view: null }
  }

  const password = generateStrongPassword(passwordLength)
  const wrapped = wrapSecretWithKey(password, masterKey)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const trueVal = db?.dialect === 'postgres' ? 'TRUE' : '1'
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_portal_credentials
       (id, user_id, profile_id, portal_host, label, login_url, username,
        has_master_wrap, wrapped_ciphertext, wrapped_iv, wrapped_tag,
        pending_registration, status,
        generated_by, generation_reason, generated_at, managed_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${trueVal}, ?, ?, ?, ${trueVal}, 'active', 'hamilton', ?, ${nowFn}, 'hamilton', ${nowFn}, ${nowFn})`,
  ).run(
    id, String(userId), String(profileId), host,
    label || `Auto-provisioned by Hamilton for ${host}`,
    loginUrl, String(username),
    wrapped.wrapped_ciphertext, wrapped.wrapped_iv, wrapped.wrapped_tag,
    reason ? String(reason) : 'portal_autopilot_identity',
  )
  const row = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get(id)
  return { credential: rowToMasked(row), already_existed: false, password_one_time_view: password }
}

/**
 * Mark that the user viewed the one-time password reveal for a credential.
 * Hamilton routes use this to enforce "show plaintext at most once" on the
 * /credentials/:id/reveal endpoint.
 */
export async function markPasswordRevealedOnce(db, id) {
  if (!db || !id) return false
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  try {
    const res = await db.prepare(
      `UPDATE hamilton_portal_credentials
         SET password_revealed_once_at = ${nowFn}, updated_at = ${nowFn}
       WHERE id = ? AND password_revealed_once_at IS NULL`,
    ).run(String(id))
    return (res?.changes ?? res?.rowCount ?? 0) > 0
  } catch { return false }
}

/**
 * SERVER-SIDE ONLY. Reveal the plaintext password for a credential ID
 * exactly once (per row). Returns null if the row is missing, the password
 * cannot be decrypted, or has already been revealed once. Callers MUST
 * surface the result to the user immediately and never persist it.
 */
export async function revealPasswordOnceById(db, id) {
  if (!db || !id) return null
  await ensureSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE id = ?').get(String(id))
  if (!row) return null
  if (row.password_revealed_once_at) return { already_revealed: true, password: null }
  let password = null
  try {
    password = decryptRuntimeSecret({
      value_ciphertext: row.password_ciphertext,
      iv: row.password_iv,
      tag: row.password_tag,
    })
  } catch { return null }
  if (!password) return null
  await markPasswordRevealedOnce(db, id)
  return { already_revealed: false, password }
}
