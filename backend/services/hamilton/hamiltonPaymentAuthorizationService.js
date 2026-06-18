/**
 * hamiltonPaymentAuthorizationService.js
 *
 * Pre-authorized payment categories. The user (or admin) approves a
 * spending envelope ahead of time:
 *
 *   - category   ('application_fee', 'transcript_fee', ...)
 *   - max amount per single charge
 *   - currency
 *   - PCI-compliant payment_method_reference (Stripe pm_xxx, etc.)
 *   - allowed portal hosts (NULL = any)
 *   - expiry date (optional)
 *
 * Hamilton NEVER:
 *   - stores raw card data
 *   - charges anything outside the authorized envelope
 *   - submits payment without a valid authorization id on record
 *
 * Each charge writes a `hamilton_blocker_resolution` row (handled by the
 * resolver, not here) so every cent Hamilton spends is auditable.
 */

import crypto from 'node:crypto'

export const PAYMENT_CATEGORIES = Object.freeze([
  'application_fee',
  'transcript_fee',
  'portal_fee',
  'test_score_send_fee',
  'postage',
  'fax_fee',
  'other',
])

let ensured = false
export function _resetPaymentSchemaCache() { ensured = false }

async function ensureSchema(db) {
  if (!db || ensured || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_payment_authorizations (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      category TEXT NOT NULL,
      max_amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      payment_method_reference TEXT,
      payment_method_label TEXT,
      allowed_portal_hosts TEXT,
      authorization_text TEXT NOT NULL,
      spent_cents INTEGER NOT NULL DEFAULT 0,
      approved_at ${tsType} DEFAULT ${nowFn},
      revoked_at ${tsType},
      expires_at ${tsType},
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_pay_profile ON hamilton_payment_authorizations(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_pay_active  ON hamilton_payment_authorizations(profile_id, category, revoked_at);
  `)
  ensured = true
}

function jsonOrEmpty(v) {
  if (!v) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return {} }
}

function rowToAuth(row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id,
    profile_id: row.profile_id,
    category: row.category,
    max_amount_cents: Number(row.max_amount_cents),
    currency: row.currency,
    payment_method_reference: row.payment_method_reference || null,
    payment_method_label: row.payment_method_label || null,
    allowed_portal_hosts: row.allowed_portal_hosts
      ? String(row.allowed_portal_hosts).split(',').map((s) => s.trim()).filter(Boolean)
      : [],
    authorization_text: row.authorization_text,
    spent_cents: Number(row.spent_cents || 0),
    approved_at: row.approved_at,
    revoked_at: row.revoked_at || null,
    expires_at: row.expires_at || null,
    metadata: jsonOrEmpty(row.metadata_json),
  }
}

/**
 * Record a pre-authorization. Returns the inserted row.
 */
export async function authorizePayment(db, {
  userId, profileId,
  category, maxAmountCents, currency = 'USD',
  paymentMethodReference = null, paymentMethodLabel = null,
  allowedPortalHosts = [],
  authorizationText,
  expiresAt = null, metadata = {},
} = {}) {
  if (!db) throw new Error('db required')
  if (!userId || !profileId) throw new Error('userId and profileId required')
  if (!PAYMENT_CATEGORIES.includes(category)) throw new Error(`invalid category: ${category}`)
  if (!Number.isFinite(Number(maxAmountCents)) || Number(maxAmountCents) <= 0) {
    throw new Error('maxAmountCents must be a positive integer')
  }
  if (!authorizationText) throw new Error('authorizationText required')
  // Reject anything that looks like raw card data — strip spaces and
  // dashes before checking so "4111 1111 1111 1111" trips the guard.
  const cardCheck = `${paymentMethodLabel || ''} ${paymentMethodReference || ''}`.replace(/[\s-]/g, '')
  if (/\d{13,19}/.test(cardCheck)) {
    throw new Error('payment_method_reference must be a tokenised reference, not raw card data')
  }
  await ensureSchema(db)
  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO hamilton_payment_authorizations
        (id, user_id, profile_id, category, max_amount_cents, currency,
         payment_method_reference, payment_method_label, allowed_portal_hosts,
         authorization_text, expires_at, metadata_json, approved_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(userId), String(profileId), category,
    Math.floor(Number(maxAmountCents)), currency,
    paymentMethodReference, paymentMethodLabel,
    Array.isArray(allowedPortalHosts) && allowedPortalHosts.length > 0
      ? allowedPortalHosts.join(',')
      : null,
    authorizationText, expiresAt,
    JSON.stringify(metadata || {}),
  )
  return rowToAuth(await db.prepare('SELECT * FROM hamilton_payment_authorizations WHERE id = ?').get(id))
}

/**
 * Determine whether Hamilton may charge `amount_cents` to `category` for
 * `portalHost` on this profile. Returns:
 *
 *   { allowed: true, authorization }                             — go
 *   { allowed: false, reason, authorization?: ... }              — stop
 */
export async function canPayFor(db, {
  profileId, category, amountCents, portalHost = null,
} = {}) {
  if (!db || !profileId || !category) return { allowed: false, reason: 'missing_inputs' }
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_payment_authorizations
      WHERE profile_id = ? AND category = ? AND revoked_at IS NULL
      ORDER BY approved_at DESC`,
  ).all(String(profileId), category)
  const cents = Math.floor(Number(amountCents) || 0)
  for (const r of rows || []) {
    const auth = rowToAuth(r)
    if (auth.expires_at && new Date(auth.expires_at).getTime() < Date.now()) continue
    if (cents > auth.max_amount_cents) continue
    if (auth.spent_cents + cents > auth.max_amount_cents) continue
    if (auth.allowed_portal_hosts.length > 0 && portalHost) {
      const host = String(portalHost).toLowerCase()
      if (!auth.allowed_portal_hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue
    }
    return { allowed: true, authorization: auth }
  }
  if ((rows || []).length === 0) {
    return { allowed: false, reason: 'no_authorization_for_category' }
  }
  return { allowed: false, reason: 'amount_or_host_outside_authorization' }
}

export async function recordCharge(db, {
  authorizationId, amountCents, taskId = null,
  portalHost = null, processorReceipt = null, metadata = {},
} = {}) {
  if (!db || !authorizationId) throw new Error('authorizationId required')
  if (!Number.isFinite(Number(amountCents)) || Number(amountCents) < 0) {
    throw new Error('amountCents required')
  }
  await ensureSchema(db)
  const cents = Math.floor(Number(amountCents))
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_payment_authorizations
        SET spent_cents = spent_cents + ?, updated_at = ${nowFn},
            metadata_json = ?
      WHERE id = ?`,
  ).run(
    cents,
    JSON.stringify({
      ...(metadata || {}),
      last_receipt: processorReceipt || null,
      last_task_id: taskId || null,
      last_portal_host: portalHost || null,
      last_charge_at: new Date().toISOString(),
    }),
    String(authorizationId),
  )
  return rowToAuth(await db.prepare('SELECT * FROM hamilton_payment_authorizations WHERE id = ?').get(String(authorizationId)))
}

export async function revokePaymentAuthorization(db, id, reason = null) {
  if (!db || !id) return null
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_payment_authorizations
        SET revoked_at = ${nowFn}, updated_at = ${nowFn}, metadata_json = ?
      WHERE id = ?`,
  ).run(JSON.stringify({ revoked_reason: reason || 'user_revoked' }), String(id))
  return rowToAuth(await db.prepare('SELECT * FROM hamilton_payment_authorizations WHERE id = ?').get(String(id)))
}

// Fetch one payment authorization by id (includes profile_id for ownership
// checks before revoke). Null when not found.
export async function getPaymentAuthorizationById(db, id) {
  if (!db || !id) return null
  await ensureSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_payment_authorizations WHERE id = ?').get(String(id))
  return row ? rowToAuth(row) : null
}

export async function listPaymentAuthorizations(db, profileId) {
  if (!db || !profileId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_payment_authorizations
      WHERE profile_id = ? ORDER BY approved_at DESC`,
  ).all(String(profileId))
  return (rows || []).map(rowToAuth)
}
