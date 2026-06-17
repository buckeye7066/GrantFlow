/**
 * robertSourceRegistry.js
 *
 * Curated source families Robert searches first. Each entry is a
 * trustworthy starting point — official portal, foundation, or
 * directory — that Robert may use without crawling the open web.
 *
 * The registry is INTENTIONALLY small. New sources should land in
 * `robert_source_candidates` with `status='pending'` and graduate to
 * this curated list only after admin approval + observed quality.
 *
 * Trust scoring rules (deterministic):
 *   - .gov / .mil / .edu / .us state portals          → 90
 *   - Known foundation locator / community foundation → 80
 *   - Major nonprofit directory                       → 70
 *   - Generic public directory                        → 55
 *   - Unknown                                         → 30
 *   - Search-engine result page                       → 0  (rejected)
 *   - Placeholder / example / test domain             → 0  (rejected)
 */

import { extractDomain, SOURCE_TYPES, SOURCE_SCOPES } from './robertTypes.js'
import { isPlaceholderUrl, isSearchEngineUrl } from './robertSafety.js'

export const TRUSTED_DOMAIN_TIERS = Object.freeze({
  GOV: { suffix: ['.gov', '.mil', '.us'], score: 90 },
  EDU: { suffix: ['.edu'], score: 85 },
  COMMUNITY_FOUNDATION: { keywords: ['communityfoundation', 'cfgcc', 'cfgreater'], score: 80 },
  KNOWN_FOUNDATION: { domains: ['gatesfoundation.org', 'rwjf.org', 'fordfoundation.org', 'kresge.org', 'kresge.org', 'kelloggfoundation.org'], score: 80 },
  NONPROFIT_DIRECTORY: { domains: ['guidestar.org', 'candid.org', '211.org', 'findhelp.org', 'unitedway.org'], score: 70 },
  STATE_GRANT_PORTAL: { keywords: ['grants.', 'opportunities.'], score: 75 },
  FIRE_GRANTS: { domains: ['fema.gov', 'usfa.fema.gov'], score: 90 },
  STUDENT_AID: { domains: ['studentaid.gov', 'fafsa.gov'], score: 90 },
  GRANTS_GOV: { domains: ['grants.gov', 'sam.gov'], score: 95 },
  BENEFITS_GOV: { domains: ['benefits.gov'], score: 90 },
  SBA: { domains: ['sba.gov'], score: 80 },
  USDA_RD: { domains: ['rd.usda.gov'], score: 90 },
})

/**
 * The canonical seed registry — small, all hand-vetted, never auto-mutated.
 * Each entry is an object Robert can pass to upsertSourceCandidate()
 * without needing additional metadata.
 */
export const ROBERT_SEED_SOURCES = Object.freeze([
  {
    source_name: 'Grants.gov',
    source_url: 'https://www.grants.gov/',
    source_type: 'federal_portal',
    source_scope: 'federal',
    applicant_types: ['nonprofit', 'individual', 'state_government', 'school', 'university'],
    need_categories: ['general'],
    trust_score: 95,
  },
  {
    source_name: 'Benefits.gov',
    source_url: 'https://www.benefits.gov/',
    source_type: 'benefits_directory',
    source_scope: 'federal',
    applicant_types: ['individual', 'family', 'veteran', 'disability', 'caregiver'],
    need_categories: ['housing', 'health', 'food', 'education', 'income'],
    trust_score: 90,
  },
  {
    source_name: 'StudentAid.gov',
    source_url: 'https://studentaid.gov/',
    source_type: 'education_directory',
    source_scope: 'federal',
    applicant_types: ['student', 'graduate_student', 'college_student', 'high_school_student'],
    need_categories: ['education', 'tuition', 'living_expenses'],
    trust_score: 90,
  },
  {
    source_name: 'FEMA Assistance to Firefighters Grants',
    source_url: 'https://www.fema.gov/grants/preparedness/firefighters',
    source_type: 'fire_department_grants',
    source_scope: 'federal',
    applicant_types: ['volunteer_fire_department', 'fire_department', 'first_responder'],
    need_categories: ['equipment', 'training', 'safety', 'capital_improvement'],
    trust_score: 95,
  },
  {
    source_name: 'USDA Rural Development',
    source_url: 'https://www.rd.usda.gov/programs-services',
    source_type: 'rural_development',
    source_scope: 'federal',
    applicant_types: ['rural', 'small_business', 'nonprofit', 'school', 'volunteer_fire_department'],
    need_categories: ['rural_development', 'community_facilities', 'capital_improvement'],
    trust_score: 90,
  },
  {
    source_name: 'SBA Grants (true grants only)',
    source_url: 'https://www.sba.gov/funding-programs/grants',
    source_type: 'federal_portal',
    source_scope: 'federal',
    applicant_types: ['small_business', 'business'],
    need_categories: ['business', 'research'],
    trust_score: 80,
  },
  {
    source_name: 'Council on Foundations — Community Foundation Locator',
    source_url: 'https://cof.org/page/community-foundation-locator',
    source_type: 'community_foundation',
    source_scope: 'national',
    applicant_types: ['nonprofit', 'church', 'school', 'individual'],
    need_categories: ['community', 'capital_improvement'],
    trust_score: 80,
  },
  {
    source_name: '211 / United Way',
    source_url: 'https://www.211.org/',
    source_type: 'nonprofit_directory',
    source_scope: 'national',
    applicant_types: ['individual', 'family', 'caregiver', 'disability'],
    need_categories: ['housing', 'food', 'utility', 'health', 'transportation'],
    trust_score: 70,
  },
  {
    source_name: 'Findhelp (formerly Aunt Bertha)',
    source_url: 'https://www.findhelp.org/',
    source_type: 'benefits_directory',
    source_scope: 'national',
    applicant_types: ['individual', 'family'],
    need_categories: ['housing', 'food', 'utility', 'health'],
    trust_score: 70,
  },
])

