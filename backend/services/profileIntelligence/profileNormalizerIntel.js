/**
 * Profile Intelligence Normalizer — Phase 1
 *
 * Reads all profile sections safely and produces a canonical structure with:
 *   entity_types[], eligibility_flags[], compliance_flags[], geographic_flags[],
 *   demographic_flags[], hardship_flags[], capability_flags[],
 *   organization_specializations[], likely_needs[], explicit_requested_needs[],
 *   search_keywords[], exclusion_flags[]
 *
 * Every signal carries provenance (which field produced it) and is classified as:
 *   historical_fact | current_state | active_unmet_need | aspirational_goal
 *
 * NOTE: This module does NOT replace backend/services/profileNormalizer.js.
 *       It is the Phase 1 intelligence layer that complements it.
 */

import { NEEDS_TAXONOMY, isValidNeedCode } from './needsTaxonomy.js'

// ---------------------------------------------------------------------------
// Signal factory helpers
// ---------------------------------------------------------------------------

function signal(value, source, type = 'current_state', weight = 1.0) {
  return { value, source, type, weight }
}

function needSignal(code, source, weight, reasons) {
  return { code, source, weight, reasons, signalType: 'active_unmet_need' }
}

// ---------------------------------------------------------------------------
// Safe field readers
// ---------------------------------------------------------------------------

function safeStr(val) {
  if (!val || typeof val !== 'string') return ''
  return val.trim()
}

function safeArr(val) {
  if (!val) return []
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    try { const p = JSON.parse(val); return Array.isArray(p) ? p : [] }
    catch { return val.split(',').map(s => s.trim()).filter(Boolean) }
  }
  return []
}

function safeBool(val) {
  if (typeof val === 'boolean') return val
  if (val === 1 || val === '1' || val === 'true' || val === 'yes') return true
  if (val === 0 || val === '0' || val === 'false' || val === 'no') return false
  return null
}

function safeObj(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return {}
  return val
}

// ---------------------------------------------------------------------------
// Entity type normalization
// ---------------------------------------------------------------------------

const ENTITY_TYPE_MAP = {
  individual: 'individual',
  person: 'individual',
  student: 'individual_student',
  nonprofit: 'nonprofit',
  'non-profit': 'nonprofit',
  '501c3': 'nonprofit',
  organization: 'nonprofit',
  church: 'church',
  religious: 'church',
  'faith-based': 'church',
  faith_based: 'church',
  congregation: 'church',
  ministry: 'church',
  parish: 'church',
  mosque: 'church',
  synagogue: 'church',
  temple: 'church',
  school: 'school_district',
  school_district: 'school_district',
  charter_school: 'school_district',
  university: 'university',
  college: 'university',
  hospital: 'hospital',
  clinic: 'hospital',
  fqhc: 'fqhc',
  tribal: 'tribal_government',
  tribal_government: 'tribal_government',
  tribal_organization: 'tribal_government',
  local_government: 'local_government',
  municipality: 'local_government',
  county: 'local_government',
  fire_department: 'volunteer_fire_dept',
  volunteer_fire: 'volunteer_fire_dept',
  volunteer_fire_dept: 'volunteer_fire_dept',
  ems: 'volunteer_fire_dept',
  volunteer_ems: 'volunteer_fire_dept',
  housing_authority: 'housing_authority',
  workforce_board: 'workforce_board',
  community_action: 'community_action_agency',
  community_action_agency: 'community_action_agency',
  cdc: 'cdc',
  cdfi: 'cdfi',
  cooperative: 'cooperative',
  veterans_org: 'veterans_org',
  vso: 'veterans_org',
  business: 'for_profit_business',
  small_business: 'for_profit_business',
  research: 'research_institute',
  research_institute: 'research_institute',
  labor_union: 'labor_union',
  environmental_org: 'environmental_org',
}

