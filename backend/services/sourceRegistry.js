/**
 * sourceRegistry.js
 *
 * Phase 4 mission rule: every funding source must be classified by trust,
 * the profile types it serves, the needs it covers, the freshness window
 * before its data is considered stale, and whether the source requires URL
 * verification at ingest. Crawlers consult this registry to (a) build a
 * source coverage plan from a profile context and (b) emit a coverage
 * report after each run.
 *
 * Trust tiers reuse the canonical SOURCE_TRUST_TIERS enum from the Phase 1
 * opportunityRealityGate so display logic and ingest logic stay aligned.
 *
 * This file is intentionally pure / data-driven: no DB, no network, no I/O.
 * It is safe to import from anywhere.
 */

import { OPPORTUNITY_KINDS, SOURCE_TRUST_TIERS } from './opportunityRealityGate.js'

/**
 * Source identifiers — must align 1:1 with `funding_opportunities.source` and
 * `funding_opportunities.record_origin` so coverage reports can join cleanly
 * to actual rows.
 */
export const SOURCE_IDS = Object.freeze({
  GRANTS_GOV: 'grants_gov',
  COF_FOUNDATION_LOCATOR: 'cof_foundation_locator',
  STATE_PORTAL: 'state_portal',
  FOUNDATION_LOCATOR: 'foundation_locator',
  OVERPASS_LOCAL: 'overpass_local',
  USDA_RURAL_DEV: 'usda_rural_dev',
  FEMA_AFG: 'fema_afg',
  SBA_GRANTS: 'sba_grants',
  SCHOLARSHIP_DIRECTORY: 'scholarship_directory',
  STUDENT_SCHOLARSHIP_PORTALS: 'student_scholarship_portals',
  COMMUNITY_ACTION: 'community_action',
  UNITED_WAY_211: 'united_way_211',
  FEEDING_AMERICA: 'feeding_america',
  ED_GOV_FAFSA: 'ed_gov_fafsa',
  HRSA_HEALTH_CENTERS: 'hrsa_health_centers',
  FAITH_BASED_GRANTS: 'faith_based_grants',
  NATIONAL_VOLUNTEER_FIRE_COUNCIL: 'national_volunteer_fire_council',
  RURAL_FIRE_GRANTS: 'rural_fire_grants',
  MINORITY_BUSINESS_DEV: 'minority_business_dev',
  WOMEN_OWNED_BUSINESS: 'women_owned_business',
  LIHEAP: 'liheap',
  SNAP: 'snap',
  MEDICAID: 'medicaid',
  PELL_GRANT: 'pell_grant',
  USED_DEPT_OF_ED: 'us_dept_of_ed',

  // Local / county / municipal government coverage. Profile types covered
  // include county_government, municipality, public_agency, tribal_government,
  // regional_planning_agency, economic_development_agency.
  GRANTS_GOV_LOCAL_GOV: 'grants_gov_local_government',
  SAM_GOV_ASSISTANCE_LISTINGS: 'sam_gov_assistance_listings',
  USDA_RD_COMMUNITY_FACILITIES: 'usda_rd_community_facilities',
  FEMA_PUBLIC_ASSISTANCE: 'fema_public_assistance',
  FEMA_HAZARD_MITIGATION: 'fema_hazard_mitigation',
  CDBG_STATE_LOCAL: 'cdbg_state_local',
  EDA_ECONOMIC_DEVELOPMENT: 'eda_economic_development',
  DOT_TRANSPORTATION_GRANTS: 'dot_transportation_grants',
  EPA_WATER_INFRASTRUCTURE: 'epa_water_infrastructure',
  BROADBAND_GRANTS: 'broadband_grants',
  OPIOID_SETTLEMENT_RESOURCES: 'opioid_settlement_resources',
  STATE_COUNTY_GRANT_PORTALS: 'state_county_grant_portals',
  STATE_EMERGENCY_MANAGEMENT: 'state_emergency_management',

  // Teacher / classroom / school-department coverage.
  TEACHER_CLASSROOM_GRANTS: 'teacher_classroom_grants',
  LOCAL_EDUCATION_FOUNDATIONS: 'local_education_foundations',
  DONORSCHOOSE_OR_EQUIVALENT: 'donorschoose_or_equivalent',
  NEA_FOUNDATION: 'nea_foundation',
  TOSHIBA_AMERICA_FOUNDATION: 'toshiba_america_foundation',
  STATE_DEPARTMENT_OF_EDUCATION: 'state_department_of_education_grants',
  PTO_PTA_GRANTS: 'pto_pta_grants',
  LIBRARY_GRANTS: 'library_grants',
  SPECIAL_EDUCATION_GRANTS: 'special_education_grants',
  SCHOOL_NUTRITION_GRANTS: 'school_nutrition_grants',
  SCHOOL_TRANSPORTATION_GRANTS: 'school_transportation_grants',

  // Tribal government coverage.
  TRIBAL_GOVERNMENT_GRANTS: 'tribal_government_grants',
  BIA_TRIBAL_PROGRAMS: 'bia_tribal_programs',

  // Public institution coverage (libraries, parks, public health).
  IMLS_LIBRARY_MUSEUM: 'imls_library_museum',
  PARKS_RECREATION_GRANTS: 'parks_recreation_grants',
  PUBLIC_HEALTH_DEPT_GRANTS: 'public_health_department_grants',

  // Specialized nonprofit verticals.
  ANIMAL_RESCUE_GRANTS: 'animal_rescue_grants',
  FOOD_PANTRY_NETWORK: 'food_pantry_network',
  HOMELESS_SERVICES_GRANTS: 'homeless_services_grants',
  DOMESTIC_VIOLENCE_SHELTER_GRANTS: 'domestic_violence_shelter_grants',
  MENTAL_HEALTH_NONPROFIT_GRANTS: 'mental_health_nonprofit_grants',
  REENTRY_PROGRAM_GRANTS: 'reentry_program_grants',
  SUBSTANCE_RECOVERY_NONPROFIT_GRANTS: 'substance_recovery_nonprofit_grants',
})

