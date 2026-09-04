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

import { opportunityLifecycleVisibilityPortableSql } from '../config/matchSurfacing.js'
import { pointerOpportunityRowSql } from '../config/linkLifecycleKinds.js'
import {
  LINK_PROOF_MAX_AGE_DAYS,
  SUCCESSFUL_LINK_STATUSES,
} from '../services/opportunityLinkProofGuard.js'

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

function linkProofReadClause(alias) {
  const prefix = alias ? `${alias}.` : ''
  const successStatuses = SUCCESSFUL_LINK_STATUSES
    .map((status) => `'${escapeSqlStringLiteral(status)}'`)
    .join(',')
  const nowMs = Date.now()
  const cutoff = new Date(nowMs - LINK_PROOF_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const futureTolerance = new Date(nowMs + 5 * 60 * 1000).toISOString()
  const pointer = pointerOpportunityRowSql(alias)

  // ISO timestamps sort chronologically in both supported adapters and an ISO
  // literal is accepted by PostgreSQL timestamp columns. This avoids dialect-
  // specific datetime arithmetic while making freshness a property of every
  // read, not merely of the last background verifier tick.
  return `(${pointer} OR (` +
    `LOWER(TRIM(COALESCE(${prefix}link_status, ''))) IN (${successStatuses})` +
    ` AND ${prefix}last_verified_at IS NOT NULL` +
    ` AND ${prefix}last_verified_at >= '${escapeSqlStringLiteral(cutoff)}'` +
    ` AND ${prefix}last_verified_at <= '${escapeSqlStringLiteral(futureTolerance)}'` +
    `))`
}

/**
 * Returns the shared READ-SIDE catalog trust fragment. A row is readable only
 * when all conditions hold:
 *   1. its origin is not explicitly untrusted;
 *   2. the canonical lifecycle contract says it is active and not hidden; and
 *   3. a direct opportunity has current successful link proof. Pointer/resource
 *      rows are intentionally outside the direct-link proof requirement.
 *
 * The lifecycle and proof composition is deliberate. `trustedOriginClause()`
 * is the long-standing read guard used by AI matching, discovery, Anya,
 * crawler-result selection, college aid lookup, and backfill paths. Keeping
 * quarantine and proof freshness here prevents any one reader from treating
 * either `is_hidden` or stale verification as optional.
 *
 * Safe for both SQLite and Postgres.
 * @param {string} [alias] - Optional table alias, e.g. 'fo'
 */
export function trustedOriginClause(alias) {
  if (alias !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`trustedOriginClause: invalid alias '${alias}'`)
  }
  const col = alias ? `${alias}.record_origin` : 'record_origin'
  const quoted = UNTRUSTED_ORIGINS.map(o => `'${escapeSqlStringLiteral(o)}'`).join(',')
  const lifecycle = opportunityLifecycleVisibilityPortableSql({ tableAlias: alias || '' })
  const linkProof = linkProofReadClause(alias)
  return `(${lifecycle} AND ${linkProof} AND (${col} IS NULL OR ${col} NOT IN (${quoted})))`
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
 * e.g. (source IS NULL OR source NOT IN ('synthetic','template','fake'))
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
