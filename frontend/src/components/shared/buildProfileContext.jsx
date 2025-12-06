/**
 * Build Profile Context for Crawlers
 * 
 * Creates a rich context object from organization/individual profile data
 * that can be passed to crawlers for better matching.
 * 
 * This ensures all relevant fields are available to discovery algorithms
 * without needing to update each crawler individually.
 */

// College ZIP code lookup (common colleges and their locations)
// This is a simplified lookup - in production you'd use a real API
const COLLEGE_ZIP_LOOKUP = {
  // Tennessee
  'lee university': '37311',
  'university of tennessee': '37996',
  'university of tennessee knoxville': '37996',
  'vanderbilt': '37235',
  'vanderbilt university': '37235',
  'middle tennessee state': '37132',
  'mtsu': '37132',
  'tennessee tech': '38505',
  'east tennessee state': '37614',
  'etsu': '37614',
  'belmont': '37212',
  'lipscomb': '37204',
  'carson newman': '37760',
  'bryan college': '37321',
  'tennessee wesleyan': '37303',
  'covenant college': '30750',
  'southern adventist': '37315',
  'chattanooga state': '37406',
  'utc': '37403',
  'university of tennessee chattanooga': '37403',
  
  // Major out-of-state
  'harvard': '02138',
  'yale': '06520',
  'princeton': '08544',
  'stanford': '94305',
  'mit': '02139',
  'ucla': '90095',
  'usc': '90089',
  'nyu': '10003',
  'columbia': '10027',
  'university of michigan': '48109',
  'ohio state': '43210',
  'penn state': '16802',
  'university of florida': '32611',
  'georgia tech': '30332',
  'duke': '27708',
  'unc': '27599',
  'university of north carolina': '27599',
  'university of georgia': '30602',
  'auburn': '36849',
  'university of alabama': '35487',
  'ole miss': '38677',
  'mississippi state': '39762',
  'lsu': '70803',
  'university of kentucky': '40506',
  'university of virginia': '22904',
  'virginia tech': '24061',
};

/**
 * Extract ZIP codes from college names (optimized)
 * @param {string[]} colleges - Array of college names
 * @returns {string[]} Array of ZIP codes
 */
function deriveZipsFromColleges(colleges) {
  if (!Array.isArray(colleges) || colleges.length === 0) return [];
  
  const zips = new Set();
  
  for (const college of colleges) {
    if (!college) continue;
    
    const normalized = college.toLowerCase().trim();
    
    // Try exact match first
    if (COLLEGE_ZIP_LOOKUP[normalized]) {
      zips.add(COLLEGE_ZIP_LOOKUP[normalized]);
      continue;
    }
    
    // Try partial match (first match wins for performance)
    for (const key in COLLEGE_ZIP_LOOKUP) {
      if (normalized.includes(key) || key.includes(normalized)) {
        zips.add(COLLEGE_ZIP_LOOKUP[key]);
        break;
      }
    }
  }
  
  return Array.from(zips);
}

/**
 * Extract ZIPs from education history (optimized)
 * @param {object[]} educationHistory - Array of education history objects
 * @returns {string[]} Array of ZIP codes
 */
function deriveZipsFromEducationHistory(educationHistory) {
  if (!Array.isArray(educationHistory) || educationHistory.length === 0) return [];
  
  const zips = new Set();
  
  for (const edu of educationHistory) {
    if (!edu?.institution_name) continue;
    
    const normalized = edu.institution_name.toLowerCase().trim();
    
    // First match wins for performance
    for (const key in COLLEGE_ZIP_LOOKUP) {
      if (normalized.includes(key) || key.includes(normalized)) {
        zips.add(COLLEGE_ZIP_LOOKUP[key]);
        break;
      }
    }
  }
  
  return Array.from(zips);
}

/**
 * Get all religious affiliations as array (optimized single-pass)
 * @param {object} org - Organization object
 * @returns {string[]} Array of religious affiliation keys
 */
function getReligiousAffiliations(org) {
  if (!org || typeof org !== 'object') return [];
  
  const affiliations = [];
  
  // Single pass through object keys
  for (const key in org) {
    if (key.startsWith('religious_affiliation_') && org[key] === true) {
      affiliations.push(key.slice(22)); // 'religious_affiliation_'.length = 22
    }
  }
  
  if (org.religious_affiliation) {
    affiliations.push(org.religious_affiliation);
  }
  
  return affiliations;
}

