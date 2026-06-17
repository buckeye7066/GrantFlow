/**
 * profilePricingInitializer.js
 *
 * Single entry point that turns a freshly-created profile (regardless of
 * how it was created — Anya intake, manual signup, organization profile,
 * imported, or admin-created) into:
 *
 *   1. a `pricing_quote` row + line items + (admin-pending) discounts
 *   2. a `profile_pricing` row that owns the access gate's status
 *   3. a `service_agreements` row that records the required acceptance
 *   4. an `admin_pricing_notifications` row queued for the only admin
 *      (buckeye7066@gmail.com — overridable via env)
 *   5. one or two `payment_access_events` rows so Sam can audit the
 *      sequence end-to-end.
 *
 * The function is idempotent: calling it twice for the same profile
 * updates the existing rows rather than creating duplicates. Graceful
 * degradation: if the migrations have not been run yet, every step
 * returns `{ ok: false, error: 'pricing_tables_not_installed' }`
 * instead of throwing.
 *
 * Admin profiles are still priced (so the catalog history is honored)
 * but their `profile_pricing` row is created with
 * `access_status='admin_waived'` and the admin notification is suppressed.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import {
  ACCESS_STATUS,
  ADMIN_NOTIFICATION_STATUS,
  ADMIN_NOTIFICATION_TYPE,
  PAYMENT_ACCESS_EVENT,
  PRICING_ENV_KEYS,
  QUOTE_STATUS,
  SERVICE_AGREEMENT_VERSION,
  adminNotificationEmail,
  isAdminNotificationTarget,
  readEnvFlag,
  toCents,
} from './pricingTypes.js'
import { buildRecommendedQuote } from './pricingEngine.js'
import { persistQuote } from './quoteBuilder.js'

const PROFILE_PRICING_TABLE = 'profile_pricing'
const SERVICE_AGREEMENTS_TABLE = 'service_agreements'
const PAYMENT_EVENTS_TABLE = 'payment_access_events'
const ADMIN_NOTIFICATIONS_TABLE = 'admin_pricing_notifications'

function isPg(db) {
  return db?.dialect === 'pg' || db?.dialect === 'postgres'
}

function jsonOut(db, value) {
  return isPg(db) ? value : JSON.stringify(value ?? null)
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function nowIso() {
  return new Date().toISOString()
}

async function tableExists(db, table) {
  if (!db) return false
  try {
    if (isPg(db)) {
      const r = await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1").get(table)
      return Boolean(r)
    }
    const r = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(table)
    return Boolean(r)
  } catch {
    return false
  }
}

async function preflight(db) {
  const tables = [PROFILE_PRICING_TABLE, SERVICE_AGREEMENTS_TABLE, PAYMENT_EVENTS_TABLE, ADMIN_NOTIFICATIONS_TABLE]
  for (const t of tables) {
    if (!(await tableExists(db, t))) return false
  }
  return true
}

/**
 * Build a discount-summary blob the admin toast can render without
 * exposing raw intake answers. We list each discount the user looks
 * eligible for + whether it's been admin-approved yet.
 */
export function summariseDiscounts(quote) {
  const discounts = quote?.discounts || []
  return {
    eligible: discounts.length > 0,
    count: discounts.length,
    items: discounts.map((d) => ({
      discount_key: d.discount_key,
      label: d.label,
      suggested_amount_cents: toCents(d.amount || 0),
      requires_admin_approval: Boolean(d.requires_admin_approval),
      approved: Boolean(d.approved),
      reason: d.reason || '',
    })),
  }
}

/**
 * Decide the access_status the new `profile_pricing` row should start
 * with. Admin profiles bypass; non-admins start `pending_agreement`
 * unless the quote requires admin review first.
 */
export function decideInitialAccessStatus({ isAdmin, quote }) {
  if (isAdmin) return ACCESS_STATUS.ADMIN_WAIVED
  if (quote?.admin_review_required) return ACCESS_STATUS.PENDING_PRICING
  if (Number(quote?.total || 0) <= 0) return ACCESS_STATUS.ACTIVE_PAID // free package
  return ACCESS_STATUS.PENDING_AGREEMENT
}

/**
 * Decide the quote status that pairs with the access status.
 */
export function decideInitialQuoteStatus({ isAdmin, quote }) {
  if (isAdmin) return QUOTE_STATUS.ADMIN_WAIVED
  if (quote?.admin_review_required) return QUOTE_STATUS.PENDING_ADMIN_REVIEW
  return QUOTE_STATUS.PENDING_USER_AGREEMENT
}

