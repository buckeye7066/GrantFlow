/**
 * hamiltonProfileIdentityVault.js
 *
 * A per-profile, encrypted store for the SENSITIVE identity values a portal may
 * demand for identity proofing or SSO — and the "ask the profile's user for it"
 * flow for when a value isn't on file yet.
 *
 * WHY THIS EXISTS
 * ---------------
 * Owner directive 2026-08-21: "The identity proofing and SSO's can be done by
 * Hamilton if they are saved in the vault. If Hamilton needs them, let him ask
 * for them from the profile's user."
 *
 * Until now an identity-proofing wall (SSN / government ID / FSA ID / Login.gov
 * / ID.me / an SSO password) was an UNCONDITIONAL hand-off — the signup adapter
 * refused the host outright and routed to co-browse, and it never asked for the
 * specific thing it needed. That is the right default when nothing is on file
 * and nothing should be fabricated, but it left full automation stopping short
 * of a submission the applicant had already consented to, even for a value the
 * applicant would gladly have saved once.
 *
 * The rule this module implements:
 *   - USE — when the needed identity value is in this vault, Hamilton fills it
 *     (only under full automation, only server-side, never logged);
 *   - ASK — when it is NOT, Hamilton emits a specific, secure request to the
 *     profile owner AND the admins ("Hamilton needs your <label> to finish an
 *     application on <portal> — add it securely here") with a deep link to the
 *     entry form, and hands off until it is provided;
 *   - NEVER FABRICATE — there is no path here that invents, guesses, or derives
 *     an identity value. Absent means ask, never make up.
 *
 * SECURITY
 * --------
 * Values are encrypted at rest with the SAME AES-256-GCM server-vault helper
 * the portal-credential vault uses (encryptRuntimeSecret / decryptRuntimeSecret,
 * keyed off the deployment's own key material). Only a non-reversible `last4`
 * (and, for a date of birth, the year) is stored in clear for display — enough
 * for the owner to recognise which value is on file, never enough to reconstruct
 * it. Plaintext is returned only to the fill path, on the server, and is never
 * written to a log, a trace, or an event.
 */

import { encryptRuntimeSecret, decryptRuntimeSecret } from '../../utils/runtimeSecrets.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-identity-vault')

/**
 * The identity values a portal can demand. Each carries the human label the
 * owner sees in the ask, and whether a `last4` display hint is meaningful.
 * `identity:<free>` is accepted too (a portal-specific proofing field), so this
 * set never has to be exhaustive to be useful.
 */
export const IDENTITY_SECRET_KINDS = Object.freeze({
  ssn: { label: 'Social Security Number', last4: true },
  itin: { label: 'ITIN (Individual Taxpayer ID)', last4: true },
  date_of_birth: { label: 'Date of birth', last4: false },
  government_id_number: { label: 'Government ID / driver’s license number', last4: true },
  passport_number: { label: 'Passport number', last4: true },
  fsa_id_username: { label: 'FSA ID username (studentaid.gov)', last4: false },
  fsa_id_password: { label: 'FSA ID password (studentaid.gov)', last4: false },
  sso_username: { label: 'University SSO username', last4: false },
  sso_password: { label: 'University SSO password', last4: false },
  login_gov_email: { label: 'Login.gov email', last4: false },
  login_gov_password: { label: 'Login.gov password', last4: false },
  id_me_email: { label: 'ID.me email', last4: false },
  id_me_password: { label: 'ID.me password', last4: false },
})

// A free-form portal-proofing field is namespaced so it can never collide with
// a canonical kind, and is still stored + asked-for the same way.
const FREEFORM_PREFIX = 'identity:'

export function isKnownIdentityKind(kind) {
  const k = String(kind || '')
  return Object.prototype.hasOwnProperty.call(IDENTITY_SECRET_KINDS, k) || k.startsWith(FREEFORM_PREFIX)
}

export function identityKindLabel(kind) {
  const k = String(kind || '')
  if (IDENTITY_SECRET_KINDS[k]) return IDENTITY_SECRET_KINDS[k].label
  if (k.startsWith(FREEFORM_PREFIX)) return k.slice(FREEFORM_PREFIX.length).replace(/[_-]+/g, ' ').trim() || 'identity detail'
  return String(kind || 'identity detail')
}

let schemaReady = new WeakMap()
export function _resetIdentityVaultSchemaCache() { schemaReady = new WeakMap() }