// ---------------------------------------------------------------------------
// Trust scoring
// ---------------------------------------------------------------------------
export function computeSourceTrustScore(url, opts = {}) {
  if (isPlaceholderUrl(url)) return 0
  if (isSearchEngineUrl(url)) return 0
  const domain = extractDomain(url)
  if (!domain) return 0

  if (TRUSTED_DOMAIN_TIERS.GRANTS_GOV.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return 95
  if (TRUSTED_DOMAIN_TIERS.STUDENT_AID.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return 90
  if (TRUSTED_DOMAIN_TIERS.BENEFITS_GOV.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return 90
  if (TRUSTED_DOMAIN_TIERS.FIRE_GRANTS.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return 90
  if (TRUSTED_DOMAIN_TIERS.USDA_RD.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return 90
  if (TRUSTED_DOMAIN_TIERS.SBA.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return 80
  if (TRUSTED_DOMAIN_TIERS.NONPROFIT_DIRECTORY.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return 70

  if (TRUSTED_DOMAIN_TIERS.GOV.suffix.some((s) => domain.endsWith(s))) return 90
  if (TRUSTED_DOMAIN_TIERS.EDU.suffix.some((s) => domain.endsWith(s))) return 85

  if (TRUSTED_DOMAIN_TIERS.COMMUNITY_FOUNDATION.keywords.some((k) => domain.includes(k))) return 80
  if (TRUSTED_DOMAIN_TIERS.STATE_GRANT_PORTAL.keywords.some((k) => domain.includes(k))) return 75

  // .org without other signals
  if (domain.endsWith('.org')) return 55
  // .com without signals
  if (domain.endsWith('.com')) return opts.unknownComScore ?? 30
  return 30
}

export function classifySourceType(url) {
  const domain = extractDomain(url) || ''
  // Specific .gov first so we don't hide fire/education/rural classifications
  if (domain === 'grants.gov' || domain === 'www.grants.gov' || domain.endsWith('.grants.gov')) return 'federal_portal'
  if (domain === 'benefits.gov' || domain === 'www.benefits.gov' || domain === 'findhelp.org' || domain === '211.org' || domain === 'www.211.org' || domain === 'www.findhelp.org') return 'benefits_directory'
  if (domain === 'fema.gov' || domain === 'www.fema.gov' || domain === 'usfa.fema.gov') return 'fire_department_grants'
  if (domain === 'studentaid.gov' || domain === 'www.studentaid.gov') return 'education_directory'
  if (domain === 'rd.usda.gov') return 'rural_development'
  if (domain === 'sba.gov' || domain === 'www.sba.gov') return 'federal_portal'
  if (domain.endsWith('.edu')) return 'university_scholarship_portal'
  if (domain.includes('communityfoundation') || domain.includes('cfgcc')) return 'community_foundation'
  if (domain.includes('foundation')) return 'private_foundation'
  if (domain.endsWith('.gov')) return 'federal_portal'
  return null
}

export function isAcceptableSourceType(type) {
  return SOURCE_TYPES.includes(type)
}

export function isAcceptableScope(scope) {
  return SOURCE_SCOPES.includes(scope)
}

export const __testing__ = { ROBERT_SEED_SOURCES, TRUSTED_DOMAIN_TIERS }
