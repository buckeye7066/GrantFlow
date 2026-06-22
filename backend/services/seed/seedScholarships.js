/**
 * seedScholarships.js
 *
 * Idempotent startup seed that pushes the curated SCHOLARSHIPS catalog
 * (services/shared/data/scholarships.js) into the funding_opportunities
 * table at server boot.
 *
 * Without this seed, the rich student-aid pool — including state TN HOPE /
 * Promise / TSAA / STEP UP / Aspire, federal Pell / FSEOG, off-campus
 * housing scholarships, forensic-science / STEM / multilingual / heritage
 * funds, and emergency-aid programs — is only populated when a user
 * triggers an active crawl. That meant queries like "off-campus living
 * expenses at MTSU" returned 0 student-aid rows on a fresh deployment
 * even though the catalog data is right there in the source tree.
 *
 * Per the user rule "Counts displayed in the UI must map 1:1 to backend
 * response fields" and "Zero results is a failure state, not an
 * acceptable outcome", we fix this by treating the SCHOLARSHIPS catalog
 * as authoritative seed data alongside NATIONAL_PROGRAMS.
 *
 * The seed is idempotent: each program has a stable string id (e.g.
 * `sch-pell`, `sch-tn-hope`), and `bulkUpsertFundingOpportunities`
 * upserts on source_id. Re-running has no effect beyond a touch.
 */

import { SCHOLARSHIPS } from '../shared/data/scholarships.js'
import { bulkUpsertFundingOpportunities } from '../opportunityInserter.js'

/**
 * Convert a SCHOLARSHIPS row into the canonical FundingOpportunity shape
 * accepted by upsertFundingOpportunity.
 */
function toCanonical(program) {
  if (!program || typeof program !== 'object') return null
  if (!program.id || !program.name || !program.url) return null

  const categories = Array.isArray(program.categories) ? program.categories : []
  const intentMatch = Array.isArray(program.intentMatch) ? program.intentMatch : []
  const interestMatch = Array.isArray(program.interestMatch) ? program.interestMatch : []
  const studentMatch = Array.isArray(program.studentMatch) ? program.studentMatch : []
  const description =
    typeof program.description === 'string' ? program.description.trim() : ''

  // Map the scholarship `type` taxonomy to canonical opportunity_type.
  let opportunityType = 'scholarship'
  switch (program.type) {
    case 'grant':
      opportunityType = 'grant'
      break
    case 'portal':
    case 'referral':
    case 'directory':
      opportunityType = 'referral'
      break
    case 'scholarship':
    default:
      opportunityType = 'scholarship'
  }

  // Always include student-aid trigger keywords on every scholarship row
  // so the matching SQL hits these for any student-aid query (including
  // off-campus / cost-of-attendance / room-and-board variants). This is
  // the "directory rows must always survive filtering" rule applied to
  // the student-aid pool.
  const stableKeywords = [
    'scholarship',
    'student aid',
    'cost of attendance',
    'student living',
    'fafsa',
  ]
  // Categories that include 'housing' get explicit housing keywords so
  // off-campus / room-and-board / on-campus queries reach them.
  if (categories.includes('housing')) {
    stableKeywords.push('off-campus housing', 'room and board', 'student housing', 'student rent assistance')
  }
  // Healthcare-aimed scholarships pick up healthcare-workforce keywords.
  if (categories.includes('healthcare')) {
    stableKeywords.push('healthcare workforce', 'nursing', 'allied health')
  }

  const keywords = Array.from(
    new Set(
      [
        ...categories,
        ...intentMatch,
        ...interestMatch,
        ...studentMatch,
        ...stableKeywords,
        ...(typeof program.name === 'string' ? [program.name.toLowerCase()] : []),
      ]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase())
        .filter((s) => s.length > 1 && s.length <= 80),
    ),
  ).join(', ')

  // School-specific scholarships keep a state restriction; otherwise we
  // mark them as national so they appear for every profile.
  const stateRestriction = program.stateRestriction || program.state || null

  // Eligibility criteria — stringify so the matcher can text-match them.
  const eligLines = []
  if (program.eligibility && typeof program.eligibility === 'object') {
    if (program.eligibility.requiresStudent) eligLines.push('Must be a student')
    if (program.eligibility.stateResident) eligLines.push(`State resident: ${program.eligibility.stateResident}`)
    if (program.eligibility.minGPA) eligLines.push(`Minimum GPA: ${program.eligibility.minGPA}`)
    if (program.eligibility.minACT) eligLines.push(`Minimum ACT: ${program.eligibility.minACT}`)
    if (program.eligibility.minSAT) eligLines.push(`Minimum SAT: ${program.eligibility.minSAT}`)
    if (program.eligibility.needBased) eligLines.push('Need-based')
    if (program.eligibility.incomeBased) eligLines.push('Income-based')
  }

  return {
    source_id: program.id,
    title: program.name,
    description,
    application_url: program.url,
    source_url: program.url,
    sponsor: program.sponsor || program.name,
    source: 'scholarships_seed',
    record_origin: 'curated_catalog',
    opportunity_type: opportunityType,
    funding_type:
      program.fundingType === 'direct_grant'
        ? 'grant'
        : program.fundingType === 'referral_service'
          ? 'referral'
          : program.fundingType === 'institutional_aid'
            ? 'institutional_aid'
            : 'scholarship',
    deadline_type: 'rolling',
    is_national: !stateRestriction,
    state: stateRestriction,
    is_active: true,
    is_loan: false,
    requires_match: false,
    categories: categories.join(', '),
    keywords,
    eligibility_criteria: eligLines.length ? eligLines.join('. ') : null,
    application_note: program.applicationNote || null,
    max_amount: typeof program.maxAmount === 'number' ? program.maxAmount : null,
    priority: typeof program.priority === 'number' ? program.priority : null,
  }
}

/**
 * Seed the funding_opportunities table with the curated SCHOLARSHIPS list.
 * Returns { attempted, inserted } — caller decides whether to log warnings.
 *
 * @param {Object} db - Database connection (sqlite or postgres).
 * @param {Object} [opts]
 * @param {boolean} [opts.skipUrlVerification=true]
 */
export async function seedScholarships(db, opts = {}) {
  if (!db) {
    return { attempted: 0, inserted: 0, error: 'no_db' }
  }
  const skipUrlVerification = opts.skipUrlVerification !== false

  const canonical = SCHOLARSHIPS.map(toCanonical).filter(Boolean)
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

export default seedScholarships
