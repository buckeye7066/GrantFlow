/**
 * profileIntelligence/index.js
 *
 * THE unified profile intelligence layer for GrantFlow.
 *
 * Transforms raw profile data (profile row + sections JSON) into a structured
 * ProfileIntelligence object that is safe to use for:
 *   - Need inference
 *   - Search plan generation
 *   - Eligibility filtering
 *   - Relevance scoring
 *
 * All consumers should call buildProfileIntelligence() rather than reading
 * raw profile fields directly.
 *
 * Returns a ProfileIntelligence object with provenance-tracked signals.
 */

import crypto from 'crypto'
import { NEEDS_TAXONOMY, resolveNeedFromSynonym } from './needsTaxonomy.js'
import { inferNeeds } from './needsInference.js'

// ---------------------------------------------------------------------------
// Entity type mapping for profile primary_type / specialized types
// ---------------------------------------------------------------------------
const PRIMARY_TYPE_TO_ENTITY = {
  individual: 'individual',
  individual_need: 'individual',
  person: 'individual',
  family: 'individual',
  household: 'individual',
  adult: 'individual',
  senior: 'individual',
  student: 'individual',
  veteran: 'individual',
  caregiver: 'individual',

  nonprofit: 'nonprofit',
  '501c3': 'nonprofit',
  charity: 'nonprofit',
  ngo: 'nonprofit',
  community_organization: 'nonprofit',

  church: 'church',
  faith_based: 'church',
  religious_organization: 'church',
  ministry: 'church',
  religious: 'church',

  school: 'school',
  school_district: 'school_district',
  charter_school: 'charter_school',
  k12: 'school',
  k_12: 'school',
  elementary_school: 'school',
  middle_school: 'school',
  high_school: 'school',

  college: 'college',
  university: 'college',
  community_college: 'college',
  hbcu: 'college',
  hsi: 'college',
  tcu: 'college',
  tribal_college: 'college',

  fire_ems: 'fire_ems',
  fire_department: 'fire_ems',
  volunteer_fire: 'fire_ems',
  ems: 'fire_ems',
  emergency_services: 'fire_ems',
  rescue_squad: 'fire_ems',

  government: 'government',
  municipality: 'government',
  county: 'government',
  city: 'government',
  township: 'government',
  tribal_government: 'tribal',
  tribe: 'tribal',
  tribal: 'tribal',

  business: 'business',
  small_business: 'business',
  entrepreneur: 'business',

  hospital: 'hospital',
  clinic: 'hospital',
  fqhc: 'hospital',
  health_center: 'hospital',
  rural_health_clinic: 'hospital',

  housing_authority: 'housing_authority',
  community_action: 'community_action',
  community_action_agency: 'community_action',
  cdfi: 'cdfi',
  library: 'library',
}

// ---------------------------------------------------------------------------
// Safe section reader
// ---------------------------------------------------------------------------
function readSection(profileSections, ...keys) {
  if (!profileSections || typeof profileSections !== 'object') return null
  for (const key of keys) {
    const sec = profileSections[key]
    if (!sec) continue
    if (typeof sec === 'object') {
      // May be { answers: {...} } or a flat object
      return sec.answers ?? sec
    }
  }
  return null
}

function safeStr(val) {
  return typeof val === 'string' ? val.trim() : ''
}

function safeBool(val) {
  if (typeof val === 'boolean') return val
  if (val === 1 || val === '1' || val === 'true' || val === 'yes') return true
  return false
}