/**
 * Get all cultural heritage flags as array (optimized)
 * @param {object} org - Organization object
 * @returns {string[]} Array of heritage types
 */
function getCulturalHeritage(org) {
  if (!org || typeof org !== 'object') return [];
  
  const heritage = new Set();
  
  // Map for faster lookup and normalization
  const heritageMap = {
    jewish_heritage: 'jewish',
    irish_heritage: 'irish',
    italian_heritage: 'italian',
    polish_heritage: 'polish',
    greek_heritage: 'greek',
    armenian_heritage: 'armenian',
    cajun_creole_heritage: 'cajun creole',
    pacific_islander: 'pacific islander',
    middle_eastern: 'middle eastern',
    white_caucasian: 'white caucasian',
    multiracial: 'multiracial',
    african_american: 'african american',
    hispanic_latino: 'hispanic latino',
    asian_american: 'asian american',
    native_american: 'native american'
  };
  
  // Single pass with map
  for (const field in heritageMap) {
    if (org[field]) {
      heritage.add(heritageMap[field]);
    }
  }
  
  // Add array fields
  if (Array.isArray(org.cultural_heritage)) {
    org.cultural_heritage.forEach(h => heritage.add(h));
  }
  
  if (Array.isArray(org.race_ethnicity)) {
    org.race_ethnicity.forEach(r => heritage.add(r));
  }
  
  return Array.from(heritage);
}

/**
 * Get military status summary
 * @param {object} org - Organization object
 * @returns {object} Military status object
 */
function getMilitaryStatus(org) {
  if (!org || typeof org !== 'object') {
    return {
      isVeteran: false,
      isActiveDuty: false,
      isNationalGuard: false,
      isDisabledVeteran: false,
      isMilitarySpouse: false,
      isMilitaryDependent: false,
      isGoldStarFamily: false,
      branch: null,
      dischargeType: null,
      vaDisabilityPercent: 0,
      hasGIBill: false,
      hasCHAMPVA: false,
      hasDd214: false,
      campaignMedals: []
    };
  }
  
  return {
    isVeteran: org.veteran || false,
    isActiveDuty: org.active_duty_military || false,
    isNationalGuard: org.national_guard || false,
    isDisabledVeteran: org.disabled_veteran || false,
    isMilitarySpouse: org.military_spouse || false,
    isMilitaryDependent: org.military_dependent || false,
    isGoldStarFamily: org.gold_star_family || false,
    branch: org.military_branch || null,
    dischargeType: org.character_of_discharge || null,
    vaDisabilityPercent: org.va_disability_percent || 0,
    hasGIBill: org.post_911_gi_bill || false,
    hasCHAMPVA: org.champva || false,
    hasDd214: org.dd214_on_file || false,
    campaignMedals: org.campaign_medals || []
  };
}

/**
 * Get health/disability summary (optimized)
 * @param {object} org - Organization object
 * @returns {object} Health status object
 */
function getHealthStatus(org) {
  if (!org || typeof org !== 'object') {
    return {
      conditions: [],
      hasDisability: false,
      cancerType: null,
      chronicIllnessType: null,
      rareDiseaseType: null,
      supportNeedsLevel: null,
      disabilityTypes: [],
      needsAssistiveTech: false,
      isTelehealthCapable: false,
      isHCBSEligible: false
    };
  }
  
  const conditions = [];
  
  // Single-pass with direct checks
  if (org.cancer_survivor) conditions.push('cancer survivor');
  if (org.chronic_illness) conditions.push('chronic illness');
  if (org.dialysis_patient) conditions.push('dialysis patient');
  if (org.organ_transplant) conditions.push('organ transplant');
  if (org.hiv_aids) conditions.push('hiv aids');
  if (org.tbi_survivor) conditions.push('tbi survivor');
  if (org.amputee) conditions.push('amputee');
  if (org.neurodivergent) conditions.push('neurodivergent');
  if (org.visual_impairment) conditions.push('visual impairment');
  if (org.hearing_impairment) conditions.push('hearing impairment');
  if (org.wheelchair_user) conditions.push('wheelchair user');
  if (org.substance_recovery) conditions.push('substance recovery');
  if (org.mental_health_condition) conditions.push('mental health condition');
  if (org.long_covid) conditions.push('long covid');
  if (org.maternal_health) conditions.push('maternal health');
  if (org.hospice_care) conditions.push('hospice care');
  if (org.rare_disease) conditions.push('rare disease');
  if (org.behavioral_health_smi) conditions.push('behavioral health smi');
  if (org.behavioral_health_sed) conditions.push('behavioral health sed');
  if (org.oud_moud_participant) conditions.push('oud moud participant');
  if (org.dental_need) conditions.push('dental need');
  
  return {
    conditions,
    hasDisability: conditions.length > 0 || (org.disabilities?.length > 0),
    cancerType: org.cancer_type || null,
    chronicIllnessType: org.chronic_illness_type || null,
    rareDiseaseType: org.rare_disease_type || null,
    supportNeedsLevel: org.support_needs_level || null,
    disabilityTypes: org.disability_type || [],
    needsAssistiveTech: org.assistive_tech_need || false,
    isTelehealthCapable: org.telehealth_capable || false,
    isHCBSEligible: org.hcbs_waiver_eligible || false
  };
}

