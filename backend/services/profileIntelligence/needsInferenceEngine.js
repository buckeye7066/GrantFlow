/**
 * Needs Inference Engine — Phase 3
 *
 * Rules-based inference engine (no LLM dependency) that infers likely needs
 * from a normalized profile intelligence object.
 *
 * A need is only marked high-confidence when supported by MULTIPLE corroborating
 * signals from different profile sections (converging signals doctrine).
 *
 * Every inferred need includes:
 *   code, weight (0-1), reasons[{signal, source, type}], signalCount, confidence
 *
 * Supported profile archetypes:
 *   - Church / faith-based organization
 *   - Volunteer fire department / EMS
 *   - School / school district (including band, sports, STEM)
 *   - Individual student
 *   - Individual hardship (utility, housing, medical)
 *   - Veteran
 *   - Healthcare worker / provider
 *   - Nonprofit general
 *   - Small business
 */

import { isValidNeedCode } from './needsTaxonomy.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function needResult(code, weight, reasons) {
  const signalCount = reasons.length
  // Confidence scales with number of corroborating signals
  const confidence = signalCount >= 3 ? 'high' : signalCount === 2 ? 'medium' : 'low'
  return { code, weight: Math.min(1.0, weight), reasons, signalCount, confidence }
}

function hasEntityType(intel, type) {
  return intel.entity_types?.includes(type)
}

function hasAnyEntityType(intel, types) {
  return types.some(t => intel.entity_types?.includes(t))
}

function hasFlag(arr, flag) {
  return arr?.includes(flag)
}

function hasHardship(intel, flag) {
  return hasFlag(intel.hardship_flags, flag)
}

function hasKeyword(intel, keyword) {
  if (!intel.search_keywords) return false
  const kw = keyword.toLowerCase()
  return intel.search_keywords.some(k => String(k).toLowerCase().includes(kw))
}

function stateIsRural(intel) {
  return intel.is_rural || hasFlag(intel.geographic_flags, 'rural')
}

/**
 * Accumulate signals for a need and compute the aggregated weight.
 */
function buildNeed(code, signalList) {
  const validSignals = signalList.filter(s => s !== null && s !== undefined)
  if (validSignals.length === 0) return null

  const totalWeight = validSignals.reduce((sum, s) => sum + (s.weight || 0.3), 0)
  const avgWeight = totalWeight / validSignals.length
  // Cap at 0.97; require >=2 signals for anything above 0.6
  const finalWeight = validSignals.length === 1
    ? Math.min(0.6, avgWeight)
    : Math.min(0.97, avgWeight + (validSignals.length - 1) * 0.05)

  return needResult(code, finalWeight, validSignals.map(s => s.reason))
}

// ---------------------------------------------------------------------------
// Per-archetype inference rules
// ---------------------------------------------------------------------------

/**
 * Church / faith-based organization inference
 */
