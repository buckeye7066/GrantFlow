/**
 * Unified content/junk filter for funding opportunities.
 *
 * Single isJunkOpportunity() filter combining URL domain checks,
 * curated-source exception, and profile-aware copay/health/transport filtering.
 *
 * Used by both matching.js and discovery.js so junk detection is consistent.
 */

import { isSearchEngineUrl } from '../config/urlRules.js'

const INFO_TITLE_PATTERNS = [
  'health topics', 'health information', 'medlineplus', 'health library',
  'medical encyclopedia', 'disease information', 'condition overview',
  'patient education', 'health topic', 'disease fact sheet',
  'symptoms and causes', 'what is', 'about this condition',
  'healthfinder',
]

const INFO_DOMAINS = [
  'cdc.gov', 'medlineplus.gov', 'mayoclinic.org', 'webmd.com',
  'healthline.com', 'wikipedia.org', 'nih.gov/health',
  'niddk.nih.gov', 'ninds.nih.gov', 'nei.nih.gov',
]

const DIRECTORY_PATTERNS = [
  'contact your state', 'find a doctor', 'find a clinic',
  'state contact directory', 'office locator', 'provider directory',
]

const FUNDING_RESCUE_TERMS = [
  'grant', 'funding', 'scholarship', 'financial assistance',
  'financial aid', 'subsidy', 'award', 'stipend', 'benefit',
]

const COPAY_PATTERNS = [
  'copay assistance', 'copay foundation', 'copay relief',
  'patient assistance program', 'patient advocate foundation',
  'patient advocate', 'medication assistance', 'prescription assistance',
  'drug assistance', 'needymeds', 'pan foundation',
  'healthwell foundation', 'patient access network',
  'rx assistance', 'pharmaceutical assistance',
]

const HEALTH_DIR_PATTERNS = [
  'medicaid: contact', 'medicare: contact',
  'health insurance marketplace', 'healthcare.gov',
  'find local health', 'community health center',
]

/**
 * Determine if an opportunity is junk (informational page, directory listing,
 * or irrelevant copay/health resource).
 *
 * @param {Object} opp - The funding opportunity row
 * @param {Object} [hints] - Optional profile-awareness hints
 * @param {boolean} [hints.hasHealthNeeds] - Profile has health conditions
 * @param {boolean} [hints.needsTransport] - Profile needs transportation
 * @returns {boolean} true if the opportunity should be excluded
 */
export function isJunkOpportunity(opp, hints = {}) {
  const title = (opp.title || opp.program_name || '').toLowerCase()
  const desc = (opp.description || opp.summary || '').toLowerCase()
  const url = (opp.url || opp.application_url || opp.source_url || '').toLowerCase()
  const combined = title + ' ' + desc

  // 0. Generic search-engine result URL — never a real funding source, just a
  //    query string a crawler turned into a click (e.g.
  //    "https://www.google.com/search?q=<school> housing scholarships").
  //    The reality gate (assessReality → pickRealUrl → isPlaceholderUrl) already
  //    drops these on the insert/trust path, but the display-side junk filter
  //    must agree so a legacy row carrying ONLY a search URL never surfaces.
  //    Checked across application_url / source_url / url (the same fields the
  //    canonical isSearchEngineUrl gate inspects).
  for (const candidate of [opp.application_url, opp.apply_url, opp.url, opp.source_url]) {
    if (isSearchEngineUrl(candidate)) return true
  }

  // 1. Informational health pages — always junk
  if (INFO_TITLE_PATTERNS.some(p => combined.includes(p))) return true

  // 2. Informational domains — always junk
  if (INFO_DOMAINS.some(d => url.includes(d))) return true

  // 3. Generic contact/directory pages — junk UNLESS they mention real funding terms
  const isDirectoryPage = DIRECTORY_PATTERNS.some(p => combined.includes(p))
  if (isDirectoryPage && !FUNDING_RESCUE_TERMS.some(t => combined.includes(t))) return true

  // 4. Copay/patient assistance programs
  //    - If profile HAS health needs: keep them (they're real assistance)
  //    - If profile has NO health needs: filter them out
  //    - If no profile info (hints empty): keep if from curated source, else filter
  const { hasHealthNeeds, needsTransport } = hints
  const isCopay = COPAY_PATTERNS.some(p => combined.includes(p))
  if (isCopay) {
    // Explicit denial: profile says no health needs â filter
    if (hasHealthNeeds === false) return true
    // Unknown profile: keep all copay records and let the decision engine decide (Goal 7)
    // Do not filter when profile health status is unknown â recall is preferred at this stage
    // hasHealthNeeds === true â always keep
  }

  // 5. Health resource directories — only filter when profile has no health needs
  if (hasHealthNeeds === false) {
    if (HEALTH_DIR_PATTERNS.some(p => combined.includes(p))) return true
  }

  // 6. Transportation assistance — only filter when profile doesn't need it
  if (needsTransport === false && combined.includes('transportation assistance')) {
    return true
  }

  return false
}
