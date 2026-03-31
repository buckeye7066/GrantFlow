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
].sort((a, b) => b[0].length - a[0].length)

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
 * @param {object} opportunity  - Opportunity row (title, description, keywords, state, sponsor, …)
 * @param {object} profileData  - Extracted profile fields (see extractProfileData helper below)
 * @returns {{ pass: boolean, reason?: string, ruleId?: string }}
 */
export function applyRelevanceFilter(opportunity, profileData) {
  if (!opportunity || !profileData) return { pass: true }

  const oppText = buildOppText(opportunity)

  for (const rule of RELEVANCE_RULES) {
    const patternMatches = rule.oppPattern == null || rule.oppPattern.test(oppText)
    if (patternMatches && rule.profileCheck(profileData, oppText, opportunity)) {
      const reason =
        typeof rule.reason === 'function' ? rule.reason(profileData, opportunity) : rule.reason
      return { pass: false, reason, ruleId: rule.id }
    }
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
      null,
    first_responder:
      null,
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
    unable_to_work: (employment.notes || '').toLowerCase().includes('not able to work') || 
      (employment.notes || '').toLowerCase().includes('unable to work') ||
      (employment.current_status || '').toLowerCase().includes('disabled') ||
      health.disability_status === true,
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
