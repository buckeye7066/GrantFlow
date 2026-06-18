/**
 * hamiltonAttestationStore.js
 *
 * Standing attestation authorizations. The user pre-approves
 * categories of routine attestations (e.g. "I certify the
 * information is accurate to the best of my knowledge") and Hamilton
 * may then auto-tick checkboxes whose label text matches the
 * authorized pattern.
 *
 * Hamilton NEVER auto-ticks a penalty-of-perjury / wet-signature /
 * unique-judgment attestation, even if a row exists. The hard-stop
 * resolver enforces this (see hamiltonAutopilotEngine.HARD_ATTESTATION_PATTERNS).
 */

import crypto from 'node:crypto'

export const ATTESTATION_CATEGORIES = Object.freeze([
  'truthfulness',
  'terms_of_use',
  'authorize_release',
  'eligibility_self_certify',
  'understand_disqualification',
])

let ensured = false
export function _resetAttestationSchemaCache() { ensured = false }

async function ensureSchema(db) {
  if (!db || ensured || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_attestation_authorizations (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      category TEXT NOT NULL,
      pattern TEXT NOT NULL,
      authorization_text TEXT NOT NULL,
      approved_at ${tsType} DEFAULT ${nowFn},
      revoked_at ${tsType},
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_attest_profile ON hamilton_attestation_authorizations(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_attest_active  ON hamilton_attestation_authorizations(profile_id, category, revoked_at);
  `)
  ensured = true
}

function rowToAuth(row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id,
    profile_id: row.profile_id,
    category: row.category,
    pattern: row.pattern,
    authorization_text: row.authorization_text,
    approved_at: row.approved_at,
    revoked_at: row.revoked_at || null,
  }
}

const SEED_PATTERNS = Object.freeze({
  truthfulness: 'information.*(true|accurate|correct).*best.*knowledge',
  terms_of_use: 'agree.*terms.*(conditions|service|use)',
  authorize_release: 'authorize.*(release|verify|confirm).*information',
  eligibility_self_certify: '(meet|qualify).*eligibility.*requirements',
  understand_disqualification: 'understand.*may\\s*be\\s*disqualif',
})

export async function authorizeAttestation(db, {
  userId, profileId, category, pattern = null, authorizationText, metadata = {},
} = {}) {
  if (!db || !userId || !profileId) throw new Error('userId and profileId required')
  if (!ATTESTATION_CATEGORIES.includes(category)) {
    throw new Error(`invalid category: ${category}`)
  }
  if (!authorizationText) throw new Error('authorizationText required')
  await ensureSchema(db)
  const finalPattern = String(pattern || SEED_PATTERNS[category] || '').trim()
  if (!finalPattern) throw new Error('pattern required')
  // Validate the pattern compiles.
  try { new RegExp(finalPattern, 'i') } catch { throw new Error('pattern must be a valid regex') }

  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare(
    `SELECT id FROM hamilton_attestation_authorizations
      WHERE user_id = ? AND profile_id = ? AND category = ? AND revoked_at IS NULL
      ORDER BY approved_at DESC LIMIT 1`,
  ).get(String(userId), String(profileId), category)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_attestation_authorizations
          SET pattern = ?, authorization_text = ?, metadata_json = ?,
              approved_at = ${nowFn}, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(finalPattern, authorizationText, JSON.stringify(metadata || {}), existing.id)
    return rowToAuth(await db.prepare('SELECT * FROM hamilton_attestation_authorizations WHERE id = ?').get(existing.id))
  }
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO hamilton_attestation_authorizations
        (id, user_id, profile_id, category, pattern, authorization_text, approved_at, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ${nowFn}, ?, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(userId), String(profileId), category, finalPattern, authorizationText,
    JSON.stringify(metadata || {}),
  )
  return rowToAuth(await db.prepare('SELECT * FROM hamilton_attestation_authorizations WHERE id = ?').get(id))
}

export async function revokeAttestation(db, id, reason = null) {
  if (!db || !id) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_attestation_authorizations
        SET revoked_at = ${nowFn}, updated_at = ${nowFn}, metadata_json = ?
      WHERE id = ?`,
  ).run(JSON.stringify({ revoked_reason: reason || 'user_revoked' }), String(id))
  return rowToAuth(await db.prepare('SELECT * FROM hamilton_attestation_authorizations WHERE id = ?').get(String(id)))
}

// Fetch one attestation authorization by id (includes profile_id for
// ownership checks before revoke). Null when not found.
export async function getAttestationById(db, id) {
  if (!db || !id) return null
  await ensureSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_attestation_authorizations WHERE id = ?').get(String(id))
  return row ? rowToAuth(row) : null
}

export async function listActiveAttestations(db, profileId) {
  if (!db || !profileId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_attestation_authorizations
      WHERE profile_id = ? AND revoked_at IS NULL ORDER BY approved_at DESC`,
  ).all(String(profileId))
  return (rows || []).map(rowToAuth)
}

/**
 * Decide whether a given attestation label text is auto-tickable for
 * this profile. Returns { allowed: boolean, category?, authorization? }.
 */
export async function isAttestationAllowed(db, { profileId, labelText } = {}) {
  if (!db || !profileId || !labelText) return { allowed: false, reason: 'missing_inputs' }
  const list = await listActiveAttestations(db, profileId)
  for (const auth of list) {
    try {
      if (new RegExp(auth.pattern, 'i').test(labelText)) {
        return { allowed: true, category: auth.category, authorization: auth }
      }
    } catch { /* skip malformed pattern */ }
  }
  return { allowed: false, reason: 'no_matching_authorization' }
}

export const ATTESTATION_SEED_PATTERNS = SEED_PATTERNS
