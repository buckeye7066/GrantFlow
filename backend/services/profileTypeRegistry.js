/**
 * profileTypeRegistry.js
 *
 * THE single canonical registry of profile types GrantFlow supports.
 *
 * Mission rule (goal #5): "Let the system evolve as new profile types,
 * needs, and funding categories appear." Before this module the contract
 * for "what is a profile type" was scattered across:
 *
 *   - profileSignals/index.js          (intent extraction)
 *   - profileTaxonomy.js               (display labels)
 *   - applicationSchema.json           (form options)
 *   - strategyRegistry.js              (per-type strategy)
 *   - sourceRegistry.js                (per-type source plan)
 *   - queryPlanner.js                  (per-type keyword recipes)
 *
 * That made it brittle to add new types (e.g. county_government,
 * classroom_teacher). This file centralises the contract:
 *
 *   { id, aliases, parentTypes, defaultNeeds, requiredProfileFields,
 *     recommendedSources, recommendedStrategy, anyaLabel, summary }
 *
 * Anything that needs to know "what does this profile type mean" — Anya,
 * crawlers, query planner, signal extraction, source registry — should
 * resolve through this registry instead of pattern-matching strings in
 * its own file.
 *
 * Pure / data-driven: no DB, no network, no I/O. Safe to import anywhere.
 */

import { SOURCE_IDS } from './sourceRegistry.js'

/**
 * Each profile-type entry is the contract that lets the rest of the
 * system reason about a profile by id rather than by ad-hoc keyword
 * matching:
 *
 *   id                    canonical id (snake_case)
 *   aliases               input variants users / forms / legacy data may use
 *   parentTypes           broader categories this type rolls up to (used
 *                         when a downstream consumer only knows the parent)
 *   defaultNeeds          starter set of needs to feed the matcher when the
 *                         profile has no explicit needs declared yet
 *   requiredProfileFields fields that must be present to plan a useful
 *                         crawl (used by Anya to ask the right next-step
 *                         question; never used to suppress results)
 *   recommendedSources    SOURCE_IDS values that should always survive
 *                         filtering for this type (mission rule: directory
 *                         and verticals must always survive)
 *   recommendedStrategy   strategyRegistry id the dispatcher should pick
 *                         when no other signal forces a different strategy
 *   anyaLabel             human-readable label Anya uses when narrating
 *   summary               short admin/dashboard description
 */
