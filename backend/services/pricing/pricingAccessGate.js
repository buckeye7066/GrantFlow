/**
 * pricingAccessGate.js
 *
 * Single source of truth for "should this (principal, profile) be allowed
 * past the agreement+payment gate?". Used by:
 *
 *   - GET /api/access-gate/status   (frontend uses this to decide
 *     whether to render the app or redirect to /PricingRequired)
 *   - <RequirePaidAccess>          (HOC that calls the same endpoint)
 *   - samPricingGateAuditor        (audits leaks + admin blocks)
 *
 * Pure decision function `decideAccess({ principal, pricing, agreement })`
 * has no IO. The DB-backed `getAccessStatus(db, …)` adds the lookup +
 * agreement check and is what the route uses.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import {
  ACCESS_STATUS,
  PRICING_ENV_KEYS,
  SERVICE_AGREEMENT_VERSION,
  readEnvFlag,
} from './pricingTypes.js'
import {
  getProfilePricing,
  PROFILE_PRICING_TABLE,
  SERVICE_AGREEMENTS_TABLE,
} from './profilePricingInitializer.js'

/**
 * Routes whose unauthenticated/unpaid access we deliberately allow. The
 * gate logic is centralized here so backend + frontend agree on the
 * allow-list.
 *
 * Match is prefix-based (case-sensitive in the path). Query strings are
 * ignored before comparison.
 */
export const ALWAYS_ALLOWED_ROUTES = Object.freeze([
  '/login',
  '/auth/callback',
  '/set-password',
  '/AnyaOnboarding',
  '/AnyaIntakeResults',
  '/Pricing',
  '/PricingRequired',
  '/ServiceAgreement',
  '/Checkout',
  '/CheckoutRequired',
  '/services',
  '/ServiceApplication',
  '/Help',
  '/Settings',
  '/Admin',
])

/**
 * Routes that explicitly require a paid (or waived) access. Used by
 * Sam's gate auditor — a leak is anyone with `access_granted=false`
 * who reached one of these paths.
 */
export const PAYMENT_GATED_ROUTES = Object.freeze([
  '/Dashboard',
  '/ProfileDetail',
  '/DiscoverGrants',
  '/FundingOpportunities',
  '/FundingResults',
  '/Pipeline',
  '/Documents',
  '/Apply',
  '/GrantDetail',
  '/Applications',
  '/Proposals',
  '/Outreach',
  '/Reports',
  '/AdvancedAnalytics',
  '/Calendar',
  '/Budgets',
  '/SmartMatcher',
  '/ItemFunding',
  '/NewProject',
  '/VNextApplication',
  '/VNextFinishPacket',
  '/SourceDirectory',
  '/SourceRegistry',
  '/Stewardship',
  '/Automation',
  '/InvoiceView',
  '/CreateInvoice',
])

export function isAlwaysAllowedPath(pathname) {
  if (!pathname) return false
  const path = String(pathname).split('?')[0]
  return ALWAYS_ALLOWED_ROUTES.some((p) => path === p || path.startsWith(`${p}/`))
}

export function isPaymentGatedPath(pathname) {
  if (!pathname) return false
  const path = String(pathname).split('?')[0]
  return PAYMENT_GATED_ROUTES.some((p) => path === p || path.startsWith(`${p}/`))
}

function isTrustedPrincipal(principal) {
  return principal?.identityResolved === true
}

function isCanonicalAdmin(principal) {
  return isTrustedPrincipal(principal) && principal?.isAdmin === true
}

function makeAgreementId() {
  return `sa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function getLatestServiceAgreement(db, profileId) {
  if (!profileId) return null
  return withProfileScope({ bypass: true }, () =>
    db.prepare(
      `SELECT * FROM ${SERVICE_AGREEMENTS_TABLE} WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(profileId),
  )
}

/**
 * Pure decision: takes a canonical, server-projected request principal + the
 * persisted profile_pricing + the latest service_agreements row. No IO.
 *
 * Callers must not pass raw JWT/user claims here. `identityResolved` and
 * `isAdmin` are projections of req.ctx, whose authority was resolved by the
 * backend request-context middleware.
 */