async function loadProfilePricing(db, profileId) {
  if (!(await tableExists(db, PROFILE_PRICING_TABLE))) return null
  return withProfileScope({ bypass: true }, () =>
    db.prepare(`SELECT * FROM ${PROFILE_PRICING_TABLE} WHERE profile_id = ?`).get(profileId),
  )
}

async function upsertProfilePricing(db, payload) {
  const {
    profileId,
    userId,
    quoteId,
    pricingCatalogVersion,
    clientCategory,
    categoryConfidence,
    recommendedPackageName,
    primaryServiceKey,
    subtotalCents,
    discountTotalCents,
    totalCents,
    currency,
    paymentRequired,
    agreementRequired,
    accessStatus,
    adminReviewRequired,
    discountEligible,
    discountSummary,
    reasons,
    missingInputs,
  } = payload

  return withProfileScope({ bypass: true }, async () => {
    const existing = await db.prepare(`SELECT id FROM ${PROFILE_PRICING_TABLE} WHERE profile_id = ?`).get(profileId)
    if (existing) {
      const updateFields = [
        'user_id = ?',
        'quote_id = ?',
        'pricing_catalog_version = ?',
        'client_category = ?',
        'category_confidence = ?',
        'recommended_package_name = ?',
        'primary_service_key = ?',
        'subtotal_cents = ?',
        'discount_total_cents = ?',
        'total_cents = ?',
        'currency = ?',
        'payment_required = ?',
        'agreement_required = ?',
        'access_status = ?',
        'admin_review_required = ?',
        'discount_eligible = ?',
        'discount_summary_json = ?',
        'reasons_json = ?',
        'missing_inputs_json = ?',
        'updated_at = ?',
      ]
      const sql = isPg(db)
        ? rebuildPgFields(updateFields)
        : `UPDATE ${PROFILE_PRICING_TABLE} SET ${updateFields.join(', ')} WHERE profile_id = ?`
      await db.prepare(sql).run(
        userId,
        quoteId,
        pricingCatalogVersion,
        clientCategory,
        categoryConfidence,
        recommendedPackageName,
        primaryServiceKey,
        subtotalCents,
        discountTotalCents,
        totalCents,
        currency,
        paymentRequired ? 1 : 0,
        agreementRequired ? 1 : 0,
        accessStatus,
        adminReviewRequired ? 1 : 0,
        discountEligible ? 1 : 0,
        jsonOut(db, discountSummary || null),
        jsonOut(db, reasons || []),
        jsonOut(db, missingInputs || []),
        nowIso(),
        profileId,
      )
      return { id: existing.id, created: false }
    }
    const id = makeId('pp')
    const ph = isPg(db)
      ? Array.from({ length: 21 }, (_, i) => `$${i + 1}`)
      : Array(21).fill('?')
    await db.prepare(
      `INSERT INTO ${PROFILE_PRICING_TABLE}
        (id, profile_id, user_id, quote_id, pricing_catalog_version,
         client_category, category_confidence, recommended_package_name,
         primary_service_key, subtotal_cents, discount_total_cents, total_cents,
         currency, payment_required, agreement_required, access_status,
         admin_review_required, discount_eligible, discount_summary_json,
         reasons_json, missing_inputs_json)
       VALUES (${ph.join(',')})`,
    ).run(
      id,
      profileId,
      userId,
      quoteId,
      pricingCatalogVersion,
      clientCategory,
      categoryConfidence,
      recommendedPackageName,
      primaryServiceKey,
      subtotalCents,
      discountTotalCents,
      totalCents,
      currency,
      paymentRequired ? 1 : 0,
      agreementRequired ? 1 : 0,
      accessStatus,
      adminReviewRequired ? 1 : 0,
      discountEligible ? 1 : 0,
      jsonOut(db, discountSummary || null),
      jsonOut(db, reasons || []),
      jsonOut(db, missingInputs || []),
    )
    return { id, created: true }
  })
}

function rebuildPgFields(fields) {
  // For Postgres we rewrite the placeholders so they're $1..$N; SQLite uses
  // unnamed `?` placeholders. We don't actually re-emit Postgres SQL when
  // running through better-sqlite3 in tests — `isPg` is false there.
  let i = 1
  const parts = fields.map((f) => f.replace('?', () => `$${i++}`))
  const where = `$${i}`
  return `UPDATE ${PROFILE_PRICING_TABLE} SET ${parts.join(', ')} WHERE profile_id = ${where}`
}