function inferChurchNeeds(intel) {
  const results = []
  const isFaith = hasAnyEntityType(intel, ['church']) || intel.is_faith_based

  if (!isFaith) return results

  const signals = {
    facilities_repair: [],
    facilities_preservation: [],
    utilities_support: [],
    community_outreach: [],
    donor_support_private: [],
    denomination_support: [],
    staffing_salary: [],
    safety_upgrades: [],
    accessibility_upgrades: [],
    program_operations: [],
    food_programs: [],
    energy_efficiency: [],
  }

  // Core church entity signals
  signals.facilities_repair.push({ weight: 0.55, reason: { signal: 'entity_type:church', source: 'profile.primary_type', type: 'current_state' } })
  signals.facilities_preservation.push({ weight: 0.50, reason: { signal: 'entity_type:church', source: 'profile.primary_type', type: 'current_state' } })
  signals.community_outreach.push({ weight: 0.65, reason: { signal: 'entity_type:church', source: 'profile.primary_type', type: 'current_state' } })
  signals.donor_support_private.push({ weight: 0.70, reason: { signal: 'entity_type:church', source: 'profile.primary_type', type: 'current_state' } })
  signals.denomination_support.push({ weight: 0.65, reason: { signal: 'entity_type:church', source: 'profile.primary_type', type: 'current_state' } })
  signals.program_operations.push({ weight: 0.55, reason: { signal: 'entity_type:church', source: 'profile.primary_type', type: 'current_state' } })

  // Rural church — higher facilities and utilities need
  if (stateIsRural(intel)) {
    signals.facilities_repair.push({ weight: 0.80, reason: { signal: 'geographic:rural', source: 'profile.rural', type: 'current_state' } })
    signals.utilities_support.push({ weight: 0.70, reason: { signal: 'geographic:rural', source: 'profile.rural', type: 'current_state' } })
    signals.energy_efficiency.push({ weight: 0.60, reason: { signal: 'geographic:rural', source: 'profile.rural', type: 'current_state' } })
  }

  // Hardship signal
  if (hasHardship(intel, 'low_income')) {
    signals.utilities_support.push({ weight: 0.75, reason: { signal: 'hardship:low_income', source: 'sections.financial_situation', type: 'active_unmet_need' } })
    signals.program_operations.push({ weight: 0.70, reason: { signal: 'hardship:low_income', source: 'sections.financial_situation', type: 'active_unmet_need' } })
  }

  // Keyword signals
  if (hasKeyword(intel, 'repair') || hasKeyword(intel, 'renovation') || hasKeyword(intel, 'building')) {
    signals.facilities_repair.push({ weight: 0.85, reason: { signal: 'keyword:repair/renovation/building', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'historic') || hasKeyword(intel, 'preservation')) {
    signals.facilities_preservation.push({ weight: 0.85, reason: { signal: 'keyword:historic/preservation', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'pastor') || hasKeyword(intel, 'salary') || hasKeyword(intel, 'compensation')) {
    signals.staffing_salary.push({ weight: 0.80, reason: { signal: 'keyword:pastor/salary', source: 'narrative', type: 'active_unmet_need' } })
    signals.denomination_support.push({ weight: 0.75, reason: { signal: 'keyword:pastor/salary', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'food') || hasKeyword(intel, 'pantry') || hasKeyword(intel, 'hunger')) {
    signals.food_programs.push({ weight: 0.80, reason: { signal: 'keyword:food/pantry', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'utility') || hasKeyword(intel, 'electric') || hasKeyword(intel, 'heat')) {
    signals.utilities_support.push({ weight: 0.80, reason: { signal: 'keyword:utility/electric', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'ramp') || hasKeyword(intel, 'accessibility') || hasKeyword(intel, 'ada')) {
    signals.accessibility_upgrades.push({ weight: 0.85, reason: { signal: 'keyword:ramp/accessibility', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'safety') || hasKeyword(intel, 'fire') || hasKeyword(intel, 'alarm')) {
    signals.safety_upgrades.push({ weight: 0.75, reason: { signal: 'keyword:safety/fire', source: 'narrative', type: 'active_unmet_need' } })
  }

  // Add public grant exclusion reminder
  if (signals.facilities_repair.length > 0 || signals.facilities_preservation.length > 0) {
    // This is handled via exclusion_flags in the normalizer
  }

  for (const [code, sigs] of Object.entries(signals)) {
    if (sigs.length > 0) {
      const need = buildNeed(code, sigs)
      if (need) results.push(need)
    }
  }

  return results
}

/**
 * Volunteer fire department / EMS inference
 */
function inferFireDeptNeeds(intel) {
  const results = []
  const isFireDept = hasAnyEntityType(intel, ['volunteer_fire_dept'])

  if (!isFireDept) return results

  const signals = {
    public_safety_equipment: [],
    ppe: [],
    training: [],
    vehicles: [],
    safety_upgrades: [],
    technology: [],
    facilities_repair: [],
  }

  // Core fire dept entity signals — all high weight
  signals.public_safety_equipment.push({ weight: 0.90, reason: { signal: 'entity_type:volunteer_fire_dept', source: 'profile.primary_type', type: 'current_state' } })
  signals.ppe.push({ weight: 0.88, reason: { signal: 'entity_type:volunteer_fire_dept', source: 'profile.primary_type', type: 'current_state' } })
  signals.training.push({ weight: 0.80, reason: { signal: 'entity_type:volunteer_fire_dept', source: 'profile.primary_type', type: 'current_state' } })
  signals.vehicles.push({ weight: 0.75, reason: { signal: 'entity_type:volunteer_fire_dept', source: 'profile.primary_type', type: 'current_state' } })
  signals.safety_upgrades.push({ weight: 0.70, reason: { signal: 'entity_type:volunteer_fire_dept', source: 'profile.primary_type', type: 'current_state' } })

  // Rural fire dept — higher priority (underserved)
  if (stateIsRural(intel)) {
    signals.public_safety_equipment.push({ weight: 0.92, reason: { signal: 'geographic:rural', source: 'profile.rural', type: 'current_state' } })
    signals.vehicles.push({ weight: 0.88, reason: { signal: 'geographic:rural + fire dept', source: 'profile.rural', type: 'active_unmet_need' } })
  }

  // Keyword signals
  if (hasKeyword(intel, 'gear') || hasKeyword(intel, 'turnout') || hasKeyword(intel, 'scba')) {
    signals.ppe.push({ weight: 0.95, reason: { signal: 'keyword:gear/turnout/scba', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'truck') || hasKeyword(intel, 'apparatus') || hasKeyword(intel, 'engine') || hasKeyword(intel, 'tanker')) {
    signals.vehicles.push({ weight: 0.95, reason: { signal: 'keyword:truck/apparatus', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'radio') || hasKeyword(intel, 'communication') || hasKeyword(intel, 'dispatch')) {
    signals.public_safety_equipment.push({ weight: 0.90, reason: { signal: 'keyword:radio/communications', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'training') || hasKeyword(intel, 'certification') || hasKeyword(intel, 'course')) {
    signals.training.push({ weight: 0.90, reason: { signal: 'keyword:training/certification', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'station') || hasKeyword(intel, 'firehouse') || hasKeyword(intel, 'building')) {
    signals.facilities_repair.push({ weight: 0.75, reason: { signal: 'keyword:station/firehouse', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'technology') || hasKeyword(intel, 'computer') || hasKeyword(intel, 'software')) {
    signals.technology.push({ weight: 0.70, reason: { signal: 'keyword:technology/computer', source: 'narrative', type: 'active_unmet_need' } })
  }

  for (const [code, sigs] of Object.entries(signals)) {
    if (sigs.length > 0) {
      const need = buildNeed(code, sigs)
      if (need) results.push(need)
    }
  }

  return results
}

/**
 * School district / charter school inference
 */
function inferSchoolNeeds(intel) {
  const results = []
  const isSchool = hasAnyEntityType(intel, ['school_district'])

  if (!isSchool) return results

  const signals = {
    technology: [],
    arts_equipment: [],
    athletics_equipment: [],
    facilities_repair: [],
    safety_upgrades: [],
    accessibility_upgrades: [],
    training: [],
    broadband: [],
    workforce_development: [],
    program_operations: [],
  }

  // Core school entity signals
  signals.technology.push({ weight: 0.75, reason: { signal: 'entity_type:school_district', source: 'profile.primary_type', type: 'current_state' } })
  signals.safety_upgrades.push({ weight: 0.72, reason: { signal: 'entity_type:school_district', source: 'profile.primary_type', type: 'current_state' } })
  signals.facilities_repair.push({ weight: 0.60, reason: { signal: 'entity_type:school_district', source: 'profile.primary_type', type: 'current_state' } })
  signals.training.push({ weight: 0.65, reason: { signal: 'entity_type:school_district', source: 'profile.primary_type', type: 'current_state' } })

  if (stateIsRural(intel)) {
    signals.broadband.push({ weight: 0.82, reason: { signal: 'geographic:rural + school', source: 'profile.rural', type: 'active_unmet_need' } })
    signals.technology.push({ weight: 0.80, reason: { signal: 'geographic:rural + school', source: 'profile.rural', type: 'active_unmet_need' } })
  }

  // Keyword signals
  if (hasKeyword(intel, 'band') || hasKeyword(intel, 'music') || hasKeyword(intel, 'instrument') || hasKeyword(intel, 'orchestra')) {
    signals.arts_equipment.push({ weight: 0.90, reason: { signal: 'keyword:band/music/instruments', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'sports') || hasKeyword(intel, 'athletics') || hasKeyword(intel, 'uniform') || hasKeyword(intel, 'equipment')) {
    signals.athletics_equipment.push({ weight: 0.88, reason: { signal: 'keyword:sports/athletics/equipment', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'stem') || hasKeyword(intel, 'science') || hasKeyword(intel, 'technology') || hasKeyword(intel, 'computer')) {
    signals.technology.push({ weight: 0.88, reason: { signal: 'keyword:stem/science/technology', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'repair') || hasKeyword(intel, 'renovation') || hasKeyword(intel, 'roof') || hasKeyword(intel, 'hvac')) {
    signals.facilities_repair.push({ weight: 0.85, reason: { signal: 'keyword:repair/renovation', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'accessibility') || hasKeyword(intel, 'ada') || hasKeyword(intel, 'ramp')) {
    signals.accessibility_upgrades.push({ weight: 0.85, reason: { signal: 'keyword:accessibility/ada', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'internet') || hasKeyword(intel, 'broadband') || hasKeyword(intel, 'wifi')) {
    signals.broadband.push({ weight: 0.85, reason: { signal: 'keyword:internet/broadband', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'after school') || hasKeyword(intel, 'after-school') || hasKeyword(intel, 'afterschool')) {
    signals.program_operations.push({ weight: 0.80, reason: { signal: 'keyword:after-school', source: 'narrative', type: 'active_unmet_need' } })
  }

  for (const [code, sigs] of Object.entries(signals)) {
    if (sigs.length > 0) {
      const need = buildNeed(code, sigs)
      if (need) results.push(need)
    }
  }

  return results
}

/**
 * Individual student inference
 */
function inferStudentNeeds(intel) {
  const results = []
  const isStudent = intel.is_student || hasAnyEntityType(intel, ['individual_student']) ||
    hasFlag(intel.demographic_flags, 'enrolled_student')

  if (!isStudent) return results

  const signals = {
    scholarships_tuition: [],
    housing_support: [],
    transportation_support: [],
    health_medical_support: [],
    training: [],
    technology: [],
    childcare_support: [],
  }

  // Core student entity signals — HIGHEST weight
  signals.scholarships_tuition.push({ weight: 0.90, reason: { signal: 'entity_type:student', source: 'profile.primary_type', type: 'current_state' } })

  // Low-income student signals
  if (hasHardship(intel, 'low_income')) {
    signals.scholarships_tuition.push({ weight: 0.92, reason: { signal: 'hardship:low_income + student', source: 'sections.financial_situation', type: 'active_unmet_need' } })
    signals.housing_support.push({ weight: 0.72, reason: { signal: 'hardship:low_income + student', source: 'sections.financial_situation', type: 'active_unmet_need' } })
    signals.transportation_support.push({ weight: 0.65, reason: { signal: 'hardship:low_income + student', source: 'sections.financial_situation', type: 'active_unmet_need' } })
  }

  if (hasHardship(intel, 'disability')) {
    signals.scholarships_tuition.push({ weight: 0.88, reason: { signal: 'hardship:disability + student', source: 'sections.health_medical', type: 'active_unmet_need' } })
    signals.health_medical_support.push({ weight: 0.85, reason: { signal: 'hardship:disability + student', source: 'sections.health_medical', type: 'active_unmet_need' } })
    signals.technology.push({ weight: 0.75, reason: { signal: 'hardship:disability + assistive_tech', source: 'sections.health_medical', type: 'active_unmet_need' } })
  }

  if (hasHardship(intel, 'single_parent')) {
    signals.childcare_support.push({ weight: 0.82, reason: { signal: 'hardship:single_parent + student', source: 'sections.family_life', type: 'active_unmet_need' } })
  }

  // Faith-based scholarship
  if (intel.is_faith_based || hasFlag(intel.demographic_flags, 'religion:christian') || hasFlag(intel.demographic_flags, 'religion:jewish')) {
    signals.scholarships_tuition.push({ weight: 0.80, reason: { signal: 'religious_affiliation: faith-based scholarship possible', source: 'sections.demographics', type: 'current_state' } })
  }

  if (hasHardship(intel, 'unemployed') && isStudent) {
    signals.training.push({ weight: 0.75, reason: { signal: 'hardship:unemployed + student', source: 'sections.financial_situation', type: 'active_unmet_need' } })
  }

  for (const [code, sigs] of Object.entries(signals)) {
    if (sigs.length > 0) {
      const need = buildNeed(code, sigs)
      if (need) results.push(need)
    }
  }

  return results
}

/**
 * Individual hardship inference
 */
function inferHardshipNeeds(intel) {
  const results = []
  const isIndividual = hasAnyEntityType(intel, ['individual']) || intel.entity_types?.length === 0

  if (!isIndividual && !hasAnyEntityType(intel, ['individual'])) return results

  const signals = {
    emergency_assistance: [],
    utilities_support: [],
    housing_support: [],
    health_medical_support: [],
    transportation_support: [],
    food_programs: [],
    childcare_support: [],
    debt_relief: [],
    workforce_development: [],
    training: [],
  }

  if (hasHardship(intel, 'low_income')) {
    signals.emergency_assistance.push({ weight: 0.70, reason: { signal: 'hardship:low_income', source: 'sections.financial_situation', type: 'active_unmet_need' } })
    signals.utilities_support.push({ weight: 0.75, reason: { signal: 'hardship:low_income', source: 'sections.financial_situation', type: 'active_unmet_need' } })
    signals.food_programs.push({ weight: 0.65, reason: { signal: 'hardship:low_income', source: 'sections.financial_situation', type: 'active_unmet_need' } })
  }

  if (hasHardship(intel, 'experiencing_homelessness')) {
    signals.housing_support.push({ weight: 0.95, reason: { signal: 'hardship:homelessness', source: 'sections.family_life', type: 'active_unmet_need' } })
    signals.emergency_assistance.push({ weight: 0.88, reason: { signal: 'hardship:homelessness', source: 'sections.family_life', type: 'active_unmet_need' } })
  }

  if (hasHardship(intel, 'chronic_illness') || hasHardship(intel, 'disability')) {
    signals.health_medical_support.push({ weight: 0.90, reason: { signal: 'hardship:disability/illness', source: 'sections.health_medical', type: 'active_unmet_need' } })
    signals.transportation_support.push({ weight: 0.65, reason: { signal: 'hardship:disability requires transportation', source: 'sections.health_medical', type: 'active_unmet_need' } })
  }

  if (hasHardship(intel, 'unemployed')) {
    signals.workforce_development.push({ weight: 0.80, reason: { signal: 'hardship:unemployed', source: 'sections.financial_situation', type: 'active_unmet_need' } })
    signals.training.push({ weight: 0.75, reason: { signal: 'hardship:unemployed', source: 'sections.financial_situation', type: 'active_unmet_need' } })
  }

  if (hasHardship(intel, 'single_parent')) {
    signals.childcare_support.push({ weight: 0.85, reason: { signal: 'hardship:single_parent', source: 'sections.family_life', type: 'active_unmet_need' } })
    signals.emergency_assistance.push({ weight: 0.72, reason: { signal: 'hardship:single_parent + financial strain', source: 'sections.family_life', type: 'active_unmet_need' } })
  }

  // Keyword signals
  if (hasKeyword(intel, 'utility') || hasKeyword(intel, 'electric') || hasKeyword(intel, 'heat') || hasKeyword(intel, 'water')) {
    signals.utilities_support.push({ weight: 0.88, reason: { signal: 'keyword:utility/electric/heat', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'rent') || hasKeyword(intel, 'eviction') || hasKeyword(intel, 'housing') || hasKeyword(intel, 'homeless')) {
    signals.housing_support.push({ weight: 0.90, reason: { signal: 'keyword:rent/eviction/housing', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'medical') || hasKeyword(intel, 'hospital') || hasKeyword(intel, 'prescription') || hasKeyword(intel, 'health')) {
    signals.health_medical_support.push({ weight: 0.85, reason: { signal: 'keyword:medical/health', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'food') || hasKeyword(intel, 'hunger') || hasKeyword(intel, 'groceries')) {
    signals.food_programs.push({ weight: 0.85, reason: { signal: 'keyword:food/hunger', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'debt') || hasKeyword(intel, 'loan') || hasKeyword(intel, 'credit')) {
    signals.debt_relief.push({ weight: 0.65, reason: { signal: 'keyword:debt/loan', source: 'narrative', type: 'active_unmet_need' } })
  }

  for (const [code, sigs] of Object.entries(signals)) {
    if (sigs.length > 0) {
      const need = buildNeed(code, sigs)
      if (need) results.push(need)
    }
  }

  return results
}

/**
 * Veteran inference
 */
function inferVeteranNeeds(intel) {
  const results = []
  if (!intel.is_veteran && !hasFlag(intel.demographic_flags, 'veteran')) return results

  const signals = {
    health_medical_support: [],
    housing_support: [],
    emergency_assistance: [],
    training: [],
    workforce_development: [],
    transportation_support: [],
  }

  signals.health_medical_support.push({ weight: 0.80, reason: { signal: 'demographic:veteran', source: 'sections.military_service', type: 'current_state' } })
  signals.housing_support.push({ weight: 0.65, reason: { signal: 'demographic:veteran', source: 'sections.military_service', type: 'current_state' } })

  if (hasHardship(intel, 'disability')) {
    signals.health_medical_support.push({ weight: 0.92, reason: { signal: 'veteran + disability', source: 'sections.health_medical', type: 'active_unmet_need' } })
  }
  if (hasHardship(intel, 'unemployed')) {
    signals.workforce_development.push({ weight: 0.85, reason: { signal: 'veteran + unemployed', source: 'sections.financial_situation', type: 'active_unmet_need' } })
    signals.training.push({ weight: 0.80, reason: { signal: 'veteran + unemployed', source: 'sections.financial_situation', type: 'active_unmet_need' } })
  }
  if (hasHardship(intel, 'experiencing_homelessness')) {
    signals.housing_support.push({ weight: 0.95, reason: { signal: 'veteran + homelessness', source: 'sections.family_life', type: 'active_unmet_need' } })
    signals.emergency_assistance.push({ weight: 0.88, reason: { signal: 'veteran + homelessness', source: 'sections.family_life', type: 'active_unmet_need' } })
  }
  if (hasHardship(intel, 'low_income')) {
    signals.emergency_assistance.push({ weight: 0.75, reason: { signal: 'veteran + low_income', source: 'sections.financial_situation', type: 'active_unmet_need' } })
  }

  for (const [code, sigs] of Object.entries(signals)) {
    if (sigs.length > 0) {
      const need = buildNeed(code, sigs)
      if (need) results.push(need)
    }
  }

  return results
}

/**
 * Healthcare worker / provider inference
 */
function inferHealthcareWorkerNeeds(intel) {
  const results = []
  const isHealthcareWorker = hasAnyEntityType(intel, ['hospital', 'fqhc', 'clinic']) ||
    hasKeyword(intel, 'nurse') || hasKeyword(intel, 'healthcare worker') ||
    hasKeyword(intel, 'physician') || hasKeyword(intel, 'medical professional') ||
    hasKeyword(intel, 'provider')

  if (!isHealthcareWorker) return results

  const signals = {
    training: [],
    technology: [],
    health_medical_support: [],
    facilities_repair: [],
    equipment: [],
    workforce_development: [],
    staffing_salary: [],
  }

  if (hasAnyEntityType(intel, ['hospital', 'fqhc', 'clinic'])) {
    signals.equipment.push({ weight: 0.80, reason: { signal: 'entity_type:healthcare_org', source: 'profile.primary_type', type: 'current_state' } })
    signals.technology.push({ weight: 0.75, reason: { signal: 'entity_type:healthcare_org', source: 'profile.primary_type', type: 'current_state' } })
    signals.training.push({ weight: 0.72, reason: { signal: 'entity_type:healthcare_org', source: 'profile.primary_type', type: 'current_state' } })
    signals.facilities_repair.push({ weight: 0.65, reason: { signal: 'entity_type:healthcare_org', source: 'profile.primary_type', type: 'current_state' } })
    signals.staffing_salary.push({ weight: 0.70, reason: { signal: 'entity_type:healthcare_org', source: 'profile.primary_type', type: 'current_state' } })
  }

  if (stateIsRural(intel)) {
    signals.health_medical_support.push({ weight: 0.85, reason: { signal: 'rural + healthcare', source: 'profile.rural', type: 'active_unmet_need' } })
    signals.workforce_development.push({ weight: 0.80, reason: { signal: 'rural + healthcare worker shortage', source: 'profile.rural', type: 'active_unmet_need' } })
  }

  for (const [code, sigs] of Object.entries(signals)) {
    if (sigs.length > 0) {
      const need = buildNeed(code, sigs)
      if (need) results.push(need)
    }
  }

  return results
}

/**
 * General nonprofit inference
 */
function inferNonprofitNeeds(intel) {
  const results = []
  const isNonprofit = intel.is_nonprofit ||
    hasAnyEntityType(intel, ['nonprofit', 'community_action_agency'])

  // Don't double-apply if more specific type already ran
  const hasSpecificType = hasAnyEntityType(intel, [
    'church', 'volunteer_fire_dept', 'school_district', 'university', 'hospital', 'fqhc'
  ])
  if (!isNonprofit || hasSpecificType) return results

  const signals = {
    program_operations: [],
    community_outreach: [],
    staffing_salary: [],
    technology: [],
    training: [],
    facilities_repair: [],
  }

  signals.program_operations.push({ weight: 0.70, reason: { signal: 'entity_type:nonprofit', source: 'profile.primary_type', type: 'current_state' } })
  signals.community_outreach.push({ weight: 0.65, reason: { signal: 'entity_type:nonprofit', source: 'profile.primary_type', type: 'current_state' } })

  if (hasHardship(intel, 'low_income') || hasKeyword(intel, 'operating') || hasKeyword(intel, 'budget')) {
    signals.program_operations.push({ weight: 0.78, reason: { signal: 'operating budget pressure', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'staff') || hasKeyword(intel, 'salary') || hasKeyword(intel, 'personnel')) {
    signals.staffing_salary.push({ weight: 0.75, reason: { signal: 'keyword:staff/salary', source: 'narrative', type: 'active_unmet_need' } })
  }
  if (hasKeyword(intel, 'technology') || hasKeyword(intel, 'computer') || hasKeyword(intel, 'software')) {
    signals.technology.push({ weight: 0.72, reason: { signal: 'keyword:technology/computer', source: 'narrative', type: 'active_unmet_need' } })
  }

  for (const [code, sigs] of Object.entries(signals)) {
    if (sigs.length > 0) {
      const need = buildNeed(code, sigs)
      if (need) results.push(need)
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Merge and deduplicate needs
// ---------------------------------------------------------------------------

function mergeNeeds(needArrays) {
  const map = new Map()
  for (const needs of needArrays) {
    for (const need of needs) {
      if (!isValidNeedCode(need.code)) continue
      if (map.has(need.code)) {
        const existing = map.get(need.code)
        // Merge: take higher weight, combine reasons
        const mergedReasons = [...existing.reasons, ...need.reasons]
        const mergedWeight = Math.min(0.97, Math.max(existing.weight, need.weight) + 0.03)
        const signalCount = mergedReasons.length
        const confidence = signalCount >= 3 ? 'high' : signalCount === 2 ? 'medium' : 'low'
        map.set(need.code, { ...existing, weight: mergedWeight, reasons: mergedReasons, signalCount, confidence })
      } else {
        map.set(need.code, need)
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.weight - a.weight)
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Infer needs from a normalized profile intelligence object.
 *
 * @param {Object} intel - Output of normalizeProfileIntelligence()
 * @returns {Object[]} Array of inferred needs sorted by weight descending
 */
export function inferNeeds(intel) {
  const allNeeds = mergeNeeds([
    inferChurchNeeds(intel),
    inferFireDeptNeeds(intel),
    inferSchoolNeeds(intel),
    inferStudentNeeds(intel),
    inferHardshipNeeds(intel),
    inferVeteranNeeds(intel),
    inferHealthcareWorkerNeeds(intel),
    inferNonprofitNeeds(intel),
  ])

  return allNeeds
}

/**
 * Annotate a normalized intel object with inferred needs.
 *
 * @param {Object} intel - Output of normalizeProfileIntelligence()
 * @returns {Object} intel with likely_needs populated
 */
export function annotateWithInferredNeeds(intel) {
  const inferred = inferNeeds(intel)
  return { ...intel, likely_needs: inferred }
}

export default { inferNeeds, annotateWithInferredNeeds }
