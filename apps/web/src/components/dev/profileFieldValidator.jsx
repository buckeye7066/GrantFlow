/**
 * Profile Field Validator
 * Development-time validator to ensure UI fields match entity schema
 * 
 * Usage:
 *   import { validateFieldBindings } from '@/components/dev/profileFieldValidator';
 *   validateFieldBindings('Organization', organization, uiFieldList);
 */

const ORGANIZATION_UI_FIELDS = [
  // Contact
  'name', 'email', 'phone', 'website', 'date_of_birth', 'age', 'ssn', 'green_card_number',
  'address', 'city', 'state', 'zip',
  
  // Organization
  'applicant_type', 'ein', 'uei', 'cage_code', 'organization_type', 'nonprofit_type',
  'annual_budget', 'staff_count', 'indirect_rate', 'indirect_cost_rate', 'nicra_rate',
  
  // Keywords & Focus
  'keywords', 'focus_areas', 'program_areas', 'assistance_categories', 'mission',
  'primary_goal', 'target_population', 'geographic_focus', 'funding_amount_needed',
  'timeline', 'past_experience', 'unique_qualities', 'collaboration_partners',
  'sustainability_plan', 'barriers_faced', 'special_circumstances', 'goals', 'unique_story',
  'funding_need', 'challenges_barriers', 'support_system',
  
  // Education
  'current_college', 'intended_major', 'gpa', 'act_score', 'sat_score', 'gre_score',
  'gmat_score', 'lsat_score', 'mcat_score', 'community_service_hours', 'first_generation',
  'education_history', 'target_colleges', 'extracurricular_activities', 'awards_achievements',
  'achievements', 'frpl_percentage', 'idea_disability_category', 'cte_pathway', 'efc_sai_band',
  'housing_status', 'student_housing_status', 'planned_enrollment_term', 'planned_enrollment_year',
  'honor_societies', 'competitions_awards', 'grade_levels', 'education_types', 'test_scores',
  'student_qualifiers', 'academic_characteristics',
  
  // Education booleans
  'title_i_school', 'iep_504', 'dual_enrollment', 'rotc_jrotc', 'civil_air_patrol',
  'work_study_eligible', 'faith_based_college', 'athletics_commitment', 'arts_commitment',
  'arts_humanities_field', 'medical_nursing_field', 'education_social_work_field',
  'trade_apprenticeship_participant', 'ged_graduate', 'returning_adult_student', 'stem_student',
  'recent_graduate', 'pell_eligible', 'fafsa_completed', 'student_with_dependents',
  'homeschool_family', 'private_school_student', 'charter_school_student', 'virtual_academy_student',
  'parent_led_education', 'homeschool_coop_member', 'esa_eligible', 'education_choice_participant',
  
  // Health & Disability
  'cancer_survivor', 'cancer_type', 'cancer_diagnosis_year', 'chronic_illness', 'chronic_illness_type',
  'dialysis_patient', 'organ_transplant', 'hiv_aids', 'tbi_survivor', 'amputee', 'neurodivergent',
  'visual_impairment', 'hearing_impairment', 'wheelchair_user', 'substance_recovery',
  'mental_health_condition', 'long_covid', 'maternal_health', 'hospice_care',
  'rare_disease', 'rare_disease_type', 'behavioral_health_smi', 'behavioral_health_sed',
  'oud_moud_participant', 'dental_need', 'assistive_tech_need', 'telehealth_capable',
  'hcbs_waiver_eligible', 'maternal_risk', 'genetic_testing', 'clinical_trial_ready',
  'no_pcp', 'vision_need', 'hearing_need', 'support_needs_level', 'disability_type',
  'disabilities', 'health_conditions', 'health_condition_details', 'icd10_codes', 'primary_diagnosis',
  
  // Demographics
  'african_american', 'hispanic_latino', 'asian_american', 'native_american', 'lgbtq',
  'lgbtq_plus', 'new_immigrant', 'tribal_affiliation', 'race_ethnicity', 'immigration_status',
  
  // Cultural Heritage
  'cultural_heritage', 'jewish_heritage', 'irish_heritage', 'italian_heritage', 'polish_heritage',
  'greek_heritage', 'armenian_heritage', 'cajun_creole_heritage', 'pacific_islander',
  'middle_eastern', 'white_caucasian', 'multiracial',
  
  // Religious Affiliations (all denominational booleans)
  'religious_affiliation', 'religious_denomination', 'religious_affiliation_other',
  'religious_affiliation_christian', 'religious_affiliation_catholic', 'religious_affiliation_roman_catholic',
  'religious_affiliation_eastern_catholic', 'religious_affiliation_orthodox', 'religious_affiliation_greek_orthodox',
  'religious_affiliation_russian_orthodox', 'religious_affiliation_antiochian_orthodox',
  'religious_affiliation_coptic_orthodox', 'religious_affiliation_ethiopian_orthodox',
  'religious_affiliation_baptist', 'religious_affiliation_southern_baptist', 'religious_affiliation_freewill_baptist',
  'religious_affiliation_independent_baptist', 'religious_affiliation_missionary_baptist',
  'religious_affiliation_primitive_baptist', 'religious_affiliation_american_baptist',
  'religious_affiliation_national_baptist', 'religious_affiliation_reformed_baptist',
  'religious_affiliation_pentecostal', 'religious_affiliation_church_of_god', 'religious_affiliation_cogop',
  'religious_affiliation_assemblies_of_god', 'religious_affiliation_foursquare', 'religious_affiliation_apostolic',
  'religious_affiliation_upci', 'religious_affiliation_cogic', 'religious_affiliation_charismatic',
  'religious_affiliation_vineyard', 'religious_affiliation_methodist', 'religious_affiliation_united_methodist',
  'religious_affiliation_global_methodist', 'religious_affiliation_free_methodist', 'religious_affiliation_wesleyan',
  'religious_affiliation_ame', 'religious_affiliation_ame_zion', 'religious_affiliation_cme',
  'religious_affiliation_nazarene', 'religious_affiliation_salvation_army', 'religious_affiliation_lutheran',
  'religious_affiliation_elca', 'religious_affiliation_lcms', 'religious_affiliation_wels',
  'religious_affiliation_presbyterian', 'religious_affiliation_pcusa', 'religious_affiliation_pca',
  'religious_affiliation_epc', 'religious_affiliation_reformed', 'religious_affiliation_crc',
  'religious_affiliation_protestant', 'religious_affiliation_evangelical', 'religious_affiliation_nondenominational',
  'religious_affiliation_disciples_of_christ', 'religious_affiliation_church_of_christ',
  'religious_affiliation_episcopal', 'religious_affiliation_congregational',
  'religious_affiliation_christian_missionary_alliance', 'religious_affiliation_covenant',
  'religious_affiliation_brethren', 'religious_affiliation_amish', 'religious_affiliation_mennonite',
  'religious_affiliation_hutterite', 'religious_affiliation_brethren_in_christ', 'religious_affiliation_quaker',
  'religious_affiliation_seventh_day_adventist', 'religious_affiliation_latter_day_saints',
  'religious_affiliation_jehovahs_witness', 'religious_affiliation_unity', 'religious_affiliation_christian_science',
  'religious_affiliation_jewish', 'religious_affiliation_reform_jewish', 'religious_affiliation_conservative_jewish',
  'religious_affiliation_orthodox_jewish', 'religious_affiliation_hasidic', 'religious_affiliation_reconstructionist',
  'religious_affiliation_messianic_jewish', 'religious_affiliation_muslim', 'religious_affiliation_sunni',
  'religious_affiliation_shia', 'religious_affiliation_sufi', 'religious_affiliation_nation_of_islam',
  'religious_affiliation_ahmadiyya', 'religious_affiliation_buddhist', 'religious_affiliation_zen',
  'religious_affiliation_tibetan_buddhist', 'religious_affiliation_theravada', 'religious_affiliation_mahayana',
  'religious_affiliation_pure_land', 'religious_affiliation_hindu', 'religious_affiliation_vaishnava',
  'religious_affiliation_shaiva', 'religious_affiliation_shakta', 'religious_affiliation_hare_krishna',
  'religious_affiliation_sikh', 'religious_affiliation_bahai', 'religious_affiliation_jain',
  'religious_affiliation_zoroastrian', 'religious_affiliation_shinto', 'religious_affiliation_taoist',
  'religious_affiliation_confucian', 'religious_affiliation_unitarian', 'religious_affiliation_wiccan',
  'religious_affiliation_native_american_spirituality', 'religious_affiliation_spiritual_not_religious',
  'religious_affiliation_agnostic', 'religious_affiliation_atheist',
  
  // Ministry & Clergy
  'denominational_affiliation', 'clergy_credential_level', 'years_in_ministry',
  'pastoral_assignment_type', 'ecclesial_status', 'statement_of_faith', 'non_proselytizing_policy',
  'ordained_clergy', 'chaplaincy_links', 'active_ministries', 'facility_assets',
  
  // Family & Life
  'single_parent', 'foster_youth', 'homeless', 'low_income', 'refugee', 'formerly_incarcerated',
  'returning_citizen', 'caregiver', 'orphan', 'adopted', 'widow_widower',
  'grandparent_raising_grandchildren', 'first_time_parent', 'domestic_violence_survivor',
  'trafficking_survivor', 'disaster_survivor', 'minor_child', 'young_adult', 'foster_parent',
  'kinship_care', 'eviction_risk', 'pregnancy_parenting_student', 'runaway_homeless_youth',
  'justice_impacted', 'migrant_farmworker', 'lep', 'family_life_situations',
  
  // Military
  'veteran', 'active_duty_military', 'national_guard', 'disabled_veteran', 'military_spouse',
  'military_dependent', 'gold_star_family', 'military_branch', 'character_of_discharge',
  'va_disability_percent', 'gold_star_relationship', 'guard_reserve_activation',
  'dd214_on_file', 'vso_representation', 'post_911_gi_bill', 'vr_and_e', 'champva',
  'campaign_medals', 'military_service',
  
  // Occupation
  'student', 'healthcare_worker', 'healthcare_worker_type', 'ems_worker', 'educator',
  'firefighter', 'law_enforcement', 'public_servant', 'clergy', 'missionary', 'nonprofit_employee',
  'small_business_owner', 'minority_owned_business', 'women_owned_business', 'union_member',
  'farmer', 'truck_driver', 'construction_trades_worker', 'researcher_scientist',
  'environmental_conservation_worker', 'energy_sector_worker', 'artist_musician_cultural_worker',
  'occupation_work', 'occupation_details', 'union_membership', 'union_local', 'work_characteristics',
  'shift_work', 'high_hazard_industry', 'irb_iacuc_ibc', 'farm_details', 'farmer_acreage',
  'licensure_certs', 'usda_programs', 'prior_grant_numbers', 'firearms_qualifications',
  'hunting_licenses', 'political_civic',
  
  // Financial
  'household_income', 'household_size', 'financial_challenges', 'unemployed', 'underemployed',
  'displaced_worker', 'job_retraining', 'uninsured', 'medical_debt', 'education_debt',
  'bankruptcy', 'first_time_homebuyer', 'rent_burdened', 'severely_rent_burdened',
  'utility_arrears', 'transportation_insecurity', 'childcare_cost_burden', 'recent_income_shock',
  'credit_score_good', 'good_credit_score',
  
  // Government Assistance
  'government_assistance', 'medicaid_enrolled', 'medicaid_waiver_program', 'medicaid_number',
  'medicare_recipient', 'ssi_recipient', 'ssdi_recipient', 'snap_recipient', 'tanf_recipient',
  'section8_housing', 'public_housing_resident', 'tenncare_id', 'wic_recipient', 'chip_recipient',
  'head_start_participant', 'liheap_recipient', 'lifeline_acp_recipient', 'wioa_services',
  'vocational_rehab', 'eitc_eligible', 'ryan_white',
  
  // Geographic
  'rural', 'rural_resident', 'frontier_county', 'appalachian_region', 'urban_underserved',
  'qct', 'opportunity_zone', 'ej_area', 'persistent_poverty_county', 'tribal_land',
  'us_territory', 'fema_disaster_area', 'broadband_unserved', 'mua_status', 'promise_zone',
  'choice_neighborhood', 'delta_regional_authority', 'northern_border_commission',
  'denali_commission', 'colonias', 'nmtc_eligible', 'brownfield_site', 'wui_risk',
  'floodplain', 'crs_score', 'ruca_code', 'hpsa_score', 'distance_to_services',
  'broadband_speed', 'percent_ami', 'geographic_designations',
  
  // Organization Qualifications
  'sam_registered', 'faith_based', 'minority_serving', 'c3_public_charity', 'c3_private_foundation',
  'fqhc', 'community_action_agency', 'cdc_org', 'housing_authority', 'workforce_board',
  'veterans_service_org', 'volunteer_fire_ems', 'research_institute', 'cooperative',
  'cdfi_partner', 'msi_institution', 'rural_health_clinic', 'environmental_org',
  'labor_union_org', 'agricultural_extension', 'specialized_org_types', 'specialized_org_details',
  'organization_qualifications',
  
  // Business Certifications
  'business_8a', 'sdvosb', 'hubzone', 'dbe', 'mbe', 'wbe', 'sbe', 'business_certifications',
  'naics_codes', 'sba_size_standard', 'size_standard_status',
  
  // Capacity & Compliance
  'grants_gov_account', 'era_commons_account', 'state_vendor_registration',
  'charitable_solicitation_registered', 'nicra', 'audited_financials', 'single_audit_year',
  'sam_exclusions_check', 'hipaa_compliant', 'ferpa_compliant', 'cfr_part_2_compliant',
  'community_governance', 'deia_plan', 'fiscal_sponsor', 'endowment_size',
  'board_staff_demographics', 'data_protections', 'existing_mous', 'mou_partnerships',
  'liability_coverage', 'insurance_types', 'insurance_gl_limits', 'insurance_workers_comp',
  'insurance_cyber', 'federal_registrations', 'ntee_code', 'evidence_based_program',
  
  // Research
  'research_expenditures', 'irb_fwa_number', 'tech_transfer_office', 'sbir_sttr_experience',
  'sbir_sttr_eligible', 'carnegie_classification', 'iacuc_ibc_approvals', 'data_use_agreements',
  
  // Healthcare Organization
  'uds_reporter', 'three_forty_b_participation', 'joint_commission', 'ncqa_pcmh',
  'carf_accreditation', 'telehealth_capacity', 'ehr_vendor', 'hie_participation',
  'cms_certified_rhc', 'cost_based_reimbursement',
  
  // Specialized Capacity
  'csbg_eligible_entity', 'roma_outcomes', 'wap_participation', 'hud_chdo', 'lihtc_development',
  'mtw_status', 'rad_experience', 'fss_hcv_metrics', 'wioa_performance', 'etpl_role',
  'va_ssvf_gpd', 'vso_accreditation', 'nfpa_compliance', 'iso_rating', 'afg_safer_history',
  'csi_tsi_designation', 'perkins_v_ready', 'school_safety_team',
  
  // Tribal
  'pl_93_638_compacting', 'ihs_service_unit', 'icdbg_nahasda_experience',
  'bia_bie_relationships', 'tribal_resolution_process',
  
  // Agriculture/Land/Energy
  'reap_usda_experience', 'member_count', 'service_territory', 'land_trust_accreditation',
  'stewardship_acres', 'nepa_readiness', 'registered_apprenticeship', 'taft_hartley_fund',
  'smith_lever_projects', 'county_extension_mou',
  
  // Business/Institutional
  'cmmc_nist_800_171', 'iso_certifications', 'energy_star_green', 'export_ready',
  'cdfi_certified', 'cdfi_target_market', 'cdfi_deployment_ratio', 'msi_designation_year',
  'student_threshold_met',
  
  // Seniors
  'senior_55_plus', 'senior_62_plus', 'senior_65_plus',
  
  // Misc
  'pro_bono', 'profile_image_url'
];

