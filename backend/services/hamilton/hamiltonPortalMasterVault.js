/**
 * hamiltonPortalMasterVault.js
 *
 * "Portal Autopilot Identity" — the password-manager layer that lets Hamilton
 * self-provision logins on portals the owner has NOT signed up to, WITHOUT the
 * owner managing a password per portal.
 *
 * Two distinct pieces live here:
 *
 *   1. A per-profile AUTOPILOT IDENTITY: the email/alias Hamilton registers new
 *      accounts with (defaults to the profile's designated alias/email). This is
 *      the "username" side of every auto-provisioned login.
 *
 *   2. A per-profile MASTER PASSPHRASE that protects the vault, password-manager
 *      style. The owner sets ONE passphrase; from it we derive a key (scrypt with
 *      a per-profile random salt) and use that key to wrap each per-portal secret.
 *
 * SECURITY — defense in depth, NEVER weakening the existing vault:
 *   - Every per-portal password is still a UNIQUE crypto-random string (never one
 *     reused password) and is still encrypted at rest with the existing
 *     server-side AES-256-GCM vault key (runtimeSecrets) in
 *     hamiltonPortalCredentialService. THIS module ADDS an inner passphrase layer
 *     on top of that: the plaintext password is first AES-256-GCM-encrypted with
 *     the scrypt-derived master key, and the (already server-vault-encrypted)
 *     inner ciphertext is what is stored. To recover a password you need BOTH the
 *     server vault key AND the owner's master passphrase.
 *   - The passphrase itself is NEVER stored, logged, or returned. We store only a
 *     random salt + a verifier (a separate scrypt output domain-separated from the
 *     wrapping key) so we can confirm an entered passphrase without keeping it.
 *   - The verifier comparison is constant-time (crypto.timingSafeEqual).
 *   - When the passphrase is not held in the runtime unlock cache, autopilot for
 *     NEW registrations is blocked with a clear "vault locked" status rather than
 *     failing silently — existing-credential logins are unaffected.
 *
 * Nothing here drives a portal. It only sets up identity + passphrase, wraps /
 * unwraps secrets, and reports lock state. Route handlers verify profile access.
 */

import crypto from 'node:crypto'
import { encryptRuntimeSecret, decryptRuntimeSecret } from '../../utils/runtimeSecrets.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-portal-master-vault')

// scrypt cost parameters. N must be a power of two; these are the standard
// interactive parameters (N=2^15) — strong but fast enough for a per-unlock
// derivation. maxmem is raised so Node doesn't refuse the allocation.
const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 })
// Domain-separation context bytes so the wrapping key and the verifier are
// derived from the SAME passphrase+salt but can never collide.
const WRAP_CONTEXT = Buffer.from('grantflow:portal:wrap', 'utf8')
const VERIFY_CONTEXT = Buffer.from('grantflow:portal:verify', 'utf8')

// ── schema (self-healing, mirrors the other Hamilton stores) ──────────────────
// Per-db WeakMap cache (not a process-global boolean): concurrent node:test
// suites each get their own in-memory db and must not race on a shared flag.
let schemaReady = new WeakMap()
export function _resetMasterVaultSchemaCache() { schemaReady = new WeakMap() }

export async function ensureMasterVaultSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_portal_master_vault (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      profile_id TEXT NOT NULL UNIQUE,
      identity_email TEXT,
      kdf TEXT NOT NULL DEFAULT 'scrypt',
      kdf_params TEXT,
      salt TEXT,
      verifier TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_master_vault_profile
      ON hamilton_portal_master_vault(profile_id);
  `)
  // Autonomous-unlock ESCROW (opt-in): a server-key-wrapped copy of the derived
  // wrapping key so scheduled/background runs unlock WITHOUT a human. Recovering a
  // master-wrapped password then needs only the server vault key — parity with the
  // regular server-vault logins that already run unattended. Off unless the owner
  // enables it. Idempotent add.
  if (isPostgres) {
    await db.exec(`
      ALTER TABLE hamilton_portal_master_vault ADD COLUMN IF NOT EXISTS escrow_ciphertext TEXT;
      ALTER TABLE hamilton_portal_master_vault ADD COLUMN IF NOT EXISTS escrow_iv TEXT;
      ALTER TABLE hamilton_portal_master_vault ADD COLUMN IF NOT EXISTS escrow_tag TEXT;
    `)
  } else {
    const cols = new Set((await db.prepare('PRAGMA table_info(hamilton_portal_master_vault)').all()).map((r) => r.name))
    if (!cols.has('escrow_ciphertext')) await db.exec('ALTER TABLE hamilton_portal_master_vault ADD COLUMN escrow_ciphertext TEXT')
    if (!cols.has('escrow_iv')) await db.exec('ALTER TABLE hamilton_portal_master_vault ADD COLUMN escrow_iv TEXT')
    if (!cols.has('escrow_tag')) await db.exec('ALTER TABLE hamilton_portal_master_vault ADD COLUMN escrow_tag TEXT')
  }
  schemaReady.set(db, true)
}

// ── autonomous-unlock escrow (opt-in) ─────────────────────────────────────────

/** Store a server-key-wrapped copy of the derived wrapping key for auto-unlock. */
export async function escrowWrappingKey(db, profileId, key) {
  if (!db || !profileId || !key) return false
  await ensureMasterVaultSchema(db)
  const enc = encryptRuntimeSecret(Buffer.from(key).toString('base64'))
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_portal_master_vault
        SET escrow_ciphertext = ?, escrow_iv = ?, escrow_tag = ?, updated_at = ${nowFn}
      WHERE profile_id = ?`,
  ).run(enc.value_ciphertext, enc.iv, enc.tag, String(profileId))
  log.info('vault_autonomous_unlock_enabled', { profileId: String(profileId) })
  return true
}

