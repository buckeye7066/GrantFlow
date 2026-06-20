/**
 * profileTypeToClientCategory.js
 *
 * THE single, dependency-free mapping from a profile's TYPE taxonomy to a
 * BILLING client category. Lives in shared/ so the backend (pricing,
 * billing, entitlements) and the frontend (profile create/edit, pricing
 * preview) agree on exactly one answer.
 *
 * Billing client categories (the 4-code form used by
 * `service_catalog_items.client_category`, the Stripe checkout pipeline,
 * and `clientCategoryClassifier.toCatalogCategory`):
 *
 *   'individual' | 'small' | 'mid' | 'large'
 *
 * Mapping rules (canonical — keep in sync with docs + the org budget bands
 * in pricingTypes.CLIENT_CATEGORY_BUDGET_THRESHOLDS):
 *
 *   Individuals / families seeking assistance  → 'individual'
 *     Student, Individual, Family, Homeschool family, Medical/healthcare.
 *
 *   Organization → bucketed by annual budget:
 *     under  $250,000          → 'small'
 *     $250,000 – $2,000,000    → 'mid'
 *     over   $2,000,000        → 'large'
 *     (budget unknown          → 'small', the cheapest org tier, until set)
 *
 *   Other → defaults to 'individual', UNLESS marked an organization
 *           (then 'small' until a budget is supplied).
 *
 * This module never reads the DB and never throws — unknown / legacy /
 * mistyped values resolve to a sensible category (individual-ish → the
 * Individual tier) so old rows like 'caregiver' or 'senior' keep working.
 */

// The org annual-budget thresholds. Mirrors
// backend/services/pricing/pricingTypes.js CLIENT_CATEGORY_BUDGET_THRESHOLDS.
// Duplicated here (not imported) to keep this file frontend-safe and
// dependency-free; a guard test asserts the two never drift.
export const ORG_BUDGET_THRESHOLDS = Object.freeze({
  small_max: 250000, // under this → small
  mid_max: 2000000, // up to & including this → mid; above → large
})

export const CLIENT_CATEGORIES = Object.freeze(['individual', 'small', 'mid', 'large'])

/**
 * Canonical individual-tier profile types (the curated, selectable set
 * plus their close relatives). Anything here bills as 'individual'
 * regardless of budget.
 */
const INDIVIDUAL_TYPES = new Set([
  'individual',
  'family',
  'student',
  'homeschool_family',
  'medical', // canonical UI value
  'medical_need', // registry canonical id
  'medical_assistance', // legacy alias
  'healthcare_assistance',
  // Student sub-levels.
  'high_school_student',
  'college_student',
  'graduate_student',
  // Legacy / odd individual-ish types that must not crash and should bill
  // as Individual (backward-compatibility, mission rule: never lose a user).
  'individual_need',
  'caregiver',
  'senior',
  'veteran',
  'disabled_adult',
])

/**
 * Profile types that are organizations. These are budget-bucketed. We list
 * the canonical UI sub-types (nonprofit / business / school) plus the
 * registry organization ids and common legacy values.
 */
const ORG_TYPES = new Set([
  'organization',
  'nonprofit',
  'business',
  'small_business',
  'school',
  'public_school',
  'school_district',
  'church',
  'ministry',
  'volunteer_fire_department',
  'minority_owned_business',
  'women_owned_business',
  'government',
  'public_agency',
  'county_government',
  'municipality',
  'tribal_government',
  'other_organization',
])

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
}

/**
 * Parse a possibly-formatted budget ("$1,250,000", "1250000", 1250000) to a
 * finite non-negative number, or null when it is not a usable number.
 */
export function parseAnnualBudget(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : Number(value)
  if (Number.isFinite(n) && n >= 0) return n
  return null
}

/**
 * Bucket an organization's annual budget into a billing category. Budget
 * unknown → 'small' (the cheapest org tier) until the user supplies one.
 *
 * @param {number|string|null} annualBudget
 * @returns {'small'|'mid'|'large'}
 */
export function orgCategoryForBudget(annualBudget) {
  const budget = parseAnnualBudget(annualBudget)
  if (budget === null) return 'small'
  if (budget < ORG_BUDGET_THRESHOLDS.small_max) return 'small'
  if (budget <= ORG_BUDGET_THRESHOLDS.mid_max) return 'mid'
  return 'large'
}

/**
 * Return true if a (normalized) profile type is an organization type.
 */
function isOrgType(normalizedType, orgSubtype) {
  if (ORG_TYPES.has(normalizedType)) return true
  // An explicit org sub-type (nonprofit / business / school) means org even
  // when the primary type itself is generic.
  const sub = normalize(orgSubtype)
  return sub === 'nonprofit' || sub === 'business' || sub === 'school'
}

/**
 * Map a profile's type taxonomy to a billing client category.
 *
 * @param {object} input
 * @param {string} [input.primaryType]  the profile's primary/applicant type
 * @param {string} [input.orgSubtype]   for organizations: 'nonprofit' | 'business' | 'school'
 * @param {number|string|null} [input.annualBudget]  org annual budget (USD)
 * @returns {'individual'|'small'|'mid'|'large'}
 */
export function profileTypeToClientCategory({ primaryType, orgSubtype, annualBudget } = {}) {
  const type = normalize(primaryType)

  // Explicit individual-tier types always bill as Individual.
  if (INDIVIDUAL_TYPES.has(type)) return 'individual'

  // Organizations are budget-bucketed.
  if (isOrgType(type, orgSubtype)) return orgCategoryForBudget(annualBudget)

  // 'Other' (and anything unknown): default to Individual unless the caller
  // marked it an organization via an org sub-type (handled above). Budget
  // alone does NOT promote an unknown type to an org — the user must declare
  // they are an organization.
  return 'individual'
}

export default {
  profileTypeToClientCategory,
  orgCategoryForBudget,
  parseAnnualBudget,
  ORG_BUDGET_THRESHOLDS,
  CLIENT_CATEGORIES,
}
