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
 * Capability flags are the vocabulary the backend enforces
 * (backend/utils/tierGating.js). Plain-English labels live here so no UI ever
 * shows a raw flag name.
 *
 * PACKAGING (2026-09-15). Three flags could not express a seven-rung ladder, so
 * every tier had been given every capability and there was nothing to sell.
 * The flag set below is the smallest one that separates the tiers on the two
 * axes that actually matter:
 *   - COST TO SERVE: drafting and automation burn LLM and portal time; reading
 *     a saved grant does not. Anything with a per-use cost sits behind a paid
 *     tier.
 *   - RISK: `enable_auto_submit` is split out of `enable_pipeline_automation`
 *     on purpose. "Run unattended and leave a draft" and "file an application
 *     on someone's behalf" are the same flag no longer: one is recoverable, the
 *     other is an irreversible act in the outside world, and only the second
 *     belongs at the top of the ladder.
 *
 * Discovery, saved grants, deadlines and reminders are deliberately UNGATED at
 * every tier, including free. They are the hook, they cost almost nothing to
 * serve, and gating them would mean a new user cannot see the product work.
 */

export const CAPABILITY_KEYS = Object.freeze({
  DOCUMENT_AI: 'enable_document_ai',
  ITEM_FUNDING: 'enable_item_funding',
  MATCHING_INTELLIGENCE: 'enable_matching_intelligence',
  APPLICATION_DRAFTING: 'enable_application_drafting',
  PIPELINE_AUTOMATION: 'enable_pipeline_automation',
  AUTO_SUBMIT: 'enable_auto_submit',
  FUNDER_INTELLIGENCE: 'enable_funder_intelligence',
  OUTREACH: 'enable_outreach',
  COMPLIANCE_REPORTING: 'enable_compliance_reporting',
  BULK_EXPORT: 'enable_bulk_export',
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
  enable_matching_intelligence: {
    label: 'Deep match scoring',
    plain: 'Every funding source is scored against your whole profile and must clear four checks before it reaches you: it is real, it is relevant to you, it funds something you actually need, and you qualify for it.',
  },
  enable_application_drafting: {
    label: 'Application drafting',
    plain: 'Hamilton writes the application for you, drawing on your profile and the funder’s own stated requirements instead of a generic template.',
  },
  enable_pipeline_automation: {
    label: 'Pipeline automation',
    plain: 'Hamilton works your pipeline hands-off — opening portals, filling forms and saving drafts — and stops before submitting so you have the last word.',
  },
  enable_auto_submit: {
    label: 'Autonomous submission',
    plain: 'Hamilton finishes the job and submits without waiting for a final review. You turn this on yourself, per profile, and can turn it off at any time.',
  },
  enable_funder_intelligence: {
    label: 'Funder intelligence',
    plain: 'See what a funder has actually given, to whom, where and how much, from their public 990 filings — so you approach the ones who already fund work like yours.',
  },
  enable_outreach: {
    label: 'Outreach campaigns',
    plain: 'Find new funder and partner leads and send personalised introductions written from that organisation’s own mission and giving history.',
  },
  enable_compliance_reporting: {
    label: 'Compliance & award reporting',
    plain: 'Track budgets and spend against an award, and produce the compliance reports and award summaries a funder asks for after you win.',
  },
  enable_bulk_export: {
    label: 'Bulk export & analytics',
    plain: 'Export your whole pipeline and profile packets in bulk, and see portfolio-level analytics across every profile you manage.',
  },
})

/**
 * Capability add-ons are durable account entitlements, not shadow tiers. Prices
 * are intentionally absent here: a price must come from a versioned quote or
 * verified Stripe/service purchase, while this catalog owns only the stable
 * capability vocabulary and customer-facing meaning.
 */
export const ADDON_CATALOG = Object.freeze(
  Object.values(CAPABILITY_KEYS).map((key) => Object.freeze({
    id: key.replace(/^enable_/, ''),
    capability_key: key,
    label: CAPABILITY_LABELS[key].label,
    plain: CAPABILITY_LABELS[key].plain,
  })),
)

/**
 * Build a capability set from the flags a tier GRANTS. Everything unnamed is
 * false. Positional arguments did not survive going from three flags to ten -
 * `cap(true, true, false, true, ...)` is unreadable and a silently reordered
 * argument would hand out a capability nobody sold.
 */
const cap = (...granted) => {
  const set = {}
  for (const key of Object.values(CAPABILITY_KEYS)) set[key] = false
  for (const key of granted) {
    if (!(key in set)) throw new Error(`unknown capability in tier catalog: ${key}`)
    set[key] = true
  }
  return set
}

