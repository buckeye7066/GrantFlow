/**
 * Eligibility Filter — Pre-pipeline gate for opportunities
 *
 * Runs hard and soft eligibility checks against a ProfileIntelligence object
 * before an opportunity can be inserted into a profile's pipeline.
 *
 * Returns a structured result:
 * {
 *   verdict: 'eligible'|'probably_eligible'|'probably_ineligible'|'ineligible',
 *   score: 0–100,
 *   reasons: string[],           // All reasons (pass and fail)
 *   hard_failures: string[],     // Absolute blockers
 *   soft_warnings: string[],     // Soft concerns that reduce score
 *   matched_needs: string[],     // Need codes this opportunity addresses
 *   unmet_requirements: string[], // Requirements the profile doesn't meet
 * }
 */

import { NEEDS_TAXONOMY } from './needsTaxonomy.js'
import { isValidHttpUrl } from '../shared/crawlerOpportunityContract.js'
import { isTruthyFlag } from '../opportunityTrust.js'

/** Parse a DB field that may be a JSON array, CSV string, or already an array. */
function parseArrayField(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'string') return []
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) { try { const a = JSON.parse(trimmed); if (Array.isArray(a)) return a } catch { /* fall through */ } }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Entity type groups for eligibility matching
// ---------------------------------------------------------------------------
const NONPROFIT_TYPES = new Set([
  'nonprofit', 'church', 'faith_based', 'community_action', 'library',
  'school', 'school_district', 'charter_school', 'college', 'hospital',
  'housing_authority', 'cdfi',
])

const ORG_TYPES = new Set([
  'nonprofit', 'church', 'faith_based', 'community_action', 'library',
  'school', 'school_district', 'charter_school', 'college', 'hospital',
  'housing_authority', 'cdfi', 'business', 'government', 'tribal',
  'fire_ems',
])

