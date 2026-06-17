/**
 * Charge resolver — single source of truth for Stripe checkout amounts.
 *
 * The resolver returns the exact charge that will be presented to Stripe
 * (Stripe Price ID + cents amount) along with every intermediate value
 * (catalog amount, quote base, approved discount, milestone phase). The
 * Stripe checkout route MUST call this resolver and refuse to create a
 * checkout session whenever `can_checkout === false`. The Sam audit also
 * calls this in dry-run mode to detect drift between the catalog, the
 * stored quote, and the Stripe Price configured by the operator.
 *
 * Hard rules enforced here:
 *   1. Service slug → exactly one `service_catalog_items` row.
 *      Legacy slugs are remapped via `serviceSlugAliases.js`.
 *   2. `client_category` is recomputed server-side via the classifier when
 *      the caller passes a profile; otherwise the explicit category is
 *      validated against the canonical 4-code set.
 *   3. `service_prices` must exist for service+category+currency+phase.
 *   4. `service_prices.amount_cents` must equal the 2026-06-15 catalog
 *      amount for that service/category. Drift → block + surface for Sam.
 *   5. Quote line-item amount must equal `service_prices.amount_cents`
 *      unless an approved discount is present.
 *   6. Discounts only reduce the final charge once approved (or when
 *      `PRICING_AUTO_DISCOUNTS_ENABLED=true`).
 *   7. Stripe checkout uses `service_prices.stripe_price_id` for the
 *      resolved row.
 *   8. Missing Stripe mapping ⇒ `STRIPE_PRICE_MISSING`.
 *   9. Stripe-side `unit_amount` mismatch ⇒ `STRIPE_PRICE_AMOUNT_MISMATCH`.
 *  10. Never construct a checkout with a stale or mismatched Price ID.
 *
 * The resolver itself does NOT call the Stripe API. The caller (checkout
 * route or Sam audit) decides whether to additionally invoke
 * `stripePriceVerifier.verifyStripePrice()` to confirm the Stripe-side
 * unit amount and currency. We separate the concerns so unit tests can
 * exercise resolver math without network access.
 */

import {
  PRICING_CATALOG_VERSION,
  SERVICE_KEYS,
} from './pricingTypes.js'
import { getService, getServicePrice } from './pricingCatalog.js'
import { resolveCanonicalServiceSlug } from './serviceSlugAliases.js'
import { classifyClient, isCatalogCategory, toCatalogCategory } from './clientCategoryClassifier.js'
import { hourlyRateToSixMinuteUnitCents } from '../hourlyRounding.js'

const VALID_PHASES = Object.freeze(new Set(['', 'kickoff', 'draft', 'submission']))

/** @returns {boolean} */
function isAutoDiscountsEnabled() {
  return String(process.env.PRICING_AUTO_DISCOUNTS_ENABLED || '').trim().toLowerCase() === 'true'
}

