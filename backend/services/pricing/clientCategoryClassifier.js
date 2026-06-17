/**
 * Client-category classifier (single source of truth).
 *
 * The underlying rules live in `pricingRules.js` so the classifier and
 * service-recommendation engine share parsing helpers. This module:
 *
 *  1. Adds `admin_review_required` to the spec'd return shape.
 *  2. Normalises the engine's `mid_size` label to the canonical 4-code
 *     `mid` value used by `service_catalog_items.client_category` and
 *     by the Stripe checkout pipeline.
 *
 * The engine's category labels (`individual / small / mid_size / large`)
 * appear in the pricing-engine return value and quote line items; the
 * service catalog and Stripe price rows use the shorter 4-code form
 * (`individual / small / mid / large`). Frontend forms must never be
 * trusted to pick a chargeable category — `chargeResolver` always calls
 * `classifyClient()` server-side and ignores any client_category sent
 * from the browser.
 */

import { determineClientCategory as _determineClientCategory } from './pricingRules.js'

export { determineClientCategory } from './pricingRules.js'

const CONFIDENCE_NEEDS_ADMIN = 'estimated_needs_admin_review'

const CATEGORY_LABEL_MAP = Object.freeze({
  individual: 'individual',
  small: 'small',
  mid: 'mid',
  mid_size: 'mid',
  large: 'large',
})

const VALID_CATALOG_CATEGORIES = Object.freeze(new Set(['individual', 'small', 'mid', 'large']))

/**
 * Map a pricing-engine category label (which may be `mid_size`) to the
 * canonical service-catalog category used by `service_prices` and Stripe.
 *
 * @param {string} category
 * @returns {string} one of `individual` / `small` / `mid` / `large`
 */
export function toCatalogCategory(category) {
  const normalized = String(category || '').trim().toLowerCase()
  return CATEGORY_LABEL_MAP[normalized] || 'small'
}

/**
 * Returns true when `category` is a valid 4-code service-catalog category.
 *
 * @param {string} category
 * @returns {boolean}
 */
export function isCatalogCategory(category) {
  return VALID_CATALOG_CATEGORIES.has(String(category || '').trim().toLowerCase())
}

/**
 * Spec-compliant classifier that returns the 4-code service-catalog
 * category along with audit metadata. Always recomputes the category
 * server-side; never trusts a category supplied by the frontend.
 *
 * @returns {{
 *   client_category: string,
 *   confidence: string,
 *   reason: string,
 *   missing_fields: string[],
 *   admin_review_required: boolean,
 * }}
 */
export function classifyClient(profile, intakeAnswers, organization) {
  const result = _determineClientCategory({
    profile: profile || {},
    intakeAnswers: intakeAnswers || {},
    organization: organization || {},
  })
  const catalogCategory = toCatalogCategory(result.client_category)
  const baseReview = result.confidence === 'needs_admin_review'
  const missing = Array.isArray(result.missing_fields) ? result.missing_fields : []
  const orgWithoutBudget = missing.includes('annual_budget') && catalogCategory !== 'individual'
  const adminReviewRequired = baseReview || orgWithoutBudget
  const confidence = orgWithoutBudget ? CONFIDENCE_NEEDS_ADMIN : result.confidence

  return {
    client_category: catalogCategory,
    confidence,
    reason: result.reason,
    missing_fields: missing,
    admin_review_required: adminReviewRequired,
  }
}

export default {
  classifyClient,
  toCatalogCategory,
  isCatalogCategory,
}