/** Null the escrowed columns WITHOUT touching the runtime unlock cache. Used by
 * setMasterPassphrase (which must leave the just-derived key cached). */
async function clearEscrowColumns(db, profileId) {
  if (!db || !profileId) return false
  await ensureMasterVaultSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_portal_master_vault
        SET escrow_ciphertext = NULL, escrow_iv = NULL, escrow_tag = NULL, updated_at = ${nowFn}
      WHERE profile_id = ?`,
  ).run(String(profileId))
  return true
}

/** Remove the escrowed key (disables auto-unlock) AND lock the runtime cache. */
export async function clearEscrow(db, profileId) {
  const ok = await clearEscrowColumns(db, profileId)
  lockVault(profileId)
  return ok
}

export async function hasEscrow(db, profileId) {
  const row = await getMasterVault(db, profileId)
  return Boolean(row?.escrow_ciphertext && row?.escrow_iv && row?.escrow_tag)
}

async function loadEscrowedKey(db, profileId) {
  const row = await getMasterVault(db, profileId)
  if (!row?.escrow_ciphertext || !row?.escrow_iv || !row?.escrow_tag) return null
  try {
    const b64 = decryptRuntimeSecret({ value_ciphertext: row.escrow_ciphertext, iv: row.escrow_iv, tag: row.escrow_tag })
    return Buffer.from(String(b64), 'base64')
  } catch {
    return null
  }
}

/**
 * The wrapping key for a profile, unlocking from escrow if needed. Returns the
 * cached key, else transparently unlocks from the escrowed key (auto-unlock for
 * autonomous runs), else null (vault locked + no escrow → needs a human).
 */
export async function ensureUnlocked(db, profileId) {
  const cached = cachedKey(profileId)
  if (cached) return cached
  const key = await loadEscrowedKey(db, profileId)
  if (key) { cacheKey(profileId, key); return key }
  return null
}

// ── runtime unlock cache (passphrase held in memory only, per process) ────────
// Mirrors the runtimeSecrets pattern: the derived wrapping key for a profile is
// kept in-process after unlock so unattended autopilot can wrap/unwrap without
// re-prompting. It is NEVER persisted. A profile re-locks on process restart or
// an explicit lock() call. We store the derived KEY (not the passphrase).
const unlockedKeys = new Map() // profileId -> { key: Buffer, at: number }
const UNLOCK_TTL_MS = Number(process.env.HAMILTON_VAULT_UNLOCK_TTL_MS || 0) || 0 // 0 = no expiry

function cacheKey(profileId, key) {
  unlockedKeys.set(String(profileId), { key, at: Date.now() })
}
function cachedKey(profileId) {
  const entry = unlockedKeys.get(String(profileId))
  if (!entry) return null
  if (UNLOCK_TTL_MS > 0 && Date.now() - entry.at > UNLOCK_TTL_MS) {
    unlockedKeys.delete(String(profileId))
    return null
  }
  return entry.key
}
export function lockVault(profileId) {
  return unlockedKeys.delete(String(profileId))
}
export function _resetUnlockCache() { unlockedKeys.clear() }

// ── KDF ───────────────────────────────────────────────────────────────────────

/**
 * Derive a 32-byte key from passphrase + salt + a domain-separation context.
 * scrypt is intentionally memory-hard so a stolen verifier/salt can't be
 * brute-forced cheaply.
 */
function deriveKeyWithContext(passphrase, salt, context) {
  // Bind the context by salting scrypt with salt||context (still a unique salt
  // per (profile, purpose)). scrypt's salt accepts arbitrary bytes.
  const saltWithCtx = Buffer.concat([Buffer.from(salt), context])
  return crypto.scryptSync(
    Buffer.from(String(passphrase), 'utf8'),
    saltWithCtx,
    SCRYPT_PARAMS.keylen,
    { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_PARAMS.maxmem },
  )
}

function deriveWrappingKey(passphrase, salt) {
  return deriveKeyWithContext(passphrase, salt, WRAP_CONTEXT)
}
function deriveVerifier(passphrase, salt) {
  return deriveKeyWithContext(passphrase, salt, VERIFY_CONTEXT)
}

function constantTimeEqualB64(aB64, bBuf) {
  try {
    const a = Buffer.from(String(aB64 || ''), 'base64')
    if (a.length !== bBuf.length) return false
    return crypto.timingSafeEqual(a, bBuf)
  } catch {
    return false
  }
}

// ── wrap / unwrap a per-portal secret with the master key ─────────────────────

/**
 * Wrap a plaintext secret with the master wrapping key (inner AES-256-GCM layer),
 * then encrypt the inner ciphertext with the server vault key (outer layer).
 * Returns the three columns to persist. NEVER returns plaintext.
 */
export function wrapSecretWithKey(plaintext, key) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const inner = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // The inner blob = iv || tag || ciphertext, base64. We then run it through the
  // existing server vault so what lands on disk is doubly encrypted.
  const innerBlob = Buffer.concat([iv, tag, inner]).toString('base64')
  const outer = encryptRuntimeSecret(innerBlob)
  return {
    wrapped_ciphertext: outer.value_ciphertext,
    wrapped_iv: outer.iv,
    wrapped_tag: outer.tag,
  }
}

/**
 * Reverse wrapSecretWithKey. Throws on a wrong key (GCM auth failure) — callers
 * treat a throw as "wrong passphrase / corrupt".
 */
export function unwrapSecretWithKey({ wrapped_ciphertext, wrapped_iv, wrapped_tag }, key) {
  const innerBlob = decryptRuntimeSecret({ value_ciphertext: wrapped_ciphertext, iv: wrapped_iv, tag: wrapped_tag })
  const raw = Buffer.from(String(innerBlob), 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString('utf8')
}

// ── row mapping ───────────────────────────────────────────────────────────────

function rowToPublic(row) {
  if (!row) return null
  return {
    profile_id: row.profile_id,
    identity_email: row.identity_email || null,
    // Whether a passphrase has ever been set (a salt+verifier exist). The salt
    // and verifier themselves are NEVER returned.
    has_passphrase: Boolean(row.salt && row.verifier),
    // Whether autonomous auto-unlock is enabled (an escrowed key exists). The
    // escrowed material itself is NEVER returned.
    autonomous_unlock: Boolean(row.escrow_ciphertext && row.escrow_iv && row.escrow_tag),
    kdf: row.kdf || 'scrypt',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
}

// ── public API ─────────────────────────────────────────────────────────────────

export async function getMasterVault(db, profileId) {
  if (!db || !profileId) return null
  await ensureMasterVaultSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_portal_master_vault WHERE profile_id = ? LIMIT 1').get(String(profileId))
  return row || null
}

/**
 * Public-safe identity/lock view for a profile. Never returns the salt/verifier.
 * `is_unlocked` reflects whether the runtime cache currently holds the key.
 */
export async function getMasterVaultStatus(db, profileId) {
  const row = await getMasterVault(db, profileId)
  const pub = rowToPublic(row) || { profile_id: String(profileId), identity_email: null, has_passphrase: false, kdf: 'scrypt' }
  return { ...pub, is_unlocked: pub.has_passphrase ? Boolean(cachedKey(profileId)) : false }
}

/**
 * Set or update the per-profile autopilot identity email/alias (the username
 * Hamilton registers new accounts with). Independent of the passphrase.
 */
export async function setAutopilotIdentity(db, { profileId, identityEmail } = {}) {
  if (!db || !profileId) throw new Error('profileId required')
  const email = identityEmail ? String(identityEmail).trim() : null
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('identityEmail must be a valid email')
  await ensureMasterVaultSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await getMasterVault(db, profileId)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_master_vault SET identity_email = ?, updated_at = ${nowFn} WHERE profile_id = ?`,
    ).run(email, String(profileId))
  } else {
    await db.prepare(
      `INSERT INTO hamilton_portal_master_vault (profile_id, identity_email, kdf) VALUES (?, ?, 'scrypt')`,
    ).run(String(profileId), email)
  }
  return getMasterVaultStatus(db, profileId)
}