async function ensureSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_profile_identity_secrets (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      profile_id TEXT NOT NULL,
      secret_kind TEXT NOT NULL,
      -- AES-256-GCM via runtimeSecrets (same key material as the credential vault).
      value_ciphertext TEXT NOT NULL,
      value_iv TEXT NOT NULL,
      value_tag TEXT NOT NULL,
      -- Non-reversible display hint ONLY (last 4 chars, or a birth year). Never
      -- enough to reconstruct the value; enough for the owner to recognise it.
      display_hint TEXT,
      created_by TEXT,
      updated_by TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_hamilton_identity_profile_kind
      ON hamilton_profile_identity_secrets(profile_id, secret_kind);
  `)
  schemaReady.set(db, true)
}

function displayHintFor(kind, value) {
  const v = String(value ?? '')
  if (kind === 'date_of_birth') {
    const m = v.match(/(\d{4})/)
    return m ? `••••${m[1]}` : null
  }
  const spec = IDENTITY_SECRET_KINDS[kind]
  if (spec && spec.last4 === false) return null
  const digits = v.replace(/\D+/g, '')
  const tail = (digits || v).slice(-4)
  return tail ? `••••${tail}` : null
}

/**
 * Store (or replace) one identity value for a profile. Returns the display hint
 * only — never the plaintext, never the ciphertext.
 */
export async function setIdentitySecret(db, {
  profileId, kind, value, userId = null,
} = {}) {
  if (!db) throw new Error('db required')
  if (!profileId) throw new Error('profileId required')
  if (!isKnownIdentityKind(kind)) throw new Error(`unknown identity kind: ${kind}`)
  const plaintext = String(value ?? '')
  if (plaintext.trim() === '') throw new Error('value required')
  await ensureSchema(db)

  const enc = encryptRuntimeSecret(plaintext)
  const hint = displayHintFor(kind, plaintext)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'

  const existing = await db.prepare(
    'SELECT id FROM hamilton_profile_identity_secrets WHERE profile_id = ? AND secret_kind = ?',
  ).get(String(profileId), String(kind))

  if (existing) {
    await db.prepare(
      `UPDATE hamilton_profile_identity_secrets
          SET value_ciphertext = ?, value_iv = ?, value_tag = ?, display_hint = ?,
              updated_by = ?, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(enc.value_ciphertext, enc.iv, enc.tag, hint, userId ? String(userId) : null, existing.id)
  } else {
    await db.prepare(
      `INSERT INTO hamilton_profile_identity_secrets
          (profile_id, secret_kind, value_ciphertext, value_iv, value_tag, display_hint, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn})`,
    ).run(String(profileId), String(kind), enc.value_ciphertext, enc.iv, enc.tag, hint,
      userId ? String(userId) : null, userId ? String(userId) : null)
  }
  return { kind: String(kind), display_hint: hint }
}

/** Is a given identity value on file for this profile? (No decryption.) */
export async function hasIdentitySecret(db, { profileId, kind } = {}) {
  if (!db || !profileId || !kind) return false
  await ensureSchema(db)
  const row = await db.prepare(
    'SELECT 1 AS x FROM hamilton_profile_identity_secrets WHERE profile_id = ? AND secret_kind = ?',
  ).get(String(profileId), String(kind))
  return Boolean(row)
}

/**
 * Which identity values are on file for a profile — kinds, labels, and display
 * hints ONLY. Never decrypts. This is what the UI and the "what is still
 * missing" check read.
 */
export async function listIdentitySecrets(db, profileId) {
  if (!db || !profileId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT secret_kind, display_hint, updated_at
       FROM hamilton_profile_identity_secrets WHERE profile_id = ?
      ORDER BY secret_kind`,
  ).all(String(profileId))
  return (rows || []).map((r) => ({
    kind: r.secret_kind,
    label: identityKindLabel(r.secret_kind),
    display_hint: r.display_hint ?? null,
    updated_at: r.updated_at ?? null,
  }))
}

/**
 * Decrypt one identity value for the FILL path. Server-side only; the caller
 * must never log or trace the result. Returns null when not on file.
 */
export async function getIdentitySecretValue(db, { profileId, kind } = {}) {
  if (!db || !profileId || !kind) return null
  await ensureSchema(db)
  const row = await db.prepare(
    `SELECT value_ciphertext, value_iv, value_tag
       FROM hamilton_profile_identity_secrets WHERE profile_id = ? AND secret_kind = ?`,
  ).get(String(profileId), String(kind))
  if (!row) return null
  try {
    return decryptRuntimeSecret({ value_ciphertext: row.value_ciphertext, iv: row.value_iv, tag: row.value_tag })
  } catch (err) {
    // A value we cannot decrypt is a value we do not have — ask for it again
    // rather than fill garbage. Never throw into the run.
    log.error('identity_secret_decrypt_failed', { profileId: String(profileId), kind: String(kind), err: err?.message })
    return null
  }
}

/**
 * Build the plaintext identity-value map the autopilot engine fills from, for
 * ALL kinds currently on file. Loaded by the ORCHESTRATOR (which owns the db)
 * and passed into the engine, preserving the engine's "nothing reads the db
 * mid-run" contract — exactly how narrativeAnswers already flows. Only ever
 * called under full automation.
 */
export async function loadIdentityValuesForFill(db, profileId) {
  const onFile = await listIdentitySecrets(db, profileId)
  const values = {}
  for (const { kind } of onFile) {
    const v = await getIdentitySecretValue(db, { profileId, kind })
    if (v !== null && v !== undefined && String(v) !== '') values[kind] = v
  }
  return values
}

export async function revokeIdentitySecret(db, { profileId, kind } = {}) {
  if (!db || !profileId || !kind) return 0
  await ensureSchema(db)
  const res = await db.prepare(
    'DELETE FROM hamilton_profile_identity_secrets WHERE profile_id = ? AND secret_kind = ?',
  ).run(String(profileId), String(kind))
  return Number(res?.changes ?? res?.rowCount ?? 0)
}

export default {
  IDENTITY_SECRET_KINDS,
  isKnownIdentityKind,
  identityKindLabel,
  setIdentitySecret,
  hasIdentitySecret,
  listIdentitySecrets,
  getIdentitySecretValue,
  loadIdentityValuesForFill,
  revokeIdentitySecret,
  _resetIdentityVaultSchemaCache,
}