async function ensureServiceAgreement(db, { profileId, userId, quoteId }) {
  return withProfileScope({ bypass: true }, async () => {
    const existing = await db.prepare(
      `SELECT id, accepted FROM ${SERVICE_AGREEMENTS_TABLE} WHERE profile_id = ? AND agreement_version = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(profileId, SERVICE_AGREEMENT_VERSION)
    if (existing) return existing
    const id = makeId('sa')
    const ph = isPg(db) ? Array.from({ length: 5 }, (_, i) => `$${i + 1}`) : Array(5).fill('?')
    await db.prepare(
      `INSERT INTO ${SERVICE_AGREEMENTS_TABLE}
        (id, user_id, profile_id, quote_id, agreement_version)
       VALUES (${ph.join(',')})`,
    ).run(id, userId, profileId, quoteId, SERVICE_AGREEMENT_VERSION)
    return { id, accepted: 0 }
  })
}

export async function recordPaymentAccessEvent(db, { userId, profileId, quoteId, eventType, details }) {
  if (!(await tableExists(db, PAYMENT_EVENTS_TABLE))) return null
  return withProfileScope({ bypass: true }, async () => {
    const id = makeId('pae')
    const ph = isPg(db) ? Array.from({ length: 6 }, (_, i) => `$${i + 1}`) : Array(6).fill('?')
    await db.prepare(
      `INSERT INTO ${PAYMENT_EVENTS_TABLE}
        (id, user_id, profile_id, quote_id, event_type, details_json)
       VALUES (${ph.join(',')})`,
    ).run(id, userId, profileId, quoteId, eventType, jsonOut(db, details || {}))
    return id
  })
}

async function queueAdminNotification(db, { userId, profileId, quoteId, quote, profile }) {
  if (!readEnvFlag(PRICING_ENV_KEYS.PRICING_ADMIN_TOASTS_ENABLED, true)) return null
  const adminEmail = adminNotificationEmail()
  const subject =
    profile?.display_name ||
    profile?.name ||
    profile?.organization_name ||
    'New GrantFlow client'
  const totalDollars = Number(quote.total || 0)
  const discountInfo = quote.discount_eligible
    ? (quote.discounts || []).map((d) => d.label).join(', ') || 'pending review'
    : 'None'
  const body = [
    `${subject} was priced at $${totalDollars.toLocaleString()} for ${quote.recommended_package_name}.`,
    `Discount eligible: ${quote.discount_eligible ? 'Yes' : 'No'}.`,
    `Discount: ${discountInfo}.`,
  ].join(' ')

  return withProfileScope({ bypass: true }, async () => {
    const id = makeId('apn')
    const ph = isPg(db) ? Array.from({ length: 9 }, (_, i) => `$${i + 1}`) : Array(9).fill('?')
    await db.prepare(
      `INSERT INTO ${ADMIN_NOTIFICATIONS_TABLE}
        (id, admin_email, user_id, profile_id, quote_id, notification_type,
         title, body, payload_json)
       VALUES (${ph.join(',')})`,
    ).run(
      id,
      adminEmail,
      userId,
      profileId,
      quoteId,
      ADMIN_NOTIFICATION_TYPE.NEW_USER_PRICING,
      'New GrantFlow client priced',
      body,
      jsonOut(db, {
        client_category: quote.client_category,
        recommended_package_name: quote.recommended_package_name,
        primary_service_key: quote.primary_service_key,
        total_cents: toCents(quote.total),
        admin_review_required: quote.admin_review_required,
        discount_eligible: quote.discount_eligible,
        currency: quote.currency,
      }),
    )
    return id
  })
}

/**
 * Initialize automatic pricing for a profile.
 *
 * @param {object} db    — DB handle (better-sqlite3 in tests, pg in prod)
 * @param {object} args
 * @param {object} args.profile          — the freshly-created profile row
 * @param {object} [args.intakeAnswers]  — Anya intake answers, if any
 * @param {object} [args.organization]   — separate org payload, if any
 * @param {object} [args.matches]        — pre-computed funding matches, if any
 * @param {object} [args.user]           — { id, email, is_admin } of the user whose profile this is
 * @param {object} [args.discountInputs] — discount-eligibility hints from intake
 * @param {string} [args.intakeSessionId]
 * @param {string} [args.source]         — e.g. 'anya_onboarding', 'manual_profile', 'organization_profile', 'imported', 'admin_created'
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   profile_pricing_id?: string,
 *   quote_id?: string,
 *   access_status?: string,
 *   admin_notification_id?: string|null,
 *   agreement_id?: string,
 *   error?: string,
 *   created?: boolean,
 * }>}
 */
export async function initializeProfilePricing(db, args = {}) {
  const {
    profile = {},
    intakeAnswers = {},
    organization = {},
    matches = [],
    user = null,
    discountInputs = {},
    intakeSessionId = null,
    source = 'unspecified',
  } = args
  const profileId = profile?.id
  if (!profileId) return { ok: false, error: 'profile_id_required' }
  if (!(await preflight(db))) return { ok: false, error: 'pricing_tables_not_installed' }

  const isAdmin = Boolean(user?.is_admin || isAdminNotificationTarget(user?.email))

  const quote = buildRecommendedQuote({
    profile,
    intakeAnswers,
    organization,
    matches,
    discountInputs,
  })

  const initialQuoteStatus = decideInitialQuoteStatus({ isAdmin, quote })
  const persisted = await persistQuote(db, {
    userId: user?.id || null,
    profileId,
    intakeSessionId,
    quote,
    status: initialQuoteStatus,
  })
  if (!persisted?.ok) {
    return { ok: false, error: persisted?.error || 'persist_quote_failed' }
  }

  const accessStatus = decideInitialAccessStatus({ isAdmin, quote })
  const profilePricing = await upsertProfilePricing(db, {
    profileId,
    userId: user?.id || null,
    quoteId: persisted.id,
    pricingCatalogVersion: quote.pricing_catalog_version,
    clientCategory: quote.client_category,
    categoryConfidence: quote.category_confidence,
    recommendedPackageName: quote.recommended_package_name,
    primaryServiceKey: quote.primary_service_key,
    subtotalCents: toCents(quote.subtotal),
    discountTotalCents: toCents(quote.discount_total),
    totalCents: toCents(quote.total),
    currency: quote.currency,
    paymentRequired: !isAdmin && quote.user_payment_required,
    agreementRequired: !isAdmin,
    accessStatus,
    adminReviewRequired: quote.admin_review_required,
    discountEligible: quote.discount_eligible,
    discountSummary: summariseDiscounts(quote),
    reasons: quote.reasons,
    missingInputs: quote.missing_pricing_inputs,
  })

  let agreementId = null
  if (!isAdmin) {
    const ag = await ensureServiceAgreement(db, {
      profileId,
      userId: user?.id || null,
      quoteId: persisted.id,
    })
    agreementId = ag?.id || null
  }

  let adminNotificationId = null
  if (!isAdmin) {
    adminNotificationId = await queueAdminNotification(db, {
      userId: user?.id || null,
      profileId,
      quoteId: persisted.id,
      quote,
      profile,
    })
  }

  await recordPaymentAccessEvent(db, {
    userId: user?.id || null,
    profileId,
    quoteId: persisted.id,
    eventType: PAYMENT_ACCESS_EVENT.PRICING_CREATED,
    details: { source, is_admin: isAdmin, total_cents: toCents(quote.total) },
  })

  if (adminNotificationId) {
    await recordPaymentAccessEvent(db, {
      userId: user?.id || null,
      profileId,
      quoteId: persisted.id,
      eventType: PAYMENT_ACCESS_EVENT.ADMIN_NOTIFIED,
      details: { admin_email: adminNotificationEmail(), notification_id: adminNotificationId },
    })
  }

  return {
    ok: true,
    profile_pricing_id: profilePricing.id,
    quote_id: persisted.id,
    access_status: accessStatus,
    admin_notification_id: adminNotificationId,
    agreement_id: agreementId,
    created: profilePricing.created,
  }
}

/**
 * Read the latest profile_pricing row for a profile (or null if not initialised).
 */
export async function getProfilePricing(db, profileId) {
  return loadProfilePricing(db, profileId)
}

/**
 * Mark a profile as admin-waived. Records an event so Sam can audit it.
 */
export async function adminWaiveProfile(db, profileId, { actor }) {
  if (!(await tableExists(db, PROFILE_PRICING_TABLE))) {
    return { ok: false, error: 'pricing_tables_not_installed' }
  }
  return withProfileScope({ bypass: true }, async () => {
    await db.prepare(
      `UPDATE ${PROFILE_PRICING_TABLE}
        SET access_status = ?, admin_review_required = 0, payment_required = 0,
            agreement_required = 0, updated_at = ?
       WHERE profile_id = ?`,
    ).run(ACCESS_STATUS.ADMIN_WAIVED, nowIso(), profileId)
    const pricing = await loadProfilePricing(db, profileId)
    await recordPaymentAccessEvent(db, {
      userId: pricing?.user_id || null,
      profileId,
      quoteId: pricing?.quote_id || null,
      eventType: PAYMENT_ACCESS_EVENT.ADMIN_WAIVED,
      details: { actor: actor?.email || actor?.id || 'unknown' },
    })
    return { ok: true, access_status: ACCESS_STATUS.ADMIN_WAIVED }
  })
}

export {
  PROFILE_PRICING_TABLE,
  SERVICE_AGREEMENTS_TABLE,
  PAYMENT_EVENTS_TABLE,
  ADMIN_NOTIFICATIONS_TABLE,
}
