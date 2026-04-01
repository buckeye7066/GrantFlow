/**
 * Needs Inference Engine — Rules-based, no LLM dependency
 *
 * Infers funding needs from a normalized profile intelligence object.
 * Every inferred need includes a "why" provenance list explaining which
 * profile signals triggered it.
 *
 * Returns an array of InferredNeed objects:
 * {
 *   code: string,               // need code from NEEDS_TAXONOMY
 *   confidence: 'high'|'medium'|'low',
 *   weight: number,             // 0.0–1.0
 *   signals: string[],          // profile signals that triggered this
 *   source_fields: string[],    // which profile fields contributed
 *   fact_types: string[],       // classification: 'active_unmet_need'|'aspirational_goal'|'historical_fact'|'current_state'
 * }
 */

import { NEEDS_TAXONOMY, getAllNeedCodes, resolveNeedFromSynonym } from './needsTaxonomy.js'

// ---------------------------------------------------------------------------
// Confidence weight constants
// ---------------------------------------------------------------------------
const CONF_VERY_HIGH = 0.95
const CONF_HIGH = 0.90
const CONF_HIGH_MEDIUM = 0.85
const CONF_MEDIUM_HIGH = 0.80
const CONF_MEDIUM = 0.70
const CONF_MEDIUM_LOW = 0.65
const CONF_LOW = 0.60