function safeArr(val) {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    try { const p = JSON.parse(val); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

/**
 * Group 11 matcher coverage: build a normalized `demographics` object from
 * raw profile + section answers. Every field is optional; missing values are
 * represented as null or empty arrays so downstream scoring can treat them
 * neutrally (per user rule: missing fields must NOT disqualify a funding
 * source by default).
 */
function buildDemographicProfile(profile, sections) {
  const p = profile || {}
  const orgDetails = readSection(sections, 'organization_details') || {}
  const smallBiz = readSection(sections, 'small_business_details') || {}
  const financial = readSection(sections, 'financial_information') || {}
  const occupation = readSection(sections, 'occupation') || {}
  const narrative = readSection(sections, 'narrative') || {}
  const programs = readSection(sections, 'programs_services') || {}
  const fundingNeeds = readSection(sections, 'funding_needs') || {}
  const basic = readSection(sections, 'basic_information') || {}
  const location = readSection(sections, 'location_focus') || {}

  const num = (v) => {
    if (v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const arr = (v) => {
    if (Array.isArray(v)) return v.map((s) => safeStr(s)).filter(Boolean)
    if (typeof v === 'string') return v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)
    return []
  }

  return {
    country: safeStr(p.country || basic.country || location.country || '') || null,
    employee_count:
      num(p.employee_count)
      ?? num(orgDetails.employee_count)
      ?? num(smallBiz.employee_count ?? smallBiz.employees)
      ?? num(occupation.employee_count),
    annual_revenue:
      num(p.annual_revenue)
      ?? num(financial.annual_revenue ?? financial.revenue)
      ?? num(orgDetails.annual_revenue)
      ?? num(smallBiz.annual_revenue),
    years_in_operation:
      num(p.years_in_operation)
      ?? num(orgDetails.years_in_operation)
      ?? num(smallBiz.years_in_operation),
    veteran_owned: safeBool(
      p.veteran_owned
      ?? occupation.veteran_owned
      ?? occupation.veteran_owned_business
      ?? smallBiz.veteran_owned
      ?? orgDetails.veteran_owned,
    ),
    woman_owned: safeBool(
      p.woman_owned
      ?? p.women_owned
      ?? occupation.woman_owned
      ?? occupation.women_owned_business
      ?? smallBiz.woman_owned
      ?? orgDetails.woman_owned,
    ),
    minority_owned: safeBool(
      p.minority_owned
      ?? occupation.minority_owned
      ?? occupation.minority_owned_business
      ?? smallBiz.minority_owned
      ?? orgDetails.minority_owned,
    ),
    organization_type:
      safeStr(p.organization_type || orgDetails.organization_type || smallBiz.organization_type || '') || null,
    population_served:
      arr(p.population_served ?? programs.population_served ?? orgDetails.population_served ?? fundingNeeds.population_served),
    mission_focus:
      arr(p.mission_focus ?? p.mission ?? orgDetails.mission_focus ?? orgDetails.mission ?? narrative.mission_focus),
  }
}

function safeObj(val) {
  if (val && typeof val === 'object' && !Array.isArray(val)) return val
  if (typeof val === 'string') {
    try { const p = JSON.parse(val); return (p && typeof p === 'object') ? p : {} } catch { return {} }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Tokenize story/goal/keyword text into lowercase tokens
// ---------------------------------------------------------------------------
function tokenizeText(...texts) {
  const tokens = []
  for (const text of texts) {
    if (!text || typeof text !== 'string') continue
    // Extract words and short phrases
    tokens.push(...text.toLowerCase().split(/[\s,;.!?\n]+/).filter(t => t.length > 2))
    tokens.push(text.toLowerCase())  // also push the full string for regex matching
  }
  return [...new Set(tokens)]
}

// ---------------------------------------------------------------------------
// Entity type resolver
// ---------------------------------------------------------------------------
function resolveEntityType(profile, profileSections) {
  const primaryType = safeStr(profile.primary_type).toLowerCase().replace(/[\s-]+/g, '_')
  if (primaryType && PRIMARY_TYPE_TO_ENTITY[primaryType]) {
    return { entityType: PRIMARY_TYPE_TO_ENTITY[primaryType], source: 'primary_type' }
  }

  // Check specialized org type section
  const orgSection = readSection(profileSections,
    'organization', 'organization_details', 'org_details', 'basic_information')
  if (orgSection) {
    const specializationType = safeStr(orgSection.specialized_type ||
      orgSection.organization_type || orgSection.org_type).toLowerCase().replace(/[\s-]+/g, '_')
    if (specializationType && PRIMARY_TYPE_TO_ENTITY[specializationType]) {
      return { entityType: PRIMARY_TYPE_TO_ENTITY[specializationType], source: 'org_section' }
    }
  }

  // Check specialized_org_types section
  const specSection = readSection(profileSections, 'specialized_org_types', 'specialized_types')
  if (specSection) {
    // Keys like volunteer_fire_ems, charter_school, hospital_clinic_fqhc, etc.
    if (specSection.volunteer_fire_ems || specSection.fire_ems) {
      return { entityType: 'fire_ems', source: 'specialized_org_types' }
    }
    if (specSection.charter_school) {
      return { entityType: 'charter_school', source: 'specialized_org_types' }
    }
    if (specSection.school_district) {
      return { entityType: 'school_district', source: 'specialized_org_types' }
    }
    if (specSection.college_university || specSection.community_college) {
      return { entityType: 'college', source: 'specialized_org_types' }
    }
    if (specSection.hospital_clinic_fqhc || specSection.rural_health_clinic) {
      return { entityType: 'hospital', source: 'specialized_org_types' }
    }
    if (specSection.tribal_government) {
      return { entityType: 'tribal', source: 'specialized_org_types' }
    }
    if (specSection.housing_authority) {
      return { entityType: 'housing_authority', source: 'specialized_org_types' }
    }
    if (specSection.community_action_agency) {
      return { entityType: 'community_action', source: 'specialized_org_types' }
    }
    if (specSection.cdfi) {
      return { entityType: 'cdfi', source: 'specialized_org_types' }
    }
  }

  // Fallback: use display_name hints
  if (profile.display_name) {
    const name = profile.display_name.toLowerCase()
    if (/church|chapel|cathedral|ministry|parish|fellowship/i.test(name)) {
      return { entityType: 'church', source: 'display_name_heuristic' }
    }
    if (/fire|ems|rescue|ambulance/i.test(name)) {
      return { entityType: 'fire_ems', source: 'display_name_heuristic' }
    }
    if (/school district|unified school|elementary|middle school|high school/i.test(name)) {
      return { entityType: 'school', source: 'display_name_heuristic' }
    }
    if (/college|university|institute/i.test(name)) {
      return { entityType: 'college', source: 'display_name_heuristic' }
    }
  }

  return { entityType: 'individual', source: 'default' }
}

// ---------------------------------------------------------------------------
// Extract all flags from profile sections
// ---------------------------------------------------------------------------

function extractEligibilityFlags(profile, profileSections) {
  const flags = new Set()

  // Qualifications section
  const qualSection = readSection(profileSections,
    'general_qualifications', 'qualifications', 'federal_registration')
  if (qualSection) {
    if (safeBool(qualSection.is_501c3) || safeBool(qualSection['501c3'])) flags.add('is_501c3')
    if (safeBool(qualSection.faith_based) || safeBool(qualSection.is_faith_based)) flags.add('faith_based')
    if (safeBool(qualSection.rural) || safeBool(qualSection.is_rural)) flags.add('rural')
    if (safeBool(qualSection.minority_serving) || safeBool(qualSection.is_minority_serving)) {
      flags.add('minority_serving')
    }
    if (safeBool(qualSection.sam_registered) || safeBool(qualSection.in_sam)) flags.add('sam_registered')
    if (safeStr(qualSection.uei_number || qualSection.uei)) flags.add('has_uei')
    if (safeStr(qualSection.ein_number || qualSection.ein)) flags.add('has_ein')
    if (safeStr(qualSection.cage_code || qualSection.cage)) flags.add('has_cage')
  }

  // Federal registration section
  const fedSection = readSection(profileSections, 'federal_registration', 'compliance')
  if (fedSection) {
    if (safeBool(fedSection.sam_registered)) flags.add('sam_registered')
    if (safeStr(fedSection.uei || fedSection.uei_number)) flags.add('has_uei')
  }

  // Compliance / audit
  const auditSection = readSection(profileSections, 'audit_compliance', 'audit', 'compliance_audit')
  if (auditSection) {
    if (safeBool(auditSection.single_audit_required) || safeBool(auditSection.single_audit)) {
      flags.add('single_audit_required')
    }
    if (safeBool(auditSection.nicra)) flags.add('has_nicra')
    if (safeBool(auditSection.hipaa_compliant) || safeBool(auditSection.hipaa)) {
      flags.add('hipaa_compliant')
    }
    if (safeBool(auditSection.ferpa)) flags.add('ferpa_compliant')
  }

  // Business certifications
  const bizSection = readSection(profileSections,
    'business_certifications', 'business', 'small_business_details')
  if (bizSection) {
    if (safeBool(bizSection.sba_certified)) flags.add('sba_certified')
    if (safeBool(bizSection.woman_owned) || safeBool(bizSection.wosb)) flags.add('woman_owned_business')
    if (safeBool(bizSection.minority_owned) || safeBool(bizSection.mbe)) flags.add('minority_owned_business')
    if (safeBool(bizSection.veteran_owned) || safeBool(bizSection.vosb)) flags.add('veteran_owned_business')
    if (safeBool(bizSection.hubzone)) flags.add('hubzone')
    if (safeBool(bizSection.disadvantaged)) flags.add('disadvantaged_business')
  }

  return flags
}

function extractGeographicFlags(profile, profileSections) {
  const flags = new Set()
  const geoSection = readSection(profileSections,
    'geographic_designations', 'geography', 'address')

  if (geoSection) {
    if (safeBool(geoSection.rural) || safeBool(geoSection.is_rural)) flags.add('rural')
    if (safeBool(geoSection.underserved) || safeBool(geoSection.is_underserved)) {
      flags.add('underserved')
    }
    if (safeBool(geoSection.medically_underserved)) flags.add('medically_underserved')
    if (safeBool(geoSection.opportunity_zone)) flags.add('opportunity_zone')
    if (safeBool(geoSection.promise_zone)) flags.add('promise_zone')
    if (safeBool(geoSection.tribal_land)) flags.add('tribal_land')
    if (safeBool(geoSection.hud_qualified)) flags.add('hud_qualified')
  }

  // Check qualifications too
  const qualSection = readSection(profileSections, 'general_qualifications', 'qualifications')
  if (qualSection) {
    if (safeBool(qualSection.rural)) flags.add('rural')
    if (safeBool(qualSection.underserved)) flags.add('underserved')
    if (safeBool(qualSection.tribal)) flags.add('tribal_land')
  }

  // State-level rural designation
  const state = safeStr(profile.state || profile.location_state)
  if (state) flags.add(`state:${state.toUpperCase()}`)

  return flags
}

function extractDemographicFlags(profile, profileSections) {
  const flags = new Set()

  const demoSection = readSection(profileSections, 'demographics', 'demographic_info')
  const familySection = readSection(profileSections, 'family_life', 'family', 'household')

  if (demoSection) {
    if (safeStr(demoSection.ethnicity)) flags.add(`ethnicity:${demoSection.ethnicity.toLowerCase()}`)
    if (safeBool(demoSection.low_income) || safeBool(demoSection.is_low_income)) flags.add('low_income')
    if (safeBool(demoSection.female) || safeStr(demoSection.gender) === 'female') flags.add('female')
    if (safeBool(demoSection.lgbtq) || safeBool(demoSection.lgbtq_identifying)) flags.add('lgbtq')
    if (safeStr(demoSection.age_group)) flags.add(`age_group:${demoSection.age_group}`)
  }

  if (familySection) {
    if (safeBool(familySection.has_children) || Number(familySection.number_of_children) > 0) {
      flags.add('has_children')
    }
    if (safeBool(familySection.single_parent)) flags.add('single_parent')
    if (safeBool(familySection.foster_parent)) flags.add('foster_parent')
  }

  return flags
}

function extractHardshipFlags(profile, profileSections) {
  const flags = new Set()

  const financialSection = readSection(profileSections,
    'financial_situation', 'financial', 'income')
  const govSection = readSection(profileSections, 'government_assistance', 'assistance_programs')
  const emergencySection = readSection(profileSections, 'emergency', 'disaster', 'crisis')
  const housingSection = readSection(profileSections, 'housing', 'shelter')

  if (financialSection) {
    if (safeBool(financialSection.financial_hardship) || safeBool(financialSection.in_hardship)) {
      flags.add('financial_hardship')
    }
    if (safeBool(financialSection.low_income) || safeBool(financialSection.below_poverty)) {
      flags.add('low_income')
    }
    if (safeBool(financialSection.medical_debt) || safeBool(financialSection.has_medical_debt)) {
      flags.add('medical_hardship')
    }
    if (safeBool(financialSection.debt_burden) || safeBool(financialSection.in_debt)) {
      flags.add('debt_burden')
    }
    if (safeBool(financialSection.unable_to_pay_utilities)) flags.add('utility_hardship')
  }

  if (govSection) {
    // Being on government assistance is a hardship indicator
    const assistanceFields = ['medicaid', 'snap', 'tanf', 'ssi', 'ssdi', 'wic', 'section_8']
    for (const field of assistanceFields) {
      if (safeBool(govSection[field]) || safeBool(govSection[`${field}_recipient`])) {
        flags.add('government_assistance_recipient')
        flags.add('low_income') // implied
        break
      }
    }
  }

  if (emergencySection) {
    if (safeBool(emergencySection.has_emergency) || safeBool(emergencySection.in_crisis)) {
      flags.add('in_crisis')
      flags.add('emergency')
    }
    if (safeBool(emergencySection.disaster_affected) || safeBool(emergencySection.fema_eligible)) {
      flags.add('disaster_affected')
      flags.add('in_crisis')
    }
  }

  if (housingSection) {
    if (safeBool(housingSection.housing_instability) || safeBool(housingSection.risk_of_eviction)) {
      flags.add('housing_instability')
    }
    if (safeBool(housingSection.homeless) || safeBool(housingSection.experiencing_homelessness)) {
      flags.add('homeless')
      flags.add('housing_instability')
    }
  }

  // Low budget for org profiles
  const orgSection = readSection(profileSections, 'organization_details', 'organization')
  if (orgSection) {
    const budget = Number(orgSection.annual_budget || orgSection.budget || 0)
    if (budget > 0 && budget < 50000) flags.add('low_budget')
    if (safeBool(orgSection.financial_distress)) flags.add('financial_hardship')
  }

  return flags
}

function extractDisabilityFlags(profile, profileSections) {
  const flags = new Set()

  const healthSection = readSection(profileSections, 'health_medical', 'health', 'medical')
  const disabilitySection = readSection(profileSections, 'disability', 'disabilities')

  if (healthSection) {
    if (safeBool(healthSection.chronic_illness) || safeBool(healthSection.has_chronic_illness)) {
      flags.add('chronic_illness')
    }
    if (safeBool(healthSection.disability) || safeBool(healthSection.has_disability)) {
      flags.add('disability')
    }
    if (safeBool(healthSection.physical_disability)) flags.add('physical_disability')
    if (safeBool(healthSection.developmental_disability)) flags.add('developmental_disability')
    if (safeBool(healthSection.mental_health_condition)) flags.add('mental_health')
    if (safeBool(healthSection.vision_impairment) || safeBool(healthSection.visual_impairment)) {
      flags.add('vision_impairment')
    }
    if (safeBool(healthSection.hearing_impairment)) flags.add('hearing_impairment')
  }

  if (disabilitySection) {
    if (safeBool(disabilitySection.has_disability)) flags.add('disability')
    const disTypes = safeArr(disabilitySection.disability_types || disabilitySection.types)
    for (const t of disTypes) flags.add(`disability_type:${String(t).toLowerCase()}`)
  }

  return flags
}

function extractMilitaryFlags(profile, profileSections) {
  const flags = new Set()
  const milSection = readSection(profileSections, 'military_service', 'military', 'veteran')

  if (milSection) {
    if (safeBool(milSection.veteran) || safeBool(milSection.is_veteran)) flags.add('veteran')
    if (safeBool(milSection.active_duty) || safeBool(milSection.is_active_duty)) {
      flags.add('active_duty')
    }
    if (safeBool(milSection.guard) || safeBool(milSection.national_guard)) flags.add('national_guard')
    if (safeBool(milSection.reserve)) flags.add('reserve')
    if (safeStr(milSection.branch)) flags.add(`branch:${milSection.branch.toLowerCase()}`)
  }

  // Also check root profile fields
  if (safeBool(profile.is_veteran) || safeBool(profile.veteran)) flags.add('veteran')

  return flags
}

function extractOrganizationFlags(profile, profileSections) {
  const flags = new Set()

  const orgSection = readSection(profileSections, 'organization_details', 'organization')
  const specSection = readSection(profileSections, 'specialized_org_types')
  const qualSection = readSection(profileSections, 'general_qualifications')

  if (orgSection) {
    if (safeBool(orgSection.volunteer_organization) || safeBool(orgSection.is_volunteer)) {
      flags.add('volunteer_organization')
    }
    if (safeBool(orgSection.rural_org) || safeBool(orgSection.serves_rural)) flags.add('rural_org')
    if (safeBool(orgSection.historic_building) || safeBool(orgSection.is_historic)) {
      flags.add('historic')
    }
  }

  if (specSection) {
    if (specSection.research_institute) flags.add('research_institute')
    if (specSection.environmental_org || specSection.conservation_org) flags.add('environmental_org')
    if (specSection.labor_union) flags.add('labor_union')
    if (specSection.cooperative) flags.add('cooperative')
    if (specSection.cdfi) flags.add('cdfi')
    if (specSection.housing_authority) flags.add('housing_focused')
    if (specSection.community_action_agency) flags.add('community_action')
  }

  if (qualSection) {
    if (safeBool(qualSection.faith_based)) flags.add('faith_based')
    if (safeBool(qualSection.hbcu) || safeBool(qualSection.is_hbcu)) flags.add('hbcu')
    if (safeBool(qualSection.hsi)) flags.add('hsi')
    if (safeBool(qualSection.tcu)) flags.add('tcu')
    if (safeBool(qualSection.msi)) flags.add('msi')
  }

  return flags
}

function extractFacilityFlags(profile, profileSections) {
  const flags = new Set()

  const orgSection = readSection(profileSections, 'organization_details', 'organization')
  const facilitySection = readSection(profileSections, 'facilities', 'building')

  if (orgSection) {
    if (safeBool(orgSection.historic_building) || safeBool(orgSection.registered_historic)) {
      flags.add('historic')
    }
    if (safeBool(orgSection.needs_accessibility_upgrades)) flags.add('needs_accessibility')
    if (safeBool(orgSection.building_owned)) flags.add('owns_building')
  }

  if (facilitySection) {
    if (safeBool(facilitySection.needs_repair)) flags.add('needs_repair')
    if (safeBool(facilitySection.needs_accessibility)) flags.add('needs_accessibility')
    if (safeBool(facilitySection.is_historic)) flags.add('historic')
  }

  return flags
}

function extractEmergencyFlags(profile, profileSections) {
  const flags = new Set()
  const emergencySection = readSection(profileSections, 'emergency', 'disaster', 'crisis')

  if (emergencySection) {
    if (safeBool(emergencySection.disaster_affected) || safeBool(emergencySection.fema_eligible)) {
      flags.add('disaster_affected')
    }
    if (safeBool(emergencySection.has_emergency)) flags.add('in_crisis')
    if (safeStr(emergencySection.disaster_type)) {
      flags.add(`disaster_type:${emergencySection.disaster_type.toLowerCase()}`)
    }
  }

  return flags
}

function extractStoryKeywords(profile, profileSections) {
  const storySection = readSection(profileSections, 'story', 'narrative', 'background')
  const goalsSection = readSection(profileSections, 'goals', 'funding_goals', 'objectives')
  const keywordsSection = readSection(profileSections, 'keywords', 'tags')

  const texts = [
    safeStr(profile.story),
    safeStr(profile.goals),
    safeStr(profile.funding_ask),
    safeStr(profile.barriers),
    safeStr(profile.keywords),
  ]

  if (storySection) {
    texts.push(safeStr(storySection.story || storySection.narrative || storySection.description))
  }
  if (goalsSection) {
    texts.push(safeStr(goalsSection.goals || goalsSection.objectives || goalsSection.funding_ask))
  }
  if (keywordsSection) {
    const kws = safeArr(keywordsSection.keywords || keywordsSection.tags || [])
    texts.push(...kws.map(k => safeStr(k)))
  }

  return tokenizeText(...texts)
}

function extractExplicitRequestedNeeds(profile, profileSections) {
  const explicit = []

  // funding_ask is the primary explicit need signal
  const fundingAsk = safeStr(profile.funding_ask)
  if (fundingAsk) explicit.push(fundingAsk)

  // goals section
  const goalsSection = readSection(profileSections, 'goals', 'funding_goals')
  if (goalsSection) {
    const goalText = safeStr(goalsSection.goals || goalsSection.funding_ask || goalsSection.purpose)
    if (goalText) explicit.push(goalText)
    const fundingTypes = safeArr(goalsSection.funding_types_needed || goalsSection.needs || [])
    explicit.push(...fundingTypes.map(t => safeStr(t)).filter(Boolean))
  }

  // story section explicit ask
  const storySection = readSection(profileSections, 'story')
  if (storySection) {
    const fundingAskText = safeStr(storySection.funding_ask || storySection.needs_requested)
    if (fundingAskText) explicit.push(fundingAskText)
  }

  return explicit.filter(Boolean)
}

function extractSearchKeywords(profile, profileSections, intel) {
  const keywords = new Set()

  // Add story keywords
  for (const kw of intel.storyKeywords) {
    if (kw.length > 3) keywords.add(kw)
  }

  // Add location
  if (intel.state) keywords.add(intel.state.toLowerCase())
  if (intel.city) keywords.add(intel.city.toLowerCase())

  // Add entity type
  keywords.add(intel.entityType)

  // Add need codes
  for (const need of intel.inferredNeeds ?? []) {
    keywords.add(need.code)
    const def = NEEDS_TAXONOMY[need.code]
    if (def) {
      for (const kw of def.example_search_terms.slice(0, 2)) {
        keywords.add(kw.toLowerCase())
      }
    }
  }

  // Special flags to keywords
  if (intel.geographicFlags.has('rural')) keywords.add('rural')
  if (intel.eligibilityFlags.has('faith_based')) keywords.add('faith-based')
  if (intel.eligibilityFlags.has('is_501c3')) keywords.add('nonprofit 501c3')
  if (intel.isVeteran) keywords.add('veteran')
  if (intel.isStudent) keywords.add('student')

  return Array.from(keywords).filter(k => k.length >= 2)
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a ProfileIntelligence object from raw profile + sections.
 *
 * @param {Object} profile - Raw profile row from DB
 * @param {Object|string} profileSections - Sections JSON (object or JSON string)
 * @returns {ProfileIntelligence}
 */
export function buildProfileIntelligence(profile, profileSections) {
  if (!profile) {
    console.warn('buildProfileIntelligence: null profile provided')
    return null
  }

  // Parse sections if string
  const sections = typeof profileSections === 'string'
    ? (() => { try { return JSON.parse(profileSections) } catch { return {} } })()
    : (profileSections ?? {})

  // Resolve entity type
  const { entityType, source: entityTypeSource } = resolveEntityType(profile, sections)

  // Extract geography
  const state = safeStr(profile.state || profile.location_state || '').toUpperCase() || null
  const zip = safeStr(profile.zip || profile.zipcode || profile.postal_code || '')
  const city = safeStr(profile.city || profile.location_city || '')
  const county = safeStr(profile.county || '')

  // Extract all flag sets
  const eligibilityFlags = extractEligibilityFlags(profile, sections)
  const geographicFlags = extractGeographicFlags(profile, sections)
  const demographicFlags = extractDemographicFlags(profile, sections)
  const hardshipFlags = extractHardshipFlags(profile, sections)
  const disabilityFlags = extractDisabilityFlags(profile, sections)
  const militaryFlags = extractMilitaryFlags(profile, sections)
  const organizationFlags = extractOrganizationFlags(profile, sections)
  const facilityFlags = extractFacilityFlags(profile, sections)
  const emergencyFlags = extractEmergencyFlags(profile, sections)

  // Boolean convenience flags
  const isVeteran = militaryFlags.has('veteran') || safeBool(profile.is_veteran)
  const isStudent = entityType === 'student'
    || ['student', 'individual_student'].includes(safeStr(profile.primary_type).toLowerCase())
    || (() => {
        const eduSection = readSection(sections, 'education', 'academic', 'school_enrollment')
        return eduSection
          ? safeBool(eduSection.currently_enrolled) || safeBool(eduSection.is_student)
          : false
      })()
  const isNonprofit = ['nonprofit', 'church', 'faith_based', 'community_action',
    'library', 'school', 'school_district', 'charter_school', 'college',
    'hospital', 'housing_authority'].includes(entityType) ||
    eligibilityFlags.has('is_501c3')
  const isBusiness = entityType === 'business'
  const isChurch = entityType === 'church'
  const isFireEms = entityType === 'fire_ems'
  const isSchool = ['school', 'school_district', 'charter_school'].includes(entityType)
  const isGovernment = ['government', 'tribal', 'fire_ems', 'housing_authority'].includes(entityType)

  // Story keywords
  const storyKeywords = extractStoryKeywords(profile, sections)
  const explicitRequestedNeeds = extractExplicitRequestedNeeds(profile, sections)

  // Partial intel for inference (before inferredNeeds)
  const partialIntel = {
    id: profile.id,
    entityType,
    entityTypeSource,
    state,
    zip,
    city,
    county,
    eligibilityFlags,
    geographicFlags,
    demographicFlags,
    hardshipFlags,
    disabilityFlags,
    militaryFlags,
    organizationFlags,
    facilityFlags,
    emergencyFlags,
    storyKeywords,
    explicitRequestedNeeds,
    isVeteran,
    isStudent,
    isNonprofit,
    isBusiness,
    isChurch,
    isFireEms,
    isSchool,
    isGovernment,
    displayName: safeStr(profile.display_name || profile.name || ''),
    // Group 11 matcher coverage: surface the 10 demographic/operational fields
    // flagged by admin.code.missionAudit as "missing matcher inputs". Reads
    // stay best-effort (null when absent) so existing profiles don't regress.
    demographics: buildDemographicProfile(profile, sections),
    financialFlags: new Set(hardshipFlags),  // shallow copy – prevents mutation aliasing
  }

  // Infer needs
  const inferredNeeds = inferNeeds(partialIntel)

  // Extract search keywords (after needs inferred)
  const intelWithNeeds = { ...partialIntel, inferredNeeds }
  const searchKeywords = extractSearchKeywords(profile, sections, intelWithNeeds)

  // Compute intelligence fingerprint
  const fingerprint = computeIntelligenceFingerprint(partialIntel, inferredNeeds)

  return {
    ...intelWithNeeds,
    searchKeywords,
    fingerprint,
    builtAt: new Date().toISOString(),
    version: '1.0.0',
  }
}

function computeIntelligenceFingerprint(intel, inferredNeeds) {
  const relevant = {
    entityType: intel.entityType,
    state: intel.state,
    zip: intel.zip,
    isVeteran: intel.isVeteran,
    isStudent: intel.isStudent,
    isNonprofit: intel.isNonprofit,
    isBusiness: intel.isBusiness,
    hardshipFlags: Array.from(intel.hardshipFlags).sort(),
    disabilityFlags: Array.from(intel.disabilityFlags).sort(),
    militaryFlags: Array.from(intel.militaryFlags).sort(),
    eligibilityFlags: Array.from(intel.eligibilityFlags).sort(),
    demographicFlags: Array.from(intel.demographicFlags).sort(),
    geographicFlags: Array.from(intel.geographicFlags).sort(),
    organizationFlags: Array.from(intel.organizationFlags).sort(),
    facilityFlags: Array.from(intel.facilityFlags).sort(),
    emergencyFlags: Array.from(intel.emergencyFlags).sort(),
    topNeeds: Array.isArray(inferredNeeds) ? inferredNeeds.slice(0, 5).map(n => n.code) : [],
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Get a human-readable summary of inferred needs for UI display.
 * Returns an array of { label, confidence, why } objects.
 */
export function getProfileNeedsSummary(intel) {
  if (!intel || !intel.inferredNeeds) return []

  return (intel.inferredNeeds || [])
    .filter(n => n.confidence !== 'low')
    .map(n => {
      const def = NEEDS_TAXONOMY[n.code]
      return {
        code: n.code,
        label: def?.label ?? n.code,
        confidence: n.confidence,
        weight: n.weight,
        why: n.signals.join('; '),
        fact_types: n.fact_types,
      }
    })
}

/**
 * Get entity types that this profile should be eligible for.
 * Returns an array of entity type strings.
 */
export function getEligibleEntityTypes(intel) {
  if (!intel) return []

  const types = [intel.entityType]

  // Add related types
  if (intel.isNonprofit) types.push('nonprofit')
  if (intel.isChurch) types.push('faith_based', 'nonprofit')
  if (intel.isFireEms) types.push('public_safety', 'government')
  if (intel.isSchool) types.push('education', 'k12')
  if (intel.eligibilityFlags.has('is_501c3')) types.push('nonprofit', '501c3')

  return [...new Set(types)]
}
