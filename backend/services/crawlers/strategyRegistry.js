/**
 * strategyRegistry.js
 *
 * Maps each crawler_type to a concrete strategy that controls:
 *   - candidateSources: which datasets to load
 *   - scoringWeights: emphasis adjustments per domain
 *   - hardGates: required intents (profile must have these or strategy is "gated")
 *   - intentBoost: extra score for intent-aligned programs
 *   - negativeRules: anti-match categories to suppress
 *   - urlPolicy: strict (funding only) vs relaxed (directories OK)
 *   - needEmphasis: need categories to prioritise
 */

const STRATEGIES = {
  comprehensive: {
    id: 'comprehensive',
    label: 'Comprehensive Search',
    candidateSources: ['federal', 'state', 'national', 'business', 'scholarships', 'schoolCards', 'prescription', 'senior', 'property_tax', 'utility_assistance'],
    hardGates: [],
    needEmphasis: [],
    intentBoost: {},
    urlPolicy: 'standard',
    maxResults: 100,
    minScore: 25,
  },

  local_funding: {
    id: 'local_funding',
    label: 'Local & State Funding',
    candidateSources: ['state', 'national', 'senior', 'property_tax', 'utility_assistance'],
    hardGates: [],
    needEmphasis: ['housing', 'utilities', 'food', 'cash_assistance', 'childcare', 'transportation', 'property_tax_relief'],
    intentBoost: { locality: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 25,
  },

  government_funding: {
    id: 'government_funding',
    label: 'Government Benefits',
    candidateSources: ['federal', 'state', 'senior', 'property_tax', 'utility_assistance'],
    hardGates: [],
    needEmphasis: ['utilities', 'housing', 'food', 'healthcare', 'cash_assistance', 'disability', 'employment',
      'certification_assistance', 'workforce_training', 'license_reinstatement_support',
      'workforce_reentry_training', 'property_tax_relief'],
    intentBoost: {},
    urlPolicy: 'strict',
    maxResults: 60,
    minScore: 25,
  },

  student_grants: {
    id: 'student_grants',
    label: 'Student Grants & Scholarships',
    // 'state' added so a state-resident student (e.g. TN) also picks up the
    // state's student-aid and benefit portals (TANF/childcare for student
    // parents, state grant offices) — these are state-filtered downstream, so
    // recall rises without cross-state junk. 'scholarships' already carries the
    // state-restricted awards (TN HOPE / TSAA / STEP UP / Aspire / Promise).
    candidateSources: ['federal', 'scholarships', 'state', 'national', 'schoolCards'],
    hardGates: ['education'],
    needEmphasis: ['scholarship', 'education', 'financial_aid', 'living_expenses', 'cost_of_attendance'],
    intentBoost: { education: 20, scholarship: 15, financial_aid: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
  },

  health_resources: {
    id: 'health_resources',
    label: 'Health & Medical Assistance',
    candidateSources: ['federal', 'state', 'national', 'prescription', 'senior'],
    hardGates: ['healthcare'],
    needEmphasis: ['healthcare', 'mental_health', 'disability', 'substance_recovery', 'prescription_assistance'],
    intentBoost: { healthcare: 20, prescription_assistance: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 25,
    categoryFilter: ['healthcare', 'mental_health', 'substance_recovery', 'disability', 'prescription_assistance'],
  },

  special_needs: {
    id: 'special_needs',
    label: 'Special Needs & Disability',
    candidateSources: ['federal', 'state', 'national'],
    hardGates: ['special_needs'],
    needEmphasis: ['disability', 'healthcare'],
    intentBoost: { special_needs: 20 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 25,
    categoryFilter: ['disability', 'healthcare', 'employment', 'transportation', 'housing'],
  },

  ecf_benefits: {
    id: 'ecf_benefits',
    label: 'ECF / CHOICES / Waiver Benefits',
    candidateSources: ['federal', 'state'],
    hardGates: ['special_needs'],
    needEmphasis: ['disability', 'healthcare'],
    intentBoost: { special_needs: 15 },
    urlPolicy: 'standard',
    maxResults: 40,
    minScore: 20,
    categoryFilter: ['disability', 'healthcare'],
  },

  curated_benefits: {
    id: 'curated_benefits',
    label: 'Curated Benefits',
    candidateSources: ['federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: [],
    intentBoost: {},
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 25,
  },

  license_reinstatement: {
    id: 'license_reinstatement',
    label: 'License Reinstatement & Professional Remediation',
    candidateSources: ['federal', 'state', 'national', 'scholarships'],
    hardGates: [],
    needEmphasis: ['license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'workforce_reentry_training', 'employment',
      'education', 'healthcare'],
    intentBoost: { license_reinstatement: 25, healthcare: 15, employment: 15, education: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'workforce_reentry_training', 'employment',
      'education', 'healthcare', 'disability'],
  },

  certification_training: {
    id: 'certification_training',
    label: 'Certification & Training Assistance',
    candidateSources: ['federal', 'state', 'national', 'scholarships'],
    hardGates: [],
    needEmphasis: ['certification_assistance', 'cpr_first_aid_training', 'workforce_training',
      'community_health_training', 'volunteer_training_support', 'employment', 'education',
      'license_reinstatement_support', 'professional_remediation_funding'],
    intentBoost: { employment: 15, education: 15, community_health_training: 20, license_reinstatement: 15 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['certification_assistance', 'cpr_first_aid_training', 'employment',
      'education', 'workforce_training', 'community_health_training', 'volunteer_training_support',
      'healthcare', 'childcare', 'license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'workforce_reentry_training'],
  },

  item_matching: {
    id: 'item_matching',
    label: 'Item / Specific Need Matching',
    candidateSources: ['federal', 'state', 'national', 'business'],
    hardGates: [],
    needEmphasis: [],
    intentBoost: {},
    urlPolicy: 'strict',
    maxResults: 30,
    minScore: 20,
  },

  nonprofit_org: {
    id: 'nonprofit_org',
    label: 'Nonprofit & Community Organization Grants',
    candidateSources: ['federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: ['capacity_building', 'program_funding', 'community_development', 'education', 'healthcare', 'housing'],
    intentBoost: { nonprofit: 20, community: 15, organization: 15 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['capacity_building', 'program_funding', 'community_development', 'education',
      'healthcare', 'housing', 'employment', 'cash_assistance'],
  },

  volunteer_fire: {
    id: 'volunteer_fire',
    label: 'Volunteer Fire & EMS Grants',
    candidateSources: ['volunteer_fire', 'federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: ['equipment', 'certification_assistance', 'volunteer_training_support', 'cpr_first_aid_training'],
    intentBoost: { volunteer_fire: 25, firefighter: 20, ems: 20, certification: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 20,
    categoryFilter: ['equipment', 'certification_assistance', 'volunteer_training_support',
      'cpr_first_aid_training', 'employment', 'community_development'],
  },

  church: {
    id: 'church',
    label: 'Church / Faith-Based Organization',
    profileTypes: ['church', 'faith_based', 'ministry'],
    candidateSources: ['faith_based', 'federal', 'national', 'state'],
    hardGates: [],
    needEmphasis: ['community_services', 'facility_improvement', 'food_pantry', 'capacity_building', 'social_services'],
    intentBoost: { church: 25, faith_based: 20, ministry: 20, community: 10, nonprofit: 5 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['community', 'rural_development', 'facility_improvement', 'social_services',
      'capacity_building', 'food_assistance', 'emergency', 'shelter', 'housing',
      'health', 'mental_health', 'substance_abuse', 'victim_services', 'volunteer',
      'historic_preservation', 'arts', 'culture', 'technology', 'education',
      'environment', 'business'],
  },

  family: {
    id: 'family',
    label: 'Family',
    profileTypes: ['family', 'individual'],
    candidateSources: ['family', 'federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: ['childcare', 'food_assistance', 'family_support', 'health', 'financial_assistance'],
    intentBoost: { family: 25, children: 20, single_parent: 20, childcare: 15, parenting: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 15,
  },

  school: {
    id: 'school',
    label: 'K-12 School / Education Institution',
    profileTypes: ['school', 'k12', 'charter_school', 'private_school'],
    candidateSources: ['school', 'federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: ['academic_support', 'technology', 'professional_development', 'special_education', 'food_service'],
    intentBoost: { school: 25, k12: 20, education: 20, teacher: 15, student: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
  },

  housing_funding: {
    id: 'housing_funding',
    label: 'Housing & Living Expense Funding',
    profileTypes: ['student', 'college_student', 'high_school_student', 'individual', 'family'],
    candidateSources: ['federal', 'state', 'national', 'scholarships', 'faith_based'],
    hardGates: [],
    needEmphasis: ['housing', 'education', 'scholarship', 'living_expenses', 'utilities', 'food'],
    intentBoost: { housing: 25, education: 20, scholarship: 20, living_expenses: 20, faith: 10, music: 10, talent: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 15,
    categoryFilter: ['housing', 'education', 'scholarship', 'financial_aid', 'faith_based', 'talent', 'arts', 'music'],
  },

  // -------------------------------------------------------------------
  // Local government / county / municipality (Phase 4 expansion)
  // -------------------------------------------------------------------
  county_government: {
    id: 'county_government',
    label: 'County Government Funding',
    profileTypes: ['county_government', 'county_official', 'local_government',
      'public_agency', 'regional_planning_agency', 'economic_development_agency'],
    candidateSources: ['federal', 'state', 'national', 'local_government'],
    hardGates: [],
    needEmphasis: ['public_safety', 'infrastructure', 'community_facilities',
      'roads_transportation', 'water_sewer', 'broadband', 'emergency_management',
      'economic_development', 'housing_development', 'environmental_remediation',
      'parks_recreation'],
    intentBoost: { county: 25, local_government: 25, public_safety: 15,
      infrastructure: 15, broadband: 10, emergency_management: 15,
      economic_development: 10, water_sewer: 10, parks_recreation: 5 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['public_safety', 'infrastructure', 'community_facilities',
      'roads_transportation', 'water_sewer', 'broadband', 'emergency_management',
      'economic_development', 'housing_development', 'environmental_remediation',
      'parks_recreation', 'community'],
  },

  municipality: {
    id: 'municipality',
    label: 'Municipality / City Funding',
    profileTypes: ['municipality', 'city', 'town', 'township', 'village',
      'borough', 'local_government', 'public_agency'],
    candidateSources: ['federal', 'state', 'national', 'local_government'],
    hardGates: [],
    needEmphasis: ['public_safety', 'infrastructure', 'community_facilities',
      'parks_recreation', 'water_sewer', 'broadband', 'roads_transportation',
      'economic_development', 'housing_development'],
    intentBoost: { municipality: 25, city: 20, local_government: 20,
      public_safety: 15, infrastructure: 15, parks_recreation: 10,
      community_facilities: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['public_safety', 'infrastructure', 'community_facilities',
      'parks_recreation', 'water_sewer', 'broadband', 'roads_transportation',
      'economic_development', 'housing_development', 'community'],
  },

  public_agency: {
    id: 'public_agency',
    label: 'Public Agency Funding',
    profileTypes: ['public_agency', 'state_agency', 'government_agency'],
    candidateSources: ['federal', 'state', 'national', 'local_government'],
    hardGates: [],
    needEmphasis: ['public_safety', 'infrastructure', 'community_facilities',
      'community', 'health'],
    intentBoost: { public_agency: 20, government: 15, infrastructure: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 20,
  },

  tribal_government: {
    id: 'tribal_government',
    label: 'Tribal Government Funding',
    profileTypes: ['tribal_government', 'tribal', 'indian_tribe', 'tribal_nation'],
    candidateSources: ['federal', 'state', 'national', 'local_government', 'tribal'],
    hardGates: [],
    needEmphasis: ['community_facilities', 'health', 'education', 'public_safety',
      'infrastructure', 'broadband', 'housing_development', 'environmental_remediation',
      'economic_development'],
    intentBoost: { tribal: 25, indian: 20, native_american: 20,
      community_facilities: 15, infrastructure: 10, housing_development: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['community_facilities', 'health', 'education', 'public_safety',
      'infrastructure', 'broadband', 'housing_development', 'environmental_remediation',
      'economic_development', 'community', 'rural'],
  },

  // -------------------------------------------------------------------
  // Teacher / classroom funding (Phase 4 expansion)
  // -------------------------------------------------------------------
  teacher_classroom: {
    id: 'teacher_classroom',
    label: 'Teacher / Classroom Funding',
    profileTypes: ['teacher', 'classroom_teacher', 'educator', 'pta_pto'],
    candidateSources: ['federal', 'state', 'national', 'school', 'classroom'],
    hardGates: [],
    needEmphasis: ['classroom_supplies', 'stem_classroom', 'arts_education',
      'professional_development', 'school_supplies', 'special_education',
      'library_media', 'education'],
    intentBoost: { teacher: 25, classroom: 25, educator: 20, stem: 15,
      arts: 10, professional_development: 10, school_supplies: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 15,
    categoryFilter: ['classroom_supplies', 'stem_classroom', 'arts_education',
      'professional_development', 'school_supplies', 'special_education',
      'library_media', 'education'],
  },

  school_district_department: {
    id: 'school_district_department',
    label: 'School District Department Funding',
    profileTypes: ['school_district', 'public_school', 'special_education_program',
      'school_food_service', 'school_transportation', 'library_media_center'],
    candidateSources: ['federal', 'state', 'national', 'school', 'classroom'],
    hardGates: [],
    needEmphasis: ['special_education', 'school_nutrition', 'school_transportation',
      'library_media', 'classroom_supplies', 'professional_development', 'education'],
    intentBoost: { school_district: 20, special_education: 20, school_nutrition: 15,
      school_transportation: 15, library_media: 15, education: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['special_education', 'school_nutrition', 'school_transportation',
      'library_media', 'classroom_supplies', 'professional_development', 'education',
      'community_facilities'],
  },

  // -------------------------------------------------------------------
  // Public institutions (Phase 4 expansion)
  // -------------------------------------------------------------------
  library: {
    id: 'library',
    label: 'Public Library Funding',
    profileTypes: ['library', 'public_library', 'library_media_center', 'museum'],
    candidateSources: ['federal', 'state', 'national', 'local_government'],
    hardGates: [],
    needEmphasis: ['library_media', 'community_facilities', 'broadband',
      'education', 'community'],
    intentBoost: { library: 25, museum: 15, broadband: 10, education: 10 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 20,
  },

  parks_recreation: {
    id: 'parks_recreation',
    label: 'Parks & Recreation Funding',
    profileTypes: ['parks_department', 'community_center', 'municipality',
      'county_government'],
    candidateSources: ['federal', 'state', 'national', 'local_government'],
    hardGates: [],
    needEmphasis: ['parks_recreation', 'community_facilities', 'community',
      'environmental_remediation'],
    intentBoost: { parks: 25, recreation: 20, community: 10 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 20,
  },

  public_health_department: {
    id: 'public_health_department',
    label: 'Public Health Department Funding',
    profileTypes: ['public_health_department', 'health_department', 'doh',
      'county_health_department', 'local_health_department'],
    candidateSources: ['federal', 'state', 'national', 'local_government'],
    hardGates: [],
    needEmphasis: ['health', 'mental_health', 'substance_recovery', 'community',
      'public_safety', 'environmental_remediation'],
    intentBoost: { public_health: 25, health: 15, mental_health: 10,
      substance_recovery: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['health', 'mental_health', 'substance_recovery', 'community',
      'public_safety', 'environmental_remediation', 'community_facilities'],
  },

  // -------------------------------------------------------------------
  // Specialized nonprofit verticals (Phase 4 expansion)
  // -------------------------------------------------------------------
  animal_rescue: {
    id: 'animal_rescue',
    label: 'Animal Rescue / Welfare Funding',
    profileTypes: ['animal_rescue', 'animal_shelter', 'animal_welfare', 'humane_society'],
    candidateSources: ['federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: ['animal_welfare', 'capacity_building', 'community', 'equipment'],
    intentBoost: { animal: 25, rescue: 20, shelter: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 15,
  },

  food_pantry: {
    id: 'food_pantry',
    label: 'Food Pantry / Hunger Relief Funding',
    profileTypes: ['food_pantry', 'food_bank', 'food_shelf', 'soup_kitchen'],
    candidateSources: ['federal', 'state', 'national', 'faith_based'],
    hardGates: [],
    needEmphasis: ['food', 'community', 'capacity_building', 'equipment'],
    intentBoost: { food: 25, hunger: 20, pantry: 20 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 15,
  },

  homeless_services: {
    id: 'homeless_services',
    label: 'Homeless / Shelter Services Funding',
    profileTypes: ['homeless_shelter', 'shelter', 'transitional_housing',
      'domestic_violence_shelter', 'reentry_program'],
    candidateSources: ['federal', 'state', 'national', 'faith_based'],
    hardGates: [],
    needEmphasis: ['housing', 'housing_development', 'mental_health', 'community',
      'substance_recovery', 'public_safety'],
    intentBoost: { homeless: 25, shelter: 20, housing: 20, transitional: 15 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 15,
  },
};

/**
 * Get a strategy by crawler_type. Falls back to comprehensive.
 */
export function getStrategy(crawlerType) {
  return STRATEGIES[crawlerType] || STRATEGIES.comprehensive;
}

/**
 * Check whether a strategy's hard gates are satisfied by profile intents.
 * Returns { gated: false } if OK, or { gated: true, reason } if blocked.
 */
/**
 * Check whether a strategy's hard gates are satisfied by profile intents.
 * A strategy is gated only when EVERY hard gate is missing from the profile.
 * If at least one gate is present, the strategy proceeds (partial match is
 * better than full suppression — final decisions belong to computeMatchDecision).
 * Returns { gated: false } if OK, or { gated: true, reason, missingGates } if blocked.
 *
 * Goals served: 3 (legitimate hard-reject only), 5 (intent set from full profile),
 *               7 (recall over suppression), 8 (reason logged for observability).
 */
/**
 * Check whether a strategy's hard gates are satisfied by profile intents.
 * Returns { gated: false } if OK, or { gated: true, reason, missingGates } if blocked.
 *
 * IMPORTANT: gated:true means the STRATEGY is skipped at the crawler/pipeline level.
 * Per-opportunity filtering remains the responsibility of relevanceFilter and
 * computeMatchDecision (Goals 3, 4). This gate is ONLY applied when the profile
 * has NO signal whatsoever for the strategy domain AND the intents Set is non-empty
 * (i.e., the profile was actually evaluated — an empty intents Set means the profile
 * was not fully processed and gating must be skipped to avoid suppressing due to
 * incomplete extraction).
 *
 * Goals served: 3, 5, 7, 8.
 */
export function checkGates(strategy, intents) {
  if (!strategy.hardGates || strategy.hardGates.length === 0) {
    return { gated: false };
  }

  // If the intents Set is empty, the profile may not have been fully extracted.
  // Do NOT gate on an empty profile — surface results so the user can see options
  // and improve their profile (Goals 7, 10).
  if (!intents || intents.size === 0) {
    return { gated: false };
  }

  const missingGates = strategy.hardGates.filter(gate => !intents.has(gate));

  // Only gate when ALL required intents are absent AND the profile has other intents
  // (proving the profile was evaluated but genuinely lacks this domain).
  // Defer final eligibility judgment to the match engine for all per-opportunity decisions.
  if (missingGates.length === strategy.hardGates.length) {
    const reason =
      `Strategy "${strategy.id}" requires at least one of [${strategy.hardGates.join(', ')}] ` +
      `but profile has none. Profile intents: [${[...intents].join(', ')}]. ` +
      `Strategy skipped — per-opportunity filtering remains with relevanceFilter/computeMatchDecision (Goals 3, 4, 7).`;
    return {
      gated: true,
      missingGates,
      reason,
    };
  }

  return { gated: false };
}

/**
 * List all available strategies.
 */
export function listStrategies() {
  return Object.values(STRATEGIES).map(s => ({
    id: s.id,
    label: s.label,
    hardGates: s.hardGates,
  }));
}

/**
 * Returns true only if the decision engine's score meets the strategy floor.
 * MUST be called AFTER computeMatchDecision() — never before.
 * Using this as a pre-engine filter violates Goals 4 and 7.
 */
export function meetsMinScore(strategy, engineScore) {
  if (typeof engineScore !== 'number') return true; // unknown score â do not suppress (Goal 7)
  return engineScore >= (strategy.minScore ?? 0);
}

export default { getStrategy, checkGates, listStrategies, meetsMinScore, STRATEGIES };
