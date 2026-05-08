/**
 * Search Plan Generator
 *
 * Converts a ProfileIntelligence object + inferred needs into a prioritized
 * list of search plans. Each search plan targets a specific need with:
 * - Targeted search terms
 * - Entity eligibility constraints
 * - Geography constraints
 * - Priority weight
 * - Funding type expectations
 * - Which sources to search (local/state/federal/private)
 *
 * @typedef {Object} SearchPlan
 * @property {string} need_code         - The need this plan addresses
 * @property {string} need_label        - Human-readable need label
 * @property {string} search_lane       - Category: 'federal'|'state'|'local'|'private'|'foundation'
 * @property {string[]} search_terms    - Ordered search query strings
 * @property {string[]} boosted_terms   - Additional terms from profile context
 * @property {string[]} entity_types    - Entity types to include in search
 * @property {string[]} geography_terms - Location context terms
 * @property {string[]} exclusions      - Terms/types to exclude
 * @property {number} priority          - 0–100, higher = search first
 * @property {string} expected_funding  - 'grant'|'scholarship'|'rebate'|'contract'|'donor'
 * @property {boolean} search_federal   - Whether to search federal sources
 * @property {boolean} search_state     - Whether to search state-level sources
 * @property {boolean} search_local     - Whether to search local sources
 * @property {boolean} search_private   - Whether to search private/foundation sources
 * @property {string} confidence        - 'high'|'medium'|'low'
 * @property {string[]} why             - Explanation of why this plan was generated
 */

import { NEEDS_TAXONOMY, FUNDING_CATEGORY } from './needsTaxonomy.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('searchPlanGenerator')

// ---------------------------------------------------------------------------
// Search lane definitions
// ---------------------------------------------------------------------------
const SEARCH_LANE = {
  FEDERAL: 'federal',
  STATE: 'state',
  LOCAL: 'local',
  PRIVATE: 'private',
  FOUNDATION: 'foundation',
  DENOMINATION: 'denomination',
}

// ---------------------------------------------------------------------------
// Lane configuration per funding type
// ---------------------------------------------------------------------------
function getLanesForFundingType(fundingType) {
  switch (fundingType) {
    case FUNDING_CATEGORY.GRANT:
      return [SEARCH_LANE.FEDERAL, SEARCH_LANE.STATE, SEARCH_LANE.FOUNDATION, SEARCH_LANE.LOCAL]
    case FUNDING_CATEGORY.SCHOLARSHIP:
      return [SEARCH_LANE.FEDERAL, SEARCH_LANE.STATE, SEARCH_LANE.FOUNDATION, SEARCH_LANE.PRIVATE]
    case FUNDING_CATEGORY.REBATE:
      return [SEARCH_LANE.STATE, SEARCH_LANE.LOCAL, SEARCH_LANE.PRIVATE]
    case FUNDING_CATEGORY.CONTRACT:
      return [SEARCH_LANE.FEDERAL, SEARCH_LANE.STATE, SEARCH_LANE.LOCAL]
    case FUNDING_CATEGORY.DONOR:
      return [SEARCH_LANE.PRIVATE, SEARCH_LANE.FOUNDATION, SEARCH_LANE.DENOMINATION]
    default:
      return [SEARCH_LANE.FEDERAL, SEARCH_LANE.STATE, SEARCH_LANE.FOUNDATION]
  }
}

// ---------------------------------------------------------------------------
// Geography term builder
// ---------------------------------------------------------------------------
function buildGeographyTerms(intel) {
  const terms = []

  if (intel.state) terms.push(intel.state)
  if (intel.city) terms.push(intel.city)
  if (intel.county) terms.push(`${intel.county} county`)
  if (intel.zip) terms.push(intel.zip)

  if (intel.geographicFlags?.has('rural')) terms.push('rural')
  if (intel.geographicFlags?.has('tribal_land')) terms.push('tribal')
  if (intel.geographicFlags?.has('underserved')) terms.push('underserved')

  return terms
}