export const PROFILE_TYPES = Object.freeze({
  // ---------------------------------------------------------------------
  // People & households
  // ---------------------------------------------------------------------
  individual: {
    id: 'individual',
    aliases: ['person', 'individual_adult', 'adult', 'low_income_individual'],
    parentTypes: [],
    defaultNeeds: ['food', 'utilities', 'housing', 'health'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.COMMUNITY_ACTION,
      SOURCE_IDS.LIHEAP,
      SOURCE_IDS.SNAP,
      SOURCE_IDS.MEDICAID,
      SOURCE_IDS.HRSA_HEALTH_CENTERS,
    ],
    recommendedStrategy: 'comprehensive',
    anyaLabel: 'Individual',
    summary: 'Single adult seeking benefits, assistance, or grants.',
  },
  family: {
    id: 'family',
    aliases: ['household', 'family_with_children', 'single_parent_household'],
    parentTypes: ['individual'],
    defaultNeeds: ['food', 'utilities', 'housing', 'childcare', 'health'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.COMMUNITY_ACTION,
      SOURCE_IDS.LIHEAP,
      SOURCE_IDS.SNAP,
      SOURCE_IDS.FEEDING_AMERICA,
    ],
    recommendedStrategy: 'family',
    anyaLabel: 'Family / household',
    summary: 'Family or household with one or more dependents.',
  },
  homeschool_family: {
    id: 'homeschool_family',
    aliases: ['homeschool', 'homeschooling_family', 'home_school_family', 'home_education'],
    parentTypes: ['family', 'individual'],
    defaultNeeds: ['education', 'curriculum', 'scholarship', 'stem_classroom'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS,
      SOURCE_IDS.SCHOLARSHIP_DIRECTORY,
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.COMMUNITY_ACTION,
    ],
    recommendedStrategy: 'family',
    anyaLabel: 'Homeschool family',
    summary: 'Family educating children at home, seeking curriculum, ESA, and education funding.',
  },
  senior: {
    id: 'senior',
    aliases: ['older_adult', 'elderly'],
    parentTypes: ['individual'],
    defaultNeeds: ['food', 'utilities', 'health', 'housing', 'transportation'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.COMMUNITY_ACTION,
      SOURCE_IDS.LIHEAP,
      SOURCE_IDS.MEDICAID,
    ],
    recommendedStrategy: 'comprehensive',
    anyaLabel: 'Senior / older adult',
    summary: 'Older adult eligible for benefits and senior-specific programs.',
  },
  veteran: {
    id: 'veteran',
    aliases: ['us_veteran', 'military_veteran'],
    parentTypes: ['individual'],
    defaultNeeds: ['health', 'housing', 'employment', 'mental_health'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.HRSA_HEALTH_CENTERS,
      SOURCE_IDS.HOMELESS_SERVICES_GRANTS,
    ],
    recommendedStrategy: 'comprehensive',
    anyaLabel: 'Veteran',
    summary: 'US veteran seeking VA-related and supportive services.',
  },
  disabled_adult: {
    id: 'disabled_adult',
    aliases: ['adult_with_disability', 'person_with_disability'],
    parentTypes: ['individual'],
    defaultNeeds: ['health', 'housing', 'transportation', 'employment'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.MEDICAID,
      SOURCE_IDS.HRSA_HEALTH_CENTERS,
    ],
    recommendedStrategy: 'special_needs',
    anyaLabel: 'Adult with disability',
    summary: 'Adult with one or more disabilities seeking accommodations and assistance.',
  },
  medical_need: {
    id: 'medical_need',
    aliases: [
      'medical_assistance',
      'medical',
      'health_profile',
      'medical_profile',
      'patient_assistance',
      'medical_hardship',
    ],
    parentTypes: ['individual', 'family'],
    defaultNeeds: ['health', 'medical_bills', 'medication', 'transportation', 'caregiving'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.HRSA_HEALTH_CENTERS,
      SOURCE_IDS.MEDICAID,
      SOURCE_IDS.MENTAL_HEALTH_NONPROFIT_GRANTS,
      SOURCE_IDS.COMMUNITY_ACTION,
    ],
    recommendedStrategy: 'comprehensive',
    anyaLabel: 'Medical / health need',
    summary: 'Person or family with active medical, disability, or caregiving funding needs.',
  },

  // ---------------------------------------------------------------------
  // Students
  // ---------------------------------------------------------------------
  student: {
    id: 'student',
    aliases: ['scholar', 'student_general'],
    parentTypes: ['individual'],
    defaultNeeds: ['scholarship', 'education', 'housing'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS,
      SOURCE_IDS.SCHOLARSHIP_DIRECTORY,
      SOURCE_IDS.PELL_GRANT,
      SOURCE_IDS.ED_GOV_FAFSA,
    ],
    recommendedStrategy: 'student_grants',
    anyaLabel: 'Student',
    summary: 'Student seeking scholarships, financial aid, and education funding.',
  },
  high_school_student: {
    id: 'high_school_student',
    aliases: ['hs_student', 'high_schooler', '12th_grader', '11th_grader', '10th_grader', '9th_grader'],
    parentTypes: ['student', 'individual'],
    defaultNeeds: ['scholarship', 'college_prep', 'fafsa', 'first_gen'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS,
      SOURCE_IDS.SCHOLARSHIP_DIRECTORY,
      SOURCE_IDS.PELL_GRANT,
      SOURCE_IDS.ED_GOV_FAFSA,
    ],
    recommendedStrategy: 'student_grants',
    anyaLabel: 'High school student',
    summary: 'Grades 9-12 student preparing for college and seeking scholarships / FAFSA / Pell.',
  },
  college_student: {
    id: 'college_student',
    aliases: ['undergraduate', 'undergrad', 'college_undergraduate', 'university_student'],
    parentTypes: ['student', 'individual'],
    defaultNeeds: ['scholarship', 'tuition', 'housing', 'textbooks', 'fafsa'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS,
      SOURCE_IDS.SCHOLARSHIP_DIRECTORY,
      SOURCE_IDS.PELL_GRANT,
      SOURCE_IDS.ED_GOV_FAFSA,
    ],
    recommendedStrategy: 'student_grants',
    anyaLabel: 'College / undergraduate student',
    summary: 'Undergraduate seeking scholarships, FAFSA / Pell, housing, and textbook aid.',
  },
  graduate_student: {
    id: 'graduate_student',
    aliases: ['grad_student', 'masters_student', 'phd_student', 'doctoral_student', 'professional_student'],
    parentTypes: ['student', 'individual'],
    defaultNeeds: ['fellowship', 'research_funding', 'tuition', 'stipend'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS,
      SOURCE_IDS.SCHOLARSHIP_DIRECTORY,
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.ED_GOV_FAFSA,
    ],
    recommendedStrategy: 'student_grants',
    anyaLabel: 'Graduate student',
    summary: 'Master\u2019s, PhD, or professional school student seeking fellowships and research funding.',
  },

  // ---------------------------------------------------------------------
  // Businesses
  // ---------------------------------------------------------------------
  business: {
    id: 'business',
    aliases: ['small_business', 'small_business_owner'],
    parentTypes: [],
    defaultNeeds: ['business', 'startup'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.SBA_GRANTS,
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.STATE_PORTAL,
      SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT,
    ],
    recommendedStrategy: 'comprehensive',
    anyaLabel: 'Small business',
    summary: 'Small business looking for grants and startup capital.',
  },
  minority_owned_business: {
    id: 'minority_owned_business',
    aliases: ['mbe', 'minority_business'],
    parentTypes: ['business'],
    defaultNeeds: ['business', 'startup'],
    requiredProfileFields: ['state'],
    recommendedSources: [SOURCE_IDS.MINORITY_BUSINESS_DEV, SOURCE_IDS.SBA_GRANTS, SOURCE_IDS.GRANTS_GOV],
    recommendedStrategy: 'comprehensive',
    anyaLabel: 'Minority-owned business',
    summary: 'Minority-owned business looking for MBDA, SBA, and minority-set-aside funding.',
  },
  women_owned_business: {
    id: 'women_owned_business',
    aliases: ['wbe', 'wosb'],
    parentTypes: ['business'],
    defaultNeeds: ['business', 'startup'],
    requiredProfileFields: ['state'],
    recommendedSources: [SOURCE_IDS.WOMEN_OWNED_BUSINESS, SOURCE_IDS.SBA_GRANTS, SOURCE_IDS.GRANTS_GOV],
    recommendedStrategy: 'comprehensive',
    anyaLabel: 'Women-owned business',
    summary: 'Women-owned business looking for WOSB, SBA, and women\'s grant funding.',
  },

  // ---------------------------------------------------------------------
  // Faith / nonprofit / community organizations
  // ---------------------------------------------------------------------
  nonprofit: {
    id: 'nonprofit',
    aliases: ['nonprofit_org', '501c3', 'charity'],
    parentTypes: [],
    defaultNeeds: ['capacity_building', 'program_funding', 'community'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.STATE_PORTAL,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
      SOURCE_IDS.FOUNDATION_LOCATOR,
    ],
    recommendedStrategy: 'nonprofit_org',
    anyaLabel: 'Nonprofit organization',
    summary: 'Nonprofit (501c3) seeking general program and capacity funding.',
  },
  church: {
    id: 'church',
    aliases: ['parish', 'congregation', 'faith_based', 'synagogue', 'mosque', 'temple'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['community', 'food', 'housing'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.FAITH_BASED_GRANTS,
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.STATE_PORTAL,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
    ],
    recommendedStrategy: 'church',
    anyaLabel: 'Church',
    summary: 'Church or congregation seeking faith-based and community grants.',
  },
  ministry: {
    id: 'ministry',
    aliases: ['mission', 'outreach_ministry'],
    parentTypes: ['church', 'nonprofit'],
    defaultNeeds: ['community', 'food', 'housing'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.FAITH_BASED_GRANTS,
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.STATE_PORTAL,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
    ],
    recommendedStrategy: 'church',
    anyaLabel: 'Ministry',
    summary: 'Ministry or outreach program seeking faith-based grants.',
  },

  // ---------------------------------------------------------------------
  // Public safety
  // ---------------------------------------------------------------------
  volunteer_fire_department: {
    id: 'volunteer_fire_department',
    aliases: ['vfd', 'volunteer_fire', 'fire_department', 'ems', 'rescue_squad', 'fire_company'],
    parentTypes: ['nonprofit', 'public_agency'],
    defaultNeeds: ['equipment', 'training', 'public_safety'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.FEMA_AFG,
      SOURCE_IDS.NATIONAL_VOLUNTEER_FIRE_COUNCIL,
      SOURCE_IDS.RURAL_FIRE_GRANTS,
      SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES,
      SOURCE_IDS.STATE_EMERGENCY_MANAGEMENT,
    ],
    recommendedStrategy: 'volunteer_fire',
    anyaLabel: 'Volunteer fire / EMS department',
    summary: 'Volunteer fire department or EMS agency seeking equipment, training, and operational grants.',
  },

  // ---------------------------------------------------------------------
  // Local government / county / municipal / public agency
  // ---------------------------------------------------------------------
  county_government: {
    id: 'county_government',
    aliases: ['county', 'county_official', 'county_administration', 'county_commission'],
    parentTypes: ['local_government', 'public_agency'],
    defaultNeeds: ['public_safety', 'infrastructure', 'community_facilities', 'emergency_management'],
    requiredProfileFields: ['state', 'county_or_zip'],
    recommendedSources: [
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
      SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
      SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES,
      SOURCE_IDS.FEMA_PUBLIC_ASSISTANCE,
      SOURCE_IDS.FEMA_HAZARD_MITIGATION,
      SOURCE_IDS.CDBG_STATE_LOCAL,
      SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT,
      SOURCE_IDS.DOT_TRANSPORTATION_GRANTS,
      SOURCE_IDS.EPA_WATER_INFRASTRUCTURE,
      SOURCE_IDS.BROADBAND_GRANTS,
      SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS,
      SOURCE_IDS.STATE_EMERGENCY_MANAGEMENT,
    ],
    recommendedStrategy: 'county_government',
    anyaLabel: 'County government',
    summary: 'County government seeking infrastructure, public safety, and community-facility grants.',
  },
  municipality: {
    id: 'municipality',
    aliases: ['city', 'town', 'township', 'village', 'borough', 'city_government', 'town_government'],
    parentTypes: ['local_government', 'public_agency'],
    defaultNeeds: ['public_safety', 'infrastructure', 'community_facilities', 'parks_recreation'],
    requiredProfileFields: ['state', 'county_or_zip'],
    recommendedSources: [
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
      SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
      SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES,
      SOURCE_IDS.FEMA_PUBLIC_ASSISTANCE,
      SOURCE_IDS.CDBG_STATE_LOCAL,
      SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT,
      SOURCE_IDS.DOT_TRANSPORTATION_GRANTS,
      SOURCE_IDS.EPA_WATER_INFRASTRUCTURE,
      SOURCE_IDS.BROADBAND_GRANTS,
      SOURCE_IDS.PARKS_RECREATION_GRANTS,
      SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS,
    ],
    recommendedStrategy: 'municipality',
    anyaLabel: 'Municipality / city / town',
    summary: 'Incorporated municipality seeking infrastructure, parks, and community-facility grants.',
  },
  local_government: {
    id: 'local_government',
    aliases: ['special_district', 'special_district_government'],
    parentTypes: ['public_agency'],
    defaultNeeds: ['public_safety', 'infrastructure', 'community_facilities'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
      SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
      SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS,
      SOURCE_IDS.STATE_EMERGENCY_MANAGEMENT,
    ],
    recommendedStrategy: 'county_government',
    anyaLabel: 'Local government',
    summary: 'Generic local government / special district.',
  },
  public_agency: {
    id: 'public_agency',
    aliases: ['government_agency', 'state_agency'],
    parentTypes: [],
    defaultNeeds: ['public_safety', 'infrastructure', 'community_facilities'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
      SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
      SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS,
    ],
    recommendedStrategy: 'public_agency',
    anyaLabel: 'Public agency',
    summary: 'Public agency or government department.',
  },
  regional_planning_agency: {
    id: 'regional_planning_agency',
    aliases: ['mpo', 'metropolitan_planning_organization', 'cog', 'council_of_governments'],
    parentTypes: ['public_agency', 'local_government'],
    defaultNeeds: ['infrastructure', 'roads_transportation', 'economic_development'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.DOT_TRANSPORTATION_GRANTS,
      SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
    ],
    recommendedStrategy: 'county_government',
    anyaLabel: 'Regional planning agency',
    summary: 'MPO / COG / regional planning organization.',
  },
  economic_development_agency: {
    id: 'economic_development_agency',
    aliases: ['eda_agency', 'economic_development_authority'],
    parentTypes: ['public_agency'],
    defaultNeeds: ['economic_development', 'infrastructure', 'broadband'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT,
      SOURCE_IDS.CDBG_STATE_LOCAL,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
    ],
    recommendedStrategy: 'county_government',
    anyaLabel: 'Economic development agency',
    summary: 'County or regional economic-development authority.',
  },
  tribal_government: {
    id: 'tribal_government',
    aliases: ['tribe', 'tribal', 'indian_tribe', 'native_american_tribe', 'tribal_nation'],
    parentTypes: ['local_government', 'public_agency'],
    defaultNeeds: ['community_facilities', 'health', 'education', 'public_safety', 'infrastructure'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.TRIBAL_GOVERNMENT_GRANTS,
      SOURCE_IDS.BIA_TRIBAL_PROGRAMS,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
      SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES,
      SOURCE_IDS.FEMA_PUBLIC_ASSISTANCE,
      SOURCE_IDS.BROADBAND_GRANTS,
    ],
    recommendedStrategy: 'tribal_government',
    anyaLabel: 'Tribal government',
    summary: 'Federally / state-recognized tribal government.',
  },

  // ---------------------------------------------------------------------
  // Schools / education institutions / teachers
  // ---------------------------------------------------------------------
  school: {
    id: 'school',
    aliases: ['k12', 'k_12', 'elementary_school', 'middle_school', 'high_school', 'private_school', 'charter_school'],
    parentTypes: [],
    defaultNeeds: ['classroom_supplies', 'stem_classroom', 'special_education', 'professional_development'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.USED_DEPT_OF_ED,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS,
    ],
    recommendedStrategy: 'school',
    anyaLabel: 'K-12 school',
    summary: 'K-12 school (public, charter, or private) seeking program funding.',
  },
  public_school: {
    id: 'public_school',
    aliases: ['public_k12', 'district_school'],
    parentTypes: ['school'],
    defaultNeeds: ['classroom_supplies', 'stem_classroom', 'special_education',
      'school_nutrition', 'professional_development'],
    requiredProfileFields: ['state', 'school_district'],
    recommendedSources: [
      SOURCE_IDS.USED_DEPT_OF_ED,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
      SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS,
      SOURCE_IDS.SPECIAL_EDUCATION_GRANTS,
      SOURCE_IDS.SCHOOL_NUTRITION_GRANTS,
      SOURCE_IDS.LIBRARY_GRANTS,
    ],
    recommendedStrategy: 'school',
    anyaLabel: 'Public K-12 school',
    summary: 'Public K-12 school seeking program, classroom, and federal funding.',
  },
  school_district: {
    id: 'school_district',
    aliases: ['district', 'school_district_office', 'lea', 'local_education_agency'],
    parentTypes: ['public_school', 'public_agency'],
    defaultNeeds: ['classroom_supplies', 'stem_classroom', 'special_education',
      'school_nutrition', 'school_transportation', 'professional_development'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.USED_DEPT_OF_ED,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
      SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.SPECIAL_EDUCATION_GRANTS,
      SOURCE_IDS.SCHOOL_NUTRITION_GRANTS,
      SOURCE_IDS.SCHOOL_TRANSPORTATION_GRANTS,
      SOURCE_IDS.BROADBAND_GRANTS,
    ],
    recommendedStrategy: 'school_district_department',
    anyaLabel: 'School district / LEA',
    summary: 'Local education agency / district central office.',
  },
  pta_pto: {
    id: 'pta_pto',
    aliases: ['pta', 'pto', 'parent_teacher_organization', 'parent_teacher_association'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['classroom_supplies', 'arts_education', 'stem_classroom'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.PTO_PTA_GRANTS,
      SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS,
      SOURCE_IDS.DONORSCHOOSE_OR_EQUIVALENT,
    ],
    recommendedStrategy: 'teacher_classroom',
    anyaLabel: 'PTA / PTO',
    summary: 'School parent organization seeking classroom enrichment grants.',
  },
  teacher: {
    id: 'teacher',
    aliases: ['k12_teacher', 'school_teacher'],
    parentTypes: ['educator'],
    defaultNeeds: ['classroom_supplies', 'stem_classroom', 'arts_education', 'professional_development'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.TEACHER_CLASSROOM_GRANTS,
      SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS,
      SOURCE_IDS.DONORSCHOOSE_OR_EQUIVALENT,
      SOURCE_IDS.NEA_FOUNDATION,
      SOURCE_IDS.TOSHIBA_AMERICA_FOUNDATION,
      SOURCE_IDS.PTO_PTA_GRANTS,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
    ],
    recommendedStrategy: 'teacher_classroom',
    anyaLabel: 'Teacher',
    summary: 'Individual K-12 teacher seeking classroom funding.',
  },
  classroom_teacher: {
    id: 'classroom_teacher',
    aliases: ['classroom_educator'],
    parentTypes: ['teacher', 'educator'],
    defaultNeeds: ['classroom_supplies', 'stem_classroom', 'arts_education'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.TEACHER_CLASSROOM_GRANTS,
      SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS,
      SOURCE_IDS.DONORSCHOOSE_OR_EQUIVALENT,
      SOURCE_IDS.NEA_FOUNDATION,
      SOURCE_IDS.TOSHIBA_AMERICA_FOUNDATION,
      SOURCE_IDS.PTO_PTA_GRANTS,
    ],
    recommendedStrategy: 'teacher_classroom',
    anyaLabel: 'Classroom teacher',
    summary: 'Classroom teacher seeking direct supply and STEM/arts grants.',
  },
  educator: {
    id: 'educator',
    aliases: ['paraeducator', 'school_staff', 'instructional_coach'],
    parentTypes: [],
    defaultNeeds: ['professional_development', 'classroom_supplies', 'education'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.NEA_FOUNDATION,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
      SOURCE_IDS.TEACHER_CLASSROOM_GRANTS,
    ],
    recommendedStrategy: 'teacher_classroom',
    anyaLabel: 'Educator',
    summary: 'Educator (teacher, coach, paraeducator) seeking classroom and PD funding.',
  },
  special_education_program: {
    id: 'special_education_program',
    aliases: ['sped', 'special_ed', 'idea_program'],
    parentTypes: ['public_school', 'school_district'],
    defaultNeeds: ['special_education', 'disability', 'classroom_supplies'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.SPECIAL_EDUCATION_GRANTS,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
      SOURCE_IDS.USED_DEPT_OF_ED,
    ],
    recommendedStrategy: 'school_district_department',
    anyaLabel: 'Special education program',
    summary: 'IDEA-funded special education program at a public school or district.',
  },
  school_food_service: {
    id: 'school_food_service',
    aliases: ['food_services', 'school_nutrition', 'lunch_program'],
    parentTypes: ['public_school', 'school_district'],
    defaultNeeds: ['school_nutrition', 'food', 'community_facilities'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.SCHOOL_NUTRITION_GRANTS,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
      SOURCE_IDS.USED_DEPT_OF_ED,
    ],
    recommendedStrategy: 'school_district_department',
    anyaLabel: 'School food service',
    summary: 'School-district food service / nutrition department.',
  },
  school_transportation: {
    id: 'school_transportation',
    aliases: ['student_transportation', 'school_bus_program'],
    parentTypes: ['public_school', 'school_district'],
    defaultNeeds: ['school_transportation', 'roads_transportation', 'environmental_remediation'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.SCHOOL_TRANSPORTATION_GRANTS,
      SOURCE_IDS.DOT_TRANSPORTATION_GRANTS,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
    ],
    recommendedStrategy: 'school_district_department',
    anyaLabel: 'School transportation',
    summary: 'School-district transportation / school bus program.',
  },
  library_media_center: {
    id: 'library_media_center',
    aliases: ['school_library', 'lmc'],
    parentTypes: ['public_school', 'library'],
    defaultNeeds: ['library_media', 'classroom_supplies', 'broadband', 'education'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.LIBRARY_GRANTS,
      SOURCE_IDS.IMLS_LIBRARY_MUSEUM,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
    ],
    recommendedStrategy: 'school_district_department',
    anyaLabel: 'Library / media center',
    summary: 'School library / library-media center.',
  },

  // ---------------------------------------------------------------------
  // Public institutions
  // ---------------------------------------------------------------------
  library: {
    id: 'library',
    aliases: ['public_library', 'county_library'],
    parentTypes: ['public_agency'],
    defaultNeeds: ['library_media', 'community_facilities', 'broadband', 'education'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.LIBRARY_GRANTS,
      SOURCE_IDS.IMLS_LIBRARY_MUSEUM,
      SOURCE_IDS.BROADBAND_GRANTS,
      SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS,
    ],
    recommendedStrategy: 'library',
    anyaLabel: 'Public library',
    summary: 'Public library seeking literacy, broadband, and facility grants.',
  },
  museum: {
    id: 'museum',
    aliases: ['historical_museum', 'art_museum'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['arts_education', 'community_facilities', 'community'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.IMLS_LIBRARY_MUSEUM,
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
    ],
    recommendedStrategy: 'nonprofit_org',
    anyaLabel: 'Museum',
    summary: 'Museum or historical society seeking arts/culture funding.',
  },
  parks_department: {
    id: 'parks_department',
    aliases: ['parks_recreation_department', 'parks_and_rec'],
    parentTypes: ['public_agency', 'local_government'],
    defaultNeeds: ['parks_recreation', 'community_facilities', 'community'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.PARKS_RECREATION_GRANTS,
      SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
    ],
    recommendedStrategy: 'parks_recreation',
    anyaLabel: 'Parks & recreation department',
    summary: 'Municipal or county parks and recreation department.',
  },
  community_center: {
    id: 'community_center',
    aliases: ['neighborhood_center', 'civic_center'],
    parentTypes: ['nonprofit', 'public_agency'],
    defaultNeeds: ['community_facilities', 'community', 'parks_recreation'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.PARKS_RECREATION_GRANTS,
      SOURCE_IDS.CDBG_STATE_LOCAL,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
    ],
    recommendedStrategy: 'parks_recreation',
    anyaLabel: 'Community center',
    summary: 'Neighborhood community center seeking facility and program funding.',
  },
  public_health_department: {
    id: 'public_health_department',
    aliases: ['health_department', 'doh', 'county_health_department', 'local_health_department'],
    parentTypes: ['public_agency', 'local_government'],
    defaultNeeds: ['health', 'mental_health', 'substance_recovery', 'community'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.PUBLIC_HEALTH_DEPT_GRANTS,
      SOURCE_IDS.HRSA_HEALTH_CENTERS,
      SOURCE_IDS.OPIOID_SETTLEMENT_RESOURCES,
      SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
    ],
    recommendedStrategy: 'public_health_department',
    anyaLabel: 'Public health department',
    summary: 'Local or county public health department.',
  },
  local_housing_authority: {
    id: 'local_housing_authority',
    aliases: ['housing_authority', 'phra', 'public_housing_authority'],
    parentTypes: ['public_agency', 'local_government'],
    defaultNeeds: ['housing', 'housing_development', 'community_facilities'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.CDBG_STATE_LOCAL,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
      SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
    ],
    recommendedStrategy: 'county_government',
    anyaLabel: 'Local housing authority',
    summary: 'Public housing authority or housing-development agency.',
  },

  // ---------------------------------------------------------------------
  // Specialized nonprofit verticals
  // ---------------------------------------------------------------------
  animal_rescue: {
    id: 'animal_rescue',
    aliases: ['animal_shelter', 'animal_welfare', 'humane_society'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['animal_welfare', 'capacity_building', 'community'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.ANIMAL_RESCUE_GRANTS,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
      SOURCE_IDS.FOUNDATION_LOCATOR,
    ],
    recommendedStrategy: 'animal_rescue',
    anyaLabel: 'Animal rescue / shelter',
    summary: 'Animal rescue, shelter, or humane society.',
  },
  food_pantry: {
    id: 'food_pantry',
    aliases: ['food_bank', 'food_shelf', 'soup_kitchen'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['food', 'community', 'capacity_building'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.FOOD_PANTRY_NETWORK,
      SOURCE_IDS.FEEDING_AMERICA,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
      SOURCE_IDS.FAITH_BASED_GRANTS,
    ],
    recommendedStrategy: 'food_pantry',
    anyaLabel: 'Food pantry / food bank',
    summary: 'Food pantry, food bank, or hunger-relief program.',
  },
  homeless_shelter: {
    id: 'homeless_shelter',
    aliases: ['shelter', 'emergency_shelter', 'transitional_housing'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['housing', 'housing_development', 'mental_health', 'community'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.HOMELESS_SERVICES_GRANTS,
      SOURCE_IDS.CDBG_STATE_LOCAL,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
      SOURCE_IDS.FAITH_BASED_GRANTS,
    ],
    recommendedStrategy: 'homeless_services',
    anyaLabel: 'Homeless shelter',
    summary: 'Emergency or transitional shelter for people experiencing homelessness.',
  },
  domestic_violence_shelter: {
    id: 'domestic_violence_shelter',
    aliases: ['dv_shelter', 'family_violence_shelter'],
    parentTypes: ['nonprofit', 'homeless_shelter'],
    defaultNeeds: ['housing', 'mental_health', 'community', 'public_safety'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.DOMESTIC_VIOLENCE_SHELTER_GRANTS,
      SOURCE_IDS.HOMELESS_SERVICES_GRANTS,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
    ],
    recommendedStrategy: 'homeless_services',
    anyaLabel: 'Domestic-violence shelter',
    summary: 'Shelter / advocacy program for domestic-violence survivors.',
  },
  reentry_program: {
    id: 'reentry_program',
    aliases: ['second_chance_program', 'reintegration_program'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['workforce', 'employment', 'housing', 'mental_health'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.REENTRY_PROGRAM_GRANTS,
      SOURCE_IDS.HOMELESS_SERVICES_GRANTS,
      SOURCE_IDS.COF_FOUNDATION_LOCATOR,
    ],
    recommendedStrategy: 'nonprofit_org',
    anyaLabel: 'Reentry program',
    summary: 'Reentry / second-chance program for justice-involved adults.',
  },
  substance_recovery_org: {
    id: 'substance_recovery_org',
    aliases: ['recovery_program', 'sud_program'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['substance_recovery', 'mental_health', 'health'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.SUBSTANCE_RECOVERY_NONPROFIT_GRANTS,
      SOURCE_IDS.OPIOID_SETTLEMENT_RESOURCES,
      SOURCE_IDS.MENTAL_HEALTH_NONPROFIT_GRANTS,
    ],
    recommendedStrategy: 'nonprofit_org',
    anyaLabel: 'Substance recovery organization',
    summary: 'Nonprofit substance use / recovery program.',
  },
  mental_health_nonprofit: {
    id: 'mental_health_nonprofit',
    aliases: ['behavioral_health_nonprofit', 'mh_nonprofit'],
    parentTypes: ['nonprofit'],
    defaultNeeds: ['mental_health', 'health', 'community'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.MENTAL_HEALTH_NONPROFIT_GRANTS,
      SOURCE_IDS.SUBSTANCE_RECOVERY_NONPROFIT_GRANTS,
      SOURCE_IDS.OPIOID_SETTLEMENT_RESOURCES,
    ],
    recommendedStrategy: 'nonprofit_org',
    anyaLabel: 'Mental health nonprofit',
    summary: 'Mental health / behavioral health nonprofit.',
  },

  // ---------------------------------------------------------------------
  // Catch-all
  // ---------------------------------------------------------------------
  other: {
    id: 'other',
    aliases: ['unspecified', 'unknown', 'other_profile'],
    parentTypes: [],
    defaultNeeds: ['community', 'general'],
    requiredProfileFields: ['state'],
    recommendedSources: [
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.COMMUNITY_ACTION,
      SOURCE_IDS.GRANTS_GOV,
    ],
    recommendedStrategy: 'comprehensive',
    anyaLabel: 'Other',
    summary: 'Profile that does not fit a named type — matched comprehensively.',
  },
})

/**
 * Build a one-shot lookup table from id + every alias to the canonical id.
 * Built lazily and frozen so consumers never mutate it.
 */
let ALIAS_INDEX = null
function getAliasIndex() {
  if (ALIAS_INDEX) return ALIAS_INDEX
  const index = new Map()
  for (const entry of Object.values(PROFILE_TYPES)) {
    index.set(normalize(entry.id), entry.id)
    for (const alias of entry.aliases || []) {
      const key = normalize(alias)
      if (!index.has(key)) index.set(key, entry.id)
    }
  }
  ALIAS_INDEX = index
  return index
}

function normalize(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9_]/g, '_')
}

/**
 * Resolve any user-supplied profile-type string (id, alias, or display
 * label) to a canonical id. Returns null if no match is found — callers
 * should treat null as "unclassified, run comprehensive" rather than
 * throwing.
 */
export function resolveProfileType(rawType) {
  if (!rawType) return null
  const direct = getAliasIndex().get(normalize(rawType))
  if (direct) return direct
  return null
}

/**
 * Get the full registry entry for a canonical id (or alias). Returns null
 * if unknown.
 */
export function getProfileType(rawType) {
  const id = resolveProfileType(rawType)
  if (!id) return null
  return PROFILE_TYPES[id] ?? null
}

/**
 * List all registered profile types.
 */
export function listProfileTypes() {
  return Object.values(PROFILE_TYPES)
}

/**
 * Walk a profile type's parent chain (deduped, depth-first). Useful for
 * downstream consumers that only know how to handle parent types.
 *
 *   getParentChain('classroom_teacher') → ['teacher', 'educator']
 */
export function getParentChain(rawType) {
  const visited = new Set()
  const chain = []
  const walk = (id) => {
    const entry = PROFILE_TYPES[id]
    if (!entry) return
    for (const parent of entry.parentTypes || []) {
      if (visited.has(parent)) continue
      visited.add(parent)
      chain.push(parent)
      walk(parent)
    }
  }
  const startId = resolveProfileType(rawType)
  if (!startId) return chain
  walk(startId)
  return chain
}

/**
 * Resolve to the recommended strategy id for a given profile type. Falls
 * back to the parent chain so a `classroom_teacher` whose own strategy is
 * defined still works even if the dispatcher only knows the parent.
 */
export function recommendStrategyFor(rawType) {
  const entry = getProfileType(rawType)
  if (entry?.recommendedStrategy) return entry.recommendedStrategy
  for (const parentId of getParentChain(rawType)) {
    const parent = PROFILE_TYPES[parentId]
    if (parent?.recommendedStrategy) return parent.recommendedStrategy
  }
  return 'comprehensive'
}

/**
 * Recommended sources for a profile type, including everything its
 * ancestors recommend. De-duplicated, source-id strings only.
 */
export function recommendedSourcesFor(rawType) {
  const entry = getProfileType(rawType)
  const out = new Set()
  if (entry?.recommendedSources) {
    for (const s of entry.recommendedSources) out.add(s)
  }
  for (const parentId of getParentChain(rawType)) {
    const parent = PROFILE_TYPES[parentId]
    for (const s of parent?.recommendedSources ?? []) out.add(s)
  }
  return Array.from(out)
}

/**
 * Default needs for a profile type, including ancestors.
 */
export function defaultNeedsFor(rawType) {
  const entry = getProfileType(rawType)
  const out = new Set()
  for (const n of entry?.defaultNeeds ?? []) out.add(n)
  for (const parentId of getParentChain(rawType)) {
    const parent = PROFILE_TYPES[parentId]
    for (const n of parent?.defaultNeeds ?? []) out.add(n)
  }
  return Array.from(out)
}

export default {
  PROFILE_TYPES,
  resolveProfileType,
  getProfileType,
  listProfileTypes,
  getParentChain,
  recommendStrategyFor,
  recommendedSourcesFor,
  defaultNeedsFor,
}
