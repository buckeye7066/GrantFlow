/**
 * Pricing types and shared constants.
 *
 * The pricing system is a deterministic function of:
 *   1. a frozen catalog (pricingCatalog.js)
 *   2. a client-category classifier (pricingRules.js)
 *   3. service-recommendation rules (pricingRules.js)
 *   4. a discount engine (discountEngine.js)
 *
 * No fee in this system is contingent on award outcomes; no fee is
 * computed as a percentage of potential funding. Sam's pricing auditor
 * enforces both rules.
 */

export const PRICING_CATALOG_VERSION = '2026-06-15'

export const CLIENT_CATEGORIES = Object.freeze({
  INDIVIDUAL: 'individual',
  SMALL: 'small',
  MID_SIZE: 'mid_size',
  LARGE: 'large',
})

export const CLIENT_CATEGORY_LABELS = Object.freeze({
  individual: 'Individual',
  small: 'Small Org',
  mid_size: 'Mid-Size',
  large: 'Large Org',
})

export const CLIENT_CATEGORY_BUDGET_THRESHOLDS = Object.freeze({
  small_max: 250000,
  mid_size_max: 2000000,
})

export const CLIENT_CATEGORY_CONFIDENCE = Object.freeze({
  HIGH: 'high',
  ESTIMATED: 'estimated',
  NEEDS_ADMIN_REVIEW: 'needs_admin_review',
})

export const QUOTE_STATUS = Object.freeze({
  DRAFT: 'draft',
  INTERNAL_RECOMMENDATION: 'internal_recommendation',
  PENDING_ADMIN_REVIEW: 'pending_admin_review',
  APPROVED: 'approved',
  PRESENTED_TO_CLIENT: 'presented_to_client',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
})

export const QUOTE_STATUSES = Object.freeze(Object.values(QUOTE_STATUS))

export const PAYMENT_TERMS = Object.freeze({
  schedule: [
    { milestone: 'project_kickoff', percent: 40 },
    { milestone: 'complete_draft_delivery', percent: 40 },
    { milestone: 'submission_and_handoff', percent: 20 },
  ],
  net_days: 15,
  late_fee_monthly_interest_percent: 1.5,
  ethical_billing_standard:
    'All fees are for professional services rendered and are not contingent on award outcomes. No percentage-based or commission fees.',
})

export const SERVICE_KEYS = Object.freeze({
  QUICK_ELIGIBILITY_SCAN: 'quick_eligibility_scan',
  COMPREHENSIVE_FUNDING_DOSSIER: 'comprehensive_funding_dossier',
  APPLICATION_STRATEGY_SESSION: 'application_strategy_session',
  MICRO_GRANT_APPLICATION: 'micro_grant_application',
  STANDARD_FOUNDATION_APPLICATION: 'standard_foundation_application',
  COMPLEX_FEDERAL_APPLICATION: 'complex_federal_application',
  TRANSFER_SCHOLARSHIP_PACK: 'transfer_scholarship_pack',
  EDITING_REDRAFT: 'editing_redraft',
  BUDGET_LOGIC_MODEL: 'budget_logic_model',
  COMPLIANCE_REPORTING: 'compliance_reporting',
  GRANT_CALENDAR: 'grant_calendar',
  HOURLY_CONSULTATION: 'hourly_consultation',
})

export const DISCOUNT_KEYS = Object.freeze({
  HARDSHIP: 'hardship',
  MINISTRY_MISSION: 'ministry_mission',
  NONPROFIT_COMMUNITY_IMPACT: 'nonprofit_community_impact',
  STUDENT_FAMILY: 'student_family',
  MULTI_SERVICE_BUNDLE: 'multi_service_bundle',
  BETA_EARLY_ADOPTER: 'beta_early_adopter',
  REFERRAL: 'referral',
  MANUAL_ADMIN: 'manual_admin',
  REPEAT_CLIENT: 'repeat_client',
  LIMITED_SCOPE: 'limited_scope',
})

/**
 * @typedef {'individual'|'small'|'mid_size'|'large'} ClientCategory
 *
 * @typedef {Object} CatalogService
 * @property {string} key
 * @property {string} name
 * @property {string} description
 * @property {string} group   discovery | grant_writing | support | hourly
 * @property {Record<ClientCategory, number>} prices  base price for the deliverable, OR hourly rate for HOURLY_CONSULTATION
 * @property {boolean} hourly
 *
 * @typedef {Object} LineItem
 * @property {string} service_key
 * @property {string} service_name
 * @property {ClientCategory} client_category
 * @property {number} base_price
 * @property {number} quantity
 * @property {number} subtotal
 * @property {string} reason
 * @property {number} confidence  0..1
 *
 * @typedef {Object} DiscountRule
 * @property {string} discount_key
 * @property {string} label
 * @property {boolean} enabled
 * @property {'percent'|'fixed'} type
 * @property {number} value
 * @property {number|null} max_amount
 * @property {string[]} applies_to_services  service_keys, [] means "all"
 * @property {boolean} requires_admin_approval
 * @property {boolean} reason_required
 *
 * @typedef {Object} DiscountApplication
 * @property {string} discount_key
 * @property {string} label
 * @property {number} amount
 * @property {string} reason
 * @property {boolean} requires_admin_approval
 * @property {boolean} approved
 *
 * @typedef {Object} Quote
 * @property {string} pricing_catalog_version
 * @property {ClientCategory} client_category
 * @property {string} category_confidence
 * @property {string} recommended_package_name
 * @property {LineItem[]} line_items
 * @property {DiscountApplication[]} discounts
 * @property {number} subtotal
 * @property {number} discount_total
 * @property {number} total
 * @property {string} currency
 * @property {boolean} admin_review_required
 * @property {string[]} reasons
 * @property {string[]} missing_pricing_inputs
 * @property {object}   payment_terms
 */

export const CURRENCY_USD = 'USD'

/**
 * Environment toggles. We expose a tiny helper so route + service code
 * read them consistently.
 */
export function readEnvFlag(name, defaultValue = false) {
  const v = (process.env || {})[name]
  if (v === undefined || v === null || v === '') return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())
}

export function readEnvNumber(name, defaultValue = 0) {
  const v = Number((process.env || {})[name])
  return Number.isFinite(v) ? v : defaultValue
}

export const PRICING_ENV_KEYS = Object.freeze({
  PRICING_DISCOUNTS_ENABLED: 'PRICING_DISCOUNTS_ENABLED',
  PRICING_AUTO_DISCOUNTS_ENABLED: 'PRICING_AUTO_DISCOUNTS_ENABLED',
  PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS: 'PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS',
  PRICING_MAX_TOTAL_DISCOUNT_PERCENT: 'PRICING_MAX_TOTAL_DISCOUNT_PERCENT',
  PRICING_SHOW_CLIENT_ESTIMATE: 'PRICING_SHOW_CLIENT_ESTIMATE',
  PRICING_REQUIRE_ADMIN_APPROVAL: 'PRICING_REQUIRE_ADMIN_APPROVAL',
})