export function decideAccess({ principal, pricing, agreement } = {}) {
  if (!isTrustedPrincipal(principal)) {
    return {
      authenticated: false,
      is_admin: false,
      access_granted: false,
      blocking_reason: 'not_authenticated',
      payment_required: false,
      agreement_required: false,
      agreement_accepted: false,
      payment_status: 'unknown',
      checkout_available: false,
    }
  }
  const isAdmin = isCanonicalAdmin(principal)
  if (isAdmin) {
    return {
      authenticated: true,
      is_admin: true,
      access_granted: true,
      blocking_reason: null,
      payment_required: false,
      agreement_required: false,
      agreement_accepted: true,
      payment_status: 'admin_bypass',
      checkout_available: false,
    }
  }

  // No pricing row yet — gate not yet initialized.
  if (!pricing) {
    return {
      authenticated: true,
      is_admin: false,
      access_granted: false,
      blocking_reason: 'no_pricing_yet',
      payment_required: true,
      agreement_required: true,
      agreement_accepted: false,
      payment_status: 'pending_pricing',
      checkout_available: false,
    }
  }

  const status = String(pricing.access_status || ACCESS_STATUS.PENDING_PRICING)
  const requirePaymentEnv = readEnvFlag(PRICING_ENV_KEYS.PRICING_REQUIRE_PAYMENT_BEFORE_FULL_ACCESS, true)
  const agreementAccepted = Boolean(agreement?.accepted) || Number(agreement?.accepted) === 1

  if (status === ACCESS_STATUS.ACTIVE_PAID || status === ACCESS_STATUS.ADMIN_WAIVED) {
    return {
      authenticated: true,
      is_admin: false,
      access_granted: true,
      blocking_reason: null,
      payment_required: false,
      agreement_required: false,
      agreement_accepted: agreementAccepted,
      payment_status: status === ACCESS_STATUS.ADMIN_WAIVED ? 'admin_waived' : 'paid',
      checkout_available: false,
    }
  }

  if (status === ACCESS_STATUS.PENDING_PRICING) {
    return {
      authenticated: true,
      is_admin: false,
      access_granted: false,
      blocking_reason: 'admin_review_required',
      payment_required: true,
      agreement_required: true,
      agreement_accepted: agreementAccepted,
      payment_status: 'pending_admin_review',
      checkout_available: false,
    }
  }

  if (status === ACCESS_STATUS.PENDING_AGREEMENT) {
    return {
      authenticated: true,
      is_admin: false,
      access_granted: false,
      blocking_reason: 'agreement_required',
      payment_required: requirePaymentEnv,
      agreement_required: true,
      agreement_accepted: false,
      payment_status: 'pending_agreement',
      checkout_available: false,
    }
  }

  if (status === ACCESS_STATUS.PENDING_PAYMENT) {
    return {
      authenticated: true,
      is_admin: false,
      access_granted: false,
      blocking_reason: 'payment_required',
      payment_required: true,
      agreement_required: false,
      agreement_accepted: agreementAccepted,
      payment_status: 'pending_payment',
      checkout_available: true,
    }
  }

  if (status === ACCESS_STATUS.BLOCKED || status === ACCESS_STATUS.EXPIRED) {
    return {
      authenticated: true,
      is_admin: false,
      access_granted: false,
      blocking_reason: status,
      payment_required: true,
      agreement_required: false,
      agreement_accepted: agreementAccepted,
      payment_status: status,
      checkout_available: false,
    }
  }

  // Defensive default: block.
  return {
    authenticated: true,
    is_admin: false,
    access_granted: false,
    blocking_reason: 'unknown_status',
    payment_required: true,
    agreement_required: true,
    agreement_accepted: agreementAccepted,
    payment_status: status,
    checkout_available: false,
  }
}

async function tableExists(db, table) {
  if (!db) return false
  try {
    if (db.dialect === 'pg' || db.dialect === 'postgres') {
      const r = await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1").get(table)
      return Boolean(r)
    }
    const r = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(table)
    return Boolean(r)
  } catch {
    return false
  }
}

/**
 * Loads pricing + latest agreement from the DB and runs `decideAccess`.
 * Used by /api/access-gate/status.
 */
