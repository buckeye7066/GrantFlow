/**
 * relevanceFilter.js
 *
 * Post-scoring hard disqualification filter.
 * Removes opportunities that cannot possibly be relevant to a profile,
 * regardless of keyword overlap or computed score.
 *
 * Rules are intentionally conservative: when profile data is missing or
 * ambiguous the filter PASSES (returns { pass: true }) so we never
 * accidentally suppress a genuine match.
 *
 * Rule definitions live in relevanceFilterRules.js — add new rules there.
 */

import { RELEVANCE_RULES } from './relevanceFilterRules.js'
import { resolveApplicantType } from './profileHelpers.js'

// State name → 2-letter abbreviation (uppercase) sorted by name length descending so
// multi-word state names ("west virginia") match before single-word names ("virginia").
const STATE_NAME_TO_ABBR_ENTRIES = [
  ['west virginia', 'WV'], ['north carolina', 'NC'], ['north dakota', 'ND'],
  ['south carolina', 'SC'], ['south dakota', 'SD'], ['new hampshire', 'NH'],
  ['rhode island', 'RI'], ['new mexico', 'NM'], ['new jersey', 'NJ'],
  ['new york', 'NY'], ['connecticut', 'CT'], ['massachusetts', 'MA'],
  ['mississippi', 'MS'], ['pennsylvania', 'PA'], ['minnesota', 'MN'],
  ['tennessee', 'TN'], ['california', 'CA'], ['louisiana', 'LA'],
  ['wisconsin', 'WI'], ['kentucky', 'KY'], ['oklahoma', 'OK'],
  ['nebraska', 'NE'], ['arkansas', 'AR'], ['colorado', 'CO'],
  ['maryland', 'MD'], ['michigan', 'MI'], ['missouri', 'MO'],
  ['delaware', 'DE'], ['illinois', 'IL'],
  ['virginia', 'VA'], ['montana', 'MT'], ['wyoming', 'WY'],
  ['georgia', 'GA'], ['arizona', 'AZ'], ['indiana', 'IN'],
  ['florida', 'FL'], ['alabama', 'AL'], ['vermont', 'VT'],
  ['kansas', 'KS'], ['nevada', 'NV'], ['oregon', 'OR'],
  ['alaska', 'AK'], ['hawaii', 'HI'], ['idaho', 'ID'],
  ['maine', 'ME'], ['texas', 'TX'], ['utah', 'UT'],
  ['iowa', 'IA'], ['ohio', 'OH'],
] // entries are already ordered longest-first; no runtime sort needed

/**
 * Detect a US state name embedded in an opportunity title.
 * "Ohio Family and Children First" → "OH"
 * "New York Tuition Assistance Program" → "NY"
 *
 * Returns the 2-letter uppercase state abbreviation or null.
 */
export function extractStateNameFromTitle(title) {
  const lower = (title || '').toLowerCase()
  for (const [name, abbr] of STATE_NAME_TO_ABBR_ENTRIES) {
    if (lower.includes(name)) return abbr
  }
  return null
}

/**
 * Build the combined text string used for pattern matching.
 * @param {object} opportunity
 * @returns {string}
 */