// ---------------------------------------------------------------------------
// Entity type terms for search
// ---------------------------------------------------------------------------
function buildEntityTerms(intel, needDef) {
  const types = [...(needDef?.related_entity_types ?? [])]

  // Include current entity type
  if (intel.entityType && !types.includes(intel.entityType)) {
    types.unshift(intel.entityType)
  }

  // Map to human-readable search terms
  const termMap = {
    individual: 'individual person',
    nonprofit: 'nonprofit organization',
    church: 'church congregation',
    faith_based: 'faith-based organization',
    school: 'K-12 school',
    school_district: 'school district',
    charter_school: 'charter school',
    college: 'college university',
    fire_ems: 'fire department EMS',
    government: 'local government municipality',
    tribal: 'tribal government',
    hospital: 'hospital clinic',
    housing_authority: 'housing authority',
    community_action: 'community action agency',
  }

  return types.slice(0, 3).map(t => termMap[t] ?? t)
}

// ---------------------------------------------------------------------------
// Boosted terms from profile context
// ---------------------------------------------------------------------------
function buildBoostedTerms(intel, needCode) {
  const boosted = []

  // Geography boosts
  if (intel.state) boosted.push(intel.state)
  if (intel.geographicFlags?.has('rural')) boosted.push('rural')
  if (intel.geographicFlags?.has('underserved')) boosted.push('underserved community')

  // Special eligibility boosts
  if (intel.eligibilityFlags?.has('is_501c3')) boosted.push('501(c)(3)')
  if (intel.eligibilityFlags?.has('faith_based') || intel.isChurch) boosted.push('faith-based')
  if (intel.isVeteran) boosted.push('veteran')
  if (intel.isStudent) boosted.push('student')
  if (intel.organizationFlags?.has('hbcu')) boosted.push('HBCU')
  if (intel.organizationFlags?.has('hsi')) boosted.push('HSI')
  if (intel.organizationFlags?.has('volunteer_organization')) boosted.push('volunteer')

  // Hardship boosts
  if (intel.hardshipFlags?.has('low_income') || intel.hardshipFlags?.has('low_budget')) {
    boosted.push('low income')
  }
  if (intel.hardshipFlags?.has('financial_hardship')) boosted.push('hardship')

  // Disability
  if ((intel.disabilityFlags?.size ?? 0) > 0) boosted.push('disability')

  // Minority
  if (intel.demographicFlags?.has('ethnicity:hispanic') ||
    intel.demographicFlags?.has('ethnicity:latino')) {
    boosted.push('Hispanic Latino')
  }
  if (intel.demographicFlags?.has('ethnicity:african_american') ||
    intel.demographicFlags?.has('ethnicity:black')) {
    boosted.push('African American Black')
  }
  if (intel.organizationFlags?.has('minority_owned_business') ||
    intel.eligibilityFlags?.has('minority_owned_business')) {
    boosted.push('minority-owned')
  }

  return [...new Set(boosted)]
}

// ---------------------------------------------------------------------------
// Exclusion terms
// ---------------------------------------------------------------------------
function buildExclusions(intel, needDef) {
  if (!needDef) return []
  const exclusions = []

  // Exclude disallowed entity types
  for (const disallowed of (needDef.disallowed_entity_types ?? [])) {
    if (disallowed !== intel.entityType) {
      exclusions.push(`not_eligible:${disallowed}`)
    }
  }

  // Faith-based exclusions: some federal grants exclude religious use
  if (intel.isChurch || intel.eligibilityFlags?.has('faith_based')) {
    exclusions.push('public_facility_only:false')  // allow faith-based
  }

  return exclusions
}