export async function getAccessStatus(db, { principal, profileId } = {}) {
  // No DB or migrations not run → admin always allowed; non-admin blocked.
  if (!db || !(await tableExists(db, PROFILE_PRICING_TABLE))) {
    const isAdmin = isCanonicalAdmin(principal)
    if (!isTrustedPrincipal(principal)) {
      return {
        authenticated: false,
        is_admin: false,
        access_granted: false,
        blocking_reason: 'not_authenticated',
        payment_required: false,
        agreement_required: false,
        agreement_accepted: false,
        payment_status: 'unknown',
        checkout_available: false,
        installed: false,
      }
    }
    if (isAdmin) {
      return {
        authenticated: true,
        is_admin: true,
        access_granted: true,
        blocking_reason: null,
        payment_required: false,
        agreement_required: false,
        agreement_accepted: true,
        payment_status: 'admin_bypass',
        checkout_available: false,
        installed: false,
      }
    }
    return {
      authenticated: true,
      is_admin: false,
      access_granted: false,
      blocking_reason: 'pricing_tables_not_installed',
      payment_required: true,
      agreement_required: true,
      agreement_accepted: false,
      payment_status: 'unknown',
      checkout_available: false,
      installed: false,
    }
  }
  const pricing = profileId ? await getProfilePricing(db, profileId) : null
  const agreement = pricing ? await getLatestServiceAgreement(db, profileId) : null
  const decision = decideAccess({ principal, pricing, agreement })
  return {
    ...decision,
    profile_id: profileId || null,
    quote_id: pricing?.quote_id || null,
    access_status: pricing?.access_status || null,
    pricing_catalog_version: pricing?.pricing_catalog_version || null,
    recommended_package_name: pricing?.recommended_package_name || null,
    primary_service_key: pricing?.primary_service_key || null,
    total_cents: pricing?.total_cents || 0,
    discount_eligible: Number(pricing?.discount_eligible || 0) === 1,
    installed: true,
  }
}

/**
 * Convenience: mark agreement accepted and bump access_status from
 * PENDING_AGREEMENT → PENDING_PAYMENT (or ACTIVE_PAID for free packages).
 */
export async function acceptAgreement(db, { profileId, userId, ip, userAgent, agreementText }) {
  if (!(await tableExists(db, SERVICE_AGREEMENTS_TABLE))) {
    return { ok: false, error: 'pricing_tables_not_installed' }
  }
  const runInTx =
    db && typeof db.withTransaction === 'function'
      ? (work) => db.withTransaction(work)
      : async (work) => work(db)
  return runInTx((tx) => withProfileScope({ bypass: true }, async () => {
    const now = new Date().toISOString()
    const pricing = await getProfilePricing(tx, profileId)
    if (!pricing) return { ok: false, error: 'no_pricing' }
    let agreement = await getLatestServiceAgreement(tx, profileId)
    if (!agreement) {
      const agreementId = makeAgreementId()
      await tx.prepare(
        `INSERT INTO ${SERVICE_AGREEMENTS_TABLE}
          (id, user_id, profile_id, quote_id, agreement_version)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        agreementId,
        userId || pricing.user_id || null,
        profileId,
        pricing.quote_id || null,
        SERVICE_AGREEMENT_VERSION,
      )
      agreement = { id: agreementId, user_id: userId || pricing.user_id || null, quote_id: pricing.quote_id || null }
    }
    const updateResult = await tx.prepare(
      `UPDATE ${SERVICE_AGREEMENTS_TABLE}
          SET user_id = COALESCE(user_id, ?),
              quote_id = COALESCE(quote_id, ?),
              accepted = 1,
              accepted_at = ?,
              accepted_ip = ?,
              accepted_user_agent = ?,
              agreement_text_snapshot = COALESCE(agreement_text_snapshot, ?)
        WHERE id = ?`,
    ).run(
      userId || null,
      pricing.quote_id || agreement?.quote_id || null,
      now,
      ip || null,
      userAgent || null,
      agreementText || null,
      agreement.id,
    )
    if (!Number(updateResult?.changes || 0)) return { ok: false, error: 'agreement_not_found' }
    let nextStatus = pricing.access_status
    if (Number(pricing.total_cents) === 0) nextStatus = ACCESS_STATUS.ACTIVE_PAID
    else if (pricing.access_status === ACCESS_STATUS.PENDING_AGREEMENT) nextStatus = ACCESS_STATUS.PENDING_PAYMENT
    if (nextStatus !== pricing.access_status) {
      await tx.prepare(
        `UPDATE ${PROFILE_PRICING_TABLE} SET access_status = ?, updated_at = ? WHERE profile_id = ?`,
      ).run(nextStatus, now, profileId)
    }
    return { ok: true, access_status: nextStatus }
  }))
}

/**
 * Convenience: flip access_status to ACTIVE_PAID after Stripe webhook
 * confirms payment.
 */
export async function markPaid(db, { profileId }) {
  if (!(await tableExists(db, PROFILE_PRICING_TABLE))) {
    return { ok: false, error: 'pricing_tables_not_installed' }
  }
  return withProfileScope({ bypass: true }, async () => {
    await db.prepare(
      `UPDATE ${PROFILE_PRICING_TABLE} SET access_status = ?, updated_at = ? WHERE profile_id = ?`,
    ).run(ACCESS_STATUS.ACTIVE_PAID, new Date().toISOString(), profileId)
    return { ok: true, access_status: ACCESS_STATUS.ACTIVE_PAID }
  })
}
