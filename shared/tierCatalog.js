/**
 * tierCatalog.js — THE canonical tier model for GrantFlow.
 *
 * Single source of truth for: every billing tier, its plain-English
 * explanation, price, support hours, capability flags, and (for organizations)
 * the seat range that selects it. Discounts (student / minister / hardship /
 * pro bono) are OVERRIDES, not tiers.
 *
 * Consumed by:
 *   - backend: seeds `billing_tiers`, served at GET /api/billing/catalog,
 *     resolves seat-count → org tier → monthly amount.
 *   - frontend: Pricing.jsx, Billing.jsx, the "What your plan includes" matrix,
 *     and the useTierEntitlements hook (all via the API, so the backend stays
 *     the runtime source of truth).
 *
 * Capability flags are the SAME three the backend enforces everywhere
 * (backend/utils/tierGating.js): enable_document_ai, enable_item_funding,
 * enable_pipeline_automation. Plain-English labels live here so no UI ever
 * shows a raw flag name.
 */

export const CAPABILITY_KEYS = Object.freeze({
  DOCUMENT_AI: 'enable_document_ai',
  ITEM_FUNDING: 'enable_item_funding',
  PIPELINE_AUTOMATION: 'enable_pipeline_automation',
})

// Plain-English description of each capability — shown in the tier matrix.
export const CAPABILITY_LABELS = Object.freeze({
  enable_document_ai: {
    label: 'Document AI',
    plain: 'AI reads your uploaded documents, extracts the details, and fills in your profile. (Uploading and storing documents is always free.)',
  },
  enable_item_funding: {
    label: 'Item funding search',
    plain: 'Search for funding toward specific items and needs, and queue deeper crawlers that hunt down sources for them.',
  },
  enable_pipeline_automation: {
    label: 'Pipeline automation',
    plain: 'Hamilton works your pipeline for you — preparing applications, filling portals, and tracking deadlines hands-off.',
  },
})

const cap = (documentAi, itemFunding, pipeline) => ({
  enable_document_ai: documentAi,
  enable_item_funding: itemFunding,
  enable_pipeline_automation: pipeline,
})

/**
 * Canonical tiers. `id` matches billing_tiers.id (do not rename without a
 * migration). `family`: 'service' (the named plans) or 'organization' (seat-
 * driven). `seat_range` selects an organization tier from its number of logins.
 * Monetary values are cents.
 */
export const TIERS = Object.freeze([
  {
    id: 'foundation',
    name: 'Foundation',
    family: 'service',
    audience: 'Individuals & families getting started',
    monthly_cents: 0,
    hourly_cents: 0,
    support_hours: 0,
    seat_range: null,
    capabilities: cap(true, true, false),
    summary: 'Free starting point — discover grants, save and track them, and let AI read your documents.',
    includes: ['Curated grant discovery', 'AI document reading', 'Save & track opportunities', 'Item funding search'],
    excludes: ['Hands-off pipeline automation'],
  },
  {
    id: 'growth',
    name: 'Growth',
    family: 'service',
    audience: 'Active applicants who want automation',
    monthly_cents: 9900,
    hourly_cents: 15000,
    support_hours: 2,
    seat_range: null,
    capabilities: cap(true, true, true),
    summary: 'Everything in Foundation, plus Hamilton automating your pipeline and deeper itemized funding intelligence.',
    includes: ['Everything in Foundation', 'Pipeline automation', 'Itemized funding intelligence', '2 hrs/mo support'],
    excludes: [],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    family: 'service',
    audience: 'Full-service concierge',
    monthly_cents: 24900,
    hourly_cents: 22500,
    support_hours: 5,
    seat_range: null,
    capabilities: cap(true, true, true),
    summary: 'Full-service concierge with custom automation rules and dedicated analyst support.',
    includes: ['Everything in Growth', 'Custom automation rules', 'Dedicated analyst', '5 hrs/mo support'],
    excludes: [],
  },
  {
    id: 'individual',
    name: 'Individual / family',
    family: 'service',
    audience: 'A single person or household',
    monthly_cents: 0,
    hourly_cents: 8500,
    support_hours: 0,
    seat_range: null,
    capabilities: cap(true, true, false),
    summary: 'Pay-as-you-go help for one person or family. No monthly fee; hourly support when you want it.',
    includes: ['Grant discovery', 'AI document reading', 'Item funding search', 'Hourly support as needed'],
    excludes: ['Pipeline automation'],
  },
  // ── Organization tiers — selected by number of email logins (seats) ──────
  {
    id: 'small_org',
    name: 'Small organization',
    family: 'organization',
    audience: 'Organizations with 1 login',
    monthly_cents: 14900,
    hourly_cents: 8500,
    support_hours: 1,
    seat_range: { min: 1, max: 1 },
    capabilities: cap(true, true, false),
    summary: 'For small organizations operating with a single login.',
    includes: ['Grant discovery', 'AI document reading', 'Item funding search', '1 hr/mo support'],
    excludes: ['Pipeline automation'],
  },
  {
    id: 'mid_size',
    name: 'Mid-sized organization',
    family: 'organization',
    audience: 'Organizations with 2–5 logins',
    monthly_cents: 34900,
    hourly_cents: 11500,
    support_hours: 3,
    seat_range: { min: 2, max: 5 },
    capabilities: cap(true, true, true),
    summary: 'For mid-sized organizations with a small team (2–5 logins). Adds pipeline automation.',
    includes: ['Everything in Small', 'Pipeline automation', '2–5 team logins', '3 hrs/mo support'],
    excludes: [],
  },
  {
    id: 'large_org',
    name: 'Large organization',
    family: 'organization',
    audience: 'Organizations with 6+ logins',
    monthly_cents: 59900,
    hourly_cents: 15000,
    support_hours: 6,
    seat_range: { min: 6, max: null },
    capabilities: cap(true, true, true),
    summary: 'For large organizations with 6 or more logins. Full automation and the most support hours.',
    includes: ['Everything in Mid-sized', '6+ team logins', 'Full automation', '6 hrs/mo support'],
    excludes: [],
  },
])