/**
 * Source classification. Each entry is the contract that lets the crawler
 * planner decide whether to query this source for a given profile.
 *
 *   trust              — SOURCE_TRUST_TIERS value (Phase 1)
 *   default_kind       — OPPORTUNITY_KINDS value emitted by this source
 *   profile_types      — applicant_type / primary_type / organization_type
 *                        values this source serves (best-effort recall)
 *   needs              — need categories this source covers
 *   freshness_days     — how stale the data may get before it must be
 *                        re-queried by the recurring scheduler
 *   verification_required — true means the URL must pass realityGate's URL
 *                        verification at ingest (Phase 1)
 *   directory          — true means rows from this source are directory
 *                        resources, not direct grants
 *   notes              — human-readable note for admin/Anya/dashboard
 */
export const SOURCES = Object.freeze({
  [SOURCE_IDS.GRANTS_GOV]: {
    id: SOURCE_IDS.GRANTS_GOV,
    label: 'Grants.gov',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_API,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['nonprofit', 'school', 'church', 'business', 'volunteer_fire', 'volunteer_fire_department', 'ministry', 'tribal', 'state_local_gov'],
    needs: ['equipment', 'training', 'research', 'education', 'health', 'community', 'food', 'housing', 'fire', 'public_safety', 'rural'],
    freshness_days: 1,
    verification_required: true,
    directory: false,
    notes: 'Federal grant opportunities. Use profile-derived keyword + agency filters; never blank query.',
  },
  [SOURCE_IDS.COF_FOUNDATION_LOCATOR]: {
    id: SOURCE_IDS.COF_FOUNDATION_LOCATOR,
    label: 'Council on Foundations Locator',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['nonprofit', 'church', 'school', 'ministry', 'individual', 'family'],
    needs: ['community', 'general'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Foundation directory by ZIP/state. Always survives filtering.',
  },
  [SOURCE_IDS.STATE_PORTAL]: {
    id: SOURCE_IDS.STATE_PORTAL,
    label: 'State Funding Portals',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['nonprofit', 'business', 'school', 'church', 'individual', 'family', 'volunteer_fire'],
    needs: ['housing', 'utilities', 'food', 'health', 'business', 'education', 'fire', 'public_safety'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'State-run grant/benefits portals. Geographic match required.',
  },
  [SOURCE_IDS.FOUNDATION_LOCATOR]: {
    id: SOURCE_IDS.FOUNDATION_LOCATOR,
    label: 'Foundation Locators',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['nonprofit', 'church', 'school', 'ministry'],
    needs: ['community', 'general'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Directory of philanthropic foundations by region.',
  },
  [SOURCE_IDS.OVERPASS_LOCAL]: {
    id: SOURCE_IDS.OVERPASS_LOCAL,
    label: 'OpenStreetMap Local Resources',
    trust: SOURCE_TRUST_TIERS.OPEN_WEB,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['food', 'housing', 'utilities', 'community'],
    freshness_days: 30,
    verification_required: false,
    directory: true,
    notes: 'Local food banks, shelters, community centers from OSM.',
  },
  [SOURCE_IDS.USDA_RURAL_DEV]: {
    id: SOURCE_IDS.USDA_RURAL_DEV,
    label: 'USDA Rural Development',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['volunteer_fire', 'volunteer_fire_department', 'nonprofit', 'business', 'individual', 'family'],
    needs: ['rural', 'housing', 'business', 'fire', 'public_safety', 'water'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'USDA RD programs (water/community/business/housing).',
  },
  [SOURCE_IDS.FEMA_AFG]: {
    id: SOURCE_IDS.FEMA_AFG,
    label: 'FEMA Assistance to Firefighters Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['volunteer_fire', 'volunteer_fire_department'],
    needs: ['equipment', 'training', 'fire', 'public_safety'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'AFG / SAFER / FP&S firefighter grant programs.',
  },
  [SOURCE_IDS.SBA_GRANTS]: {
    id: SOURCE_IDS.SBA_GRANTS,
    label: 'Small Business Administration',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['business', 'minority_owned_business', 'women_owned_business'],
    needs: ['business', 'startup', 'rural'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'SBA grants, not loans. Filter loan results out at ingest.',
  },
  [SOURCE_IDS.SCHOLARSHIP_DIRECTORY]: {
    id: SOURCE_IDS.SCHOLARSHIP_DIRECTORY,
    label: 'Scholarship Directories',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['student'],
    needs: ['scholarship', 'education'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Scholarship-specific data sources for student profiles.',
  },
  [SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS]: {
    id: SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS,
    label: 'Student Scholarship Search Portals',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['student'],
    needs: ['scholarship', 'education'],
    freshness_days: 14,
    verification_required: false,
    directory: true,
    notes: 'Profile-matching scholarship search portals (Fastweb, CollegeScholarships.org, CollegeXpress, CollegeWhale, Peterson\'s, Unigo/Scholarship Experts, Scholly, StudentScholarships.org). Always survives filtering for student profiles.',
  },
  [SOURCE_IDS.COMMUNITY_ACTION]: {
    id: SOURCE_IDS.COMMUNITY_ACTION,
    label: 'Community Action Agencies',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['utilities', 'housing', 'food', 'cash_assistance', 'transportation'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'CAP agencies — directory of local emergency assistance.',
  },
  [SOURCE_IDS.UNITED_WAY_211]: {
    id: SOURCE_IDS.UNITED_WAY_211,
    label: 'United Way 211',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['utilities', 'housing', 'food', 'health', 'community'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'United Way 211 referral directory.',
  },
  [SOURCE_IDS.FEEDING_AMERICA]: {
    id: SOURCE_IDS.FEEDING_AMERICA,
    label: 'Feeding America Food Bank Locator',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['food'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Food bank locator — directory style.',
  },
  [SOURCE_IDS.ED_GOV_FAFSA]: {
    id: SOURCE_IDS.ED_GOV_FAFSA,
    label: 'studentaid.gov / FAFSA',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['student'],
    needs: ['education', 'scholarship', 'housing'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Federal student aid programs.',
  },
  [SOURCE_IDS.HRSA_HEALTH_CENTERS]: {
    id: SOURCE_IDS.HRSA_HEALTH_CENTERS,
    label: 'HRSA Health Center Lookup',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['health', 'mental_health'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Federally qualified health centers — directory style.',
  },
  [SOURCE_IDS.FAITH_BASED_GRANTS]: {
    id: SOURCE_IDS.FAITH_BASED_GRANTS,
    label: 'Faith-Based Foundation Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['church', 'ministry', 'nonprofit'],
    needs: ['community', 'food', 'housing', 'education'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'Faith-based foundations and ministries grants.',
  },
  [SOURCE_IDS.NATIONAL_VOLUNTEER_FIRE_COUNCIL]: {
    id: SOURCE_IDS.NATIONAL_VOLUNTEER_FIRE_COUNCIL,
    label: 'National Volunteer Fire Council',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['volunteer_fire', 'volunteer_fire_department'],
    needs: ['equipment', 'training', 'fire', 'public_safety'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'NVFC and partner programs for volunteer fire.',
  },
  [SOURCE_IDS.RURAL_FIRE_GRANTS]: {
    id: SOURCE_IDS.RURAL_FIRE_GRANTS,
    label: 'Rural Fire Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['volunteer_fire', 'volunteer_fire_department'],
    needs: ['equipment', 'training', 'fire', 'public_safety', 'rural'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'State Forestry / VFA / SAFER for rural departments.',
  },
  [SOURCE_IDS.MINORITY_BUSINESS_DEV]: {
    id: SOURCE_IDS.MINORITY_BUSINESS_DEV,
    label: 'Minority Business Development Agency',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['business', 'minority_owned_business'],
    needs: ['business', 'startup'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'MBDA programs for minority-owned businesses.',
  },
  [SOURCE_IDS.WOMEN_OWNED_BUSINESS]: {
    id: SOURCE_IDS.WOMEN_OWNED_BUSINESS,
    label: 'Women-Owned Business Programs',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['business', 'women_owned_business'],
    needs: ['business', 'startup'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'Women-owned business grant programs.',
  },
  [SOURCE_IDS.LIHEAP]: {
    id: SOURCE_IDS.LIHEAP,
    label: 'LIHEAP — Low Income Home Energy Assistance',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.BENEFIT,
    profile_types: ['individual', 'family'],
    needs: ['utilities', 'community', 'general'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Federal/state utility assistance program — direct application.',
  },
  [SOURCE_IDS.SNAP]: {
    id: SOURCE_IDS.SNAP,
    label: 'SNAP — Supplemental Nutrition Assistance Program',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.BENEFIT,
    profile_types: ['individual', 'family'],
    needs: ['food', 'community', 'general'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Federal nutrition assistance — direct application.',
  },
  [SOURCE_IDS.MEDICAID]: {
    id: SOURCE_IDS.MEDICAID,
    label: 'Medicaid / CHIP',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.BENEFIT,
    profile_types: ['individual', 'family'],
    needs: ['health', 'community', 'general'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'State Medicaid / CHIP programs — direct application.',
  },
  [SOURCE_IDS.PELL_GRANT]: {
    id: SOURCE_IDS.PELL_GRANT,
    label: 'Pell Grant',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['student'],
    needs: ['education', 'scholarship'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Federal Pell Grant — direct application via FAFSA.',
  },
  [SOURCE_IDS.USED_DEPT_OF_ED]: {
    id: SOURCE_IDS.USED_DEPT_OF_ED,
    label: 'US Dept of Education Grant Programs',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['school', 'public_school', 'school_district', 'nonprofit', 'business', 'ministry'],
    needs: ['education', 'training', 'community'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Department of Education discretionary/formula grant programs.',
  },

  // ---------------------------------------------------------------------
  // Local / county / municipal government sources (Phase 4 expansion)
  // ---------------------------------------------------------------------
  [SOURCE_IDS.GRANTS_GOV_LOCAL_GOV]: {
    id: SOURCE_IDS.GRANTS_GOV_LOCAL_GOV,
    label: 'Grants.gov — State / Local Government Filter',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_API,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'county_official', 'regional_planning_agency', 'economic_development_agency',
      'tribal_government', 'state_local_gov',
    ],
    needs: [
      'public_safety', 'infrastructure', 'roads_transportation', 'water_sewer',
      'broadband', 'parks_recreation', 'emergency_management',
      'economic_development', 'housing_development', 'community_facilities',
      'environmental_remediation', 'rural', 'community',
    ],
    freshness_days: 1,
    verification_required: true,
    directory: false,
    notes: 'Grants.gov filtered to "County governments / City or township governments / Special district governments / Native American tribal governments" eligible applicants.',
  },
  [SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS]: {
    id: SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
    label: 'SAM.gov Assistance Listings (CFDA)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_API,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'tribal_government', 'state_local_gov', 'school_district', 'public_school',
      'public_health_department',
    ],
    needs: [
      'public_safety', 'infrastructure', 'water_sewer', 'broadband',
      'emergency_management', 'economic_development', 'community_facilities',
      'environmental_remediation', 'health', 'education',
    ],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'Federal Assistance Listings (CFDA) — canonical catalog of federal aid programs by funding agency and applicant type.',
  },
  [SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES]: {
    id: SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES,
    label: 'USDA Rural Development — Community Facilities',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'tribal_government', 'volunteer_fire', 'volunteer_fire_department',
      'public_school', 'public_health_department',
    ],
    needs: ['community_facilities', 'water_sewer', 'rural', 'public_safety', 'health'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'USDA RD Community Facilities Direct Loan & Grant Program — funds essential community facilities for rural areas (≤ 20k population).',
  },
  [SOURCE_IDS.FEMA_PUBLIC_ASSISTANCE]: {
    id: SOURCE_IDS.FEMA_PUBLIC_ASSISTANCE,
    label: 'FEMA Public Assistance',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'tribal_government', 'state_local_gov',
    ],
    needs: ['emergency_management', 'infrastructure', 'community_facilities', 'public_safety'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'FEMA PA — disaster-related infrastructure repair and emergency-response cost reimbursement for state, local, tribal, and territorial governments.',
  },
  [SOURCE_IDS.FEMA_HAZARD_MITIGATION]: {
    id: SOURCE_IDS.FEMA_HAZARD_MITIGATION,
    label: 'FEMA Hazard Mitigation Assistance (HMA)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'tribal_government', 'state_local_gov',
    ],
    needs: ['emergency_management', 'infrastructure', 'environmental_remediation', 'public_safety'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'FEMA HMA — BRIC, FMA, HMGP. Pre- and post-disaster mitigation projects.',
  },
  [SOURCE_IDS.CDBG_STATE_LOCAL]: {
    id: SOURCE_IDS.CDBG_STATE_LOCAL,
    label: 'CDBG — Community Development Block Grants (State / Local)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'state_local_gov', 'nonprofit',
    ],
    needs: ['housing_development', 'community_facilities', 'infrastructure',
      'economic_development', 'community'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'HUD CDBG entitlement and state CDBG programs — community development for cities, counties, and qualified nonprofits.',
  },
  [SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT]: {
    id: SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT,
    label: 'US Economic Development Administration',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'regional_planning_agency', 'economic_development_agency', 'tribal_government',
    ],
    needs: ['economic_development', 'infrastructure', 'community_facilities', 'broadband'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'EDA Public Works, Economic Adjustment Assistance, Build Back Better, Tech Hubs.',
  },
  [SOURCE_IDS.DOT_TRANSPORTATION_GRANTS]: {
    id: SOURCE_IDS.DOT_TRANSPORTATION_GRANTS,
    label: 'US DOT Transportation Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'regional_planning_agency', 'tribal_government', 'school_district',
    ],
    needs: ['roads_transportation', 'infrastructure', 'public_safety', 'community_facilities'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'DOT BUILD/RAISE, Safe Streets For All, Reconnecting Communities, Bridge Investment, Tribal Transportation.',
  },
  [SOURCE_IDS.EPA_WATER_INFRASTRUCTURE]: {
    id: SOURCE_IDS.EPA_WATER_INFRASTRUCTURE,
    label: 'EPA Water & Environmental Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'tribal_government', 'public_health_department',
    ],
    needs: ['water_sewer', 'environmental_remediation', 'infrastructure', 'health'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'EPA WIFIA, Clean Water/Drinking Water SRF, brownfields, environmental justice grants.',
  },
  [SOURCE_IDS.BROADBAND_GRANTS]: {
    id: SOURCE_IDS.BROADBAND_GRANTS,
    label: 'NTIA / FCC / USDA Broadband Programs',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'tribal_government', 'school_district', 'public_school', 'library',
    ],
    needs: ['broadband', 'infrastructure', 'education', 'community_facilities'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'BEAD, ReConnect, Tribal Broadband Connectivity Program, E-Rate, FCC Affordable Connectivity.',
  },
  [SOURCE_IDS.OPIOID_SETTLEMENT_RESOURCES]: {
    id: SOURCE_IDS.OPIOID_SETTLEMENT_RESOURCES,
    label: 'Opioid Settlement Resources',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'public_health_department', 'tribal_government',
      'substance_recovery_org', 'mental_health_nonprofit',
    ],
    needs: ['substance_recovery', 'mental_health', 'health', 'public_safety'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'State opioid settlement allocations and abatement funding for counties, cities, and qualifying programs.',
  },
  [SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS]: {
    id: SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS,
    label: 'State / County Grant Portals',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'state_local_gov',
    ],
    needs: ['public_safety', 'infrastructure', 'community_facilities',
      'parks_recreation', 'economic_development', 'community'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'State-administered pass-through grants and county-managed grant portals (e.g. governor\'s office, DCA, county foundations).',
  },
  [SOURCE_IDS.STATE_EMERGENCY_MANAGEMENT]: {
    id: SOURCE_IDS.STATE_EMERGENCY_MANAGEMENT,
    label: 'State Emergency Management Agency Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'county_government', 'municipality', 'local_government', 'public_agency',
      'tribal_government', 'volunteer_fire', 'volunteer_fire_department',
    ],
    needs: ['emergency_management', 'public_safety', 'equipment', 'training'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'State Homeland Security Grant Program, EMPG, state-administered FEMA pass-through grants.',
  },

  // ---------------------------------------------------------------------
  // Teacher / classroom / school-department sources
  // ---------------------------------------------------------------------
  [SOURCE_IDS.TEACHER_CLASSROOM_GRANTS]: {
    id: SOURCE_IDS.TEACHER_CLASSROOM_GRANTS,
    label: 'Teacher & Classroom Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'teacher', 'classroom_teacher', 'educator',
      'public_school', 'school_district', 'school',
    ],
    needs: ['classroom_supplies', 'stem_classroom', 'arts_education',
      'professional_development', 'education'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'Curated list of teacher/classroom mini-grant funders (state DOE, regional foundations, corporate STEM funders).',
  },
  [SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS]: {
    id: SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS,
    label: 'Local Education Foundations',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: [
      'teacher', 'classroom_teacher', 'educator',
      'public_school', 'school_district', 'school', 'pta_pto',
    ],
    needs: ['classroom_supplies', 'stem_classroom', 'arts_education',
      'special_education', 'education', 'community'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Directory of local/county education foundations (LEFs) by district — always survives filtering for school/teacher profiles.',
  },
  [SOURCE_IDS.DONORSCHOOSE_OR_EQUIVALENT]: {
    id: SOURCE_IDS.DONORSCHOOSE_OR_EQUIVALENT,
    label: 'DonorsChoose-style Classroom Funding',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'teacher', 'classroom_teacher', 'educator',
      'public_school', 'school_district', 'school',
    ],
    needs: ['classroom_supplies', 'stem_classroom', 'arts_education',
      'school_supplies', 'education'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'DonorsChoose, AdoptAClassroom, ClassWish — direct classroom-project crowdfunding for public-school teachers.',
  },
  [SOURCE_IDS.NEA_FOUNDATION]: {
    id: SOURCE_IDS.NEA_FOUNDATION,
    label: 'NEA Foundation Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'teacher', 'classroom_teacher', 'educator',
      'public_school', 'school_district',
    ],
    needs: ['classroom_supplies', 'professional_development',
      'stem_classroom', 'arts_education', 'education'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'NEA Foundation Learning & Leadership / Student Success / Envision Equity grants.',
  },
  [SOURCE_IDS.TOSHIBA_AMERICA_FOUNDATION]: {
    id: SOURCE_IDS.TOSHIBA_AMERICA_FOUNDATION,
    label: 'Toshiba America Foundation — STEM Classroom',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'teacher', 'classroom_teacher', 'educator',
      'public_school', 'school_district',
    ],
    needs: ['stem_classroom', 'classroom_supplies', 'education'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'K-5 and 6-12 STEM classroom grants (rolling deadlines).',
  },
  [SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION]: {
    id: SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
    label: 'State Department of Education Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'teacher', 'classroom_teacher', 'educator',
      'public_school', 'school_district', 'school',
      'special_education_program', 'school_food_service', 'school_transportation',
    ],
    needs: ['classroom_supplies', 'stem_classroom', 'arts_education',
      'special_education', 'school_nutrition', 'professional_development',
      'education'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'State DOE pass-through grants, mini-grants, and state-funded classroom programs.',
  },
  [SOURCE_IDS.PTO_PTA_GRANTS]: {
    id: SOURCE_IDS.PTO_PTA_GRANTS,
    label: 'PTO / PTA Mini-Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'teacher', 'classroom_teacher', 'educator',
      'public_school', 'school_district', 'pta_pto',
    ],
    needs: ['classroom_supplies', 'arts_education', 'stem_classroom', 'education'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'National PTA, PTO Today, and local PTO/PTA mini-grant programs for classroom enrichment.',
  },
  [SOURCE_IDS.LIBRARY_GRANTS]: {
    id: SOURCE_IDS.LIBRARY_GRANTS,
    label: 'Library Grants (ALA / state library)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'library', 'library_media_center', 'school_district', 'public_school',
      'county_government', 'municipality',
    ],
    needs: ['library_media', 'community_facilities', 'education', 'broadband'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'ALA, IMLS pass-through state library grants, summer reading, library renovations.',
  },
  [SOURCE_IDS.SPECIAL_EDUCATION_GRANTS]: {
    id: SOURCE_IDS.SPECIAL_EDUCATION_GRANTS,
    label: 'Special Education Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'special_education_program', 'public_school', 'school_district',
      'teacher', 'classroom_teacher', 'educator',
    ],
    needs: ['special_education', 'disability', 'education', 'classroom_supplies'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'IDEA Part B/C pass-through, OSEP discretionary, and special-education foundation grants.',
  },
  [SOURCE_IDS.SCHOOL_NUTRITION_GRANTS]: {
    id: SOURCE_IDS.SCHOOL_NUTRITION_GRANTS,
    label: 'School Nutrition / Food Service Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'school_food_service', 'public_school', 'school_district',
    ],
    needs: ['school_nutrition', 'food', 'community_facilities', 'education'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'USDA NSLP/SBP equipment grants, Action for Healthy Kids, Fuel Up to Play 60, state nutrition grants.',
  },
  [SOURCE_IDS.SCHOOL_TRANSPORTATION_GRANTS]: {
    id: SOURCE_IDS.SCHOOL_TRANSPORTATION_GRANTS,
    label: 'School Transportation Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'school_transportation', 'public_school', 'school_district',
    ],
    needs: ['roads_transportation', 'school_transportation', 'education', 'environmental_remediation'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'EPA Clean School Bus, state DOT school-route safety, electric/alt-fuel school bus grants.',
  },

  // ---------------------------------------------------------------------
  // Tribal government sources
  // ---------------------------------------------------------------------
  [SOURCE_IDS.TRIBAL_GOVERNMENT_GRANTS]: {
    id: SOURCE_IDS.TRIBAL_GOVERNMENT_GRANTS,
    label: 'Tribal Government Grants (HUD ICDBG / IHS / DOJ Tribal)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['tribal_government', 'tribal'],
    needs: ['housing_development', 'community_facilities', 'health',
      'public_safety', 'education', 'broadband', 'infrastructure',
      'environmental_remediation', 'economic_development'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Indian CDBG, IHS facility/clinic grants, DOJ Tribal Justice, ANA, NAHASDA.',
  },
  [SOURCE_IDS.BIA_TRIBAL_PROGRAMS]: {
    id: SOURCE_IDS.BIA_TRIBAL_PROGRAMS,
    label: 'Bureau of Indian Affairs / BIE Programs',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['tribal_government', 'tribal'],
    needs: ['education', 'community', 'economic_development', 'public_safety',
      'housing_development', 'infrastructure'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'BIA Tribal Government Services, Welfare Assistance, Tribal Court Programs, BIE school grants.',
  },

  // ---------------------------------------------------------------------
  // Public institution sources (libraries, parks, public health)
  // ---------------------------------------------------------------------
  [SOURCE_IDS.IMLS_LIBRARY_MUSEUM]: {
    id: SOURCE_IDS.IMLS_LIBRARY_MUSEUM,
    label: 'IMLS — Institute of Museum and Library Services',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['library', 'museum', 'library_media_center', 'public_agency'],
    needs: ['library_media', 'community_facilities', 'education', 'community'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'IMLS Grants to States, National Leadership Grants, Museums for America.',
  },
  [SOURCE_IDS.PARKS_RECREATION_GRANTS]: {
    id: SOURCE_IDS.PARKS_RECREATION_GRANTS,
    label: 'Parks & Recreation Grants (LWCF / NPS / state PRA)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'parks_department', 'community_center', 'county_government',
      'municipality', 'public_agency', 'tribal_government',
    ],
    needs: ['parks_recreation', 'community_facilities', 'community',
      'environmental_remediation'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'Land and Water Conservation Fund, NPS Outdoor Recreation Legacy Partnership, state parks/rec grants.',
  },
  [SOURCE_IDS.PUBLIC_HEALTH_DEPT_GRANTS]: {
    id: SOURCE_IDS.PUBLIC_HEALTH_DEPT_GRANTS,
    label: 'Public Health Department Grants (CDC / HRSA / state DOH)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: [
      'public_health_department', 'local_housing_authority', 'county_government',
      'municipality', 'public_agency', 'tribal_government',
    ],
    needs: ['health', 'mental_health', 'substance_recovery', 'community',
      'public_safety', 'environmental_remediation'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'CDC PHEP, HRSA grants, state DOH pass-through funding for public health departments.',
  },

  // ---------------------------------------------------------------------
  // Specialized nonprofit verticals
  // ---------------------------------------------------------------------
  [SOURCE_IDS.ANIMAL_RESCUE_GRANTS]: {
    id: SOURCE_IDS.ANIMAL_RESCUE_GRANTS,
    label: 'Animal Rescue / Welfare Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['animal_rescue', 'nonprofit'],
    needs: ['animal_welfare', 'community', 'capacity_building', 'equipment'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'PetSmart Charities, Maddie\'s Fund, ASPCA, Petco Love, Banfield Foundation grants.',
  },
  [SOURCE_IDS.FOOD_PANTRY_NETWORK]: {
    id: SOURCE_IDS.FOOD_PANTRY_NETWORK,
    label: 'Food Pantry / Hunger-Relief Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['food_pantry', 'nonprofit', 'church', 'ministry'],
    needs: ['food', 'community', 'capacity_building', 'equipment'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'Feeding America agency grants, USDA TEFAP, Walmart Foundation hunger grants, regional food bank capacity grants.',
  },
  [SOURCE_IDS.HOMELESS_SERVICES_GRANTS]: {
    id: SOURCE_IDS.HOMELESS_SERVICES_GRANTS,
    label: 'Homeless Services Grants (HUD CoC / ESG)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['homeless_shelter', 'nonprofit', 'reentry_program', 'church', 'ministry'],
    needs: ['housing', 'housing_development', 'community', 'mental_health', 'health'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'HUD Continuum of Care, Emergency Solutions Grant, HHS RHY, VA SSVF.',
  },
  [SOURCE_IDS.DOMESTIC_VIOLENCE_SHELTER_GRANTS]: {
    id: SOURCE_IDS.DOMESTIC_VIOLENCE_SHELTER_GRANTS,
    label: 'Domestic Violence Shelter Grants (VOCA / VAWA)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['domestic_violence_shelter', 'nonprofit', 'public_agency'],
    needs: ['housing', 'mental_health', 'community', 'public_safety'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'OVW Transitional Housing, VOCA victim assistance, VAWA Rural / Tribal grants.',
  },
  [SOURCE_IDS.MENTAL_HEALTH_NONPROFIT_GRANTS]: {
    id: SOURCE_IDS.MENTAL_HEALTH_NONPROFIT_GRANTS,
    label: 'Mental Health Nonprofit Grants (SAMHSA)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['mental_health_nonprofit', 'nonprofit', 'public_health_department'],
    needs: ['mental_health', 'substance_recovery', 'health', 'community'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'SAMHSA discretionary grants, MHBG, suicide-prevention, peer-support funding.',
  },
  [SOURCE_IDS.REENTRY_PROGRAM_GRANTS]: {
    id: SOURCE_IDS.REENTRY_PROGRAM_GRANTS,
    label: 'Reentry Program Grants (DOJ Second Chance)',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['reentry_program', 'nonprofit', 'church', 'ministry'],
    needs: ['workforce', 'employment', 'housing', 'mental_health', 'substance_recovery'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'DOJ BJA Second Chance Act, DOL Reentry Employment Opportunities, state reentry councils.',
  },
  [SOURCE_IDS.SUBSTANCE_RECOVERY_NONPROFIT_GRANTS]: {
    id: SOURCE_IDS.SUBSTANCE_RECOVERY_NONPROFIT_GRANTS,
    label: 'Substance Recovery Nonprofit Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['substance_recovery_org', 'nonprofit', 'public_health_department'],
    needs: ['substance_recovery', 'mental_health', 'health', 'community'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'SAMHSA SOR, state opioid response funds, SUPTRS Block Grant pass-through.',
  },
})

/**
 * Get the registry entry for a source id. Returns null when unknown so
 * callers can decide whether to log/skip rather than throwing in pipelines.
 */
export function getSource(sourceId) {
  if (!sourceId) return null
  return SOURCES[String(sourceId)] ?? null
}

/**
 * Iterate registry as an array.
 */
export function listSources() {
  return Object.values(SOURCES)
}

/**
 * Plan source coverage for a profile.
 *
 * Returns an object describing which source ids the crawler/dispatcher
 * SHOULD query for the given profile, plus which ones it MUST query
 * (mission rule: every profile gets at least 3 source categories).
 *
 * Pure / synchronous: no DB calls. Caller is responsible for actually
 * dispatching the work.
 *
 * @param {object} profileContext - same shape as loadProfileContext output
 * @returns {{
 *   profile_type: string|null,
 *   needs: string[],
 *   sources_planned: string[],
 *   sources_required: string[],
 *   directory_sources: string[],
 *   direct_sources: string[],
 *   notes: string[]
 * }}
 */
export function planCoverage(profileContext = {}) {
  const profile = profileContext?.profile ?? profileContext ?? {}
  const signals = profileContext?.signals ?? {}

  const profileType =
    profile?.primary_type ??
    profile?.applicant_type ??
    profile?.organization_type ??
    null

  const setOrArrayToArray = (v) => {
    if (!v) return []
    if (Array.isArray(v)) return v
    if (typeof v?.values === 'function') return Array.from(v)
    return [String(v)]
  }
  const profileNeeds = setOrArrayToArray(signals?.needs)

  const planned = new Set()
  for (const src of listSources()) {
    const typeMatch =
      !profileType ||
      src.profile_types.length === 0 ||
      src.profile_types.some((t) => normalizeType(t) === normalizeType(profileType))
    const needMatch =
      profileNeeds.length === 0 ||
      src.needs.length === 0 ||
      src.needs.some((n) => profileNeeds.some((pn) => sameNeed(pn, n)))
    if (typeMatch && needMatch) planned.add(src.id)
  }

  // Mission rule: avoid silent zero-source runs and always plan ≥ 3
  // source categories per profile so the dispatcher never executes a
  // single-source crawl that quietly returns nothing useful.
  const FALLBACKS = [
    SOURCE_IDS.GRANTS_GOV,
    SOURCE_IDS.UNITED_WAY_211,
    SOURCE_IDS.COMMUNITY_ACTION,
    SOURCE_IDS.COF_FOUNDATION_LOCATOR,
  ]
  for (const fb of FALLBACKS) {
    if (planned.size >= 3) break
    planned.add(fb)
  }

  const required = new Set(planned)

  const plannedArr = Array.from(planned)
  const directory_sources = plannedArr.filter((id) => SOURCES[id]?.directory === true)
  const direct_sources = plannedArr.filter((id) => SOURCES[id]?.directory !== true)

  const notes = []
  if (!profileType) notes.push('profile_type missing — using broad fallback coverage')
  if (profileNeeds.length === 0) notes.push('no needs detected — querying broadly compatible sources')

  return {
    profile_type: profileType,
    needs: profileNeeds,
    sources_planned: plannedArr,
    sources_required: Array.from(required),
    directory_sources,
    direct_sources,
    notes,
  }
}

/**
 * Build a coverage report from a list of source-execution outcomes.
 * Crawlers call this after a run to emit a structured report so the
 * mission dashboard can show coverage metrics.
 *
 *   plan      — output from planCoverage()
 *   outcomes  — array of { source_id, queried, failed, found, error }
 *
 * Returns a structured object the mission dashboard / Anya / tests can
 * consume directly.
 */
export function buildCoverageReport(plan, outcomes = []) {
  const planned = new Set(plan?.sources_planned ?? [])
  const required = new Set(plan?.sources_required ?? [])

  const sources_queried = []
  const sources_failed = []
  let direct_opportunities_found = 0
  let directory_opportunities_found = 0

  for (const o of outcomes) {
    if (!o?.source_id) continue
    if (o.queried) sources_queried.push(o.source_id)
    if (o.failed || o.error) sources_failed.push({ source_id: o.source_id, error: o.error ?? 'unknown' })
    const src = SOURCES[o.source_id]
    if (src?.directory) {
      directory_opportunities_found += Number(o.found ?? 0)
    } else {
      direct_opportunities_found += Number(o.found ?? 0)
    }
  }

  const coverage_gaps = Array.from(required).filter((id) => !sources_queried.includes(id))

  return {
    profile_type: plan?.profile_type ?? null,
    sources_planned: Array.from(planned),
    sources_required: Array.from(required),
    sources_queried,
    sources_failed,
    coverage_gaps,
    direct_opportunities_found,
    directory_opportunities_found,
    notes: plan?.notes ?? [],
  }
}

/**
 * Build a sanitized list of grants.gov-friendly query terms from a profile
 * context. This replaces the legacy "search with empty keyword" call that
 * Phase 4 mission rule explicitly forbids ("do not call broad blank search
 * as 'ZIP match'").
 *
 * Returns at most `limit` non-blank, non-pii terms. Falls back to a small
 * set of broadly useful federal-grant categories when the profile is empty
 * — this preserves recall without sending an empty query.
 */
export function buildGrantsGovQueryTerms(profileContext = {}, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 8, 16))
  const profile = profileContext?.profile ?? profileContext ?? {}
  const signals = profileContext?.signals ?? {}

  const candidates = []
  const profileType =
    profile?.primary_type ?? profile?.applicant_type ?? profile?.organization_type ?? null
  if (profileType) candidates.push(String(profileType).replace(/_/g, ' '))

  const setOrArrayToArray = (v) => {
    if (!v) return []
    if (Array.isArray(v)) return v
    if (typeof v?.values === 'function') return Array.from(v)
    return [String(v)]
  }
  for (const need of setOrArrayToArray(signals?.needs)) candidates.push(String(need).replace(/_/g, ' '))
  for (const interest of setOrArrayToArray(signals?.interests)) candidates.push(String(interest).replace(/_/g, ' '))

  // De-dupe + drop empties + cap
  const seen = new Set()
  const out = []
  for (const t of candidates) {
    const v = String(t).trim().toLowerCase()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= limit) break
  }

  if (out.length === 0) {
    // BROAD FALLBACK — never empty string. Use the same set of broad
    // assistance categories the dispatcher uses for "no profile context".
    return ['community development', 'rural development', 'public safety', 'workforce development']
  }
  return out
}

function normalizeType(t) {
  return String(t || '').toLowerCase().trim().replace(/[^a-z0-9_]/g, '_')
}

function sameNeed(a, b) {
  const na = String(a || '').toLowerCase().replace(/_/g, ' ').trim()
  const nb = String(b || '').toLowerCase().replace(/_/g, ' ').trim()
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}

export default {
  SOURCE_IDS,
  SOURCES,
  getSource,
  listSources,
  planCoverage,
  buildCoverageReport,
  buildGrantsGovQueryTerms,
}
