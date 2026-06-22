/**
 * seedNationalPrograms.js
 *
 * Idempotent startup seed that pushes the curated NATIONAL_PROGRAMS data file
 * into the funding_opportunities table. Without this, the table is populated
 * only when a user runs an active crawl — meaning a brand-new deployment,
 * fresh database, or any environment where the periodic crawlers have not
 * run yet returns "0 results" for legitimate Smart Matcher queries.
 *
 * Per the Smart Matcher spec (§1, "Expand Data Source Coverage") the
 * professional development / continuing education / licensure remediation
 * programs we just added to nationalPrograms.js MUST be in the matchable
 * catalog at all times — not just after a successful nightly crawl.
 *
 * The seed is idempotent: each program has a stable string id (e.g.
 * `np-wioa-ita`), and `upsertFundingOpportunity` is upsert-by-source_id.
 * Re-running has no effect beyond a `last_verified_at`-style touch.
 */

import { NATIONAL_PROGRAMS } from '../shared/data/nationalPrograms.js'
import { bulkUpsertFundingOpportunities } from '../opportunityInserter.js'

/**
 * Convert a NATIONAL_PROGRAMS row into the canonical FundingOpportunity shape
 * accepted by upsertFundingOpportunity. Called once per row at seed time.
 */
function toCanonical(program) {
  if (!program || typeof program !== 'object') return null
  if (!program.id || !program.name || !program.url) return null

  const categories = Array.isArray(program.categories) ? program.categories : []
  const intentMatch = Array.isArray(program.intentMatch) ? program.intentMatch : []
  const occupationMatch = Array.isArray(program.occupationMatch) ? program.occupationMatch : []
  const description =
    typeof program.description === 'string' ? program.description.trim() : ''

  // Map our `type` taxonomy to the canonical opportunity_type vocabulary.
  // referral / portal / directory rows stay marked as result_kind=directory
  // (handled later by classifyResultKind on insert).
  let opportunityType = 'program'
  switch (program.type) {
    case 'grant':
      opportunityType = 'grant'
      break
    case 'benefit':
      opportunityType = 'program'
      break
    case 'assistance':
      opportunityType = 'program'
      break
    case 'directory':
    case 'referral':
    case 'portal':
      opportunityType = 'referral'
      break
    default:
      opportunityType = 'program'
  }

  // Keywords are merged from intent + occupation + a stable "always-on" set
  // so the matching SQL keyword filter (LOWER(keywords) LIKE ...) hits these
  // programs for every common Smart Matcher intent.
  const keywords = Array.from(
    new Set(
      [
        ...categories,
        ...intentMatch,
        ...occupationMatch,
        ...(typeof program.name === 'string' ? [program.name.toLowerCase()] : []),
      ]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase())
        .filter((s) => s.length > 1 && s.length <= 60),
    ),
  ).join(', ')

  return {
    source_id: program.id,
    title: program.name,
    description,
    application_url: program.url,
    source_url: program.url,
    sponsor: program.sponsor || program.name,
    source: 'national_programs_seed',
    record_origin: 'curated_catalog',
    opportunity_type: opportunityType,
    funding_type:
      program.fundingType === 'direct_grant'
        ? 'grant'
        : program.fundingType === 'direct_benefit'
          ? 'benefit'
          : program.fundingType === 'employer_sponsored'
            ? 'employer_sponsored'
            : 'referral',
    deadline_type: 'rolling',
    is_national: program.isNational !== false,
    state: program.state ?? null,
    is_active: true,
    is_loan: false,
    requires_match: false,
    categories: categories.join(', '),
    keywords,
    eligibility_criteria: program.applicationNote || null,
    application_note: program.applicationNote || null,
  }
}

/**
 * Seed the funding_opportunities table with the curated NATIONAL_PROGRAMS list.
 * Returns { attempted, inserted } — caller decides whether to log warnings.
 *
 * @param {Object} db - Database connection (sqlite or postgres).
 * @param {Object} [opts]
 * @param {boolean} [opts.skipUrlVerification=true] - Skip live URL probe to
 *   keep startup fast. The recurring linkVerificationService picks rows up
 *   later and stamps last_verified_at when a real probe runs.
 */
export async function seedNationalPrograms(db, opts = {}) {
  if (!db) {
    return { attempted: 0, inserted: 0, error: 'no_db' }
  }
  const skipUrlVerification = opts.skipUrlVerification !== false

  const canonical = NATIONAL_PROGRAMS.map(toCanonical).filter(Boolean)
  if (canonical.length === 0) {
    return { attempted: 0, inserted: 0 }
  }

  try {
    const insertedIds = await bulkUpsertFundingOpportunities(db, canonical, {
      skipUrlVerification,
      allowExpired: true,
    })
    return {
      attempted: canonical.length,
      inserted: Array.isArray(insertedIds) ? insertedIds.length : 0,
    }
  } catch (err) {
    return {
      attempted: canonical.length,
      inserted: 0,
      error: err?.message || String(err),
    }
  }
}

export default seedNationalPrograms