/**
 * Get occupation/work status summary (optimized)
 * @param {object} org - Organization object
 * @returns {object} Work status object
 */
function getWorkStatus(org) {
  if (!org || typeof org !== 'object') {
    return {
      occupations: [],
      isUnemployed: false,
      isUnderemployed: false,
      isDisplacedWorker: false,
      isUnionMember: false,
      unionLocal: null,
      healthcareWorkerType: null,
      licensureCerts: [],
      farmAcreage: 0,
      usdaPrograms: []
    };
  }
  
  const occupations = [];
  
  // Direct checks (faster than array iteration)
  if (org.student) occupations.push('student');
  if (org.healthcare_worker) occupations.push('healthcare worker');
  if (org.ems_worker) occupations.push('ems worker');
  if (org.educator) occupations.push('educator');
  if (org.firefighter) occupations.push('firefighter');
  if (org.law_enforcement) occupations.push('law enforcement');
  if (org.public_servant) occupations.push('public servant');
  if (org.clergy) occupations.push('clergy');
  if (org.missionary) occupations.push('missionary');
  if (org.nonprofit_employee) occupations.push('nonprofit employee');
  if (org.small_business_owner) occupations.push('small business owner');
  if (org.farmer) occupations.push('farmer');
  if (org.truck_driver) occupations.push('truck driver');
  if (org.construction_trades_worker) occupations.push('construction trades worker');
  if (org.researcher_scientist) occupations.push('researcher scientist');
  if (org.environmental_conservation_worker) occupations.push('environmental conservation worker');
  if (org.energy_sector_worker) occupations.push('energy sector worker');
  if (org.artist_musician_cultural_worker) occupations.push('artist musician cultural worker');
  if (org.migrant_farmworker) occupations.push('migrant farmworker');
  
  return {
    occupations,
    isUnemployed: org.unemployed || false,
    isUnderemployed: org.underemployed || false,
    isDisplacedWorker: org.displaced_worker || false,
    isUnionMember: org.union_member || false,
    unionLocal: org.union_local || null,
    healthcareWorkerType: org.healthcare_worker_type || null,
    licensureCerts: org.licensure_certs || [],
    farmAcreage: org.farmer_acreage || 0,
    usdaPrograms: org.usda_programs || []
  };
}

/**
 * Get financial status summary
 * @param {object} org - Organization object
 * @returns {object} Financial status object
 */
function getFinancialStatus(org) {
  if (!org || typeof org !== 'object') {
    return {
      householdIncome: null,
      householdSize: null,
      isLowIncome: false,
      isRentBurdened: false,
      hasUtilityArrears: false,
      hasMedicalDebt: false,
      hasEducationDebt: false,
      isFirstTimeHomebuyer: false,
      hasBankruptcy: false,
      isUninsured: false,
      hasRecentIncomeShock: false
    };
  }
  
  return {
    householdIncome: org.household_income || null,
    householdSize: org.household_size || null,
    isLowIncome: org.low_income || false,
    isRentBurdened: org.rent_burdened || org.severely_rent_burdened || false,
    hasUtilityArrears: org.utility_arrears || false,
    hasMedicalDebt: org.medical_debt || false,
    hasEducationDebt: org.education_debt || false,
    isFirstTimeHomebuyer: org.first_time_homebuyer || false,
    hasBankruptcy: org.bankruptcy || false,
    isUninsured: org.uninsured || false,
    hasRecentIncomeShock: org.recent_income_shock || false
  };
}