/**
 * Set the master passphrase for a profile (first time, or rotate). On a rotate
 * the caller is responsible for re-wrapping existing secrets BEFORE calling with
 * a new passphrase — see rotateMasterPassphrase. This low-level setter stores a
 * fresh salt + verifier and unlocks the vault in the runtime cache.
 *
 * @returns { status, key } — key is the derived wrapping key (in-memory only).
 */
export async function setMasterPassphrase(db, { profileId, passphrase, identityEmail = undefined, autonomousUnlock = false } = {}) {
  if (!db || !profileId) throw new Error('profileId required')
  const pass = String(passphrase || '')
  if (pass.length < 8) throw new Error('passphrase must be at least 8 characters')
  await ensureMasterVaultSchema(db)
  const salt = crypto.randomBytes(16)
  const verifier = deriveVerifier(pass, salt)
  const wrappingKey = deriveWrappingKey(pass, salt)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const kdfParams = JSON.stringify({ N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p })
  const existing = await getMasterVault(db, profileId)
  const email = identityEmail === undefined ? (existing?.identity_email ?? null) : (identityEmail ? String(identityEmail).trim() : null)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_master_vault
          SET salt = ?, verifier = ?, kdf = 'scrypt', kdf_params = ?, identity_email = ?, updated_at = ${nowFn}
        WHERE profile_id = ?`,
    ).run(salt.toString('base64'), verifier.toString('base64'), kdfParams, email, String(profileId))
  } else {
    await db.prepare(
      `INSERT INTO hamilton_portal_master_vault (profile_id, identity_email, kdf, kdf_params, salt, verifier)
       VALUES (?, ?, 'scrypt', ?, ?, ?)`,
    ).run(String(profileId), email, kdfParams, salt.toString('base64'), verifier.toString('base64'))
  }
  cacheKey(profileId, wrappingKey)
  // The salt (and therefore the wrapping key) just changed, so any prior escrow is
  // stale. Re-escrow the NEW key when autonomous unlock is requested, else clear it.
  if (autonomousUnlock) await escrowWrappingKey(db, profileId, wrappingKey)
  else await clearEscrowColumns(db, profileId)
  log.info('master_passphrase_set', { profileId: String(profileId), autonomous_unlock: Boolean(autonomousUnlock) })
  return { status: await getMasterVaultStatus(db, profileId), key: wrappingKey }
}

/**
 * Verify a passphrase against the stored salt+verifier (constant-time) and, on
 * success, derive + cache the wrapping key (unlock). Returns { ok, key } — key is
 * null on failure. NEVER reveals whether the failure was "no vault" vs "wrong
 * passphrase" beyond the boolean.
 */
export async function unlockVault(db, { profileId, passphrase, autonomousUnlock = false } = {}) {
  if (!db || !profileId) return { ok: false, key: null }
  const row = await getMasterVault(db, profileId)
  if (!row || !row.salt || !row.verifier) return { ok: false, key: null, reason: 'no_passphrase_set' }
  const salt = Buffer.from(String(row.salt), 'base64')
  const candidate = deriveVerifier(String(passphrase || ''), salt)
  if (!constantTimeEqualB64(row.verifier, candidate)) return { ok: false, key: null, reason: 'wrong_passphrase' }
  const key = deriveWrappingKey(String(passphrase || ''), salt)
  cacheKey(profileId, key)
  // Opt-in: escrow this key so future autonomous runs unlock without a human.
  if (autonomousUnlock) await escrowWrappingKey(db, profileId, key)
  return { ok: true, key }
}

/**
 * The in-memory wrapping key for an UNLOCKED profile, or null when the vault is
 * locked. Unattended autopilot uses this to wrap/unwrap without a passphrase
 * round-trip; null means "needs unlock" and new registrations must be blocked.
 */
export function getUnlockedKey(profileId) {
  return cachedKey(profileId)
}

/** Has the profile set a master passphrase at all (regardless of unlock state)? */
export async function hasPassphrase(db, profileId) {
  const row = await getMasterVault(db, profileId)
  return Boolean(row?.salt && row?.verifier)
}

export default {
  ensureMasterVaultSchema,
  _resetMasterVaultSchemaCache,
  getMasterVault,
  getMasterVaultStatus,
  setAutopilotIdentity,
  setMasterPassphrase,
  unlockVault,
  lockVault,
  getUnlockedKey,
  ensureUnlocked,
  escrowWrappingKey,
  clearEscrow,
  hasEscrow,
  hasPassphrase,
  wrapSecretWithKey,
  unwrapSecretWithKey,
  _resetUnlockCache,
}
