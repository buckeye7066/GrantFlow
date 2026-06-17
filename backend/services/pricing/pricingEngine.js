/**
 * pricingEngine.js — orchestrates catalog + rules + discounts → quote.
 *
 * Pure function. No DB, no network. The route layer / quoteBuilder
 * persists the result.
 *
 * Ethical-billing invariants enforced here (Sam audits these):
 *   - subtotal == sum(line_items.subtotal)
 *   - total == max(0, subtotal − sum(approved discount.amount))
 *   - currency is always USD
 *   - no discount can drop a line below 0
 *   - no fee is computed from potential funding amount
 */

import {
  PRICING_CATALOG_VERSION,
  CURRENCY_USD,
  PRICING_ENV_KEYS,
  CLIENT_CATEGORY_LABELS,
  readEnvFlag,
} from './pricingTypes.js'
import {
  PRICING_CATALOG,
  getServicePrice,
  getService,
} from './pricingCatalog.js'
import {
  determineClientCategory,
  recommendServices,
} from './pricingRules.js'
import {
  recommendDiscounts,
} from './discountEngine.js'

/**
 * Build a recommended quote for a profile + intake + matches.
 *
 * @returns {import('./pricingTypes.js').Quote & {
 *   recommended_package_name: string,
 *   reasons: string[],
 *   confidence: number,
 *   missing_pricing_inputs: string[],
 * }}
 */
export function buildRecommendedQuote({
  profile = {},
  intakeAnswers = {},
  organization = {},
  matches = [],
  discountInputs = {},
  discountRules,
  clientCategoryOverride,
} = {}) {
  const category = clientCategoryOverride
    ? {
        client_category: clientCategoryOverride,
        confidence: 'admin_override',
        reason: 'Admin-provided override.',
        missing_fields: [],
      }
    : determineClientCategory({ profile, intakeAnswers, organization })

  const recommendation = recommendServices({
    clientCategory: category.client_category,
    profile,
    intakeAnswers,
    matches,
  })

  const lineItems = recommendation.line_items.map((li) => makeLineItem(li, category.client_category))
  const subtotal = round2(lineItems.reduce((s, li) => s + Number(li.subtotal || 0), 0))

  const discountResult = recommendDiscounts({
    lineItems,
    inputs: discountInputs,
    rules: discountRules,
  })

  const adminReviewRequired = Boolean(
    recommendation.admin_review_required ||
    discountResult.admin_review_required ||
    category.confidence === 'needs_admin_review' ||
    readEnvFlag(PRICING_ENV_KEYS.PRICING_REQUIRE_ADMIN_APPROVAL, true),
  )

  const total = Math.max(0, round2(subtotal - sumApproved(discountResult.discounts)))

  const primaryServiceKey = lineItems[0]?.service_key || null
  const userPaymentRequired = total > 0
  const discountEligible = (discountResult.discounts || []).length > 0

  return {
    pricing_catalog_version: PRICING_CATALOG_VERSION,
    client_category: category.client_category,
    client_category_label: CLIENT_CATEGORY_LABELS[category.client_category] || category.client_category,
    category_confidence: category.confidence,
    category_reason: category.reason,
    category_missing_fields: category.missing_fields,
    recommended_package_name:
      recommendation.recommended_package_name ||
      (lineItems[0] ? lineItems[0].service_name : 'GrantFlow Service'),
    primary_service_key: primaryServiceKey,
    line_items: lineItems,
    discounts: discountResult.discounts,
    subtotal,
    discount_total: discountResult.discount_total,
    total,
    currency: CURRENCY_USD,
    admin_review_required: adminReviewRequired,
    user_payment_required: userPaymentRequired,
    discount_eligible: discountEligible,
    reasons: [...recommendation.reasons, ...discountResult.notes].filter(Boolean),
    missing_pricing_inputs: [
      ...(recommendation.missing_pricing_inputs || []),
      ...(category.missing_fields || []),
    ],
    confidence: deriveConfidence(category, recommendation),
    payment_terms: PRICING_CATALOG.payment_terms,
    ethical_billing_standard: PRICING_CATALOG.ethical_billing_standard,
  }
}

function makeLineItem(rec, clientCategory) {
  const service = getService(rec.service_key)
  const basePrice = getServicePrice(rec.service_key, clientCategory) ?? 0
  const quantity = Number.isFinite(rec.quantity) && rec.quantity > 0 ? rec.quantity : 1
  return {
    service_key: rec.service_key,
    service_name: service?.name || rec.service_key,
    client_category: clientCategory,
    base_price: round2(basePrice),
    quantity: round2(quantity),
    subtotal: round2(basePrice * quantity),
    reason: rec.reason || '',
    confidence: clamp01(Number(rec.confidence) || 0.5),
  }
}

function sumApproved(discounts) {
  return round2((discounts || []).filter((d) => d.approved).reduce((s, d) => s + Number(d.amount || 0), 0))
}

function deriveConfidence(category, recommendation) {
  let confidence = category.confidence === 'high' ? 0.9 : category.confidence === 'estimated' ? 0.65 : 0.4
  const lineConf = (recommendation.line_items || []).map((li) => Number(li.confidence) || 0.5)
  if (lineConf.length > 0) {
    const avg = lineConf.reduce((a, b) => a + b, 0) / lineConf.length
    confidence = (confidence + avg) / 2
  }
  return clamp01(confidence)
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.min(Math.max(n, 0), 1)
}

/**
 * Recompute the quote total after approval flips have changed. Used by
 * the admin route when a discount is approved/rejected post-build.
 */
export function recomputeTotal(quote) {
  if (!quote) return quote
  const subtotal = round2((quote.line_items || []).reduce((s, li) => s + Number(li.subtotal || 0), 0))
  const discountTotal = round2(
    (quote.discounts || []).filter((d) => d.approved).reduce((s, d) => s + Number(d.amount || 0), 0),
  )
  const total = Math.max(0, round2(subtotal - discountTotal))
  return { ...quote, subtotal, discount_total: discountTotal, total }
}

/**
 * Convert the internal quote into the gentle, non-binding string the
 * `/api/pricing/my-estimate/:profileId` endpoint returns when
 * PRICING_SHOW_CLIENT_ESTIMATE=true.
 */
export function buildClientEstimateMessage(quote) {
  if (!quote || !Number.isFinite(quote.total) || quote.total <= 0) {
    return 'Anya is preparing suggested next steps based on your matches.'
  }
  const start = roundToFriendlyDollars(quote.total)
  return `Based on your needs, GrantFlow may recommend a service package starting around $${start.toLocaleString()}. Final pricing depends on scope, deadlines, and discounts.`
}

function roundToFriendlyDollars(n) {
  if (n < 200) return Math.round(n / 25) * 25
  if (n < 1000) return Math.round(n / 50) * 50
  return Math.round(n / 100) * 100
}
