/**
 * GrantFlow Professional Grant Writing Services — pricing catalog.
 *
 * Source: /docs/PRICING_ENGINE.md (mirrors the menu the user supplied
 * dated 6/15/2026). The catalog is FROZEN — every change must bump
 * PRICING_CATALOG_VERSION and ship a migration that records the prior
 * version on existing quotes.
 *
 * Ethical-billing rules baked in here (Sam audits these):
 *   - All prices are flat fees for professional services.
 *   - No price field is computed as a percentage of an award.
 *   - No price field is contingent on award outcomes.
 */

import {
  PRICING_CATALOG_VERSION,
  CLIENT_CATEGORIES,
  PAYMENT_TERMS,
  SERVICE_KEYS,
} from './pricingTypes.js'

const { INDIVIDUAL, SMALL, MID_SIZE, LARGE } = CLIENT_CATEGORIES

/** @type {import('./pricingTypes.js').CatalogService[]} */
const SERVICES = [
  // ── Discovery & Assessment ────────────────────────────────────────────────
  {
    key: SERVICE_KEYS.QUICK_ELIGIBILITY_SCAN,
    name: 'Quick Eligibility Scan',
    group: 'discovery',
    description:
      'Rapid assessment of eligibility for federal, state, and foundation grants. Includes keyword research, initial database queries, and a summary report of 5–10 top opportunities with eligibility notes.',
    prices: { [INDIVIDUAL]: 149, [SMALL]: 349, [MID_SIZE]: 349, [LARGE]: 750 },
    hourly: false,
  },
  {
    key: SERVICE_KEYS.COMPREHENSIVE_FUNDING_DOSSIER,
    name: 'Comprehensive Funding Dossier',
    group: 'discovery',
    description:
      'Full funding landscape analysis with detailed research across federal, state, foundation, and corporate sources. Includes strategic recommendations, timeline planning, and prioritized list of 15–30+ opportunities with full eligibility analysis, award ranges, and application requirements.',
    prices: { [INDIVIDUAL]: 399, [SMALL]: 1250, [MID_SIZE]: 2400, [LARGE]: 3800 },
    hourly: false,
  },
  {
    key: SERVICE_KEYS.APPLICATION_STRATEGY_SESSION,
    name: 'Application Strategy Session',
    group: 'discovery',
    description:
      'One-on-one consultation to develop grant application strategy. Includes opportunity prioritization, timeline development, resource assessment, and action planning. 60–90 minute session with written follow-up recommendations.',
    prices: { [INDIVIDUAL]: 300, [SMALL]: 450, [MID_SIZE]: 600, [LARGE]: 600 },
    hourly: false,
  },

  // ── Grant Writing & Application ───────────────────────────────────────────
  {
    key: SERVICE_KEYS.MICRO_GRANT_APPLICATION,
    name: 'Micro-Grant Application (<$5K)',
    group: 'grant_writing',
    description:
      'Complete application preparation for small grants and assistance programs under $5,000. Includes narrative development, budget preparation, and submission coordination. Ideal for emergency assistance, scholarships, and community grants.',
    prices: { [INDIVIDUAL]: 600, [SMALL]: 900, [MID_SIZE]: 1200, [LARGE]: 1200 },
    hourly: false,
  },
  {
    key: SERVICE_KEYS.STANDARD_FOUNDATION_APPLICATION,
    name: 'Standard Foundation Application',
    group: 'grant_writing',
    description:
      'Full-service foundation grant application ($5K–$250K). Includes needs assessment, program design narrative, evaluation plan, logic model, detailed budget with justification, and all required attachments. Typically 5–15 pages.',
    prices: { [INDIVIDUAL]: 2000, [SMALL]: 3500, [MID_SIZE]: 5000, [LARGE]: 5000 },
    hourly: false,
  },
  {
    key: SERVICE_KEYS.COMPLEX_FEDERAL_APPLICATION,
    name: 'Complex/Federal Application',
    group: 'grant_writing',
    description:
      'Comprehensive federal or large foundation proposal ($250K+). Includes all narrative sections, detailed work plan, organizational capacity documentation, partnership coordination, complex budget development, sustainability planning, and compliance review. Typically 20–50+ pages.',
    prices: { [INDIVIDUAL]: 5000, [SMALL]: 8000, [MID_SIZE]: 12000, [LARGE]: 12000 },
    hourly: false,
  },
  {
    key: SERVICE_KEYS.TRANSFER_SCHOLARSHIP_PACK,
    name: 'Transfer Scholarship Pack',
    group: 'grant_writing',
    description:
      'Coordinated application support for students applying to multiple transfer scholarships. Includes common essay development, customization for 3–5 institutions, academic records coordination, and submission tracking.',
    prices: { [INDIVIDUAL]: 450, [SMALL]: 450, [MID_SIZE]: 450, [LARGE]: 450 },
    hourly: false,
  },

  // ── Support & Compliance ──────────────────────────────────────────────────
  {
    key: SERVICE_KEYS.EDITING_REDRAFT,
    name: 'Editing & Redraft Service',
    group: 'support',
    description:
      'Professional editing and revision of existing grant proposals. Includes content strengthening, compliance review, formatting, clarity enhancement, and scoring rubric alignment. Does not include complete rewrite.',
    prices: { [INDIVIDUAL]: 300, [SMALL]: 500, [MID_SIZE]: 900, [LARGE]: 900 },
    hourly: false,
  },
  {
    key: SERVICE_KEYS.BUDGET_LOGIC_MODEL,
    name: 'Budget & Logic Model Development',
    group: 'support',
    description:
      'Standalone budget creation with detailed justification and logic model development. Includes line-item budget, budget narrative, indirect cost calculations, cost-sharing documentation, and visual logic model showing inputs, activities, outputs, and outcomes.',
    prices: { [INDIVIDUAL]: 350, [SMALL]: 600, [MID_SIZE]: 900, [LARGE]: 900 },
    hourly: false,
  },
  {
    key: SERVICE_KEYS.COMPLIANCE_REPORTING,
    name: 'Compliance Reporting & Management',
    group: 'support',
    description:
      'Post-award grant management support. Includes quarterly/annual report preparation, expenditure tracking, outcomes documentation, and compliance verification. Per report or monthly retainer available.',
    prices: { [INDIVIDUAL]: 500, [SMALL]: 1000, [MID_SIZE]: 1500, [LARGE]: 1500 },
    hourly: false,
  },
  {
    key: SERVICE_KEYS.GRANT_CALENDAR,
    name: 'Grant Calendar Setup & Management',
    group: 'support',
    description:
      'Comprehensive grant opportunity tracking system. Includes research of applicable deadlines, calendar creation with milestones, automated reminders, and quarterly updates. 12-month calendar with ongoing support.',
    prices: { [INDIVIDUAL]: 800, [SMALL]: 1200, [MID_SIZE]: 1800, [LARGE]: 1800 },
    hourly: false,
  },

  // ── Hourly ────────────────────────────────────────────────────────────────
  {
    key: SERVICE_KEYS.HOURLY_CONSULTATION,
    name: 'Hourly Consultation & Advisory',
    group: 'hourly',
    description:
      'Flexible hourly support for grant research, proposal review, technical assistance, training, or ad-hoc consulting. Billed in 6-minute increments with 15-minute minimum.',
    prices: { [INDIVIDUAL]: 85, [SMALL]: 85, [MID_SIZE]: 115, [LARGE]: 150 },
    hourly: true,
  },
]