const K = CAPABILITY_KEYS

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
    capabilities: cap(K.DOCUMENT_AI, K.ITEM_FUNDING),
    summary: 'Free starting point — find grants, keep track of deadlines, and let AI read your documents and fill in your profile.',
    includes: ['Curated grant discovery', 'Deadline tracking & reminders', 'Save & track opportunities', 'AI document reading', 'Item funding search'],
    excludes: ['Deep match scoring', 'Application drafting', 'Pipeline automation', 'Autonomous submission'],
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
    capabilities: cap(K.DOCUMENT_AI, K.ITEM_FUNDING, K.MATCHING_INTELLIGENCE, K.APPLICATION_DRAFTING, K.PIPELINE_AUTOMATION),
    summary: 'Everything in Foundation, plus Hamilton scoring your matches, drafting your applications, and working your pipeline hands-off.',
    includes: ['Everything in Foundation', 'Deep match scoring', 'Application drafting', 'Pipeline automation', '2 hrs/mo support'],
    excludes: ['Autonomous submission', 'Funder intelligence', 'Compliance & award reporting'],
  },
  {
    id: 'enterprise',
    /* DISPLAY NAME 2026-09-15: "Enterprise" at $249 sits BELOW the $349 and
       $599 organization tiers, so an org buyer reading the matrix saw
       "Enterprise" as a downgrade. The id is unchanged deliberately - it maps
       to billing_tiers.id and renaming it needs a migration - but the name
       customers see now describes what this tier is: the full-service option
       for one person or household, not a company plan. */
    name: 'Concierge',
    family: 'service',
    audience: 'Full-service, for one person or household',
    monthly_cents: 24900,
    hourly_cents: 22500,
    support_hours: 5,
    seat_range: null,
    capabilities: cap(K.DOCUMENT_AI, K.ITEM_FUNDING, K.MATCHING_INTELLIGENCE, K.APPLICATION_DRAFTING,
      K.PIPELINE_AUTOMATION, K.AUTO_SUBMIT, K.FUNDER_INTELLIGENCE, K.COMPLIANCE_REPORTING),
    summary: 'Hands-off from search to submitted. Hamilton finishes and files applications for you, and you see what a funder has actually given before you apply.',
    includes: ['Everything in Growth', 'Autonomous submission', 'Funder intelligence (990 giving history)', 'Compliance & award reporting', 'Dedicated analyst', '5 hrs/mo support'],
    excludes: ['Outreach campaigns', 'Bulk export & analytics'],
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
    capabilities: cap(K.DOCUMENT_AI, K.ITEM_FUNDING),
    summary: 'Pay-as-you-go help for one person or family. No monthly fee; hourly support when you want it.',
    includes: ['Grant discovery', 'Deadline tracking & reminders', 'AI document reading', 'Item funding search', 'Hourly support as needed'],
    excludes: ['Deep match scoring', 'Application drafting', 'Pipeline automation', 'Autonomous submission'],
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
    /* At $149 this must carry everything Growth ($99) carries, or the ladder
       charges more for less. It adds what an organization needs even at one
       seat: award compliance and reporting. */
    capabilities: cap(K.DOCUMENT_AI, K.ITEM_FUNDING, K.MATCHING_INTELLIGENCE, K.APPLICATION_DRAFTING,
      K.PIPELINE_AUTOMATION, K.COMPLIANCE_REPORTING),
    summary: 'For small organizations operating with a single login. Everything in Growth, plus the budget and compliance reporting an award requires.',
    includes: ['Everything in Growth', 'Organization profile & contacts', 'Compliance & award reporting', '1 hr/mo support'],
    excludes: ['Autonomous submission', 'Funder intelligence', 'Outreach campaigns'],
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
    capabilities: cap(K.DOCUMENT_AI, K.ITEM_FUNDING, K.MATCHING_INTELLIGENCE, K.APPLICATION_DRAFTING,
      K.PIPELINE_AUTOMATION, K.AUTO_SUBMIT, K.FUNDER_INTELLIGENCE, K.OUTREACH, K.COMPLIANCE_REPORTING),
    summary: 'For mid-sized organizations with a small team (2–5 logins). Hamilton files for you, and Yana and John go find and approach new funders.',
    includes: ['Everything in Small organization', 'Autonomous submission', 'Funder intelligence', 'Outreach campaigns (leads & email)', '2–5 team logins', '3 hrs/mo support'],
    excludes: ['Bulk export & analytics'],
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
    capabilities: cap(...Object.values(CAPABILITY_KEYS)),
    summary: 'For large organizations with 6 or more logins. Every capability, portfolio-wide analytics, and the most support hours.',
    includes: ['Everything in Mid-sized', 'Bulk export & analytics', '6+ team logins', '6 hrs/mo support'],
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

/**
 * The highest NON-ADMIN tier in the catalog: the most expensive tier, and on a
 * price tie the one with the most capabilities. Admins are not a tier (they
 * bypass entitlement entirely), so this is the ceiling any customer can hold.
 * Today: large_org (every capability on). Consumed by the entitlement choke
 * point as the UNIVERSAL entitlement policy (owner order 2026-09-07); billing
 * amounts still follow the profile type and are never derived from this.
 */
export function highestNonAdminTier() {
  const capCount = (t) => Object.values(t.capabilities || {}).filter(Boolean).length
  return TIERS.reduce((best, t) => {
    if (!best) return t
    if (t.monthly_cents > best.monthly_cents) return t
    if (t.monthly_cents === best.monthly_cents && capCount(t) > capCount(best)) return t
    return best
  }, null)
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
    addons: ADDON_CATALOG,
    tiers: publicPricingTiers(),
    discounts: DISCOUNTS,
  }
}