/**
 * Get government assistance programs (optimized)
 * @param {object} org - Organization object
 * @returns {object} Assistance programs object
 */
function getGovernmentAssistance(org) {
  if (!org || typeof org !== 'object') {
    return {
      programs: [],
      medicaidWaiverProgram: null,
      tennCareId: null
    };
  }
  
  const programs = [];
  
  // Direct checks (faster than array iteration + regex)
  if (org.medicaid_enrolled) programs.push('medicaid enrolled');
  if (org.medicare_recipient) programs.push('medicare');
  if (org.ssi_recipient) programs.push('ssi');
  if (org.ssdi_recipient) programs.push('ssdi');
  if (org.snap_recipient) programs.push('snap');
  if (org.tanf_recipient) programs.push('tanf');
  if (org.section8_housing) programs.push('section8 housing');
  if (org.public_housing_resident) programs.push('public housing resident');
  if (org.wic_recipient) programs.push('wic');
  if (org.chip_recipient) programs.push('chip');
  if (org.head_start_participant) programs.push('head start participant');
  if (org.liheap_recipient) programs.push('liheap');
  if (org.lifeline_acp_recipient) programs.push('lifeline acp');
  if (org.wioa_services) programs.push('wioa services');
  if (org.vocational_rehab) programs.push('vocational rehab');
  if (org.eitc_eligible) programs.push('eitc eligible');
  if (org.ryan_white) programs.push('ryan white');
  
  return {
    programs,
    medicaidWaiverProgram: org.medicaid_waiver_program || null,
    tennCareId: org.tenncare_id || null
  };
}

/**
 * Build complete profile context for crawlers
 * @param {object} org - Organization object
 * @returns {object} Rich profile context - NEVER null, always safe defaults
 */