/**
 * Discounts / overrides — applied ON TOP of a tier, never a tier themselves.
 * `percent` is the default; admins approve and can adjust per account. Pro bono
 * is the `is_pro_bono` flag on the billing account (100% off).
 */
export const DISCOUNTS = Object.freeze([
  { id: 'student', label: 'Student', percent: 15, plain: 'Reduced rate for verified students.' },
  { id: 'minister', label: 'Minister / clergy', percent: 10, plain: 'Reduced rate for ministers and clergy.' },
  { id: 'hardship', label: 'Financial hardship', percent: 15, plain: 'Reduced rate for documented financial hardship.' },
  { id: 'pro_bono', label: 'Pro bono', percent: 100, plain: 'Fully waived — invoices show $0 for tax records.', flag: 'is_pro_bono' },
])

const TIER_BY_ID = Object.freeze(Object.fromEntries(TIERS.map((t) => [t.id, t])))
export const TIER_IDS = Object.freeze(TIERS.map((t) => t.id))

export function tierById(id) {
  return TIER_BY_ID[id] || null
}

/** The organization tier selected by a given seat (login) count. */
export function orgTierForSeats(seatCount) {
  const n = Math.max(0, Math.floor(Number(seatCount) || 0))
  const orgTiers = TIERS.filter((t) => t.family === 'organization' && t.seat_range)
  for (const t of orgTiers) {
    const { min, max } = t.seat_range
    if (n >= min && (max === null || n <= max)) return t
  }
  // 0 seats → smallest org tier (treated as 1).
  return orgTiers[0] || null
}

const centsToUsd = (c) => (c === null || c === undefined ? null : Math.round(Number(c)) / 100)

/**
 * The public-facing pricing shape (what Pricing.jsx renders). Derived from the
 * SAME tiers so marketing and billing can never drift.
 */
export function publicPricingTiers() {
  return TIERS.map((t) => ({
    id: t.id,
    name: t.name,
    family: t.family,
    audience: t.audience,
    monthly_usd: centsToUsd(t.monthly_cents),
    hourly_usd: centsToUsd(t.hourly_cents),
    support_hours: t.support_hours,
    seat_range: t.seat_range,
    capabilities: t.capabilities,
    summary: t.summary,
    includes: t.includes,
    excludes: t.excludes,
  }))
}

/** The whole catalog as the API returns it. */
export function fullCatalog() {
  return {
    capability_keys: CAPABILITY_KEYS,
    capability_labels: CAPABILITY_LABELS,
    tiers: publicPricingTiers(),
    discounts: DISCOUNTS,
  }
}