const GOVERNMENT_TYPES = new Set(['government', 'tribal'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isExpired(opportunity) {
  const deadline = opportunity.deadline || opportunity.close_date
  if (!deadline) return false

  const deadlineType = opportunity.deadline_type
  if (deadlineType === 'rolling' || deadlineType === 'open' || deadlineType === 'ongoing') return false

  try {
    const d = new Date(deadline)
    if (Number.isNaN(d.getTime())) return false
    const now = new Date()
    if (Number.isNaN(now.getTime())) return false
    // Normalize both dates to UTC midnight so same-day deadlines do not
    // flip to "expired" in negative local timezones.
    const deadlineUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    return deadlineUtc < todayUtc
  } catch { return false }
}

function hasSourceUrl(opportunity) {
  const url = opportunity.source_url || opportunity.application_url ||
    opportunity.apply_url || opportunity.evidence_url || opportunity.url || ''
  return isValidHttpUrl(url.trim())
}

function extractOppEntityTypes(opportunity) {
  // Parse eligible entity types from the opportunity
  let types = []

  if (opportunity.eligible_entity_types) {
    if (Array.isArray(opportunity.eligible_entity_types)) {
      types = opportunity.eligible_entity_types
    } else if (typeof opportunity.eligible_entity_types === 'string') {
      try {
        types = JSON.parse(opportunity.eligible_entity_types)
      } catch {
        types = opportunity.eligible_entity_types.split(',').map(t => t.trim())
      }
    }
  }

  // Fall back to opportunity_type / categories
  if (types.length === 0) {
    const oppType = String(opportunity.opportunity_type || '').toLowerCase()
    const cats = parseArrayField(opportunity.categories)

    if (oppType.includes('nonprofit') || cats.some(c => /nonprofit/i.test(c))) types.push('nonprofit')
    if (oppType.includes('individual') || cats.some(c => /individual/i.test(c))) types.push('individual')
    if (oppType.includes('business') || cats.some(c => /business/i.test(c))) types.push('business')
    if (oppType.includes('government') || cats.some(c => /government/i.test(c))) types.push('government')
    if (oppType.includes('school') || cats.some(c => /school|education/i.test(c))) types.push('school')
    if (oppType.includes('tribal') || cats.some(c => /tribal/i.test(c))) types.push('tribal')
  }

  return types.map(t => String(t).toLowerCase().trim())
}

function extractOppNeedCodes(opportunity) {
  const codes = []

  // Check explicit need_codes_supported field
  if (opportunity.need_codes_supported) {
    try {
      const parsed = Array.isArray(opportunity.need_codes_supported)
        ? opportunity.need_codes_supported
        : JSON.parse(opportunity.need_codes_supported)
      codes.push(...parsed)
    } catch {
      codes.push(...String(opportunity.need_codes_supported).split(',').map(c => c.trim()))
    }
  }

  // Infer from categories and keywords
  const textToSearch = [
    opportunity.title || '',
    opportunity.description || '',
    ...parseArrayField(opportunity.categories),
    ...parseArrayField(opportunity.keywords),
  ].join(' ').toLowerCase()

  // Map text to need codes via taxonomy synonyms (word-boundary match to avoid substring noise)
  for (const [code, def] of Object.entries(NEEDS_TAXONOMY)) {
    if (!def || typeof def !== 'object') continue
    const synonyms = Array.isArray(def.synonyms) ? def.synonyms : []
    const label = typeof def.label === 'string' ? def.label : ''
    const matchesSynonym = synonyms.some(s => {
      const escaped = String(s).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`\\b${escaped}\\b`).test(textToSearch)
    })
    const matchesLabel = label.length > 0 &&
      new RegExp(`\\b${label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(textToSearch)
    if (matchesSynonym || matchesLabel) codes.push(code)
  }

  return [...new Set(codes)]
}

// ---------------------------------------------------------------------------
// Geography check
// ---------------------------------------------------------------------------
function checkGeography(intel, opportunity) {
  const isNational = Boolean(opportunity.is_national) ||
    String(opportunity.geography_scope || '').toLowerCase() === 'national'

  if (isNational) {
    return { pass: true, reason: 'National scope — all states eligible' }
  }

  const oppState = String(opportunity.state || opportunity.states_supported || '').toUpperCase()
  const profileState = intel.state

  if (!oppState || !profileState) {
    return { pass: true, reason: 'Geographic scope undetermined — allowing' }
  }

  // Check if profile state matches
  if (oppState.includes(String(profileState))) {
    return { pass: true, reason: `State match: ${profileState}` }
  }

  // Check states_supported array
  if (opportunity.states_supported) {
    let statesArr = []
    try {
      statesArr = Array.isArray(opportunity.states_supported)
        ? opportunity.states_supported
        : JSON.parse(opportunity.states_supported)
    } catch {
      statesArr = String(opportunity.states_supported).split(',').map(s => s.trim().toUpperCase())
    }
    if (statesArr.map(s => String(s).toUpperCase()).includes(String(profileState).toUpperCase())) {
      return { pass: true, reason: `State in supported list: ${profileState}` }
    }
  }

  return {
    pass: false,
    reason: `Geographic mismatch: profile is in ${profileState}, opportunity limited to ${oppState}`,
  }
}

// ---------------------------------------------------------------------------
// Faith-based check
// ---------------------------------------------------------------------------
function checkFaithBasedEligibility(intel, opportunity) {
  const isFaithBased = intel.isChurch || intel.eligibilityFlags.has('faith_based')

  if (!isFaithBased) return { pass: true, reason: null }

  // Check if opportunity excludes religious organizations
  const desc = String(opportunity.description || '').toLowerCase()
  const title = String(opportunity.title || '').toLowerCase()
  const combined = `${title} ${desc}`

  const excludesFaithBased =
    /must not be religious|secular only|no religious|non-sectarian|must be non-religious|may not be used for religious purposes|secular organizations only|religious organizations (are )?not eligible|excludes? religious|faith-based organizations? (are )?not eligible/i.test(combined)

  if (excludesFaithBased) {
    return {
      pass: false,
      reason: 'Opportunity appears to exclude religious/faith-based organizations',
    }
  }

  return { pass: true, reason: 'Faith-based eligibility: no explicit exclusion found' }
}

// ---------------------------------------------------------------------------
// Main eligibility filter
// ---------------------------------------------------------------------------

/**
 * Filter an opportunity against a profile's intelligence.
 *
 * @param {import('./index.js').ProfileIntelligence} intel
 * @param {Object} opportunity - Raw opportunity row
 * @returns {EligibilityResult}
 */
export function filterEligibility(intel, opportunity) {
  if (!intel || !opportunity) {
    return {
      verdict: 'probably_ineligible',
      score: 0,
      reasons: ['Missing intel or opportunity data'],
      hard_failures: ['missing_data'],
      soft_warnings: [],
      matched_needs: [],
      unmet_requirements: ['profile_intel', 'opportunity_data'],
    }
  }

  const hard_failures = []
  const soft_warnings = []
  const reasons = []
  const unmet_requirements = []

  // ── Hard failures ─────────────────────────────────────────────────────────

  // 1. Expired opportunity
  if (isExpired(opportunity)) {
    hard_failures.push('deadline_expired')
    reasons.push('Application deadline has passed')
  }

  // 2. No source URL
  if (!hasSourceUrl(opportunity)) {
    hard_failures.push('no_source_url')
    reasons.push('Opportunity has no verifiable source URL')
  }

  // 3. Loan (never eligible for grant seekers)
  // Use the canonical isTruthyFlag from opportunityTrust.js so DB values like
  // '0' / 'false' / NULL are treated identically across the entire pipeline.
  // Previously this used Boolean(...) which returned true for '0'/'false'
  // strings, silently flipping non-loan grants into "is_loan" rejections.
  const isLoan = isTruthyFlag(opportunity.is_loan) ||
    /^loan$/i.test(String(opportunity.opportunity_type || '').trim())
  if (isLoan) {
    hard_failures.push('is_loan')
    reasons.push('Opportunity is a loan, not a grant')
  }

  // 4. Pro bono / in-kind / referral-only
  if (isTruthyFlag(opportunity.is_pro_bono)) {
    hard_failures.push('is_pro_bono')
    reasons.push('Pro bono service, not direct funding')
  }
  if (isTruthyFlag(opportunity.is_in_kind)) {
    hard_failures.push('is_in_kind')
    reasons.push('In-kind goods/services, not direct financial assistance')
  }
  if (isTruthyFlag(opportunity.is_referral_only)) {
    hard_failures.push('is_referral_only')
    reasons.push('Referral service only, not a direct grant application')
  }

  // 5. Entity type mismatch
  const oppEntityTypes = extractOppEntityTypes(opportunity)
  let entityTypePasses = oppEntityTypes.length === 0  // no restriction = passes

  if (oppEntityTypes.length > 0) {
    const profileEntityType = intel.entityType
    const profileIsNonprofit = intel.isNonprofit
    const profileIsBusiness = intel.isBusiness
    const profileIsGov = intel.isGovernment

    for (const reqType of oppEntityTypes) {
      if (reqType === 'individual' && profileEntityType === 'individual') {
        entityTypePasses = true; break
      }
      if (reqType === 'nonprofit' && (profileIsNonprofit || NONPROFIT_TYPES.has(profileEntityType))) {
        entityTypePasses = true; break
      }
      if (reqType === 'business' && profileIsBusiness) {
        entityTypePasses = true; break
      }
      if (reqType === 'government' && (profileIsGov || profileEntityType === 'tribal')) {
        entityTypePasses = true; break
      }
      if (reqType === 'school' && (intel.isSchool || profileEntityType === 'college')) {
        entityTypePasses = true; break
      }
      if (reqType === 'fire_ems' && intel.isFireEms) {
        entityTypePasses = true; break
      }
      if (reqType === profileEntityType) {
        entityTypePasses = true; break
      }
      // 'organization' = any org
      if (reqType === 'organization' && ORG_TYPES.has(profileEntityType)) {
        entityTypePasses = true; break
      }
    }

    if (!entityTypePasses) {
      hard_failures.push('entity_type_mismatch')
      reasons.push(`Entity type "${intel.entityType}" not in eligible types: ${oppEntityTypes.join(', ')}`)
      unmet_requirements.push('entity_type')
    }
  }

  // 6. Veteran-only requirement
  const requiresVeteran = Boolean(opportunity.requires_veteran) ||
    /veteran only|must be a veteran|veterans only/i.test(String(opportunity.description || ''))
  if (requiresVeteran && !intel.isVeteran) {
    hard_failures.push('requires_veteran')
    reasons.push('Requires veteran status')
    unmet_requirements.push('veteran_status')
  }

  // 7. Student-only requirement
  const requiresStudent = Boolean(opportunity.requires_student) ||
    /enrolled student|must be enrolled|student only/i.test(String(opportunity.description || ''))
  if (requiresStudent && !intel.isStudent) {
    hard_failures.push('requires_student')
    reasons.push('Requires enrolled student status')
    unmet_requirements.push('student_status')
  }

  // 8. 501(c)(3) requirement
  const requires501c3 = Boolean(opportunity.requires_501c3) ||
    /must be a 501.?c.?3|501c3 required|require 501/i.test(String(opportunity.description || ''))
  if (requires501c3 && !intel.eligibilityFlags.has('is_501c3')) {
    hard_failures.push('requires_501c3')
    reasons.push('Requires 501(c)(3) nonprofit status')
    unmet_requirements.push('501c3_status')
  }

  // 9. SAM registration requirement (federal grants)
  const requiresSam = Boolean(opportunity.requires_sam) ||
    /sam\.gov|system for award|uei required/i.test(String(opportunity.description || ''))
  if (requiresSam && !intel.eligibilityFlags.has('sam_registered')) {
    soft_warnings.push('may_require_sam_registration')
    reasons.push('May require SAM.gov registration')
    unmet_requirements.push('sam_registration')
  }

  // 10. Geography check
  const geoCheck = checkGeography(intel, opportunity)
  if (!geoCheck.pass) {
    hard_failures.push('geographic_mismatch')
    reasons.push(geoCheck.reason)
    unmet_requirements.push('geography')
  } else if (geoCheck.reason) {
    reasons.push(geoCheck.reason)
  }

  // 11. Faith-based exclusion
  const faithCheck = checkFaithBasedEligibility(intel, opportunity)
  if (!faithCheck.pass) {
    hard_failures.push('faith_based_exclusion')
    reasons.push(faithCheck.reason)
    unmet_requirements.push('secular_requirement')
  }

  // 12. Disaster context required
  const requiresDisaster = /fema|disaster declaration|must have disaster/i
    .test(String(opportunity.description || ''))
  if (requiresDisaster && !intel.emergencyFlags.has('disaster_affected')) {
    hard_failures.push('requires_disaster_context')
    reasons.push('Requires disaster declaration context')
    unmet_requirements.push('disaster_declaration')
  }

  // ── Soft warnings ─────────────────────────────────────────────────────────

  // Match requirement (cost share)
  if (Boolean(opportunity.match_required) || Boolean(opportunity.requires_match)) {
    soft_warnings.push('match_required')
    reasons.push('Requires matching funds/cost share')
  }

  // Reimbursement only
  if (opportunity.reimbursement_only) {
    soft_warnings.push('reimbursement_only')
    reasons.push('Reimbursement-only grant — requires upfront spending')
  }

  // Rural-only but profile not rural
  if ((Boolean(opportunity.rural_only) || Boolean(opportunity.rural_priority)) &&
    !intel.geographicFlags.has('rural')) {
    soft_warnings.push('rural_preference_not_met')
    reasons.push('Opportunity prefers/requires rural applicants')
  }

  // ── Need matching ─────────────────────────────────────────────────────────
  const oppNeedCodes = extractOppNeedCodes(opportunity)
  const profileNeedCodes = (intel.inferredNeeds ?? []).map(n => n.code)
  const matched_needs = oppNeedCodes.filter(c => profileNeedCodes.includes(c))

  if (matched_needs.length > 0) {
    reasons.push(`Need match: ${matched_needs.join(', ')}`)
  }

  // ── Compute verdict ───────────────────────────────────────────────────────
  // Hard failures are absolute blockers â any single one means ineligible.
  // Soft warnings reduce score but never block outright.
  let score
  let verdict
  if (hard_failures.length > 0) {
    verdict = 'ineligible'
    score = 0
  } else {
    score = Math.max(0, Math.min(100, 100 - soft_warnings.length * 10))
    if (score >= 70) {
      verdict = soft_warnings.length > 0 ? 'probably_eligible' : 'eligible'
    } else {
      verdict = 'probably_ineligible'
    }
  }

  return {
    verdict,
    score,
    reasons,
    hard_failures,
    soft_warnings,
    matched_needs,
    unmet_requirements,
  }
}

/**
 * Quick check: should this opportunity be hard-rejected?
 * Returns true if it should be rejected without further processing.
 */
export function shouldHardReject(intel, opportunity) {
  const result = filterEligibility(intel, opportunity)
  // Hard-reject ONLY when the verdict is definitively ineligible.
  // Do NOT add per-failure-code overrides here â that fragments decision
  // authority away from computeMatchDecision() and over-suppresses
  // 'probably_ineligible' cases that the decision engine should still
  // evaluate (Goal 4, Goal 7).
  return result.verdict === 'ineligible'
}