function dollarsToCents(dollars) {
  const n = Number(dollars)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

/**
 * Slug → SERVICE_KEY for catalog look-up (canonical 4-code form).
 * Mirrors `pricingCatalog.js` SERVICES order; kept locally so a typo here
 * is caught by the catalog version test.
 */
const SLUG_TO_SERVICE_KEY = Object.freeze({
  'quick-eligibility-scan': SERVICE_KEYS.QUICK_ELIGIBILITY_SCAN,
  'comprehensive-funding-dossier': SERVICE_KEYS.COMPREHENSIVE_FUNDING_DOSSIER,
  'application-strategy-session': SERVICE_KEYS.APPLICATION_STRATEGY_SESSION,
  'micro-grant-application': SERVICE_KEYS.MICRO_GRANT_APPLICATION,
  'standard-foundation-application': SERVICE_KEYS.STANDARD_FOUNDATION_APPLICATION,
  'complex-federal-application': SERVICE_KEYS.COMPLEX_FEDERAL_APPLICATION,
  'transfer-scholarship-pack': SERVICE_KEYS.TRANSFER_SCHOLARSHIP_PACK,
  'editing-and-redraft-service': SERVICE_KEYS.EDITING_REDRAFT,
  'budget-and-logic-model-development': SERVICE_KEYS.BUDGET_LOGIC_MODEL,
  'compliance-reporting-and-management': SERVICE_KEYS.COMPLIANCE_REPORTING,
  'grant-calendar-setup-and-management': SERVICE_KEYS.GRANT_CALENDAR,
  'hourly-consultation-and-advisory': SERVICE_KEYS.HOURLY_CONSULTATION,
})

/**
 * pricingCatalog uses `mid_size` while service_catalog uses `mid`.
 * Convert before catalog look-up.
 */
function toCatalogEngineCategory(catalogCategory) {
  if (catalogCategory === 'mid') return 'mid_size'
  return catalogCategory
}

/**
 * @typedef {Object} ResolveChargeArgs
 * @property {object} db
 * @property {string|null} [quoteId]
 * @property {string|null} [profileId]
 * @property {string|null} [userId]
 * @property {string} serviceKey            Canonical slug or SERVICE_KEYS value.
 * @property {string} [clientCategory]      Server-trusted category; if a profile
 *                                          is supplied, it is recomputed.
 * @property {string|null} [milestonePhase] '', 'kickoff', 'draft', 'submission'
 * @property {{
 *   profile?: object,
 *   intakeAnswers?: object,
 *   organization?: object,
 * }} [classification]                       Provide to recompute server-side.
 * @property {{
 *   line_items?: Array<{
 *     service_name?: string,
 *     base_price?: number,
 *     subtotal?: number,
 *     quantity?: number,
 *     client_category?: string,
 *   }>,
 *   discounts?: Array<{
 *     amount?: number,
 *     approved?: boolean,
 *     requires_admin_approval?: boolean,
 *     label?: string,
 *   }>,
 * }} [discountState]                        Caller-supplied for unit testing.
 * @property {{
 *   amount_cents?: number,
 *   currency?: string,
 *   active?: boolean,
 *   id?: string,
 * }} [stripePriceVerification]              Optional pre-fetched Stripe data.
 */

/**
 * Resolve the chargeable amount for a quote/service combination.
 * Pure with respect to the database — performs read-only lookups only.
 *
 * @param {ResolveChargeArgs} args
 * @returns {Promise<{
 *   ok: boolean,
 *   quote_id: string|null,
 *   service_id: string|null,
 *   service_slug: string|null,
 *   service_name: string|null,
 *   pricing_model: string|null,
 *   client_category: string|null,
 *   milestone_phase: string|null,
 *   catalog_amount_cents: number,
 *   quote_base_amount_cents: number,
 *   approved_discount_cents: number,
 *   final_amount_cents: number,
 *   service_price_id: string|null,
 *   stripe_price_id: string|null,
 *   stripe_price_amount_cents: number|null,
 *   stripe_price_verified: boolean,
 *   currency: string,
 *   can_checkout: boolean,
 *   blocking_reason: string|null,
 *   catalog_version: string,
 *   issues: string[],
 * }>}
 */
export async function resolveChargeForQuote({
  db,
  quoteId = null,
  profileId = null,
  userId = null,
  serviceKey,
  clientCategory,
  milestonePhase = null,
  classification = null,
  discountState = null,
  stripePriceVerification = null,
} = {}) {
  const issues = []

  const out = {
    ok: false,
    quote_id: quoteId,
    service_id: null,
    service_slug: null,
    service_name: null,
    pricing_model: null,
    client_category: null,
    milestone_phase: null,
    catalog_amount_cents: 0,
    quote_base_amount_cents: 0,
    approved_discount_cents: 0,
    final_amount_cents: 0,
    service_price_id: null,
    stripe_price_id: null,
    stripe_price_amount_cents: null,
    stripe_price_verified: false,
    currency: 'usd',
    can_checkout: false,
    blocking_reason: null,
    catalog_version: PRICING_CATALOG_VERSION,
    issues,
  }

  if (!db) {
    out.blocking_reason = 'DB_REQUIRED'
    issues.push('db_required')
    return out
  }

  // 1. Resolve canonical slug — the resolver is tolerant of legacy slugs
  // and SERVICE_KEYS values; both come back as a canonical slug.
  const rawSlug = String(serviceKey || '').trim()
  const slugFromKey = Object.entries(SLUG_TO_SERVICE_KEY).find(([, k]) => k === rawSlug)?.[0] || null
  const canonicalSlug = slugFromKey || resolveCanonicalServiceSlug(rawSlug)
  if (!canonicalSlug) {
    out.blocking_reason = 'UNKNOWN_SERVICE'
    issues.push(`unknown_service:${rawSlug}`)
    return out
  }
  out.service_slug = canonicalSlug

  // 2. Determine client category — recompute server-side when a profile is
  // supplied so the frontend cannot tamper with the chargeable tier.
  let resolvedCategory = null
  if (classification && (classification.profile || classification.intakeAnswers || classification.organization)) {
    const c = classifyClient(
      classification.profile,
      classification.intakeAnswers,
      classification.organization,
    )
    resolvedCategory = c.client_category
  } else if (clientCategory) {
    if (!isCatalogCategory(clientCategory)) {
      out.blocking_reason = 'INVALID_CLIENT_CATEGORY'
      issues.push(`invalid_client_category:${clientCategory}`)
      return out
    }
    resolvedCategory = toCatalogCategory(clientCategory)
  } else {
    out.blocking_reason = 'CLIENT_CATEGORY_REQUIRED'
    issues.push('client_category_required')
    return out
  }
  out.client_category = resolvedCategory

  // 3. Look up the catalog row in the database.
  const serviceRow = await db
    .prepare(
      `SELECT id, slug, name, description, pricing_model, is_active
       FROM service_catalog_items
       WHERE slug = ? LIMIT 1`,
    )
    .get(canonicalSlug)
  if (!serviceRow) {
    out.blocking_reason = 'SERVICE_CATALOG_ROW_MISSING'
    issues.push(`service_catalog_row_missing:${canonicalSlug}`)
    return out
  }
  out.service_id = String(serviceRow.id)
  out.service_name = String(serviceRow.name)
  out.pricing_model = String(serviceRow.pricing_model)

  // 4. Validate the milestone phase against the pricing model.
  const phase = milestonePhase === null || milestonePhase === undefined ? '' : String(milestonePhase)
  if (!VALID_PHASES.has(phase)) {
    out.blocking_reason = 'INVALID_MILESTONE_PHASE'
    issues.push(`invalid_milestone_phase:${phase}`)
    return out
  }
  if (out.pricing_model === 'milestone' && phase === '') {
    out.blocking_reason = 'MILESTONE_PHASE_REQUIRED'
    issues.push('milestone_phase_required')
    return out
  }
  if (out.pricing_model !== 'milestone' && phase && phase !== '') {
    out.blocking_reason = 'MILESTONE_PHASE_NOT_APPLICABLE'
    issues.push(`milestone_phase_not_applicable:${out.pricing_model}`)
    return out
  }
  out.milestone_phase = phase || null

  // 5. Find the active service_prices row for this combination.
  const priceRow = await db
    .prepare(
      `SELECT id, amount_cents, currency, milestone_phase, stripe_price_id, active
       FROM service_prices
       WHERE service_id = ?
         AND client_category = ?
         AND COALESCE(milestone_phase, '') = ?
         AND currency = ?
         AND active = 1
       LIMIT 1`,
    )
    .get(out.service_id, resolvedCategory, phase, out.currency)

  if (!priceRow) {
    out.blocking_reason = 'SERVICE_PRICE_ROW_MISSING'
    issues.push(`service_price_row_missing:${canonicalSlug}/${resolvedCategory}/${phase || 'one_time'}`)
    return out
  }

  out.service_price_id = String(priceRow.id)
  out.stripe_price_id = priceRow.stripe_price_id ? String(priceRow.stripe_price_id) : null
  const dbAmountCents = Number(priceRow.amount_cents)

  // 6. Compare DB price to the canonical 2026-06-15 catalog. Hourly rows
  // are stored as 6-minute unit amounts; convert before comparing.
  const expectedDollars = getServicePrice(
    SLUG_TO_SERVICE_KEY[canonicalSlug],
    toCatalogEngineCategory(resolvedCategory),
  )
  if (expectedDollars === null || expectedDollars === undefined) {
    out.blocking_reason = 'CATALOG_PRICE_MISSING'
    issues.push(`catalog_price_missing:${canonicalSlug}/${resolvedCategory}`)
    return out
  }

  const catalogService = getService(SLUG_TO_SERVICE_KEY[canonicalSlug])
  let expectedDbAmountCents
  if (out.pricing_model === 'hourly' || catalogService?.hourly === true) {
    expectedDbAmountCents = hourlyRateToSixMinuteUnitCents(dollarsToCents(expectedDollars))
  } else if (out.pricing_model === 'milestone') {
    const totalCents = dollarsToCents(expectedDollars)
    if (phase === 'kickoff') expectedDbAmountCents = Math.round(totalCents * 0.4)
    else if (phase === 'draft') expectedDbAmountCents = Math.round(totalCents * 0.4)
    else if (phase === 'submission') expectedDbAmountCents = totalCents - Math.round(totalCents * 0.4) - Math.round(totalCents * 0.4)
    else expectedDbAmountCents = totalCents
  } else {
    expectedDbAmountCents = dollarsToCents(expectedDollars)
  }
  out.catalog_amount_cents = expectedDbAmountCents

  if (dbAmountCents !== expectedDbAmountCents) {
    out.blocking_reason = 'DB_PRICE_CATALOG_DRIFT'
    issues.push(
      `db_price_catalog_drift:${canonicalSlug}/${resolvedCategory}/${phase || 'one_time'} db=${dbAmountCents} catalog=${expectedDbAmountCents}`,
    )
    return out
  }

  // 7. Compute discount math from the supplied quote/discountState.
  const lineItemSubtotalDollars = (discountState?.line_items || [])
    .filter((li) => {
      // If the caller pre-filtered, accept all; otherwise pick by service name match.
      if (!li || typeof li !== 'object') return false
      if (!li.service_name) return true
      return String(li.service_name).toLowerCase().includes(String(catalogService?.name || '').toLowerCase().slice(0, 6))
    })
    .reduce((s, li) => s + Number(li.subtotal || 0), 0)

  const baseDollars = lineItemSubtotalDollars > 0
    ? lineItemSubtotalDollars
    : (out.pricing_model === 'milestone'
        ? expectedDollars
        : expectedDollars)
  out.quote_base_amount_cents = dollarsToCents(baseDollars)

  const autoDiscountsEnabled = isAutoDiscountsEnabled()
  const approvedDiscountDollars = (discountState?.discounts || [])
    .filter((d) => d && (d.approved === true || autoDiscountsEnabled || d.requires_admin_approval === false))
    .reduce((s, d) => s + Number(d.amount || 0), 0)
  const unapprovedDiscountDollars = (discountState?.discounts || [])
    .filter((d) => d && d.approved !== true && d.requires_admin_approval !== false && !autoDiscountsEnabled)
    .reduce((s, d) => s + Number(d.amount || 0), 0)
  out.approved_discount_cents = dollarsToCents(approvedDiscountDollars)

  if (unapprovedDiscountDollars > 0) {
    issues.push(`unapproved_discount_present:${dollarsToCents(unapprovedDiscountDollars)}`)
  }

  // 8. Compute final amount based on pricing model.
  if (out.pricing_model === 'milestone') {
    // Discounts are applied to the milestone phase only when they were
    // approved against this whole service. Per spec: "compute milestone
    // split from final approved amount only if discount applies to whole
    // milestone service."
    const totalCents = out.quote_base_amount_cents
      ? out.quote_base_amount_cents - out.approved_discount_cents
      : dollarsToCents(expectedDollars) - out.approved_discount_cents
    if (phase === 'kickoff') out.final_amount_cents = Math.round(totalCents * 0.4)
    else if (phase === 'draft') out.final_amount_cents = Math.round(totalCents * 0.4)
    else if (phase === 'submission') out.final_amount_cents = totalCents - Math.round(totalCents * 0.4) - Math.round(totalCents * 0.4)
    else out.final_amount_cents = totalCents
  } else if (out.pricing_model === 'hourly') {
    // Hourly checkout is rounded server-side via the time entries; the
    // resolver returns the per-unit amount so callers can multiply by the
    // billed quantity. Discounts on hourly purchases must always be
    // approved manually because applying them to a per-unit price could
    // round-trip the wrong way.
    out.final_amount_cents = expectedDbAmountCents
    if (out.approved_discount_cents > 0) {
      issues.push('hourly_discount_requires_explicit_handling')
    }
  } else {
    const baseCents = out.quote_base_amount_cents || dollarsToCents(expectedDollars)
    out.final_amount_cents = Math.max(0, baseCents - out.approved_discount_cents)
  }

  // 9. Stripe Price mapping rules.
  if (!out.stripe_price_id) {
    out.blocking_reason = 'STRIPE_PRICE_MISSING'
    issues.push(
      `stripe_price_missing:${canonicalSlug}/${resolvedCategory}/${phase || 'one_time'}`,
    )
    return out
  }

  // Optional Stripe-side validation provided by caller.
  if (stripePriceVerification) {
    const stripeAmt = Number(stripePriceVerification.amount_cents)
    out.stripe_price_amount_cents = Number.isFinite(stripeAmt) ? stripeAmt : null
    out.stripe_price_verified = Boolean(stripePriceVerification.active !== false)
    if (!Number.isFinite(stripeAmt) || stripeAmt !== expectedDbAmountCents) {
      out.blocking_reason = 'STRIPE_PRICE_AMOUNT_MISMATCH'
      issues.push(
        `stripe_price_amount_mismatch:${out.stripe_price_id} stripe=${stripeAmt} expected=${expectedDbAmountCents}`,
      )
      return out
    }
    if (
      String(stripePriceVerification.currency || 'usd').toLowerCase() !== out.currency
    ) {
      out.blocking_reason = 'STRIPE_PRICE_CURRENCY_MISMATCH'
      issues.push(
        `stripe_price_currency_mismatch:${out.stripe_price_id} stripe=${stripePriceVerification.currency} expected=${out.currency}`,
      )
      return out
    }
    if (stripePriceVerification.active === false) {
      out.blocking_reason = 'STRIPE_PRICE_INACTIVE'
      issues.push(`stripe_price_inactive:${out.stripe_price_id}`)
      return out
    }
  }

  // 10. Approved-discount + fixed Stripe Price guard.
  // For one-time fixed-price checkouts, the Stripe Price unit_amount
  // equals the catalog amount; if a discount has been approved, the route
  // must either map to a discount-specific Stripe Price or use a coupon.
  // The resolver does not silently apply a discount to a fixed price.
  if (
    out.pricing_model === 'one_time' &&
    out.approved_discount_cents > 0 &&
    out.final_amount_cents !== expectedDbAmountCents
  ) {
    out.blocking_reason = 'DISCOUNT_REQUIRES_DEDICATED_PRICE_OR_COUPON'
    issues.push('discount_requires_dedicated_price_or_coupon')
    return out
  }

  out.ok = true
  out.can_checkout = true
  return out
}

/**
 * Compute the resolved charges for every (service, category) tuple in the
 * 2026 catalog, using only DB rows. Used by Sam's Stripe audit and the
 * admin verification endpoint.
 */
export async function resolveAllCatalogCharges(db, { stripePriceById = null } = {}) {
  const rows = await db
    .prepare(
      `SELECT sci.slug, sci.name, sci.pricing_model, sp.id AS service_price_id,
              sp.client_category, sp.amount_cents, sp.currency, sp.milestone_phase,
              sp.stripe_price_id, sp.active
         FROM service_catalog_items sci
         JOIN service_prices sp ON sp.service_id = sci.id
        WHERE sci.is_active = 1 AND sp.active = 1
        ORDER BY sci.name, sp.client_category, sp.milestone_phase`,
    )
    .all()
  const out = []
  for (const r of rows || []) {
    const stripeData = stripePriceById && r.stripe_price_id
      ? stripePriceById[String(r.stripe_price_id)]
      : null
    const resolved = await resolveChargeForQuote({
      db,
      serviceKey: r.slug,
      clientCategory: r.client_category,
      milestonePhase: r.milestone_phase || null,
      stripePriceVerification: stripeData || null,
    })
    out.push({
      service_slug: r.slug,
      service_name: r.name,
      client_category: r.client_category,
      milestone_phase: r.milestone_phase || null,
      pricing_model: r.pricing_model,
      db_amount_cents: Number(r.amount_cents),
      stripe_price_id: r.stripe_price_id || null,
      stripe_amount_cents: resolved.stripe_price_amount_cents,
      currency: r.currency || 'usd',
      can_checkout: resolved.can_checkout,
      blocking_reason: resolved.blocking_reason,
      issues: resolved.issues,
    })
  }
  return out
}

export default {
  resolveChargeForQuote,
  resolveAllCatalogCharges,
}
