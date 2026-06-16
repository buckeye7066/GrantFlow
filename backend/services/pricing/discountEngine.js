/**
 * Discount engine.
 *
 * Discounts are deliberately conservative:
 *   - No discount is applied automatically unless `PRICING_AUTO_DISCOUNTS_ENABLED=true`
 *     AND the discount rule is `enabled` AND `requires_admin_approval=false`.
 *   - When `PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS=true` (default),
 *     every recommended discount is suggested with `approved=false` and
 *     the quote is flagged `admin_review_required=true`.
 *   - The total discount across all rules is capped by
 *     `PRICING_MAX_TOTAL_DISCOUNT_PERCENT` (default 25 %).
 */

import {
  DISCOUNT_KEYS,
  PRICING_ENV_KEYS,
  readEnvFlag,
  readEnvNumber,
  SERVICE_KEYS,
} from './pricingTypes.js'

/** @type {import('./pricingTypes.js').DiscountRule[]} */
export const DEFAULT_DISCOUNT_RULES = [
  {
    discount_key: DISCOUNT_KEYS.HARDSHIP,
    label: 'Hardship discount',
    enabled: false,
    type: 'percent',
    value: 15,
    max_amount: null,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: true,
  },
  {
    discount_key: DISCOUNT_KEYS.MINISTRY_MISSION,
    label: 'Ministry / mission discount',
    enabled: false,
    type: 'percent',
    value: 10,
    max_amount: null,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: true,
  },
  {
    discount_key: DISCOUNT_KEYS.NONPROFIT_COMMUNITY_IMPACT,
    label: 'Nonprofit / community impact discount',
    enabled: false,
    type: 'percent',
    value: 10,
    max_amount: null,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: true,
  },
  {
    discount_key: DISCOUNT_KEYS.STUDENT_FAMILY,
    label: 'Student / family discount',
    enabled: false,
    type: 'percent',
    value: 15,
    max_amount: null,
    applies_to_services: [
      SERVICE_KEYS.QUICK_ELIGIBILITY_SCAN,
      SERVICE_KEYS.MICRO_GRANT_APPLICATION,
      SERVICE_KEYS.TRANSFER_SCHOLARSHIP_PACK,
    ],
    requires_admin_approval: true,
    reason_required: true,
  },
  {
    discount_key: DISCOUNT_KEYS.MULTI_SERVICE_BUNDLE,
    label: 'Multi-service bundle',
    enabled: false,
    type: 'percent',
    value: 10,
    max_amount: 1500,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: false,
  },
  {
    discount_key: DISCOUNT_KEYS.BETA_EARLY_ADOPTER,
    label: 'Beta / early adopter',
    enabled: false,
    type: 'percent',
    value: 10,
    max_amount: 750,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: false,
  },
  {
    discount_key: DISCOUNT_KEYS.REFERRAL,
    label: 'Referral discount',
    enabled: false,
    type: 'fixed',
    value: 100,
    max_amount: 100,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: true,
  },
  {
    discount_key: DISCOUNT_KEYS.MANUAL_ADMIN,
    label: 'Manual admin discount',
    enabled: true,
    type: 'percent',
    value: 0, // admin sets the value at quote time
    max_amount: null,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: true,
  },
  {
    discount_key: DISCOUNT_KEYS.REPEAT_CLIENT,
    label: 'Repeat client',
    enabled: false,
    type: 'percent',
    value: 5,
    max_amount: null,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: false,
  },
  {
    discount_key: DISCOUNT_KEYS.LIMITED_SCOPE,
    label: 'Limited-scope adjustment',
    enabled: false,
    type: 'percent',
    value: 10,
    max_amount: null,
    applies_to_services: [],
    requires_admin_approval: true,
    reason_required: true,
  },
]

const DEFAULT_RULES_BY_KEY = DEFAULT_DISCOUNT_RULES.reduce((acc, r) => {
  acc[r.discount_key] = r
  return acc
}, {})

