/**
 * Single source of truth for record_origin values across the entire backend.
 *
 * Write-side (opportunityInserter) validates incoming origins against ALLOWED_RECORD_ORIGINS.
 * Read-side (matching, discovery) excludes UNTRUSTED_ORIGINS via a SQL NOT IN clause.
 *
 * Adding a new crawler origin:
 *   1. Add it to ALLOWED_RECORD_ORIGINS below.
 *   2. Add a DB migration expanding the CHECK constraint.
 *   That's it — read-side queries automatically include it because they use a blocklist.
 */

export const ALLOWED_RECORD_ORIGINS = new Set([
  'live_crawl',
  'curated_verified',
  'curated_benefits',
  'curated_program',
  // Curated startup seed (NATIONAL_PROGRAMS + SCHOLARSHIPS data files
  // pushed into funding_opportunities by services/seed/seed*Programs.js).
  // Without this, the inserter silently rewrites the origin to 'live_crawl'
  // which loses provenance and (more importantly) blocks the curated rows
  // from being recognised as a TRUSTED_ORIGIN by pipelineAllowedSources.js.
  'curated_catalog',
  'scholarship_crawler',
  'school_portal',
  'grants_gov',
  'verified_real',
  'cof_foundation_locator',
  'manual',
  'synthetic',
  'funding_api',
  // Clinical trials / research studies surfaced for opted-in medical-need
  // profiles (ClinicalTrials.gov). These are STUDIES, not funding.
  'clinical_trials',
  'url_import',
  'directory_resource',
  'directory:health_resources',
  'directory:student_grants',
  'discovered',
  'geo_crawl',
  // User-initiated live web leads. These are allowed as low-trust leads and
  // still pass through quality/reviewer/reality gates before storage.
  'web_search',
  'seeded',
  'imported',
])

/**
 * Origins that must NEVER appear in user-facing search/match results.
 * Everything not in this list is shown (blocklist approach).
 */
export const UNTRUSTED_ORIGINS = ['synthetic', 'manual']

/**
 * Returns a SQL fragment: (record_origin IS NULL OR record_origin NOT IN ('synthetic','manual'))
 * Safe for both SQLite and Postgres.
 * @param {string} [alias] - Optional table alias, e.g. 'fo' → 'fo.record_origin'
 */
export function trustedOriginClause(alias) {
  if (alias !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
  throw new Error(`trustedOriginClause: invalid alias '${alias}'`)
}
const col = alias ? `${alias}.record_origin` : 'record_origin'
  const quoted = UNTRUSTED_ORIGINS.map(o => `'${escapeSqlStringLiteral(o)}'`).join(',')
  return `(${col} IS NULL OR ${col} NOT IN (${quoted}))`
}

/**
 * Source values (the `source` column) that should never appear in user-facing results.
 * Unified across matching.js and discovery.js to prevent drift.
 */
// 'comprehensive_crawler' was previously blocked here, which silently excluded
// all opportunities discovered by the primary crawler (comprehensiveCrawlerOptimized.js)
// from every user-facing query — a guaranteed recall loss for Goal 7.
// Removed from the blocklist. If specific crawler records are untrustworthy,
// they must be rejected at insertion time by relevanceFilter / opportunityMatcher
// (Goals 3, 4) and logged with a reason (Goal 8).
export const UNTRUSTED_SOURCES = ['synthetic', 'template', 'fake']

/**
 * Returns a SQL fragment for the `source` column blocklist.
 * e.g. (source IS NULL OR source NOT IN ('synthetic','template','comprehensive_crawler','fake'))
 * @param {string} [alias] - Optional table alias, e.g. 'fo' → 'fo.source'
 */
export function trustedSourceClause(alias) {
  const col = alias ? `${alias}.source` : 'source'
  const quoted = UNTRUSTED_SOURCES.map(o => `'${escapeSqlStringLiteral(o)}'`).join(',')
  return `(${col} IS NULL OR ${col} NOT IN (${quoted}))`
}

/** Escape a value for use inside a SQL single-quoted string literal. */
function escapeSqlStringLiteral(s) {
  return String(s).replace(/'/g, "''")
}

/**
 * Returns a Postgres CHECK constraint body using every allowed origin.
 * e.g. "record_origin IN ('live_crawl','curated_verified', ...)"
 */
export function allowedOriginCheckSQL() {
  const quoted = [...ALLOWED_RECORD_ORIGINS]
    .map(o => `'${escapeSqlStringLiteral(o)}'`)
    .join(',')
  return `record_origin IN (${quoted})`
}