/**
 * Validates that all UI fields exist on the entity object
 * Logs warnings for missing fields
 * 
 * @param {string} entityName - Name of the entity (e.g., 'Organization')
 * @param {object} entityObject - The entity data object
 * @param {string[]} uiBindings - Array of field names the UI expects
 */
// Cached validation results to prevent repeated checks
const validationCache = new Map();

export function validateFieldBindings(entityName, entityObject, uiBindings = null) {
  const isDev = typeof window !== 'undefined' && window.location.hostname === 'localhost';
  if (!isDev) {
    return; // Only run in development
  }
  
  // Cache key based on entity ID (prevents re-validation on same entity)
  const cacheKey = `${entityName}_${entityObject?.id}`;
  if (validationCache.has(cacheKey)) {
    return validationCache.get(cacheKey);
  }
  
  const fieldsToCheck = uiBindings || ORGANIZATION_UI_FIELDS;
  const missing = [];
  const nullFields = [];
  
  // Single pass through fields
  for (const field of fieldsToCheck) {
    if (!(field in entityObject)) {
      missing.push(field);
    } else if (entityObject[field] === null || entityObject[field] === undefined) {
      nullFields.push(field);
    }
  }
  
  if (missing.length > 0) {
    console.warn(
      `[Field Validator] ${entityName}: ${missing.length} UI fields not present on entity object:`,
      missing.slice(0, 10), // Show first 10
      missing.length > 10 ? `... and ${missing.length - 10} more` : ''
    );
  }
  
  console.log(
    `[Field Validator] ${entityName}: ${fieldsToCheck.length - missing.length}/${fieldsToCheck.length} fields validated`,
    { nullFields: nullFields.length }
  );
  
  const result = { missing, nullFields, total: fieldsToCheck.length };
  validationCache.set(cacheKey, result);
  
  return result;
}

/**
 * Verifies that saved data matches what was sent
 * @param {object} sentData - The data that was sent to the server
 * @param {object} returnedData - The data returned from the server
 */
export function verifySaveResult(sentData, returnedData) {
  const isDev = typeof window !== 'undefined' && window.location.hostname === 'localhost';
  if (!isDev) {
    return { success: true };
  }
  
  const mismatches = [];
  
  // Optimized: Only stringify once per value
  const sentKeys = Object.keys(sentData);
  for (const key of sentKeys) {
    const sentValue = sentData[key];
    const returnedValue = returnedData[key];
    
    // Fast equality check first (for primitives)
    if (sentValue === returnedValue) continue;
    
    // Deep compare only when needed
    if (JSON.stringify(sentValue) !== JSON.stringify(returnedValue)) {
      mismatches.push({
        field: key,
        sent: sentValue,
        received: returnedValue
      });
    }
  }
  
  if (mismatches.length > 0) {
    console.error(
      '[Save Verification] MISMATCH DETECTED - Data did not save correctly:',
      mismatches
    );
    return { success: false, mismatches };
  }
  
  console.log('[Save Verification] All fields saved correctly');
  return { success: true };
}

export { ORGANIZATION_UI_FIELDS };