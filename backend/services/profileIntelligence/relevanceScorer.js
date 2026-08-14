/**
 * Relevance Scorer v2 — Weighted dimensional scoring using ProfileIntelligence
 *
 * Scores an opportunity against a ProfileIntelligence object using:
 * 1. Hard eligibility pass/fail (from eligibilityFilter)
 * 2. Need fit — how well the opportunity matches inferred needs
 * 3. Entity fit — entity type alignment
 * 4. Geography fit — location alignment
 * 5. Compliance fit — required credentials/registrations
 * 6. Hardship/priority fit — underserved, rural, low-income boosts
 * 7. Funding practicality — realistic to apply (not too burdensome)
 * 8. Source quality — confidence in the source
 * 9. Keyword relevance — story keyword overlap
 *
 * Returns a ScoreResult:
 * {
 *   total_score: 0–100,
 *   confidence: 0–100,
 *   verdict: 'STRONG_MATCH'|'GOOD_MATCH'|'POSSIBLE_MATCH'|'WEAK_MATCH'|'REJECT',
 *   dimensions: { [dimension]: number },
 *   why_matched: string[],
 *   why_may_not_fit: string[],
 *   matched_needs: string[],
 *   verification_guidance: string[],
 * }
 */

import { filterEligibility } from './eligibilityFilter.js'
import { NEEDS_TAXONOMY } from './needsTaxonomy.js'

/** Parse a DB field that may be a JSON array, CSV string, or already an array. */
function parseArrayField(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'string') return []
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) { try { const a = JSON.parse(trimmed); if (Array.isArray(a)) return a } catch { /* fall through */ } }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean)
}
import { applyRelevanceFilter } from '../relevanceFilter.js'

// ---------------------------------------------------------------------------
// Dimension weights (must sum to 1.0)
// ---------------------------------------------------------------------------
const DIMENSION_WEIGHTS = {
  eligibility: 0.26,        // Hard eligibility is most important
  need_fit: 0.22,           // How well needs align
  entity_fit: 0.13,         // Entity type match
  geography_fit: 0.10,      // Location alignment
  compliance_fit: 0.05,     // Credentials/registration
  priority_fit: 0.05,       // Hardship/priority boosts
  practicality: 0.05,       // Ease of application
  source_quality: 0.04,     // Source trustworthiness
  keyword_relevance: 0.04,  // Story keyword overlap
  demographic_fit: 0.06,    // Group 11: org-operational demographic inputs
}

// Verify weights sum to ~1.0
const WEIGHT_SUM = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0)
if (Math.abs(WEIGHT_SUM - 1.0) > 0.001) {
  // This would be a developer error, not a runtime error
  console.warn(`[relevanceScorer] Dimension weights sum to ${WEIGHT_SUM}, not 1.0`)
}

// ---------------------------------------------------------------------------
// Source quality scoring
// ---------------------------------------------------------------------------
const OFFICIAL_DOMAINS = new Set([
  'grants.gov', 'sam.gov', 'hud.gov', 'acf.hhs.gov', 'ed.gov', 'sba.gov',
  'usda.gov', 'fema.gov', 'va.gov', 'ssa.gov', 'benefits.gov', 'usa.gov',
])

