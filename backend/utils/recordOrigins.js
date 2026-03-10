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
  'scholarship_crawler',
  'school_portal',
  'grants_gov',
  'verified_real',
  'cof_foundation_locator',
  'manual',
  'synthetic',
  'funding_api',
  'url_import',
  'directory_resource',
  'directory:health_resources',
  'directory:student_grants',
  'discovered',
  'geo_crawl',
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
 */
export function trustedOriginClause() {
  const quoted = UNTRUSTED_ORIGINS.map(o => `'${o}'`).join(',')
  return `(record_origin IS NULL OR record_origin NOT IN (${quoted}))`
}

/**
 * Returns a Postgres CHECK constraint body using every allowed origin.
 * e.g. "record_origin IN ('live_crawl','curated_verified', ...)"
 */
export function allowedOriginCheckSQL() {
  const quoted = [...ALLOWED_RECORD_ORIGINS].map(o => `'${o}'`).join(',')
  return `record_origin IN (${quoted})`
}
