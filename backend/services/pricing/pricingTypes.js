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

import { ADMIN_EMAIL, LOCAL_ADMIN_EMAIL } from '../../config/constants.js'

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
  PENDING_USER_AGREEMENT: 'pending_user_agreement',
  PENDING_USER_PAYMENT: 'pending_user_payment',
  APPROVED: 'approved',
  PRESENTED_TO_CLIENT: 'presented_to_client',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  PAID: 'paid',
  ADMIN_WAIVED: 'admin_waived',
  EXPIRED: 'expired',
})

export const QUOTE_STATUSES = Object.freeze(Object.values(QUOTE_STATUS))

export const ACCESS_STATUS = Object.freeze({
  PENDING_PRICING: 'pending_pricing',
  PENDING_AGREEMENT: 'pending_agreement',
  PENDING_PAYMENT: 'pending_payment',
  ACTIVE_PAID: 'active_paid',
  ADMIN_WAIVED: 'admin_waived',
  BLOCKED: 'blocked',
  EXPIRED: 'expired',
})

export const ACCESS_STATUSES = Object.freeze(Object.values(ACCESS_STATUS))

export const ADMIN_NOTIFICATION_STATUS = Object.freeze({
  QUEUED: 'queued',
  DELIVERED_LIVE: 'delivered_live',
  DELIVERED_ON_LOGIN: 'delivered_on_login',
  DISMISSED: 'dismissed',
})

export const ADMIN_NOTIFICATION_TYPE = Object.freeze({
  NEW_USER_PRICING: 'new_user_pricing',
  DISCOUNT_ELIGIBLE: 'discount_eligible',
  PAYMENT_COMPLETED: 'payment_completed',
  PAYMENT_FAILED: 'payment_failed',
  ADMIN_REVIEW_REQUIRED: 'admin_review_required',
})

export const PAYMENT_ACCESS_EVENT = Object.freeze({
  PRICING_CREATED: 'pricing_created',
  ADMIN_NOTIFIED: 'admin_notified',
  AGREEMENT_VIEWED: 'agreement_viewed',
  AGREEMENT_ACCEPTED: 'agreement_accepted',
  CHECKOUT_STARTED: 'checkout_started',
  PAYMENT_SUCCEEDED: 'payment_succeeded',
  PAYMENT_FAILED: 'payment_failed',
  ACCESS_GRANTED: 'access_granted',
  ACCESS_BLOCKED: 'access_blocked',
  ADMIN_WAIVED: 'admin_waived',
})

/**
 * Service-agreement template version. Bumping this requires a fresh
 * acceptance from each user — the gate compares against this constant.
 */
export const SERVICE_AGREEMENT_VERSION = '2026-06-15'

/**
 * The single admin who receives pricing toast notifications. Configurable
 * via `PRICING_ADMIN_NOTIFICATION_EMAIL`.
 */
export const DEFAULT_ADMIN_NOTIFICATION_EMAIL = LOCAL_ADMIN_EMAIL

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
  PRICING_SHOW_DISCOUNT_ELIGIBILITY_TO_CLIENT: 'PRICING_SHOW_DISCOUNT_ELIGIBILITY_TO_CLIENT',
  PRICING_REQUIRE_ADMIN_APPROVAL: 'PRICING_REQUIRE_ADMIN_APPROVAL',
  PRICING_REQUIRE_PAYMENT_BEFORE_FULL_ACCESS: 'PRICING_REQUIRE_PAYMENT_BEFORE_FULL_ACCESS',
  PRICING_ALLOW_LIMITED_MATCH_PREVIEW_BEFORE_PAYMENT: 'PRICING_ALLOW_LIMITED_MATCH_PREVIEW_BEFORE_PAYMENT',
  PRICING_ADMIN_NOTIFICATION_EMAIL: 'PRICING_ADMIN_NOTIFICATION_EMAIL',
  PRICING_ADMIN_TOASTS_ENABLED: 'PRICING_ADMIN_TOASTS_ENABLED',
  PRICING_AUTO_INITIALIZE_ON_PROFILE_CREATE: 'PRICING_AUTO_INITIALIZE_ON_PROFILE_CREATE',
})

export function adminNotificationEmail() {
  const v = (process.env || {})[PRICING_ENV_KEYS.PRICING_ADMIN_NOTIFICATION_EMAIL]
  if (typeof v === 'string' && v.includes('@')) return v.toLowerCase().trim()
  return ADMIN_EMAIL || ''
}

export function isAdminNotificationTarget(email) {
  if (!email) return false
  return String(email).toLowerCase().trim() === adminNotificationEmail()
}

/**
 * Convert dollars (number) → integer cents. Always rounds, never truncates.
 */
export function toCents(dollars) {
  const n = Number(dollars)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

export function fromCents(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n)) return 0
  return Math.round(n) / 100
}