// ---------------------------------------------------------------------------
// Build search plans for a single inferred need
// ---------------------------------------------------------------------------
function buildPlansForNeed(inferredNeed, intel) {
  const def = NEEDS_TAXONOMY[inferredNeed.code]
  if (!def) return []

  const plans = []
  const geographyTerms = buildGeographyTerms(intel)
  const entityTerms = buildEntityTerms(intel, def)
  const boostedTerms = buildBoostedTerms(intel, inferredNeed.code)
  const exclusions = buildExclusions(intel, def)
  const priority = Math.round(inferredNeed.weight * 100)

  for (const fundingCategory of def.funding_categories) {
    const lanes = getLanesForFundingType(fundingCategory)

    for (const lane of lanes) {
      // Skip donor lanes for government entities
      if (lane === SEARCH_LANE.DENOMINATION && !intel.isChurch) continue
      if (lane === SEARCH_LANE.PRIVATE && intel.isGovernment) continue

      // Build search terms from example terms + entity + geography
      const searchTerms = [
        ...def.example_search_terms.slice(0, 3),
        ...entityTerms.slice(0, 2).map(et => `${et} ${def.label.toLowerCase()}`),
      ]

      // Add geography to search terms for state/local lanes
      if (lane === SEARCH_LANE.STATE || lane === SEARCH_LANE.LOCAL) {
        if (intel.state) {
          searchTerms.unshift(`${intel.state} ${def.label.toLowerCase()} grant`)
        }
      }

      plans.push({
        need_code: inferredNeed.code,
        need_label: def.label,
        search_lane: lane,
        search_terms: [...new Set(searchTerms)].slice(0, 5),
        boosted_terms: boostedTerms,
        entity_types: [...(def?.related_entity_types ?? [])],
        geography_terms: geographyTerms,
        exclusions,
        priority: (() => {
          if (lane === SEARCH_LANE.FEDERAL) return priority
          // State/local lanes are equally primary for community-level needs
          if (lane === SEARCH_LANE.STATE || lane === SEARCH_LANE.LOCAL) return Math.max(10, priority - 5)
          return Math.max(10, priority - 10)
        })(),
        expected_funding: fundingCategory,
        search_federal: lane === SEARCH_LANE.FEDERAL,
        search_state: lane === SEARCH_LANE.STATE,
        search_local: lane === SEARCH_LANE.LOCAL,
        search_private: [SEARCH_LANE.PRIVATE, SEARCH_LANE.FOUNDATION,
          SEARCH_LANE.DENOMINATION].includes(lane),
        confidence: inferredNeed.confidence,
        why: inferredNeed.signals,
      })
    }
  }

  return plans
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate search plans from a ProfileIntelligence object.
 *
 * @param {import('./index.js').ProfileIntelligence} intel
 * @param {Object} [options]
 * @param {number} [options.maxPlans] - Max total plans to return (default: 20)
 * @param {string[]} [options.onlyNeedCodes] - Only generate plans for these codes
 * @param {boolean} [options.includeLowConfidence] - Include low-confidence needs (default: false)
 * @returns {SearchPlan[]}
 */
export function generateSearchPlans(intel, options = {}) {
  if (!intel || !intel.inferredNeeds || !Array.isArray(intel.inferredNeeds)) return []

  const {
    maxPlans = 20,
    onlyNeedCodes = null,
    includeLowConfidence = false,
  } = options

  let needs = intel.inferredNeeds

  // Filter by specific codes if requested
  if (onlyNeedCodes && onlyNeedCodes.length > 0) {
    needs = Array.isArray(needs) ? needs.filter(n => onlyNeedCodes?.includes(n.code)) : []
  }

  // Filter out low-confidence unless opted in
  if (!includeLowConfidence) {
    const before = needs.length
    needs = Array.isArray(needs) ? needs.filter(n => n.confidence !== 'low') : []
    const dropped = before - needs.length
    if (dropped > 0) {
      log.debug(
        `[searchPlanGenerator] Suppressed ${dropped} low-confidence need(s) from plan generation. ` +
        'Pass includeLowConfidence:true to include them.'
      )
    }
  }

  // Generate plans for each need
  const allPlans = []
  for (const need of needs) {
    const plans = buildPlansForNeed(need, intel)
    allPlans.push(...plans)
  }

  // Sort by priority descending, deduplicate same need+lane
  const seen = new Set()
  let dedupDropped = 0
  const deduped = allPlans
    .sort((a, b) => b.priority - a.priority)
    .filter(plan => {
      const key = `${plan.need_code}:${plan.search_lane}:${plan.expected_funding}`
      if (seen.has(key)) { dedupDropped++; return false }
      seen.add(key)
      return true
    })

  if (dedupDropped > 0) {
    log.debug(`[searchPlanGenerator] Deduplication removed ${dedupDropped} duplicate search plan(s).`)
  }
  const truncated = deduped.length - Math.min(deduped.length, maxPlans)
  if (truncated > 0) {
    log.debug(`[searchPlanGenerator] maxPlans=${maxPlans} truncated ${truncated} lower-priority plan(s).`)
  }

  return deduped.slice(0, maxPlans)
}

/**
 * Get a compact search plan summary for display.
 */
export function getSearchPlanSummary(plans) {
  if (!plans || plans.length === 0) return []

  return plans
    .map(p => ({
      need: p.need_label,
      lane: p.search_lane,
      terms: p.search_terms.slice(0, 2).join(', '),
      funding: p.expected_funding,
      priority: p.priority,
    }))
}