/** Index by service key for O(1) lookup. */
const SERVICES_BY_KEY = SERVICES.reduce((acc, s) => {
  acc[s.key] = s
  return acc
}, {})

export const PRICING_CATALOG = Object.freeze({
  version: PRICING_CATALOG_VERSION,
  currency: 'USD',
  ethical_billing_standard: PAYMENT_TERMS.ethical_billing_standard,
  payment_terms: PAYMENT_TERMS,
  services: Object.freeze(SERVICES.map((s) => Object.freeze({ ...s, prices: Object.freeze(s.prices) }))),
})

export function listServices() {
  return PRICING_CATALOG.services.slice()
}

export function getService(serviceKey) {
  return SERVICES_BY_KEY[serviceKey] || null
}

export function getServicePrice(serviceKey, clientCategory) {
  const svc = SERVICES_BY_KEY[serviceKey]
  if (!svc) return null
  const price = svc.prices[clientCategory]
  return Number.isFinite(price) ? price : null
}

/**
 * Sanity check used by the Sam pricing auditor.
 * Returns true iff every catalog price is a non-negative finite number.
 */
export function catalogIsEthical() {
  for (const svc of SERVICES) {
    for (const cat of Object.keys(svc.prices)) {
      const v = svc.prices[cat]
      if (!Number.isFinite(v) || v < 0) return false
    }
    if (typeof svc.name !== 'string' || svc.name.length === 0) return false
    // Ban any obviously contingent / percentage language in catalog metadata.
    const haystack = `${svc.name} ${svc.description}`.toLowerCase()
    if (
      haystack.includes('% of award') ||
      haystack.includes('percent of award') ||
      haystack.includes('contingent on award') ||
      haystack.includes('commission') ||
      haystack.includes('success fee')
    ) {
      return false
    }
  }
  return true
}