export function buildProfileContext(org) {
  // SAFE DEFAULT: Return empty context instead of null to prevent crashes
  if (!org) {
    return {
      id: null,
      name: '',
      applicantType: 'organization',
      address: { street: null, city: null, state: null, zip: null, additionalZips: [], allSearchZips: [] },
      demographics: { raceEthnicity: [], culturalHeritage: [], tribalAffiliation: null, immigrationStatus: null, isLGBTQ: false, isNewImmigrant: false },
      religious: { affiliations: [], denominationalAffiliation: null, isFaithBased: false, hasStatementOfFaith: false, isOrdainedClergy: false, yearsInMinistry: 0, activeMinistries: [] },
      military: { isVeteran: false, isActiveDuty: false, isNationalGuard: false, isDisabledVeteran: false, isMilitarySpouse: false, isMilitaryDependent: false, isGoldStarFamily: false, branch: null, dischargeType: null, vaDisabilityPercent: 0, hasGIBill: false, hasCHAMPVA: false, hasDd214: false, campaignMedals: [] },
      health: { conditions: [], hasDisability: false, cancerType: null, chronicIllnessType: null, rareDiseaseType: null, supportNeedsLevel: null, disabilityTypes: [], needsAssistiveTech: false, isTelehealthCapable: false, isHCBSEligible: false, icd10Codes: [], primaryDiagnosis: null },
      education: { currentCollege: null, intendedMajor: null, gpa: null, actScore: null, satScore: null, greScore: null, targetColleges: [], targetCollegeZips: [], educationHistory: [], educationHistoryZips: [], isFirstGeneration: false, isPellEligible: false, hasFAFSA: false, isSTEM: false, communityServiceHours: 0, honorSocieties: [], competitionsAwards: [] },
      work: { occupations: [], isUnemployed: false, isUnderemployed: false, isDisplacedWorker: false, isUnionMember: false, unionLocal: null, healthcareWorkerType: null, licensureCerts: [], farmAcreage: 0 },
      financial: { householdIncome: null, householdSize: null, isLowIncome: false, isRentBurdened: false, hasUtilityArrears: false, hasMedicalDebt: false, hasEducationDebt: false, isFirstTimeHomebuyer: false, hasBankruptcy: false, isUninsured: false, hasRecentIncomeShock: false },
      assistance: { programs: [], medicaidWaiverProgram: null, tennCareId: null },
      family: { isSingleParent: false, isFosterYouth: false, isHomeless: false, isRefugee: false, isCaregiver: false, isOrphan: false, isAdopted: false, isWidow: false, isGrandparentRaising: false, isDomesticViolenceSurvivor: false, isTraffickingSurvivor: false, isDisasterSurvivor: false, isFormerlyIncarcerated: false },
      geographic: { isRural: false, isAppalachian: false, isUrbanUnderserved: false, isQCT: false, isOpportunityZone: false, isEJArea: false, isPersistentPoverty: false, isTribalLand: false, isFEMADisaster: false, isBroadbandUnserved: false },
      organization: { ein: null, uei: null, nonprofitType: null, annualBudget: null, staffCount: null, isSAMRegistered: false, is501c3: false, isFQHC: false, isMinorityOwned: false, isWomenOwned: false, isVeteranOwned: false, isHUBZone: false },
      matching: { keywords: [], focusAreas: [], programAreas: [], assistanceCategories: [], mission: null, primaryGoal: null, targetPopulation: null, geographicFocus: null },
      age: { dateOfBirth: null, age: null, isSenior55Plus: false, isSenior62Plus: false, isSenior65Plus: false, isMinor: false, isYoungAdult: false },
      _raw: {}
    };
  }
  
  // Derive additional ZIPs from colleges
  const collegeZips = deriveZipsFromColleges(org.target_colleges || []);
  const educationZips = deriveZipsFromEducationHistory(org.education_history || []);
  
  // Collect all relevant ZIPs
  const allZips = [
    org.zip,
    ...collegeZips,
    ...educationZips
  ].filter(Boolean);
  
  // Deduplicate
  const uniqueZips = [...new Set(allZips)];
  
  return {
    // Identity
    id: org.id,
    name: org.name,
    applicantType: org.applicant_type || 'organization',
    
    // Location
    address: {
      street: org.address || null,
      city: org.city || null,
      state: org.state || null,
      zip: org.zip || null,
      additionalZips: uniqueZips.filter(z => z !== org.zip),
      allSearchZips: uniqueZips
    },
    
    // Demographics & Heritage
    demographics: {
      raceEthnicity: org.race_ethnicity || [],
      culturalHeritage: getCulturalHeritage(org),
      tribalAffiliation: org.tribal_affiliation || null,
      immigrationStatus: org.immigration_status || null,
      isLGBTQ: org.lgbtq || org.lgbtq_plus || false,
      isNewImmigrant: org.new_immigrant || false
    },
    
    // Religious
    religious: {
      affiliations: getReligiousAffiliations(org),
      denominationalAffiliation: org.denominational_affiliation || null,
      isFaithBased: org.faith_based || false,
      hasStatementOfFaith: org.statement_of_faith || false,
      isOrdainedClergy: org.ordained_clergy || false,
      yearsInMinistry: org.years_in_ministry || 0,
      activeMinistries: org.active_ministries || []
    },
    
    // Military
    military: getMilitaryStatus(org),
    
    // Health & Disability
    health: {
      ...getHealthStatus(org),
      icd10Codes: org.icd10_codes || [],
      primaryDiagnosis: org.primary_diagnosis || null
    },
    
    // Education
    education: {
      currentCollege: org.current_college || null,
      intendedMajor: org.intended_major || null,
      gpa: org.gpa || null,
      actScore: org.act_score || null,
      satScore: org.sat_score || null,
      greScore: org.gre_score || null,
      targetColleges: org.target_colleges || [],
      targetCollegeZips: collegeZips,
      educationHistory: org.education_history || [],
      educationHistoryZips: educationZips,
      isFirstGeneration: org.first_generation || false,
      isPellEligible: org.pell_eligible || false,
      hasFAFSA: org.fafsa_completed || false,
      isSTEM: org.stem_student || false,
      communityServiceHours: org.community_service_hours || 0,
      honorSocieties: org.honor_societies || [],
      competitionsAwards: org.competitions_awards || []
    },
    
    // Work & Occupation
    work: getWorkStatus(org),
    
    // Financial
    financial: getFinancialStatus(org),
    
    // Government Assistance
    assistance: getGovernmentAssistance(org),
    
    // Family Situation
    family: {
      isSingleParent: org.single_parent || false,
      isFosterYouth: org.foster_youth || false,
      isHomeless: org.homeless || false,
      isRefugee: org.refugee || false,
      isCaregiver: org.caregiver || false,
      isOrphan: org.orphan || false,
      isAdopted: org.adopted || false,
      isWidow: org.widow_widower || false,
      isGrandparentRaising: org.grandparent_raising_grandchildren || false,
      isDomesticViolenceSurvivor: org.domestic_violence_survivor || false,
      isTraffickingSurvivor: org.trafficking_survivor || false,
      isDisasterSurvivor: org.disaster_survivor || false,
      disasterIncidentNumber: org.disaster_incident_number || null,
      disasterYear: org.disaster_year || null,
      isFormerlyIncarcerated: org.formerly_incarcerated || org.returning_citizen || false,
      isFosterParent: org.foster_parent || false,
      isKinshipCare: org.kinship_care || false,
      isEvictionRisk: org.eviction_risk || false,
      isPregnancyParentingStudent: org.pregnancy_parenting_student || false,
      isRunawayHomelessYouth: org.runaway_homeless_youth || false,
      isJusticeImpacted: org.justice_impacted || false,
      isFirstTimeParent: org.first_time_parent || false
    },
    
    // Firearms / Second Amendment
    firearms: {
      isGunOwner: org.gun_owner || false,
      hasConcealedCarryPermit: org.concealed_carry_permit || false,
      isNRAMember: org.nra_member || false,
      isNRACertifiedInstructor: org.nra_certified_instructor || false,
      isFirearmsSafetyInstructor: org.firearms_safety_instructor || false,
      isSecondAmendmentAdvocate: org.second_amendment_advocate || false,
      worksInFirearmsIndustry: org.firearms_industry || false,
      isCompetitiveShooter: org.competitive_shooter || false,
      isHunter: org.hunter || false,
      huntingLicenseStates: org.hunting_license_state || null
    },
    
    // Political / Civic Engagement
    political: {
      isElectedOfficial: org.elected_official || false,
      officeHeld: org.public_office_held || null,
      yearsInOffice: org.years_in_office || null,
      isPoliticalCandidate: org.political_candidate || false,
      partyAffiliation: org.political_party_affiliation || null,
      isPartyCommitteeMember: org.party_committee_member || false,
      partyLeadershipPosition: org.party_leadership_position || null,
      isCampaignVolunteer: org.campaign_volunteer || false,
      isPoliticalActivist: org.political_activist || false,
      civicEngagementLevel: org.civic_engagement_level || null,
      isMunicipalOfficial: org.municipal_official || false,
      isCountyOfficial: org.county_official || false,
      isStateOfficial: org.state_official || false,
      isFederalOfficial: org.federal_official || false,
      hasCampaignFinanceExperience: org.campaign_finance_experience || false,
      policyExpertiseAreas: org.policy_expertise_areas || []
    },
    
    // Geographic Designations
    geographic: {
      isRural: org.rural || org.rural_resident || false,
      isFrontierCounty: org.frontier_county || false,
      isAppalachian: org.appalachian_region || false,
      isUrbanUnderserved: org.urban_underserved || false,
      isQCT: org.qct || false,
      isOpportunityZone: org.opportunity_zone || false,
      isEJArea: org.ej_area || false,
      isPersistentPoverty: org.persistent_poverty_county || false,
      isTribalLand: org.tribal_land || false,
      isUSTerritory: org.us_territory || false,
      isFEMADisaster: org.fema_disaster_area || false,
      isPromiseZone: org.promise_zone || false,
      isChoiceNeighborhood: org.choice_neighborhood || false,
      isDeltaRegion: org.delta_regional_authority || false,
      isNorthernBorder: org.northern_border_commission || false,
      isDenaliRegion: org.denali_commission || false,
      isColonias: org.colonias || false,
      isNMTCEligible: org.nmtc_eligible || false,
      isBrownfield: org.brownfield_site || false,
      isBroadbandUnserved: org.broadband_unserved || false,
      isWUIRisk: org.wui_risk || false,
      isFloodplain: org.floodplain || false,
      isMUA: org.mua_status || false,
      crsScore: org.crs_score || null,
      rucaCode: org.ruca_code || null,
      hpsaScore: org.hpsa_score || null,
      distanceToServices: org.distance_to_services || null,
      broadbandSpeed: org.broadband_speed || null,
      percentAMI: org.percent_ami || null
    },
    
    // Organization Details (if applicable)
    organization: {
      ein: org.ein || null,
      uei: org.uei || null,
      cageCode: org.cage_code || null,
      nonprofitType: org.nonprofit_type || null,
      organizationType: org.organization_type || null,
      annualBudget: org.annual_budget || null,
      staffCount: org.staff_count || null,
      isSAMRegistered: org.sam_registered || false,
      hasGrantsGovAccount: org.grants_gov_account || false,
      hasERACommons: org.era_commons_account || false,
      hasStateVendorReg: org.state_vendor_registration || false,
      hasCharitableSolicitationReg: org.charitable_solicitation_registered || false,
      hasSAMExclusionsCheck: org.sam_exclusions_check || false,
      hasAuditedFinancials: org.audited_financials || false,
      singleAuditYear: org.single_audit_year || null,
      hasNICRA: org.nicra || false,
      nicraRate: org.nicra_rate || null,
      nteeCode: org.ntee_code || null,
      evidenceBasedProgram: org.evidence_based_program || null,
      is501c3: org.c3_public_charity || org.c3_private_foundation || false,
      isPublicCharity: org.c3_public_charity || false,
      isPrivateFoundation: org.c3_private_foundation || false,
      isFQHC: org.fqhc || false,
      isCommunityActionAgency: org.community_action_agency || false,
      isCDC: org.cdc_org || false,
      isHousingAuthority: org.housing_authority || false,
      isWorkforceBoard: org.workforce_board || false,
      isVeteransServiceOrg: org.veterans_service_org || false,
      isVolunteerFireEMS: org.volunteer_fire_ems || false,
      isResearchInstitute: org.research_institute || false,
      isCooperative: org.cooperative || false,
      isCDFIPartner: org.cdfi_partner || false,
      isMSI: org.msi_institution || false,
      isRuralHealthClinic: org.rural_health_clinic || false,
      isEnvironmentalOrg: org.environmental_org || false,
      isLaborUnionOrg: org.labor_union_org || false,
      isAgriculturalExtension: org.agricultural_extension || false,
      isMinorityOwned: org.minority_owned_business || org.mbe || false,
      isWomenOwned: org.women_owned_business || org.wbe || false,
      isVeteranOwned: org.sdvosb || false,
      is8a: org.business_8a || false,
      isHUBZone: org.hubzone || false,
      isDBE: org.dbe || false,
      isSBE: org.sbe || false,
      isSBIRSTTREligible: org.sbir_sttr_eligible || false,
      sbirSttrEmployeeCount: org.sbir_sttr_employee_count || null,
      naicsCodes: org.naics_codes || [],
      businessCertifications: org.business_certifications || [],
      insuranceGLLimits: org.insurance_gl_limits || null,
      hasWorkersComp: org.insurance_workers_comp || false,
      hasCyberInsurance: org.insurance_cyber || false,
      dataProtections: org.data_protections || [],
      mouPartnerships: org.mou_partnerships || []
    },
    
    // Keywords & Interests (for matching)
    matching: {
      keywords: org.keywords || [],
      focusAreas: org.focus_areas || [],
      programAreas: org.program_areas || [],
      assistanceCategories: org.assistance_categories || [],
      mission: org.mission || null,
      primaryGoal: org.primary_goal || null,
      targetPopulation: org.target_population || null,
      geographicFocus: org.geographic_focus || null
    },
    
    // Age/Senior Status
    age: {
      dateOfBirth: org.date_of_birth || null,
      age: org.age || null,
      isSenior55Plus: org.senior_55_plus || false,
      isSenior62Plus: org.senior_62_plus || false,
      isSenior65Plus: org.senior_65_plus || false,
      isMinor: org.minor_child || false,
      isYoungAdult: org.young_adult || false
    },
    
    // Raw org for fallback access
    _raw: org
  };
}

export { deriveZipsFromColleges, deriveZipsFromEducationHistory };