export function defaultDiscountRules() {
  return DEFAULT_DISCOUNT_RULES.map((r) => ({ ...r, applies_to_services: r.applies_to_services.slice() }))
}

export function defaultRule(discountKey) {
  return DEFAULT_RULES_BY_KEY[discountKey] || null
}

/**
 * Inputs that influence discount candidacy (collected from intake).
 *
 * @typedef {Object} DiscountInputs
 * @property {boolean} hardship
 * @property {boolean} ministry
 * @property {boolean} nonprofit
 * @property {boolean} student_or_family
 * @property {boolean} multi_service
 * @property {boolean} beta
 * @property {boolean} referral
 * @property {boolean} repeat_client
 * @property {boolean} limited_scope
 * @property {Array<{discount_key: string, value?: number, type?: string, reason?: string}>} manual_admin
 */

/**
 * Build the recommended discount list for a quote.
 *
 * @param {Object} args
 * @param {import('./pricingTypes.js').LineItem[]} args.lineItems
 * @param {DiscountInputs} args.inputs
 * @param {import('./pricingTypes.js').DiscountRule[]} [args.rules]  override default rule set (e.g. from DB)
 * @returns {{
 *   discounts: import('./pricingTypes.js').DiscountApplication[],
 *   discount_total: number,
 *   admin_review_required: boolean,
 *   notes: string[],
 * }}
 */