function buildOppText(opportunity) {
  return [
    opportunity.title || '',
    opportunity.description || '',
    opportunity.sponsor || '',
    ...(Array.isArray(opportunity.keywords) ? opportunity.keywords : []),
    ...(Array.isArray(opportunity.categories) ? opportunity.categories : []),
    ...(Array.isArray(opportunity.eligibility_bullets) ? opportunity.eligibility_bullets : []),
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * Apply hard disqualification rules to a single opportunity.
 * Rules are defined in relevanceFilterRules.js — add new rules there.
 *
 * Per project rules ("Population / eligibility mismatches must reduce score,
 * not discard results" and "Hard boolean filters must be avoided unless the
 * funding source is explicitly exclusive"):
 *   - Rules flagged `hard: true` still return { pass: false } and REJECT.
 *   - Soft rules (default) return { pass: true, softFail: true, penalty }
 *     so callers can reduce the score instead of discarding the opportunity.
 *   - Directory / general funding resources ALWAYS pass (they must survive
 *     filtering unless explicitly excluded).
 *
 * The optional `opts.mode` lets legacy callers keep strict behavior:
 *   - 'strict' (default): soft rules still fail (backward-compatible)
 *   - 'soft': only truly exclusive (hard:true) rules fail
 *
 * @param {object} opportunity  - Opportunity row
 * @param {object} profileData  - Extracted profile fields
 * @param {object} [opts]
 * @param {'strict'|'soft'} [opts.mode='strict']
 * @returns {{ pass: boolean, reason?: string, ruleId?: string, softFail?: boolean, penalty?: number }}
 */
export function applyRelevanceFilter(opportunity, profileData, opts = {}) {
  if (!opportunity || !profileData) return { pass: true }

  const mode = opts.mode || 'strict'
  const oppText = buildOppText(opportunity)

  // Directory-style / general funding resources always survive — the project
  // explicitly requires this. Callers can still apply URL validation.
  const isDirectoryResource = Boolean(
    opportunity.is_directory_resource ||
    String(opportunity.source || '').startsWith('directory') ||
    String(opportunity.source || '').includes('local_directory') ||
    String(opportunity.record_origin || '').startsWith('directory') ||
    String(opportunity.type || '').toUpperCase() === 'DIRECTORY',
  )
  if (isDirectoryResource) return { pass: true, directory: true }

  for (const rule of RELEVANCE_RULES) {
    const patternMatches = rule.oppPattern == null || rule.oppPattern.test(oppText)
    if (!(patternMatches && rule.profileCheck(profileData, oppText, opportunity))) continue

    const reason =
      typeof rule.reason === 'function' ? rule.reason(profileData, opportunity) : rule.reason

    // Rules explicitly marked hard:true, or legacy strict mode, reject
    if (rule.hard === true || mode === 'strict') {
      return { pass: false, reason, ruleId: rule.id }
    }

    // Soft mode: allow through but signal a penalty so the caller can
    // adjust the match score rather than discarding the opportunity.
    return { pass: true, softFail: true, reason, ruleId: rule.id, penalty: rule.penalty ?? 25 }
  }

  return { pass: true }
}

/**
 * Extract a 2-letter state abbreviation from an address value that may be a
 * plain string ("123 Main St, Nashville, TN 37201") or an object ({ state: 'TN' }).
 */
function extractStateFromAddress(addr) {
  if (!addr) return null
  if (typeof addr === 'object') return addr.state || null
  if (typeof addr === 'string') {
    const m = addr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/)
    return m ? m[1] : null
  }
  return null
}

/**
 * Extract a flat profileData object from a profileContext (as used by
 * comprehensiveCrawler, opportunityMatcher, realCrawlers).
 *
 * All fields default to safe values so the filter is no-op when data is missing.
 */
export function extractProfileData(profileContext) {
  if (!profileContext) return {}
  const profile = profileContext.profile || {}
  const sections = profileContext.sections || {}

  const basic = sections.basic_information || {}
  const demographics = sections.demographics || {}
  const military = sections.military_service || {}
  const health = sections.health_medical || {}
  const employment = sections.employment || {}
  const education = sections.education || {}
  const comprehensive = sections.comprehensive_application || {}

  const family = sections.family_life || {}

  return {
    primary_type:
      resolveApplicantType(profile) ||
      comprehensive.applicant_type ||
      null,
    age:
      basic.age ||
      demographics.age ||
      null,
    gender:
      basic.gender ||
      demographics.gender ||
      null,
    veteran_status:
      demographics.veteran_status ||
      military.veteran ||
      null,
    disability_status:
      demographics.disability_status ||
      health.disability_type ||
      null,
    immigrant_status:
      demographics.immigrant_status ||
      null,
    foster_youth:
      family.foster_youth ||
      demographics.foster_youth ||
      comprehensive.foster_care ||
      null,
    first_responder:
      demographics.first_responder ||
      employment.occupation_type === 'first_responder' ||
      (employment.occupation || '').toLowerCase().match(/\b(firefighter|paramedic|emt|police|law enforcement|dispatcher)\b/) ? true : null,
    employment,
    education,
    state:
      profile.state ||
      basic.state ||
      sections.location_focus?.state ||
      extractStateFromAddress(basic.address) ||
      extractStateFromAddress((sections.comprehensive_application || {}).address) ||
      null,
    tags: profile.tags || [],
    government_assistance: sections.government_assistance || {},
    insurance_provider: (sections.medical_insurance || {}).insurance_provider || null,
    unable_to_work: !!(comprehensive.unable_to_work ||
      health.unable_to_work ||
      (employment.notes || '').toLowerCase().includes('not able to work') ||
      (employment.notes || '').toLowerCase().includes('unable to work') ||
      (employment.current_status || '').toLowerCase().includes('disabled') ||
      health.disability_status === true),
    employment_notes: employment.notes || null,
    employment_status: employment.current_status || null,
    has_children: (family.has_children === true) || Number(family.number_of_children || 0) > 0 || Number(family.members_under_18 || 0) > 0,
    number_of_children: family.number_of_children || 0,
    household_members_under_18: family.members_under_18 || 0,
    age_group: demographics.age_group || null,
    ethnicity: demographics.ethnicity || null,
    city: basic.city || (typeof basic.address === 'object' ? basic.address.city : null) || null,

  }
}