function scoreSourceQuality(opportunity) {
  const url = opportunity.source_url || opportunity.application_url ||
    opportunity.apply_url || opportunity.url || ''
  const urlLower = String(url).toLowerCase()

  if (!url || urlLower.trim() === '') return 0

  // Validate that the URL is a real HTTP/HTTPS URL before trusting it
  let isValidHttpUrl = false
  try {
    const parsed = new URL(url.trim())
    isValidHttpUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    isValidHttpUrl = false
  }

  // Placeholder strings are not real application paths
  const PLACEHOLDER_PATTERNS = /^(tbd|n\/a|na|contact|see website|pending|unknown|none|#)$/i
  if (!isValidHttpUrl || PLACEHOLDER_PATTERNS.test(urlLower.trim())) {
    // Fall back to record_origin trust only — no URL bonus
    const origin = String(opportunity.record_origin || '').toLowerCase()
    if (origin === 'grants_gov' || origin === 'verified_real') return 50
    if (origin === 'curated_verified') return 40
    return 0
  }

  // Official .gov = highest trust
  const match = urlLower.match(/(?:https?:\/\/)?(?:www\.)?([^/?\s]+)/)
  const domain = match ? match[1] : ''
  if (OFFICIAL_DOMAINS.has(domain)) return 100
  if (urlLower.includes('.gov')) return 90
  if (urlLower.includes('.edu')) return 75
  if (urlLower.includes('.org')) return 60

  const origin = String(opportunity.record_origin || '').toLowerCase()
  if (origin === 'grants_gov' || origin === 'verified_real') return 90
  if (origin === 'curated_verified') return 80
  if (origin === 'live_crawl') return 40

  return 35
}

// ---------------------------------------------------------------------------
// Need fit scoring
// ---------------------------------------------------------------------------
function scoreNeedFit(intel, opportunity) {
  if (!intel.inferredNeeds || intel.inferredNeeds.length === 0) return 50

  const oppText = [
    String(opportunity.title || ''),
    String(opportunity.description || ''),
  ].join(' ').toLowerCase()

  const oppCategories = parseArrayField(opportunity.categories).map(c => String(c).toLowerCase()).join(' ')
  const oppKeywords = parseArrayField(opportunity.keywords).map(k => String(k).toLowerCase()).join(' ')

  const fullText = `${oppText} ${oppCategories} ${oppKeywords}`

  let matchScore = 0
  let totalWeight = 0
  const matchedNeeds = []

  for (const need of intel.inferredNeeds) {
    const def = NEEDS_TAXONOMY[need.code]
    if (!def) continue

    const needWeight = need.weight
    totalWeight += needWeight

    // Check if opportunity text matches any synonyms or example terms
    const synonymMatch = (def.synonyms || []).some(s => fullText.includes(String(s || '').toLowerCase()))
    const labelMatch = fullText.includes(def.label.toLowerCase())
    const exampleMatch = (def.example_search_terms || []).some(t => {
      const term = String(t || '').toLowerCase().split(' ')[0]
      return term && fullText.includes(term)
    })  // first word of each example

    if (synonymMatch || labelMatch) {
      matchScore += needWeight * 1.0
      matchedNeeds.push(need.code)
    } else if (exampleMatch) {
      matchScore += needWeight * 0.5
    }
  }

  if (totalWeight === 0) return 50

  const ratio = matchScore / totalWeight
  return Math.round(ratio * 100)
}

// ---------------------------------------------------------------------------
// Entity fit scoring
// ---------------------------------------------------------------------------
function scoreEntityFit(intel, opportunity) {
  const oppType = String(opportunity.opportunity_type || '').toLowerCase()
  const oppDesc = String(opportunity.description || '').toLowerCase()
  const combined = `${oppType} ${oppDesc}`

  const entityType = intel.entityType

  // Perfect match signals
  if (entityType === 'church' || entityType === 'faith_based') {
    if (/church|faith.?based|religious|ministry|congregation/i.test(combined)) return 100
    if (/nonprofit/i.test(combined)) return 80
  }
  if (entityType === 'fire_ems') {
    if (/fire|ems|emergency service|first responder|rescue/i.test(combined)) return 100
    if (/public safety|government/i.test(combined)) return 75
  }
  if (entityType === 'school' || entityType === 'school_district') {
    if (/school|k.12|k12|education|classroom/i.test(combined)) return 100
    if (/nonprofit|youth/i.test(combined)) return 70
  }
  if (entityType === 'individual') {
    if (/individual|person|resident|household|family/i.test(combined)) return 100
  }
  if (entityType === 'nonprofit') {
    if (/nonprofit|501.?c.?3|charitable/i.test(combined)) return 100
  }
  if (entityType === 'college' || entityType === 'university') {
    if (/college|university|higher education/i.test(combined)) return 100
  }
  if (entityType === 'tribal') {
    if (/tribal|tribe|native american|alaska native/i.test(combined)) return 100
  }

  // Generic match
  if (/organization|eligible applicants/i.test(combined)) return 60

  return 40  // No match found
}

// ---------------------------------------------------------------------------
// Geography fit scoring
// ---------------------------------------------------------------------------
function scoreGeographyFit(intel, opportunity) {
  const isNational = Boolean(opportunity.is_national) ||
    String(opportunity.geography_scope || '').toLowerCase() === 'national'

  if (isNational) return 100

  const profileState = intel.state
  if (!profileState) return 60  // Unknown — give benefit of doubt

  const oppState = String(opportunity.state || '').toUpperCase()
  if (!oppState) return 70  // Unknown state — give benefit of doubt

  if (oppState === profileState || oppState.includes(profileState)) return 100

  // Check states_supported
  if (opportunity.states_supported) {
    try {
      const states = Array.isArray(opportunity.states_supported)
        ? opportunity.states_supported
        : JSON.parse(opportunity.states_supported)
      if (states.map(s => s.toUpperCase()).includes(profileState)) return 100
    } catch { /* ignore */ }
  }

  return 0  // State mismatch
}

// ---------------------------------------------------------------------------
// Compliance fit scoring
// ---------------------------------------------------------------------------
/**
 * Group 11 demographic fit: score the 10 org/operational fields the mission
 * audit called out as missing from the matcher. Per user rule, null/missing
 * values MUST NOT disqualify — they stay neutral (score ~50) so sparse
 * profiles still see opportunities.
 */
function scoreDemographicFit(intel, opportunity) {
  const demo = intel?.demographics
  if (!demo) return 50
  const oppText = [
    String(opportunity.title || ''),
    String(opportunity.description || ''),
    String(opportunity.eligibility_criteria || ''),
  ].join(' ').toLowerCase()

  let score = 60  // neutral-positive baseline
  let signals = 0

  // Set-asides: boolean flags boost the score when the opp mentions them.
  const setAsides = [
    { flag: demo.veteran_owned, re: /veteran[- ]owned|sdvosb|vosb/ },
    { flag: demo.woman_owned, re: /women[- ]owned|wosb|female[- ]led/ },
    { flag: demo.minority_owned, re: /minority[- ]owned|mbe|bipoc|disadvantaged business/ },
  ]
  for (const { flag, re } of setAsides) {
    if (flag && re.test(oppText)) { score += 12; signals++ }
  }

  // Population served / mission focus alignment: count matches in opp text.
  const bag = [
    ...(Array.isArray(demo.population_served) ? demo.population_served : []),
    ...(Array.isArray(demo.mission_focus) ? demo.mission_focus : []),
  ].map((s) => String(s || '').toLowerCase()).filter(Boolean)
  for (const term of bag) {
    if (term.length < 4) continue
    if (oppText.includes(term)) { score += 4; signals++ }
  }

  // Organization type should match opportunity target when both exist.
  if (demo.organization_type && /nonprofit|501c3|church|school|business|government|tribal/.test(oppText)) {
    const t = String(demo.organization_type).toLowerCase()
    if (oppText.includes(t)) { score += 6; signals++ }
  }

  // Country: only apply when the opp explicitly names a country.
  if (demo.country) {
    const c = String(demo.country).toLowerCase()
    if (oppText.includes(c)) { score += 4; signals++ }
  }

  // Scale-appropriate flags: employee_count / annual_revenue / years_in_operation
  // are expressed as size bands.
  if (typeof demo.employee_count === 'number') {
    if (demo.employee_count < 50 && /small (business|nonprofit|organization)/.test(oppText)) { score += 5; signals++ }
    if (demo.employee_count >= 500 && /large (employer|organization|nonprofit)/.test(oppText)) { score += 3; signals++ }
  }
  if (typeof demo.annual_revenue === 'number') {
    if (demo.annual_revenue < 1_000_000 && /small organization|emerging/.test(oppText)) { score += 3; signals++ }
  }
  if (typeof demo.years_in_operation === 'number') {
    if (demo.years_in_operation >= 3 && /established|multi[- ]year track record|operational history/.test(oppText)) { score += 3; signals++ }
    if (demo.years_in_operation < 3 && /startup|new (nonprofit|organization)|recently founded/.test(oppText)) { score += 3; signals++ }
  }

  // Never let signal-heavy profiles push past 100 or crash to 0.
  if (signals === 0) return 50
  return Math.max(40, Math.min(100, Math.round(score)))
}

function scoreComplianceFit(intel, opportunity) {
  let score = 80  // Default: assume compliance unless known issues

  const oppDesc = String(opportunity.description || '').toLowerCase()

  // SAM.gov registration needed but not available
  if (/sam\.gov|system for award|uei required/i.test(oppDesc)) {
    if (!intel.eligibilityFlags.has('sam_registered') && !intel.eligibilityFlags.has('has_uei')) {
      score -= 20
    }
  }

  // 501(c)(3) needed
  if (/501.?c.?3|nonprofit status required/i.test(oppDesc)) {
    if (!intel.eligibilityFlags.has('is_501c3') && !intel.isNonprofit) {
      score -= 30
    }
  }

  return Math.max(0, score)
}

// ---------------------------------------------------------------------------
// Priority/hardship fit scoring
// ---------------------------------------------------------------------------
function scorePriorityFit(intel, opportunity) {
  let score = 50  // Neutral baseline

  const oppDesc = String(opportunity.description || '').toLowerCase()
  const oppTitle = String(opportunity.title || '').toLowerCase()
  const combined = `${oppTitle} ${oppDesc}`

  // Rural preference match
  if (intel.geographicFlags.has('rural') &&
    /rural|underserved|remote area/i.test(combined)) {
    score += 25
  }

  // Low-income preference match
  if ((intel.hardshipFlags.has('low_income') || intel.hardshipFlags.has('financial_hardship')) &&
    /low.?income|below poverty|hardship|economically disadvantaged/i.test(combined)) {
    score += 25
  }

  // Minority preference match
  const isMSI = intel.organizationFlags.has('hbcu') ||
    intel.organizationFlags.has('hsi') ||
    intel.organizationFlags.has('msi')
  if (isMSI && /minority.serving|hbcu|hsi|tribal college|msi/i.test(combined)) {
    score += 20
  }

  // Veteran match
  if (intel.isVeteran && /veteran|military/i.test(combined)) {
    score += 20
  }

  return Math.min(100, score)
}

// ---------------------------------------------------------------------------
// Practicality scoring
// ---------------------------------------------------------------------------
function scorePracticality(opportunity) {
  let score = 70  // Baseline: most grants are practically accessible

  // Match requirement reduces practicality
  if (opportunity.match_required || opportunity.requires_match) {
    score -= 20
  }

  // Reimbursement-only reduces practicality
  if (opportunity.reimbursement_only) {
    score -= 15
  }

  // No deadline (rolling) = more practical
  if (!opportunity.deadline || opportunity.deadline_type === 'rolling') {
    score += 10
  }

  // Having a clear, parseable URL increases practicality
  const url = opportunity.source_url || opportunity.application_url || ''
  let urlIsValid = false
  try {
    const parsed = new URL(url.trim())
    urlIsValid = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    urlIsValid = false
  }
  if (urlIsValid) score += 10

  return Math.max(0, Math.min(100, score))
}

// ---------------------------------------------------------------------------
// Keyword relevance scoring (story overlap)
// ---------------------------------------------------------------------------
function scoreKeywordRelevance(intel, opportunity) {
  if (!intel.storyKeywords || intel.storyKeywords.length === 0) return 50

  const oppText = [
    String(opportunity.title || ''),
    String(opportunity.description || ''),
  ].join(' ').toLowerCase()

  const profileKeywords = intel.storyKeywords.filter(k => k.length > 4)
  if (profileKeywords.length === 0) return 50

  const matchCount = profileKeywords.filter(kw => oppText.includes(kw)).length
  const ratio = matchCount / Math.min(profileKeywords.length, 20)  // cap at 20 keywords

  return Math.round(50 + ratio * 50)
}

// ---------------------------------------------------------------------------
// Build explanation lists
// ---------------------------------------------------------------------------
function buildExplanation(intel, opportunity, eligResult, dimensions, matchedNeeds) {
  const why_matched = []
  const why_may_not_fit = []
  const verification_guidance = []

  // Positive reasons
  if (dimensions.need_fit >= 70) {
    const topNeeds = matchedNeeds.slice(0, 3).map(code => {
      const def = NEEDS_TAXONOMY[code]
      return def ? def.label : code
    })
    if (topNeeds.length > 0) {
      why_matched.push(`Addresses inferred needs: ${topNeeds.join(', ')}`)
    }
  }

  if (dimensions.geography_fit >= 80) {
    why_matched.push('Geographic scope includes your location')
  }

  if (dimensions.entity_fit >= 80) {
    why_matched.push(`Eligible entity types include ${intel.entityType}`)
  }

  if (dimensions.source_quality >= 80) {
    why_matched.push('From a highly trusted official source')
  }

  if (dimensions.priority_fit >= 70) {
    why_matched.push('Priority consideration for your profile characteristics')
  }

  // Negative reasons
  if (eligResult.soft_warnings.includes('match_required')) {
    why_may_not_fit.push('Requires matching funds or cost-share')
  }
  if (eligResult.soft_warnings.includes('reimbursement_only')) {
    why_may_not_fit.push('Reimbursement-only — requires paying costs upfront')
  }
  if (eligResult.soft_warnings.includes('rural_preference_not_met')) {
    why_may_not_fit.push('Opportunity prefers rural applicants')
  }
  if (eligResult.soft_warnings.includes('may_require_sam_registration')) {
    why_may_not_fit.push('May require SAM.gov registration (federal grant)')
  }

  if (dimensions.need_fit < 40) {
    why_may_not_fit.push('Opportunity focus may not directly match profile needs')
  }

  // Verification guidance
  const url = opportunity.source_url || opportunity.application_url || ''
  if (url) {
    verification_guidance.push(`Verify eligibility at: ${url}`)
  }
  if (eligResult.unmet_requirements.includes('sam_registration')) {
    verification_guidance.push('Check if SAM.gov registration is required before applying')
  }
  if (eligResult.unmet_requirements.includes('501c3_status')) {
    verification_guidance.push('Confirm 501(c)(3) status is required for this grant')
  }
  verification_guidance.push('Read the full eligibility requirements before applying')

  return { why_matched, why_may_not_fit, verification_guidance }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Score an opportunity against a ProfileIntelligence object.
 *
 * @param {import('./index.js').ProfileIntelligence} intel
 * @param {Object} opportunity - Raw opportunity row
 * @returns {ScoreResult}
 */
export function scoreOpportunity(intel, opportunity) {
  if (!intel || !opportunity) {
    return {
      total_score: 0,
      confidence: 0,
      verdict: 'REJECT',
      dimensions: {},
      why_matched: [],
      why_may_not_fit: ['Missing profile or opportunity data'],
      matched_needs: [],
      verification_guidance: [],
    }
  }

  // Run eligibility filter first
  const eligResult = filterEligibility(intel, opportunity)

  // Hard reject on eligibility failures
  // Only hard-reject on objectively unrecoverable failures.
  // 'requires_veteran', 'requires_student', and 'geographic_mismatch' are
  // scored dimensionally below; do NOT short-circuit here — let the weighted
  // total reach the caller (computeMatchDecision) which is the sole authority.
  const HARD_REJECT_CODES = ['deadline_expired']
  const hasHardFailure = eligResult.verdict === 'ineligible' ||
    eligResult.hard_failures.some(f => HARD_REJECT_CODES.includes(f))
  if (hasHardFailure) {
    return {
      total_score: 0,
      confidence: 90,
      verdict: 'REJECT',
      dimensions: { eligibility: 0 },
      why_matched: [],
      why_may_not_fit: eligResult.hard_failures.map(f =>
        eligResult.reasons.find(r => r.toLowerCase().includes(f.replace(/_/g, ' '))) ?? f),
      matched_needs: [],
      verification_guidance: [],
    }
  }

  // Also run the relevance filter rules (state-mismatch, loan, demographic, etc.)
  // to ensure both filter systems are applied on every scoring path.
  // Build a profile snapshot that surfaces all ProfileIntelligence signals
  // so relevanceFilter can apply its full hard-disqualification ruleset.
  const inferredTags = [
    ...(intel.isVeteran ? ['veteran'] : []),
    ...(intel.isStudent ? ['student'] : []),
    ...(intel.isSenior ? ['senior'] : []),
    ...(intel.isCaregiver ? ['caregiver'] : []),
    ...(intel.hasDisability ? ['disability'] : []),
    ...(intel.isNonprofit ? ['nonprofit', '501c3'] : []),
    ...(intel.geographicFlags ? [...intel.geographicFlags] : []),
    ...(intel.hardshipFlags ? [...intel.hardshipFlags] : []),
    ...(intel.organizationFlags ? [...intel.organizationFlags] : []),
    ...(intel.eligibilityFlags ? [...intel.eligibilityFlags] : []),
    ...(intel.inferredNeeds ? intel.inferredNeeds.map(n => n.code) : []),
  ]
  const profileData = {
    primary_type: intel.entityType || null,
    veteran_status: intel.isVeteran ? 'veteran' : null,
    disability_status: intel.hasDisability ? 'yes' : null,
    student_status: intel.isStudent ? 'yes' : null,
    senior_status: intel.isSenior ? 'yes' : null,
    caregiver_status: intel.isCaregiver ? 'yes' : null,
    nonprofit_status: intel.isNonprofit ? 'yes' : null,
    state: intel.state || null,
    medical_conditions: intel.medicalConditions || [],
    emergency_context: intel.emergencyContext || null,
    business_flags: intel.businessFlags ? [...intel.businessFlags] : [],
    family_flags: intel.familyFlags ? [...intel.familyFlags] : [],
    tags: inferredTags,
  }
  const relevance = applyRelevanceFilter(opportunity, profileData)
  if (!relevance.pass) {
    return {
      total_score: 0,
      confidence: 85,
      verdict: 'REJECT',
      dimensions: { eligibility: 0 },
      why_matched: [],
      why_may_not_fit: [relevance.reason],
      matched_needs: [],
      verification_guidance: [],
    }
  }

  // Calculate individual dimension scores
  const matchedNeeds = []
  const needFitScore = (() => {
    const oppText = [
      String(opportunity.title || ''),
      String(opportunity.description || ''),
    ].join(' ').toLowerCase()
    const oppCategories = parseArrayField(opportunity.categories).map(c => String(c).toLowerCase()).join(' ')
    const oppKeywords = parseArrayField(opportunity.keywords).map(k => String(k).toLowerCase()).join(' ')
    const fullText = `${oppText} ${oppCategories} ${oppKeywords}`
    if (intel.inferredNeeds) {
      for (const need of intel.inferredNeeds) {
        const def = NEEDS_TAXONOMY[need.code]
        if (!def) continue
        const synonymMatch = (def.synonyms || []).some(s => fullText.includes(String(s || '').toLowerCase()))
        const labelMatch = fullText.includes(def.label.toLowerCase())
        const exampleMatch = (def.example_search_terms || []).some(t => {
          const term = String(t || '').toLowerCase().split(' ')[0]
          return term && fullText.includes(term)
        })
        if (synonymMatch || labelMatch || exampleMatch) {
          matchedNeeds.push(need.code)
        }
      }
    }
    return scoreNeedFit(intel, opportunity)
  })()

  const eligibilityScore = eligResult.verdict === 'eligible' ? 100
    : eligResult.verdict === 'probably_eligible' ? 75
    : 40

  const dimensions = {
    eligibility: eligibilityScore,
    need_fit: needFitScore,
    entity_fit: scoreEntityFit(intel, opportunity),
    geography_fit: scoreGeographyFit(intel, opportunity),
    compliance_fit: scoreComplianceFit(intel, opportunity),
    priority_fit: scorePriorityFit(intel, opportunity),
    practicality: scorePracticality(opportunity),
    source_quality: scoreSourceQuality(opportunity),
    keyword_relevance: scoreKeywordRelevance(intel, opportunity),
    demographic_fit: scoreDemographicFit(intel, opportunity),
  }

  // Weighted total
  let total_score = 0
  for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    total_score += (dimensions[dim] ?? 50) * weight
  }
  total_score = Math.round(Math.min(100, Math.max(0, total_score)))

  // Confidence based on how much information we have
  const hasStory = (intel.storyKeywords ?? []).length > 3
  const hasNeeds = (intel.inferredNeeds ?? []).length > 0
  const hasState = Boolean(intel.state)
  const confidence = Math.round(
    (hasStory ? 30 : 10) +
    (hasNeeds ? 30 : 10) +
    (hasState ? 20 : 10) +
    (total_score > 60 ? 20 : 10)
  )

  // Verdict
  let verdict
  if (total_score >= 75) verdict = 'STRONG_MATCH'
  else if (total_score >= 60) verdict = 'GOOD_MATCH'
  else if (total_score >= 45) verdict = 'POSSIBLE_MATCH'
  else if (total_score >= 30) verdict = 'WEAK_MATCH'
  else verdict = 'REJECT'

  const { why_matched, why_may_not_fit, verification_guidance } = buildExplanation(
    intel, opportunity, eligResult, dimensions, matchedNeeds)

  return {
    total_score,
    confidence: Math.min(100, confidence),
    verdict,
    dimensions,
    why_matched,
    why_may_not_fit,
    matched_needs: [...new Set([...matchedNeeds, ...eligResult.matched_needs])],
    verification_guidance,
  }
}