export function recommendDiscounts({ lineItems = [], inputs = {}, rules } = {}) {
  const ruleSet = rules || defaultDiscountRules()
  const ruleByKey = ruleSet.reduce((acc, r) => {
    acc[r.discount_key] = r
    return acc
  }, {})

  const subtotal = sumLineItems(lineItems)

  const discountsEnabled = readEnvFlag(PRICING_ENV_KEYS.PRICING_DISCOUNTS_ENABLED, true)
  const autoEnabled = readEnvFlag(PRICING_ENV_KEYS.PRICING_AUTO_DISCOUNTS_ENABLED, false)
  const requireAdminApproval = readEnvFlag(
    PRICING_ENV_KEYS.PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS,
    true,
  )
  const maxTotalPct = clamp(readEnvNumber(PRICING_ENV_KEYS.PRICING_MAX_TOTAL_DISCOUNT_PERCENT, 25), 0, 100)
  const maxTotalAmount = round2((subtotal * maxTotalPct) / 100)

  /** @type {import('./pricingTypes.js').DiscountApplication[]} */
  const recommendations = []
  const notes = []
  let adminReviewRequired = false

  if (!discountsEnabled) {
    notes.push('Discounts disabled by PRICING_DISCOUNTS_ENABLED=false.')
    return {
      discounts: [],
      discount_total: 0,
      admin_review_required: false,
      notes,
    }
  }

  const candidacy = [
    [DISCOUNT_KEYS.HARDSHIP, Boolean(inputs.hardship), 'Hardship signal in intake.'],
    [DISCOUNT_KEYS.MINISTRY_MISSION, Boolean(inputs.ministry), 'Ministry / mission alignment.'],
    [DISCOUNT_KEYS.NONPROFIT_COMMUNITY_IMPACT, Boolean(inputs.nonprofit), 'Nonprofit / community-impact organization.'],
    [DISCOUNT_KEYS.STUDENT_FAMILY, Boolean(inputs.student_or_family), 'Student / family applicant.'],
    [DISCOUNT_KEYS.MULTI_SERVICE_BUNDLE, lineItems.length >= 2 || Boolean(inputs.multi_service), 'Two or more services bundled.'],
    [DISCOUNT_KEYS.BETA_EARLY_ADOPTER, Boolean(inputs.beta), 'Beta / early-adopter program.'],
    [DISCOUNT_KEYS.REFERRAL, Boolean(inputs.referral), 'Referred by an existing client.'],
    [DISCOUNT_KEYS.REPEAT_CLIENT, Boolean(inputs.repeat_client), 'Repeat client.'],
    [DISCOUNT_KEYS.LIMITED_SCOPE, Boolean(inputs.limited_scope), 'Limited / partial scope.'],
  ]

  for (const [discountKey, candidate, reason] of candidacy) {
    if (!candidate) continue
    const rule = ruleByKey[discountKey]
    if (!rule) continue
    if (!rule.enabled) {
      notes.push(`Skipped ${rule.label}: rule disabled.`)
      continue
    }
    const amount = computeDiscountAmount(rule, lineItems)
    if (amount <= 0) continue
    const approvalNeeded = rule.requires_admin_approval || requireAdminApproval || !autoEnabled
    if (approvalNeeded) adminReviewRequired = true
    recommendations.push({
      discount_key: discountKey,
      label: rule.label,
      amount,
      reason,
      requires_admin_approval: approvalNeeded,
      approved: false,
    })
  }

  // Manual admin discounts can be passed in as already-keyed entries.
  for (const m of inputs.manual_admin || []) {
    const rule =
      ruleByKey[m.discount_key || DISCOUNT_KEYS.MANUAL_ADMIN] ||
      ruleByKey[DISCOUNT_KEYS.MANUAL_ADMIN]
    if (!rule) continue
    const overrideRule = {
      ...rule,
      type: m.type || rule.type,
      value: Number.isFinite(m.value) ? Number(m.value) : rule.value,
    }
    const amount = computeDiscountAmount(overrideRule, lineItems)
    if (amount <= 0) continue
    recommendations.push({
      discount_key: rule.discount_key,
      label: rule.label,
      amount,
      reason: m.reason || 'Manual admin discount.',
      requires_admin_approval: true,
      approved: false,
    })
    adminReviewRequired = true
  }

  // Cap total to maxTotalAmount.
  let runningTotal = 0
  const cappedRecommendations = []
  for (const rec of recommendations) {
    const remaining = Math.max(0, maxTotalAmount - runningTotal)
    if (remaining <= 0) {
      notes.push(`Discount cap hit at $${maxTotalAmount.toFixed(2)} — ${rec.label} not applied.`)
      continue
    }
    if (rec.amount > remaining) {
      cappedRecommendations.push({ ...rec, amount: remaining, reason: `${rec.reason} (capped to remaining $${remaining.toFixed(2)})` })
      notes.push(`Capped ${rec.label} from $${rec.amount.toFixed(2)} to $${remaining.toFixed(2)}.`)
      runningTotal += remaining
    } else {
      cappedRecommendations.push(rec)
      runningTotal += rec.amount
    }
  }

  return {
    discounts: cappedRecommendations,
    discount_total: round2(runningTotal),
    admin_review_required: adminReviewRequired,
    notes,
  }
}

/**
 * Compute the dollar amount a single rule produces given the line items
 * it applies to. Honors `applies_to_services` and `max_amount`.
 */
export function computeDiscountAmount(rule, lineItems = []) {
  if (!rule) return 0
  const applicableSubtotal = lineItems
    .filter((li) =>
      !rule.applies_to_services?.length || rule.applies_to_services.includes(li.service_key),
    )
    .reduce((s, li) => s + Number(li.subtotal || 0), 0)
  if (applicableSubtotal <= 0) return 0
  let amount = 0
  if (rule.type === 'fixed') amount = Number(rule.value || 0)
  else amount = (applicableSubtotal * Number(rule.value || 0)) / 100
  if (Number.isFinite(rule.max_amount) && rule.max_amount > 0) {
    amount = Math.min(amount, rule.max_amount)
  }
  amount = Math.max(0, Math.min(amount, applicableSubtotal))
  return round2(amount)
}

function sumLineItems(items) {
  return round2((items || []).reduce((s, li) => s + Number(li.subtotal || 0), 0))
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(n, min), max)
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100
}

/**
 * Approve a previously-recommended discount. Used by the admin flow.
 */
export function approveDiscount(discount) {
  return { ...discount, approved: true, approved_at: new Date().toISOString() }
}