// ---------------------------------------------------------------------------
// Entity type constants (must match profileIntelligence entityType values)
// ---------------------------------------------------------------------------
const ET = {
  INDIVIDUAL: 'individual',
  NONPROFIT: 'nonprofit',
  CHURCH: 'church',
  FAITH_BASED: 'faith_based',
  SCHOOL: 'school',
  SCHOOL_DISTRICT: 'school_district',
  CHARTER_SCHOOL: 'charter_school',
  COLLEGE: 'college',
  FIRE_EMS: 'fire_ems',
  GOVERNMENT: 'government',
  TRIBAL: 'tribal',
  BUSINESS: 'business',
  HOSPITAL: 'hospital',
  HOUSING_AUTHORITY: 'housing_authority',
  COMMUNITY_ACTION: 'community_action',
  CDFI: 'cdfi',
  LIBRARY: 'library',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Merge an inferred need into a result map.
 * If the same code already exists, keeps the higher weight and merges signals.
 */
function mergeNeed(resultMap, code, weight, signals, sourceFields, factTypes) {
  if (!NEEDS_TAXONOMY[code]) return  // safety: only infer known codes
  const existing = resultMap.get(code)
  if (existing) {
    existing.weight = Math.min(1.0, Math.max(existing.weight, weight))
    for (const s of signals) if (!existing.signals.includes(s)) existing.signals.push(s)
    for (const f of sourceFields) if (!existing.source_fields.includes(f)) existing.source_fields.push(f)
    for (const t of factTypes) if (!existing.fact_types.includes(t)) existing.fact_types.push(t)
  } else {
    resultMap.set(code, {
      code,
      weight,
      signals: [...signals],
      source_fields: [...sourceFields],
      fact_types: [...factTypes],
    })
  }
}

function weightToConfidence(weight) {
  if (weight >= 0.7) return 'high'
  if (weight >= 0.4) return 'medium'
  return 'low'
}

// ---------------------------------------------------------------------------
// Rule sets per entity category
// ---------------------------------------------------------------------------

function inferChurchNeeds(intel, resultMap) {
  const { entityType, organizationFlags, storyKeywords, financialFlags, facilityFlags } = intel

  if (![ET.CHURCH, ET.FAITH_BASED].includes(entityType)) return

  // Core needs for any church
  mergeNeed(resultMap, 'facilities_repair', 0.7,
    ['entity_type=church/faith_based'],
    ['primary_type'],
    ['current_state'])

  mergeNeed(resultMap, 'utilities_support', CONF_MEDIUM_LOW,
    ['entity_type=church/faith_based'],
    ['primary_type'],
    ['current_state'])

  mergeNeed(resultMap, 'community_outreach', 0.7,
    ['entity_type=church/faith_based'],
    ['primary_type'],
    ['current_state'])

  mergeNeed(resultMap, 'donor_support_private', CONF_MEDIUM,
    ['church profiles primarily supported by donors'],
    ['primary_type'],
    ['current_state'])

  mergeNeed(resultMap, 'denomination_support', CONF_MEDIUM_LOW,
    ['entity_type=church — parent denomination may have grants'],
    ['primary_type'],
    ['current_state'])

  // Financial hardship signals
  if (financialFlags.has('low_budget') || financialFlags.has('financial_hardship')) {
    mergeNeed(resultMap, 'utilities_support', CONF_HIGH_MEDIUM,
      ['financial_hardship signal on church profile'],
      ['financial_situation'],
      ['active_unmet_need'])
    mergeNeed(resultMap, 'facilities_repair', CONF_MEDIUM_HIGH,
      ['financial_hardship suggests deferred maintenance'],
      ['financial_situation'],
      ['active_unmet_need'])
    mergeNeed(resultMap, 'staffing_salary', 0.6,
      ['financial_hardship may affect pastor/staff compensation'],
      ['financial_situation'],
      ['active_unmet_need'])
  }

  // Explicit facility keywords
  const facilityKeywords = ['roof', 'boiler', 'hvac', 'furnace', 'plumbing', 'electrical',
    'repair', 'renovation', 'restroom', 'accessible', 'ramp', 'foundation']
  const matchedFacility = facilityKeywords.filter(k =>
    storyKeywords.some(sk => sk.toLowerCase().includes(k)))
  if (matchedFacility.length > 0) {
    mergeNeed(resultMap, 'facilities_repair', 0.9,
      [`story/goals mention: ${matchedFacility.join(', ')}`],
      ['story', 'goals', 'funding_ask'],
      ['active_unmet_need'])
  }

  if (facilityFlags.has('historic') || storyKeywords.some(k => /histor|preserv|landmar/i.test(k))) {
    mergeNeed(resultMap, 'facilities_preservation', CONF_MEDIUM,
      ['historic/preservation signal'],
      ['story', 'organization_details'],
      ['current_state'])
  }

  if (facilityFlags.has('needs_accessibility') || storyKeywords.some(k => /ada|wheelchair|access/i.test(k))) {
    mergeNeed(resultMap, 'accessibility_upgrades', CONF_MEDIUM,
      ['accessibility signal in story/flags'],
      ['story'],
      ['active_unmet_need'])
  }

  // Food program mention
  if (storyKeywords.some(k => /food|meal|pantry|kitchen|hunger/i.test(k))) {
    mergeNeed(resultMap, 'food_programs', 0.7,
      ['food/meal program keywords in story'],
      ['story', 'goals'],
      ['current_state'])
  }

  // Capital campaign
  if (storyKeywords.some(k => /capital campaign|building fund|expansion/i.test(k))) {
    mergeNeed(resultMap, 'capital_campaign', 0.8,
      ['capital campaign keywords in story'],
      ['story', 'funding_ask'],
      ['aspirational_goal'])
  }
}

function inferFireEmsNeeds(intel, resultMap) {
  const { entityType, storyKeywords, organizationFlags, financialFlags } = intel

  if (entityType !== ET.FIRE_EMS) return

  // Core needs for volunteer fire/EMS
  mergeNeed(resultMap, 'public_safety_equipment', CONF_HIGH_MEDIUM,
    ['entity_type=fire_ems — equipment is core need'],
    ['primary_type', 'specialized_type'],
    ['current_state'])

  mergeNeed(resultMap, 'ppe', CONF_HIGH_MEDIUM,
    ['entity_type=fire_ems — PPE/turnout gear is always needed'],
    ['primary_type'],
    ['current_state'])

  mergeNeed(resultMap, 'vehicles', CONF_MEDIUM,
    ['entity_type=fire_ems — apparatus/vehicle replacement common need'],
    ['primary_type'],
    ['current_state'])

  mergeNeed(resultMap, 'training', CONF_MEDIUM_HIGH,
    ['entity_type=fire_ems — training/certification is ongoing need'],
    ['primary_type'],
    ['current_state'])

  // Volunteer-specific staffing need
  if (organizationFlags.has('volunteer_organization')) {
    mergeNeed(resultMap, 'staffing_salary', CONF_MEDIUM_LOW,
      ['volunteer fire dept may seek SAFER grants for staffing'],
      ['organization_details'],
      ['aspirational_goal'])
  }

  // Story-specific signals
  const vehicleKeywords = ['truck', 'engine', 'tanker', 'ambulance', 'apparatus', 'vehicle', 'pumper']
  const matched = vehicleKeywords.filter(k => storyKeywords.some(sk => sk.toLowerCase().includes(k)))
  if (matched.length > 0) {
    mergeNeed(resultMap, 'vehicles', CONF_HIGH,
      [`story mentions: ${matched.join(', ')}`],
      ['story', 'funding_ask'],
      ['active_unmet_need'])
  }

  if (storyKeywords.some(k => /scba|breathing apparatus|air pack|airpack/i.test(k))) {
    mergeNeed(resultMap, 'ppe', CONF_HIGH,
      ['SCBA/breathing apparatus keyword in story'],
      ['story'],
      ['active_unmet_need'])
  }

  if (storyKeywords.some(k => /radio|communication|dispatch|CAD|pager/i.test(k))) {
    mergeNeed(resultMap, 'public_safety_equipment', 0.9,
      ['communications/radio keyword in story'],
      ['story'],
      ['active_unmet_need'])
  }

  if (storyKeywords.some(k => /station|firehouse|bay|garage/i.test(k))) {
    mergeNeed(resultMap, 'facilities_repair', 0.7,
      ['fire station facility keywords in story'],
      ['story'],
      ['current_state'])
  }
}

function inferSchoolNeeds(intel, resultMap) {
  const { entityType, storyKeywords, organizationFlags } = intel

  const schoolTypes = [ET.SCHOOL, ET.SCHOOL_DISTRICT, ET.CHARTER_SCHOOL]
  if (!schoolTypes.includes(entityType)) return

  // Technology is almost always a school need
  mergeNeed(resultMap, 'technology', CONF_MEDIUM,
    ['entity_type=school — technology/Chromebook grants commonly sought'],
    ['primary_type'],
    ['current_state'])

  // Training for teachers
  mergeNeed(resultMap, 'training', CONF_MEDIUM_LOW,
    ['entity_type=school — professional development for teachers'],
    ['primary_type'],
    ['current_state'])

  // Check for band/music/arts
  if (storyKeywords.some(k => /band|music|instrument|choir|orchestra|arts|drama|theater/i.test(k))) {
    mergeNeed(resultMap, 'arts_equipment', CONF_HIGH_MEDIUM,
      ['music/arts keywords in story or goals'],
      ['story', 'goals'],
      ['active_unmet_need'])
  }

  // Check for sports/athletics
  if (storyKeywords.some(k => /sport|athletic|football|basketball|baseball|soccer|uniform|gym/i.test(k))) {
    mergeNeed(resultMap, 'athletics_equipment', CONF_HIGH_MEDIUM,
      ['sports/athletics keywords in story'],
      ['story', 'goals'],
      ['active_unmet_need'])
  }

  // STEM
  if (storyKeywords.some(k => /stem|science|lab|robotics|coding|computer/i.test(k))) {
    mergeNeed(resultMap, 'technology', CONF_HIGH_MEDIUM,
      ['STEM/lab keywords in story'],
      ['story'],
      ['active_unmet_need'])
  }

  // Accessibility
  if (storyKeywords.some(k => /ada|wheelchair|access|elevator|ramp/i.test(k))) {
    mergeNeed(resultMap, 'accessibility_upgrades', CONF_MEDIUM_HIGH,
      ['accessibility keywords in story'],
      ['story'],
      ['active_unmet_need'])
  }

  // After-school / community programs
  if (storyKeywords.some(k => /after.?school|after school|program|21st century|community/i.test(k))) {
    mergeNeed(resultMap, 'program_operations', 0.7,
      ['after-school program keywords'],
      ['story'],
      ['current_state'])
  }
}

function inferIndividualHardshipNeeds(intel, resultMap) {
  const { entityType, hardshipFlags, demographicFlags, militaryFlags, disabilityFlags,
    storyKeywords, enrolledPrograms } = intel

  if (entityType !== ET.INDIVIDUAL && entityType !== 'student') return

  // Housing instability
  if ((hardshipFlags ?? new Set()).has('housing_instability') || (hardshipFlags ?? new Set()).has('homeless') ||
    storyKeywords.some(k => /evict|homeless|housing|rent|shelter/i.test(k))) {
    mergeNeed(resultMap, 'housing_support', CONF_HIGH_MEDIUM,
      ['housing instability signal'],
      ['financial_situation', 'story'],
      ['active_unmet_need'])
  }

  // Utility need
  if ((hardshipFlags ?? new Set()).has('utility_hardship') ||
    storyKeywords.some(k => /electric|gas bill|utility|heat|water bill|liheap/i.test(k))) {
    mergeNeed(resultMap, 'utilities_support', CONF_HIGH_MEDIUM,
      ['utility hardship signal'],
      ['financial_situation', 'story'],
      ['active_unmet_need'])
  }

  // Food insecurity
  if ((hardshipFlags ?? new Set()).has('food_insecurity') ||
    storyKeywords.some(k => /food|hunger|snap|wic|grocery/i.test(k))) {
    mergeNeed(resultMap, 'food_programs', CONF_HIGH_MEDIUM,
      ['food insecurity signal'],
      ['financial_situation', 'story'],
      ['active_unmet_need'])
  }

  // Medical/health
  if ((disabilityFlags ?? new Set()).size > 0 || (hardshipFlags ?? new Set()).has('medical_hardship') ||
    storyKeywords.some(k => /medical bill|prescription|doctor|health|dental|vision|mental health/i.test(k))) {
    mergeNeed(resultMap, 'health_medical_support', CONF_HIGH_MEDIUM,
      ['medical/health hardship signal or disability flag'],
      ['health_medical', 'story'],
      ['active_unmet_need'])
  }

  // Disability-specific
  if ((disabilityFlags ?? new Set()).size > 0) {
    mergeNeed(resultMap, 'health_medical_support', CONF_HIGH_MEDIUM,
      ['disability/chronic illness flag'],
      ['health_medical'],
      ['current_state'])
    mergeNeed(resultMap, 'transportation_support', 0.6,
      ['disability flag may indicate transportation barriers'],
      ['health_medical'],
      ['current_state'])
  }

  // Emergency/crisis
  if ((hardshipFlags ?? new Set()).has('in_crisis') || (hardshipFlags ?? new Set()).has('emergency') ||
    storyKeywords.some(k => /emergency|crisis|urgent|desperate/i.test(k))) {
    mergeNeed(resultMap, 'emergency_assistance', CONF_HIGH_MEDIUM,
      ['emergency/crisis signal'],
      ['story'],
      ['active_unmet_need'])
  }

  // Childcare
  if (demographicFlags.has('has_children') ||
    storyKeywords.some(k => /childcare|daycare|child care|head start/i.test(k))) {
    mergeNeed(resultMap, 'childcare_support', CONF_MEDIUM,
      ['children/childcare signal'],
      ['family_life', 'story'],
      ['active_unmet_need'])
  }

  // Transportation
  if (storyKeywords.some(k => /transportation|car repair|bus|transit|rideshare/i.test(k))) {
    mergeNeed(resultMap, 'transportation_support', CONF_MEDIUM,
      ['transportation keyword in story'],
      ['story'],
      ['active_unmet_need'])
  }

  // Debt relief
  if ((hardshipFlags ?? new Set()).has('debt_burden') ||
    storyKeywords.some(k => /debt|loan|credit|bankruptcy/i.test(k))) {
    mergeNeed(resultMap, 'debt_relief', CONF_MEDIUM_LOW,
      ['debt/financial burden signal'],
      ['financial_situation', 'story'],
      ['active_unmet_need'])
  }

  // General hardship → emergency assistance
  if ((hardshipFlags ?? new Set()).size >= 2) {
    mergeNeed(resultMap, 'emergency_assistance', CONF_MEDIUM,
      ['multiple hardship flags indicate overall crisis'],
      ['financial_situation'],
      ['active_unmet_need'])
  }
}

function inferStudentNeeds(intel, resultMap) {
  const { entityType, isStudent, storyKeywords, demographicFlags = new Set(), disabilityFlags = new Set(), hardshipFlags = new Set() } = intel

  // Student individual or entity_type=student
  if (!isStudent && entityType !== 'student') return

  mergeNeed(resultMap, 'scholarships_tuition', CONF_HIGH,
    ['profile is student / isStudent=true'],
    ['primary_type', 'education'],
    ['active_unmet_need'])

  mergeNeed(resultMap, 'workforce_development', 0.6,
    ['student profile may need job training'],
    ['primary_type'],
    ['aspirational_goal'])

  if ((intel.hardshipFlags ?? new Set()).size > 0) {
    mergeNeed(resultMap, 'housing_support', 0.7,
      ['student with hardship flags may need campus/off-campus housing'],
      ['financial_situation'],
      ['active_unmet_need'])
    mergeNeed(resultMap, 'emergency_assistance', CONF_MEDIUM_LOW,
      ['student hardship'],
      ['financial_situation'],
      ['active_unmet_need'])
  }

  if ((disabilityFlags ?? new Set()).size > 0) {
    mergeNeed(resultMap, 'health_medical_support', CONF_MEDIUM,
      ['student with disability'],
      ['health_medical'],
      ['current_state'])
  }

  if (storyKeywords.some(k => /first.gen|first generation|low income|pell/i.test(k))) {
    mergeNeed(resultMap, 'scholarships_tuition', CONF_VERY_HIGH,
      ['first-generation / low-income student keyword'],
      ['story'],
      ['active_unmet_need'])
  }
}

// Remove unused helper function - use inline null checks instead

function inferVeteranNeeds(intel, resultMap) {
  const { isVeteran, militaryFlags, storyKeywords } = intel

  if (!isVeteran && (militaryFlags ?? new Set()).size === 0) return

  mergeNeed(resultMap, 'health_medical_support', 0.7,
    ['veteran flag — VA/veterans health programs available'],
    ['military_service'],
    ['current_state'])

  mergeNeed(resultMap, 'workforce_development', CONF_MEDIUM_LOW,
    ['veteran flag — retraining/employment programs available'],
    ['military_service'],
    ['aspirational_goal'])

  mergeNeed(resultMap, 'housing_support', 0.6,
    ['veteran flag — HUD-VASH and veteran housing programs'],
    ['military_service'],
    ['aspirational_goal'])

  if (storyKeywords.some(k => /ptsd|tbi|traumatic brain|mental health|disability/i.test(k))) {
    mergeNeed(resultMap, 'health_medical_support', CONF_HIGH_MEDIUM,
      ['PTSD/TBI/disability keyword for veteran'],
      ['story', 'military_service'],
      ['active_unmet_need'])
  }
}

function inferNonprofitNeeds(intel, resultMap) {
  const { entityType, storyKeywords, organizationFlags, financialFlags } = intel

  if (entityType !== ET.NONPROFIT && entityType !== ET.COMMUNITY_ACTION) return

  mergeNeed(resultMap, 'program_operations', 0.7,
    ['entity_type=nonprofit — general operating support commonly needed'],
    ['primary_type'],
    ['current_state'])

  mergeNeed(resultMap, 'community_outreach', CONF_MEDIUM_LOW,
    ['entity_type=nonprofit — outreach is core mission'],
    ['primary_type'],
    ['current_state'])

  if (financialFlags.has('low_budget') || financialFlags.has('financial_hardship')) {
    mergeNeed(resultMap, 'program_operations', CONF_HIGH_MEDIUM,
      ['financial hardship on nonprofit profile'],
      ['financial_situation'],
      ['active_unmet_need'])
  }

  if (storyKeywords.some(k => /food|pantry|meal|hunger/i.test(k))) {
    mergeNeed(resultMap, 'food_programs', CONF_MEDIUM_HIGH,
      ['food program keywords'],
      ['story'],
      ['current_state'])
  }

  if (storyKeywords.some(k => /workforce|job training|employment/i.test(k))) {
    mergeNeed(resultMap, 'workforce_development', CONF_MEDIUM_HIGH,
      ['workforce/employment keywords'],
      ['story'],
      ['current_state'])
  }

  if (organizationFlags.has('housing_focused') ||
    storyKeywords.some(k => /housing|shelter|homeless/i.test(k))) {
    mergeNeed(resultMap, 'housing_support', CONF_MEDIUM_HIGH,
      ['housing-focused nonprofit'],
      ['story', 'organization_details'],
      ['current_state'])
  }
}

function inferFromExplicitKeywords(intel, resultMap) {
  const { storyKeywords, explicitRequestedNeeds } = intel

  // Map explicit requested needs first (highest weight)
  for (const need of explicitRequestedNeeds) {
    const code = resolveNeedFromSynonym(need)
    if (code) {
      mergeNeed(resultMap, code, CONF_VERY_HIGH,
        [`explicit_requested_need: "${need}"`],
        ['funding_ask', 'goals'],
        ['active_unmet_need'])
    }
  }

  // Scan story keywords for taxonomy synonyms
  for (const keyword of storyKeywords) {
    const code = resolveNeedFromSynonym(keyword)
    if (code) {
      mergeNeed(resultMap, code, 0.6,
        [`story keyword matched taxonomy: "${keyword}"`],
        ['story', 'keywords'],
        ['current_state'])
    }
  }
}

function inferDisasterContext(intel, resultMap) {
  const { emergencyFlags, storyKeywords } = intel

  if ((emergencyFlags ?? new Set()).has('disaster_affected') ||
    storyKeywords.some(k => /disaster|flood|hurricane|tornado|wildfire|fema/i.test(k))) {
    mergeNeed(resultMap, 'disaster_recovery', CONF_HIGH,
      ['disaster/FEMA signal'],
      ['story', 'emergency'],
      ['active_unmet_need'])
  }
}

function inferEnergyEfficiency(intel, resultMap) {
  const { storyKeywords, entityType } = intel

  if (storyKeywords.some(k => /weatheriz|insulat|solar|energy efficien|hvac|heat pump/i.test(k))) {
    mergeNeed(resultMap, 'energy_efficiency', CONF_MEDIUM_HIGH,
      ['energy efficiency keyword in story'],
      ['story'],
      ['aspirational_goal'])
  }
}

function inferEnvironmental(intel, resultMap) {
  const { organizationFlags, storyKeywords, entityType } = intel

  if (organizationFlags.has('environmental_org') ||
    storyKeywords.some(k => /environment|conservation|wetland|brownfield|tree|pollution/i.test(k))) {
    mergeNeed(resultMap, 'environmental_projects', CONF_MEDIUM_HIGH,
      ['environmental org flag or keywords'],
      ['organization_details', 'story'],
      ['current_state'])
  }
}

function inferResearch(intel, resultMap) {
  const { organizationFlags, storyKeywords, entityType } = intel

  const researchTypes = [ET.COLLEGE, ET.HOSPITAL]
  const hasResearchOrg = researchTypes.includes(entityType) ||
    organizationFlags.has('research_institute')

  if (hasResearchOrg ||
    storyKeywords.some(k => /research|clinical trial|r&d|innovation|sbir|sttr/i.test(k))) {
    mergeNeed(resultMap, 'research_funding', CONF_MEDIUM,
      ['research org or keywords'],
      ['organization_details', 'story'],
      ['current_state'])
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Infer needs from a profile intelligence object.
 *
 * @param {import('./index.js').ProfileIntelligence} intel
 * @returns {InferredNeed[]}
 */
export function inferNeeds(intel) {
  if (!intel || typeof intel !== 'object') return []

  const resultMap = new Map()

  // Run all rule sets
  inferChurchNeeds(intel, resultMap)
  inferFireEmsNeeds(intel, resultMap)
  inferSchoolNeeds(intel, resultMap)
  inferIndividualHardshipNeeds(intel, resultMap)
  inferStudentNeeds(intel, resultMap)
  inferVeteranNeeds(intel, resultMap)
  inferNonprofitNeeds(intel, resultMap)
  inferFromExplicitKeywords(intel, resultMap)
  inferDisasterContext(intel, resultMap)
  inferEnergyEfficiency(intel, resultMap)
  inferEnvironmental(intel, resultMap)
  inferResearch(intel, resultMap)

  // Convert to array with confidence labels, sorted by weight descending
  return Array.from(resultMap.values())
    .map(n => ({ ...n, confidence: weightToConfidence(n.weight) }))
    .sort((a, b) => b.weight - a.weight)
}
