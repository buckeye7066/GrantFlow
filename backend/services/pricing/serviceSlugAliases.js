/**
 * Canonical → legacy service slug map.
 *
 * The 2026-06-15 GrantFlow catalog uses bare service titles
 * (e.g. "Standard Foundation Application"), which slug to
 * `standard-foundation-application`. Earlier extracts included
 * inline price-range qualifiers in the title (e.g. "Standard Foundation
 * Application ($5K–$250K)"), which slugged to
 * `standard-foundation-application-5k-250k`.
 *
 * To avoid duplicate `service_catalog_items` rows during the
 * 2025-11-13 → 2026-06-15 migration, the seeder rewrites any
 * legacy slug it finds in the database to the canonical slug
 * **before** upserting the new catalog. The chargeResolver and
 * Stripe verifier also call `resolveCanonicalServiceSlug()` so
 * external callers (frontend forms, admin tools, scripts) that
 * still reference legacy slugs do not silently miss prices.
 *
 * The map is intentionally exhaustive: every legacy slug we have
 * ever shipped is listed so that `resolveCanonicalServiceSlug()`
 * never falls through and creates an orphan checkout.
 */

/** @type {Readonly<Record<string, string>>} */
export const LEGACY_SLUG_TO_CANONICAL = Object.freeze({
  // 2025-11-13 inline-qualifier slugs → 2026-06-15 canonical slugs.
  'standard-foundation-application-5k-250k': 'standard-foundation-application',
  'complex-federal-application-250k': 'complex-federal-application',
  'transfer-scholarship-pack-flat-pricing': 'transfer-scholarship-pack',
  'micro-grant-application-5k': 'micro-grant-application',
})

/** @type {ReadonlySet<string>} */
export const CANONICAL_SLUGS = Object.freeze(
  new Set([
    'quick-eligibility-scan',
    'comprehensive-funding-dossier',
    'application-strategy-session',
    'micro-grant-application',
    'standard-foundation-application',
    'complex-federal-application',
    'transfer-scholarship-pack',
    'editing-and-redraft-service',
    'budget-and-logic-model-development',
    'compliance-reporting-and-management',
    'grant-calendar-setup-and-management',
    'hourly-consultation-and-advisory',
  ]),
)

/**
 * Resolve any incoming slug (canonical, legacy, or normalized variant)
 * to its canonical form. Returns `null` if the slug is unrecognised so
 * callers can produce an explicit, auditable failure mode rather than
 * silently constructing an invalid checkout.
 *
 * @param {string} slug
 * @returns {string|null}
 */
export function resolveCanonicalServiceSlug(slug) {
  if (slug === null || slug === undefined) return null
  const trimmed = String(slug).trim().toLowerCase()
  if (!trimmed) return null
  if (CANONICAL_SLUGS.has(trimmed)) return trimmed
  if (Object.prototype.hasOwnProperty.call(LEGACY_SLUG_TO_CANONICAL, trimmed)) {
    return LEGACY_SLUG_TO_CANONICAL[trimmed]
  }
  return null
}

/**
 * Returns true when the slug is recognised either as canonical or as a
 * known legacy alias. Useful for input validation in admin forms.
 *
 * @param {string} slug
 * @returns {boolean}
 */
export function isKnownServiceSlug(slug) {
  return resolveCanonicalServiceSlug(slug) !== null
}

/**
 * Reverse map: canonical → array of legacy slug aliases that resolve to it.
 * Used by Sam's auditor and by the catalog migration to detect duplicate
 * catalog rows that need to be merged onto the canonical row.
 *
 * @returns {Record<string, string[]>}
 */
export function legacyAliasesByCanonical() {
  const out = {}
  for (const [legacy, canonical] of Object.entries(LEGACY_SLUG_TO_CANONICAL)) {
    if (!out[canonical]) out[canonical] = []
    out[canonical].push(legacy)
  }
  return out
}

export default {
  LEGACY_SLUG_TO_CANONICAL,
  CANONICAL_SLUGS,
  resolveCanonicalServiceSlug,
  isKnownServiceSlug,
  legacyAliasesByCanonical,
}