function normalizeEntityType(rawType) {
  if (!rawType) return null
  const key = safeStr(rawType).toLowerCase().replace(/[\s-]/g, '_')
  return ENTITY_TYPE_MAP[key] ?? key
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

/**
 * Produce a canonical intelligence structure from raw profile + sections.
 *
 * @param {Object} profile       - Profile row (id, primary_type, display_name, state, ...)
 * @param {Object} sections      - Profile sections object (keyed by section name)
 * @returns {Object}             - Canonical intelligence output
 */
export function normalizeProfileIntelligence(profile, sections = {}) {
  const p = safeObj(profile)
  const s = safeObj(sections)

  const entity_types = []
  const eligibility_flags = []
  const compliance_flags = []
  const geographic_flags = []
  const demographic_flags = []
  const hardship_flags = []
  const capability_flags = []
  const organization_specializations = []
  const likely_needs = []
  const explicit_requested_needs = []
  const search_keywords = []
  const exclusion_flags = []

  // Provenance map: code -> [signals]
  const provenance = {}

  function addProvenance(category, value, source) {
    if (!provenance[category]) provenance[category] = []
    provenance[category].push({ value, source })
  }

  // ---------------------------------------------------------------------------
  // 1. Entity Type Resolution
  // ---------------------------------------------------------------------------
  const primaryType = safeStr(p.primary_type || p.primaryType || '')
  const orgSection = safeObj(s.organization_details || s.organization || {})
  const orgType = safeStr(orgSection.org_type || orgSection.organization_type || orgSection.type || '')
  const specOrgType = safeStr(orgSection.specialized_org_type || orgSection.specialized_type || '')
  const bizSection = safeObj(s.small_business_details || s.business || {})

  // Primary type signal
  if (primaryType) {
    const et = normalizeEntityType(primaryType)
    if (et && !entity_types.includes(et)) {
      entity_types.push(et)
      addProvenance('entity_types', et, 'profile.primary_type')
    }
  }

  // Organization type signal
  if (orgType) {
    const et = normalizeEntityType(orgType)
    if (et && !entity_types.includes(et)) {
      entity_types.push(et)
      addProvenance('entity_types', et, 'sections.organization.org_type')
    }
  }

  // Specialized org type
  if (specOrgType) {
    const et = normalizeEntityType(specOrgType)
    if (et && !entity_types.includes(et)) {
      entity_types.push(et)
      addProvenance('entity_types', et, 'sections.organization.specialized_org_type')
    }
    organization_specializations.push(signal(specOrgType, 'sections.organization.specialized_org_type', 'current_state'))
  }

  // Tags
  const tags = safeArr(p.tags)
  for (const tag of tags) {
    const et = normalizeEntityType(tag)
    if (et && !entity_types.includes(et)) {
      entity_types.push(et)
      addProvenance('entity_types', et, 'profile.tags')
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Compliance + Eligibility Flags
  // ---------------------------------------------------------------------------
  const qualSection = safeObj(s.qualifications || s.compliance || {})
  const federalSection = safeObj(s.federal_registrations || s.federal || {})
  const auditSection = safeObj(s.audit_information || {})

  if (safeBool(qualSection.is_501c3) || safeBool(qualSection['501c3'])) {
    compliance_flags.push('501c3')
    eligibility_flags.push('nonprofit_eligible')
    addProvenance('compliance_flags', '501c3', 'sections.qualifications.is_501c3')
  }
  if (safeStr(orgSection.ein)) {
    compliance_flags.push('has_ein')
    addProvenance('compliance_flags', 'has_ein', 'sections.organization.ein')
  }
  if (safeStr(federalSection.uei || federalSection.unique_entity_identifier)) {
    compliance_flags.push('has_uei')
    eligibility_flags.push('federal_grants_eligible')
    addProvenance('compliance_flags', 'has_uei', 'sections.federal_registrations.uei')
  }
  if (safeBool(federalSection.sam_registered) || safeBool(federalSection.active_sam)) {
    compliance_flags.push('sam_registered')
    eligibility_flags.push('federal_grants_eligible')
    addProvenance('compliance_flags', 'sam_registered', 'sections.federal_registrations.sam_registered')
  }
  if (safeStr(federalSection.cage_code)) {
    compliance_flags.push('has_cage')
    addProvenance('compliance_flags', 'has_cage', 'sections.federal_registrations.cage_code')
  }
  if (safeBool(qualSection.is_faith_based) || entity_types.includes('church')) {
    eligibility_flags.push('faith_based')
    exclusion_flags.push('public_grant_excludes_religious_use')
    addProvenance('eligibility_flags', 'faith_based', 'sections.qualifications.is_faith_based')
  }
  if (safeBool(qualSection.is_rural) || safeStr(qualSection.rural_designation)) {
    geographic_flags.push('rural')
    eligibility_flags.push('rural_eligible')
    addProvenance('geographic_flags', 'rural', 'sections.qualifications.is_rural')
  }
  if (safeBool(qualSection.is_minority_serving) || safeBool(qualSection.minority_serving_institution)) {
    eligibility_flags.push('minority_serving_eligible')
    addProvenance('eligibility_flags', 'minority_serving', 'sections.qualifications.is_minority_serving')
  }
  if (safeBool(qualSection.hipaa_compliant)) {
    compliance_flags.push('hipaa_compliant')
    addProvenance('compliance_flags', 'hipaa_compliant', 'sections.qualifications.hipaa_compliant')
  }
  if (safeBool(qualSection.ferpa_compliant)) {
    compliance_flags.push('ferpa_compliant')
    addProvenance('compliance_flags', 'ferpa_compliant', 'sections.qualifications.ferpa_compliant')
  }
  if (safeBool(auditSection.single_audit_required) || safeBool(auditSection.single_audit_completed)) {
    compliance_flags.push('single_audit_required')
    addProvenance('compliance_flags', 'single_audit', 'sections.audit_information')
  }

  // ---------------------------------------------------------------------------
  // 3. Geographic Flags
  // ---------------------------------------------------------------------------
  const addrSection = safeObj(s.address || s.basic_information || {})
  const state = safeStr(p.state || addrSection.state || '')
  const city = safeStr(p.city || addrSection.city || '')
  const zip = safeStr(p.zip_code || p.zip || addrSection.zip || addrSection.zip_code || '')
  const county = safeStr(addrSection.county || '')

  if (state) {
    geographic_flags.push(`state:${state}`)
    addProvenance('geographic_flags', `state:${state}`, 'profile.state')
  }
  if (county) {
    geographic_flags.push(`county:${county.toLowerCase()}`)
    addProvenance('geographic_flags', `county:${county}`, 'sections.address.county')
  }
  if (zip) {
    geographic_flags.push(`zip:${zip}`)
    addProvenance('geographic_flags', `zip:${zip}`, 'profile.zip_code')
  }

  const geoSection = safeObj(s.geographic_designations || {})
  if (safeBool(geoSection.appalachian_region)) {
    geographic_flags.push('appalachian_region')
  }
  if (safeBool(geoSection.opportunity_zone)) {
    geographic_flags.push('opportunity_zone')
    eligibility_flags.push('opportunity_zone_eligible')
  }
  if (safeBool(geoSection.tribal_land)) {
    geographic_flags.push('tribal_land')
  }
  if (safeBool(geoSection.colonias)) {
    geographic_flags.push('colonias')
  }

  // ---------------------------------------------------------------------------
  // 4. Demographic Flags
  // ---------------------------------------------------------------------------
  const demoSection = safeObj(s.demographics || s.personal_information || {})
  const age = parseInt(demoSection.age || p.age || '0', 10) || 0
  const raceEthnicity = safeArr(demoSection.race_ethnicity || demoSection.ethnicity || [])
  const gender = safeStr(demoSection.gender || '')
  const veteran = safeBool(
    demoSection.is_veteran || demoSection.veteran ||
    safeObj(s.military_service).veteran || safeObj(s.military_service).is_veteran
  )
  const studentStatus = safeBool(demoSection.is_student) || primaryType === 'student'
  const religionAffil = safeStr(demoSection.religious_affiliation || orgSection.denomination || '')

  if (age >= 60) {
    demographic_flags.push('senior')
    addProvenance('demographic_flags', 'senior', 'sections.demographics.age')
  } else if (age > 0 && age <= 25) {
    demographic_flags.push('youth')
    addProvenance('demographic_flags', 'youth', 'sections.demographics.age')
  }
  if (veteran) {
    demographic_flags.push('veteran')
    eligibility_flags.push('veteran_eligible')
    addProvenance('demographic_flags', 'veteran', 'sections.military_service.veteran')
  }
  if (studentStatus) {
    demographic_flags.push('enrolled_student')
    eligibility_flags.push('student_eligible')
    addProvenance('demographic_flags', 'student', 'profile.primary_type')
  }
  for (const race of raceEthnicity) {
    demographic_flags.push(`race:${safeStr(race).toLowerCase().replace(/\s+/g, '_')}`)
  }
  if (gender && ['female', 'woman', 'nonbinary'].includes(gender.toLowerCase())) {
    demographic_flags.push(`gender:${gender.toLowerCase()}`)
  }
  if (religionAffil) {
    demographic_flags.push(`religion:${safeStr(religionAffil).toLowerCase().replace(/\s+/g, '_')}`)
    addProvenance('demographic_flags', `religion:${religionAffil}`, 'sections.demographics.religious_affiliation')
  }

  // ---------------------------------------------------------------------------
  // 5. Hardship Flags
  // ---------------------------------------------------------------------------
  const financialSection = safeObj(s.financial_situation || s.financial || {})
  const healthSection = safeObj(s.health_medical || s.health || s.medical || {})
  const familySection = safeObj(s.family_life || s.family || {})

  if (safeBool(financialSection.is_low_income) ||
    safeStr(financialSection.income_level || '').match(/low|poverty|below/i)) {
    hardship_flags.push('low_income')
    addProvenance('hardship_flags', 'low_income', 'sections.financial_situation')
  }
  if (safeBool(financialSection.unemployed) || safeStr(financialSection.employment_status || '').match(/unemploy/i)) {
    hardship_flags.push('unemployed')
    addProvenance('hardship_flags', 'unemployed', 'sections.financial_situation.unemployed')
  }
  if (safeBool(familySection.experiencing_homelessness) || safeBool(financialSection.homeless)) {
    hardship_flags.push('experiencing_homelessness')
    addProvenance('hardship_flags', 'homelessness', 'sections.family_life.experiencing_homelessness')
  }
  if (safeBool(healthSection.has_chronic_illness) || safeBool(healthSection.chronic_illness)) {
    hardship_flags.push('chronic_illness')
    addProvenance('hardship_flags', 'chronic_illness', 'sections.health_medical.chronic_illness')
  }
  if (safeBool(healthSection.has_disability) || safeBool(healthSection.disability) ||
    safeArr(healthSection.disability_types).length > 0) {
    hardship_flags.push('disability')
    addProvenance('hardship_flags', 'disability', 'sections.health_medical.disability')
  }
  if (safeBool(familySection.is_single_parent) || safeBool(familySection.single_parent)) {
    hardship_flags.push('single_parent')
    addProvenance('hardship_flags', 'single_parent', 'sections.family_life.single_parent')
  }

  // ---------------------------------------------------------------------------
  // 6. Capability Flags (things the org CAN do / has)
  // ---------------------------------------------------------------------------
  if (compliance_flags.includes('sam_registered')) capability_flags.push('can_receive_federal_grants')
  if (compliance_flags.includes('has_uei')) capability_flags.push('can_receive_federal_grants')
  if (compliance_flags.includes('501c3')) capability_flags.push('can_receive_foundation_grants')
  if (safeStr(orgSection.annual_budget || '')) capability_flags.push('has_budget_data')
  if (parseInt(safeStr(orgSection.staff_count || orgSection.num_employees || ''), 10) > 0) {
    capability_flags.push('has_paid_staff')
  }
  if (safeArr(s.partnerships?.mou_partners || []).length > 0) {
    capability_flags.push('has_mou_partnerships')
  }

  // ---------------------------------------------------------------------------
  // 7. Keyword extraction from narrative sections
  // ---------------------------------------------------------------------------
  const narrativeSection = safeObj(s.narrative || s.story || {})
  const storyText = safeStr(
    narrativeSection.story || narrativeSection.barriers_faced ||
    narrativeSection.funding_request || narrativeSection.goals ||
    narrativeSection.special_circumstances || p.description || ''
  )
  const rawKeywords = safeArr(narrativeSection.keywords || narrativeSection.tags || s.keywords || p.keywords || [])
  for (const kw of rawKeywords) {
    if (kw && !search_keywords.includes(kw)) search_keywords.push(kw)
  }
  // Extract simple keywords from story text
  if (storyText) {
    const stopwords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'our', 'are', 'we', 'to', 'in', 'of', 'a', 'is', 'be', 'have', 'has', 'it', 'an'])
    const words = storyText.toLowerCase().match(/\b[a-z]{4,}\b/g) || []
    const freq = {}
    for (const w of words) { if (!stopwords.has(w)) freq[w] = (freq[w] || 0) + 1 }
    const topWords = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([w]) => w)
    for (const w of topWords) {
      if (!search_keywords.includes(w)) search_keywords.push(w)
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Explicit requested needs (from funding ask / narrative)
  // ---------------------------------------------------------------------------
  const requestedNeeds = safeArr(
    narrativeSection.funding_needs || narrativeSection.requested_needs ||
    s.funding_request?.needs || s.requested_needs || []
  )
  for (const rn of requestedNeeds) {
    const code = safeStr(rn).toLowerCase().replace(/\s+/g, '_')
    if (isValidNeedCode(code)) {
      explicit_requested_needs.push(needSignal(code, 'sections.narrative.funding_needs', 0.95, [`Explicitly requested: ${rn}`]))
    }
  }

  // ---------------------------------------------------------------------------
  // 9. Infer likely_needs from entity type + signals
  // (Phase 3 engine does the heavy lifting; this provides the base set)
  // ---------------------------------------------------------------------------
  // (Moved to needsInferenceEngine.js for single responsibility)
  // We add a placeholder hook here so callers know to run the inference engine.

  return {
    profile_id: safeStr(p.id || ''),
    entity_types,
    eligibility_flags: [...new Set(eligibility_flags)],
    compliance_flags: [...new Set(compliance_flags)],
    geographic_flags: [...new Set(geographic_flags)],
    demographic_flags: [...new Set(demographic_flags)],
    hardship_flags: [...new Set(hardship_flags)],
    capability_flags: [...new Set(capability_flags)],
    organization_specializations,
    likely_needs,
    explicit_requested_needs,
    search_keywords: [...new Set(search_keywords)],
    exclusion_flags: [...new Set(exclusion_flags)],
    provenance,
    // Derived convenience fields for downstream consumers
    state: state || null,
    city: city || null,
    zip: zip || null,
    is_rural: geographic_flags.includes('rural'),
    is_veteran: demographic_flags.includes('veteran'),
    is_student: demographic_flags.includes('enrolled_student'),
    is_faith_based: eligibility_flags.includes('faith_based'),
    is_nonprofit: compliance_flags.includes('501c3'),
    has_federal_compliance: compliance_flags.includes('sam_registered') || compliance_flags.includes('has_uei'),
  }
}

export default { normalizeProfileIntelligence }
