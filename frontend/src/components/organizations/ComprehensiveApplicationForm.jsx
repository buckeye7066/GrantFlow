import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { 
  User, GraduationCap, Heart, Briefcase, MapPin, FileText, 
  CheckCircle, ChevronRight, ChevronLeft, Upload, AlertCircle, Building2,
  Shield, Stethoscope, Users
} from "lucide-react";
import MultiSelectCombobox from "../shared/MultiSelectCombobox";
import { Badge } from "@/components/ui/badge";

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

const GRADE_LEVELS = [
  { value: 'high_school_freshman', label: 'High School Freshman (9th)' },
  { value: 'high_school_sophomore', label: 'High School Sophomore (10th)' },
  { value: 'high_school_junior', label: 'High School Junior (11th)' },
  { value: 'high_school_senior', label: 'High School Senior (12th)' },
  { value: 'college_freshman', label: 'College Freshman' },
  { value: 'college_sophomore', label: 'College Sophomore' },
  { value: 'college_junior', label: 'College Junior' },
  { value: 'college_senior', label: 'College Senior' },
  { value: 'graduate', label: 'Graduate Student' },
];

export default function ComprehensiveApplicationForm({ onSubmit, onCancel, isSubmitting, initialData = {} }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState({
    // Basic Info
    name: initialData.name || "",
    date_of_birth: initialData.date_of_birth || "",
    email: initialData.email || "",
    phone: initialData.phone || "",
    address: initialData.address || "",
    city: initialData.city || "",
    state: initialData.state || "",
    zip: initialData.zip || "",
    website: initialData.website || "", // ADDED
    age: initialData.age || null,
    good_credit_score: initialData.good_credit_score || false,

    // Profile Type
    applicant_type: initialData.applicant_type || "",
    
    // Student Fields
    student_grade_levels: initialData.student_grade_levels || [],
    current_college: initialData.current_college || "",
    target_colleges: initialData.target_colleges || [],
    gpa: initialData.gpa || null,
    act_score: initialData.act_score || null,
    sat_score: initialData.sat_score || null,
    gre_score: initialData.gre_score || null,
    gmat_score: initialData.gmat_score || null,
    lsat_score: initialData.lsat_score || null,
    mcat_score: initialData.mcat_score || null,
    intended_major: initialData.intended_major || "",
    first_generation: initialData.first_generation || false,
    stem_student: initialData.stem_student || false,
    arts_humanities_field: initialData.arts_humanities_field || false,
    medical_nursing_field: initialData.medical_nursing_field || false,
    education_social_work_field: initialData.education_social_work_field || false,
    trade_apprenticeship_participant: initialData.trade_apprenticeship_participant || false,
    extracurricular_activities: initialData.extracurricular_activities || [],
    achievements: initialData.achievements || [],
    community_service_hours: initialData.community_service_hours || null,
    
    // Student Enhancements
    title_i_school: initialData.title_i_school || false,
    frpl_percentage: initialData.frpl_percentage || null, // ADDED
    iep_504: initialData.iep_504 || false,
    idea_disability_category: initialData.idea_disability_category || "",
    cte_pathway: initialData.cte_pathway || "",
    dual_enrollment: initialData.dual_enrollment || false,
    rotc_jrotc: initialData.rotc_jrotc || false,
    civil_air_patrol: initialData.civil_air_patrol || false,
    honor_societies: initialData.honor_societies || [],
    competitions_awards: initialData.competitions_awards || [],
    work_study_eligible: initialData.work_study_eligible || false,
    efc_sai_band: initialData.efc_sai_band || "",
    housing_status: initialData.housing_status || "",
    faith_based_college: initialData.faith_based_college || false,
    athletics_commitment: initialData.athletics_commitment || false,
    arts_commitment: initialData.arts_commitment || false,
    pell_eligible: initialData.pell_eligible || false,
    fafsa_completed: initialData.fafsa_completed || false,
    
    // Education types
    ged_graduate: initialData.ged_graduate || false,
    returning_adult_student: initialData.returning_adult_student || false,
    homeschool_family: initialData.homeschool_family || false,
    private_school_student: initialData.private_school_student || false,
    charter_school_student: initialData.charter_school_student || false,
    virtual_academy_student: initialData.virtual_academy_student || false,
    parent_led_education: initialData.parent_led_education || false,
    homeschool_coop_member: initialData.homeschool_coop_member || false,
    esa_eligible: initialData.esa_eligible || false,
    education_choice_participant: initialData.education_choice_participant || false,
    student_with_dependents: initialData.student_with_dependents || false,
    
    // Financial
    household_income: initialData.household_income || null,
    household_size: initialData.household_size || null,
    percent_ami: initialData.percent_ami || null, // ADDED
    financial_need_level: initialData.financial_need_level || "",
    low_income: initialData.low_income || false,
    unemployed: initialData.unemployed || false,
    underemployed: initialData.underemployed || false,
    displaced_worker: initialData.displaced_worker || false,
    job_retraining: initialData.job_retraining || false,
    uninsured: initialData.uninsured || false,
    medical_debt: initialData.medical_debt || false,
    education_debt: initialData.education_debt || false,
    bankruptcy: initialData.bankruptcy || false,
    first_time_homebuyer: initialData.first_time_homebuyer || false,
    rent_burdened: initialData.rent_burdened || false,
    severely_rent_burdened: initialData.severely_rent_burdened || false,
    utility_arrears: initialData.utility_arrears || false,
    transportation_insecurity: initialData.transportation_insecurity || false,
    childcare_cost_burden: initialData.childcare_cost_burden || false,
    recent_income_shock: initialData.recent_income_shock || false,
    
    // Government Assistance
    medicaid_enrolled: initialData.medicaid_enrolled || false,
    medicaid_waiver_program: initialData.medicaid_waiver_program || "none",
    medicare_recipient: initialData.medicare_recipient || false,
    ssi_recipient: initialData.ssi_recipient || false,
    ssdi_recipient: initialData.ssdi_recipient || false,
    snap_recipient: initialData.snap_recipient || false,
    tanf_recipient: initialData.tanf_recipient || false,
    wic_recipient: initialData.wic_recipient || false,
    chip_recipient: initialData.chip_recipient || false,
    head_start_participant: initialData.head_start_participant || false,
    section8_housing: initialData.section8_housing || false,
    public_housing_resident: initialData.public_housing_resident || false,
    liheap_recipient: initialData.liheap_recipient || false,
    lifeline_acp_recipient: initialData.lifeline_acp_recipient || false,
    wioa_services: initialData.wioa_services || false,
    vocational_rehab: initialData.vocational_rehab || false,
    eitc_eligible: initialData.eitc_eligible || false,
    ryan_white: initialData.ryan_white || false,
    tenncare_id: initialData.tenncare_id || "",
    
    // Immigration & Citizenship
    immigration_status: initialData.immigration_status || "us_citizen",
    permanent_resident: initialData.permanent_resident || false,
    refugee: initialData.refugee || false,
    new_immigrant: initialData.new_immigrant || false,
    
    // Demographics
    african_american: initialData.african_american || false,
    hispanic_latino: initialData.hispanic_latino || false,
    asian_american: initialData.asian_american || false,
    native_american: initialData.native_american || false,
    tribal_affiliation: initialData.tribal_affiliation || "",
    pacific_islander: initialData.pacific_islander || false,
    middle_eastern: initialData.middle_eastern || false,
    white_caucasian: initialData.white_caucasian || false,
    multiracial: initialData.multiracial || false,
    
    // Cultural Heritage
    jewish_heritage: initialData.jewish_heritage || false,
    irish_heritage: initialData.irish_heritage || false,
    italian_heritage: initialData.italian_heritage || false,
    polish_heritage: initialData.polish_heritage || false,
    greek_heritage: initialData.greek_heritage || false,
    armenian_heritage: initialData.armenian_heritage || false,
    cajun_creole_heritage: initialData.cajun_creole_heritage || false,
    
    // Religious Affiliations
    religious_affiliation_christian: initialData.religious_affiliation_christian || false,
    religious_affiliation_catholic: initialData.religious_affiliation_catholic || false,
    religious_affiliation_protestant: initialData.religious_affiliation_protestant || false,
    religious_affiliation_baptist: initialData.religious_affiliation_baptist || false,
    religious_affiliation_methodist: initialData.religious_affiliation_methodist || false,
    religious_affiliation_lutheran: initialData.religious_affiliation_lutheran || false,
    religious_affiliation_presbyterian: initialData.religious_affiliation_presbyterian || false,
    religious_affiliation_pentecostal: initialData.religious_affiliation_pentecostal || false,
    religious_affiliation_orthodox: initialData.religious_affiliation_orthodox || false,
    religious_affiliation_latter_day_saints: initialData.religious_affiliation_latter_day_saints || false,
    religious_affiliation_amish: initialData.religious_affiliation_amish || false,
    religious_affiliation_mennonite: initialData.religious_affiliation_mennonite || false,
    religious_affiliation_quaker: initialData.religious_affiliation_quaker || false,
    religious_affiliation_jewish: initialData.religious_affiliation_jewish || false,
    religious_affiliation_reform_jewish: initialData.religious_affiliation_reform_jewish || false,
    religious_affiliation_conservative_jewish: initialData.religious_affiliation_conservative_jewish || false,
    religious_affiliation_orthodox_jewish: initialData.religious_affiliation_orthodox_jewish || false,
    religious_affiliation_muslim: initialData.religious_affiliation_muslim || false,
    religious_affiliation_sunni: initialData.religious_affiliation_sunni || false,
    religious_affiliation_shia: initialData.religious_affiliation_shia || false,
    religious_affiliation_buddhist: initialData.religious_affiliation_buddhist || false,
    religious_affiliation_hindu: initialData.religious_affiliation_hindu || false,
    religious_affiliation_sikh: initialData.religious_affiliation_sikh || false,
    religious_affiliation_wiccan: initialData.wiccan || false,
    religious_affiliation_unitarian: initialData.unitarian || false,
    religious_affiliation_other: initialData.religious_affiliation_other || "",
    
    lgbtq: initialData.lgbtq || false,
    
    // Health & Medical
    cancer_survivor: initialData.cancer_survivor || false,
    cancer_type: initialData.cancer_type || "",
    cancer_diagnosis_year: initialData.cancer_diagnosis_year || null,
    chronic_illness: initialData.chronic_illness || false,
    chronic_illness_type: initialData.chronic_illness_type || "",
    rare_disease: initialData.rare_disease || false,
    rare_disease_type: initialData.rare_disease_type || "",
    disability_type: initialData.disability_type || [],
    support_needs_level: initialData.support_needs_level || "",
    dialysis_patient: initialData.dialysis_patient || false,
    organ_transplant: initialData.organ_transplant || false,
    hiv_aids: initialData.hiv_aids || false,
    long_covid: initialData.long_covid || false,
    tbi_survivor: initialData.tbi_survivor || false,
    amputee: initialData.amputee || false,
    neurodivergent: initialData.neurodivergent || false,
    visual_impairment: initialData.visual_impairment || false,
    hearing_impairment: initialData.hearing_impairment || false,
    wheelchair_user: initialData.wheelchair_user || false,
    substance_recovery: initialData.substance_recovery || false,
    mental_health_condition: initialData.mental_health_condition || false,
    maternal_health: initialData.maternal_health || false,
    hospice_care: initialData.hospice_care || false,
    behavioral_health_smi: initialData.behavioral_health_smi || false,
    behavioral_health_sed: initialData.behavioral_health_sed || false,
    oud_moud_participant: initialData.oud_moud_participant || false,
    dental_need: initialData.dental_need || false,
    assistive_tech_need: initialData.assistive_tech_need || false,
    
    // Family & Life Situation
    single_parent: initialData.single_parent || false,
    foster_youth: initialData.foster_youth || false,
    orphan: initialData.orphan || false,
    adopted: initialData.adopted || false,
    foster_parent: initialData.foster_parent || false,
    caregiver: initialData.caregiver || false,
    kinship_care: initialData.kinship_care || false,
    widow_widower: initialData.widow_widower || false,
    grandparent_raising_grandchildren: initialData.grandparent_raising_grandchildren || false,
    first_time_parent: initialData.first_time_parent || false,
    pregnancy_parenting_student: initialData.pregnancy_parenting_student || false,
    homeless: initialData.homeless || false,
    runaway_homeless_youth: initialData.runaway_homeless_youth || false,
    eviction_risk: initialData.eviction_risk || false,
    
    // Trauma & Recovery
    domestic_violence_survivor: initialData.domestic_violence_survivor || false,
    trafficking_survivor: initialData.trafficking_survivor || false,
    disaster_survivor: initialData.disaster_survivor || false,
    disaster_incident_number: initialData.disaster_incident_number || "",
    disaster_year: initialData.disaster_year || null,
    formerly_incarcerated: initialData.formerly_incarcerated || false,
    returning_citizen: initialData.returning_citizen || false,
    justice_impacted: initialData.justice_impacted || false,
    
    // Military
    veteran: initialData.veteran || false,
    military_branch: initialData.military_branch || "",
    campaign_medals: initialData.campaign_medals || [],
    character_of_discharge: initialData.character_of_discharge || "",
    dd214_on_file: initialData.dd214_on_file || false,
    va_disability_percent: initialData.va_disability_percent || null,
    active_duty_military: initialData.active_duty_military || false,
    national_guard: initialData.national_guard || false,
    guard_reserve_activation: initialData.guard_reserve_activation || "",
    disabled_veteran: initialData.disabled_veteran || false,
    military_spouse: initialData.military_spouse || false,
    military_dependent: initialData.military_dependent || false,
    gold_star_family: initialData.gold_star_family || false,
    gold_star_relationship: initialData.gold_star_relationship || "",
    post_911_gi_bill: initialData.post_911_gi_bill || false, // Moved from Government Assistance
    vr_and_e: initialData.vr_and_e || false, // Moved from Government Assistance
    champva: initialData.champva || false, // Moved from Government Assistance
    vso_representation: initialData.vso_representation || false,
    
    // Occupation
    healthcare_worker: initialData.healthcare_worker || false,
    healthcare_worker_type: initialData.healthcare_worker_type || "",
    licensure_certs: initialData.licensure_certs || [],
    ems_worker: initialData.ems_worker || false,
    educator: initialData.educator || false,
    firefighter: initialData.firefighter || false,
    law_enforcement: initialData.law_enforcement || false,
    public_servant: initialData.public_servant || false,
    clergy: initialData.clergy || false,
    missionary: initialData.missionary || false,
    nonprofit_employee: initialData.nonprofit_employee || false,
    small_business_owner: initialData.small_business_owner || false,
    minority_owned_business: initialData.minority_owned_business || false,
    women_owned_business: initialData.women_owned_business || false,
    union_member: initialData.union_member || false,
    union_local: initialData.union_local || "",
    shift_work: initialData.shift_work || false,
    high_hazard_industry: initialData.high_hazard_industry || false,
    farmer: initialData.farmer || false,
    farmer_acreage: initialData.farmer_acreage || null,
    usda_programs: initialData.usda_programs || [],
    truck_driver: initialData.truck_driver || false,
    construction_trades_worker: initialData.construction_trades_worker || false,
    researcher_scientist: initialData.researcher_scientist || false,
    environmental_conservation_worker: initialData.environmental_conservation_worker || false,
    energy_sector_worker: initialData.energy_sector_worker || false,
    artist_musician_cultural_worker: initialData.artist_musician_cultural_worker || false,
    recent_graduate: initialData.recent_graduate || false,
    
    // Firearms / Second Amendment
    gun_owner: initialData.gun_owner || false,
    concealed_carry_permit: initialData.concealed_carry_permit || false,
    nra_member: initialData.nra_member || false,
    nra_certified_instructor: initialData.nra_certified_instructor || false,
    firearms_safety_instructor: initialData.firearms_safety_instructor || false,
    second_amendment_advocate: initialData.second_amendment_advocate || false,
    firearms_industry: initialData.firearms_industry || false,
    competitive_shooter: initialData.competitive_shooter || false,
    hunter: initialData.hunter || false,
    hunting_license_state: initialData.hunting_license_state || "",
    
    // Political / Civic Engagement
    elected_official: initialData.elected_official || false,
    public_office_held: initialData.public_office_held || "",
    years_in_office: initialData.years_in_office || null,
    political_candidate: initialData.political_candidate || false,
    political_party_affiliation: initialData.political_party_affiliation || "none",
    party_committee_member: initialData.party_committee_member || false,
    party_leadership_position: initialData.party_leadership_position || "",
    campaign_volunteer: initialData.campaign_volunteer || false,
    political_activist: initialData.political_activist || false,
    civic_engagement_level: initialData.civic_engagement_level || "none",
    municipal_official: initialData.municipal_official || false,
    county_official: initialData.county_official || false,
    state_official: initialData.state_official || false,
    federal_official: initialData.federal_official || false,
    campaign_finance_experience: initialData.campaign_finance_experience || false,
    policy_expertise_areas: initialData.policy_expertise_areas || [],
    
    // Age Categories
    minor_child: initialData.minor_child || false,
    young_adult: initialData.young_adult || false,
    senior_55_plus: initialData.senior_55_plus || false,
    senior_62_plus: initialData.senior_62_plus || false,
    senior_65_plus: initialData.senior_65_plus || false,
    
    // Geographic
    rural_resident: initialData.rural_resident || false,
    appalachian_region: initialData.appalachian_region || false,
    urban_underserved: initialData.urban_underserved || false,
    frontier_county: initialData.frontier_county || false,
    ruca_code: initialData.ruca_code || "",
    hpsa_score: initialData.hpsa_score || null,
    mua_status: initialData.mua_status || false,
    distance_to_services: initialData.distance_to_services || null,
    broadband_speed: initialData.broadband_speed || null,
    qct: initialData.qct || false,
    opportunity_zone: initialData.opportunity_zone || false,
    ej_area: initialData.ej_area || false,
    persistent_poverty_county: initialData.persistent_poverty_county || false,
    tribal_land: initialData.tribal_land || false,
    us_territory: initialData.us_territory || false,
    fema_disaster_area: initialData.fema_disaster_area || false,
    promise_zone: initialData.promise_zone || false,
    choice_neighborhood: initialData.choice_neighborhood || false,
    delta_regional_authority: initialData.delta_regional_authority || false,
    northern_border_commission: initialData.northern_border_commission || false,
    denali_commission: initialData.denali_commission || false,
    colonias: initialData.colonias || false,
    nmtc_eligible: initialData.nmtc_eligible || false,
    brownfield_site: initialData.brownfield_site || false,
    broadband_unserved: initialData.broadband_unserved || false,
    wui_risk: initialData.wui_risk || false,
    floodplain: initialData.floodplain || false,
    crs_score: initialData.crs_score || null,
    
    // Other demographics
    lep: initialData.lep || false,
    migrant_farmworker: initialData.migrant_farmworker || false,
    business_affected_covid: initialData.business_affected_covid || false,
    
    // Profile Narrative
    mission: initialData.mission || "",
    primary_goal: initialData.primary_goal || "",
    target_population: initialData.target_population || "",
    geographic_focus: initialData.geographic_focus || "",
    funding_amount_needed: initialData.funding_amount_needed || "",
    timeline: initialData.timeline || "",
    past_experience: initialData.past_experience || "",
    unique_qualities: initialData.unique_qualities || "",
    collaboration_partners: initialData.collaboration_partners || "",
    sustainability_plan: initialData.sustainability_plan || "",
    barriers_faced: initialData.barriers_faced || "",
    special_circumstances: initialData.special_circumstances || "",
    keywords: initialData.keywords || [],
    focus_areas: initialData.focus_areas || [],
    
    // Additional missing fields to match entity
    cage_code: initialData.cage_code || "",
    c3_public_charity: initialData.c3_public_charity || false,
    c3_private_foundation: initialData.c3_private_foundation || false,
    denominational_affiliation: initialData.denominational_affiliation || "",
    clergy_credential_level: initialData.clergy_credential_level || "",
    years_in_ministry: initialData.years_in_ministry || null,
    pastoral_assignment_type: initialData.pastoral_assignment_type || "",
    ecclesial_status: initialData.ecclesial_status || "",
    statement_of_faith: initialData.statement_of_faith || false,
    non_proselytizing_policy: initialData.non_proselytizing_policy || false,
    ordained_clergy: initialData.ordained_clergy || false,
    chaplaincy_links: initialData.chaplaincy_links || false,
    active_ministries: initialData.active_ministries || [],
    facility_assets: initialData.facility_assets || [],
    hcbs_waiver_eligible: initialData.hcbs_waiver_eligible || false,
    maternal_risk: initialData.maternal_risk || false,
    genetic_testing: initialData.genetic_testing || false,
    clinical_trial_ready: initialData.clinical_trial_ready || false,
    no_pcp: initialData.no_pcp || false,
    telehealth_capable: initialData.telehealth_capable || false,
    // Firearms / Second Amendment
    gun_owner: initialData.gun_owner || false,
    concealed_carry_permit: initialData.concealed_carry_permit || false,
    nra_member: initialData.nra_member || false,
    nra_certified_instructor: initialData.nra_certified_instructor || false,
    firearms_safety_instructor: initialData.firearms_safety_instructor || false,
    second_amendment_advocate: initialData.second_amendment_advocate || false,
    firearms_industry: initialData.firearms_industry || false,
    competitive_shooter: initialData.competitive_shooter || false,
    hunter: initialData.hunter || false,
    hunting_license_state: initialData.hunting_license_state || "",
    // Political / Civic
    elected_official: initialData.elected_official || false,
    public_office_held: initialData.public_office_held || "",
    years_in_office: initialData.years_in_office || null,
    political_candidate: initialData.political_candidate || false,
    political_party_affiliation: initialData.political_party_affiliation || "none",
    party_committee_member: initialData.party_committee_member || false,
    party_leadership_position: initialData.party_leadership_position || "",
    campaign_volunteer: initialData.campaign_volunteer || false,
    political_activist: initialData.political_activist || false,
    civic_engagement_level: initialData.civic_engagement_level || "none",
    municipal_official: initialData.municipal_official || false,
    county_official: initialData.county_official || false,
    state_official: initialData.state_official || false,
    federal_official: initialData.federal_official || false,
    campaign_finance_experience: initialData.campaign_finance_experience || false,
    policy_expertise_areas: initialData.policy_expertise_areas || [],
    disaster_incident_number: initialData.disaster_incident_number || "",
    disaster_year: initialData.disaster_year || null,
  });

  const steps = [
    { 
      id: 'type', 
      title: 'Profile Type', 
      icon: User,
      description: 'What type of applicant are you?'
    },
    { 
      id: 'basic', 
      title: 'Basic Information', 
      icon: User,
      description: 'Your personal information'
    },
    { 
      id: 'student', 
      title: 'Education', 
      icon: GraduationCap,
      description: 'Academic background',
      show: () => ['high_school_student', 'college_student', 'graduate_student', 'homeschool_family'].includes(formData.applicant_type)
    },
    { 
      id: 'financial', 
      title: 'Financial Situation', 
      icon: Briefcase,
      description: 'Income and financial need'
    },
    { 
      id: 'assistance', 
      title: 'Government Assistance', 
      icon: Heart,
      description: 'Benefits you receive'
    },
    { 
      id: 'health', 
      title: 'Health & Medical', 
      icon: Stethoscope,
      description: 'Health conditions and needs'
    },
    { 
      id: 'demographics', 
      title: 'Demographics', 
      icon: Users,
      description: 'Background information'
    },
    { 
      id: 'family', 
      title: 'Family & Life', 
      icon: Heart,
      description: 'Family situation'
    },
    { 
      id: 'military', 
      title: 'Military Status', 
      icon: Shield,
      description: 'Military service'
    },
    { 
      id: 'occupation', 
      title: 'Occupation', 
      icon: Briefcase,
      description: 'Your profession'
    },
    { 
      id: 'firearms', 
      title: 'Firearms / 2A', 
      icon: Shield,
      description: 'Shooting sports & hunting',
      // currentStep is 0-indexed, so occupation is 9. Firearms is 10.
      show: () => formData.gun_owner || formData.hunter || formData.nra_member || currentStep >= 10
    },
    { 
      id: 'political', 
      title: 'Political / Civic', 
      icon: Building2,
      description: 'Elected office & civic engagement',
      // currentStep is 0-indexed, so firearms is 10. Political is 11.
      show: () => formData.elected_official || formData.political_candidate || currentStep >= 11
    },
    { 
      id: 'location', 
      title: 'Location', 
      icon: MapPin,
      description: 'Where you live'
    },
    { 
      id: 'narrative', 
      title: 'Your Story', 
      icon: FileText,
      description: 'Tell us about yourself'
    },
    { 
      id: 'review', 
      title: 'Review', 
      icon: CheckCircle,
      description: 'Review and submit'
    }
  ];

  const visibleSteps = steps.filter(step => !step.show || step.show());
  const progress = ((currentStep + 1) / visibleSteps.length) * 100;

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleNext = () => {
    if (currentStep < visibleSteps.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const sanitizeFormData = (data) => {
    let finalData = { ...data };
    
    // Sanitize string fields - remove empty strings and ensure they are strings
    const stringFields = ['email', 'phone', 'website', 'tenncare_id', 'tribal_affiliation', 
      'cancer_type', 'chronic_illness_type', 'rare_disease_type', 'military_branch', 
      'character_of_discharge', 'healthcare_worker_type', 'union_local', 'hunting_license_state',
      'public_office_held', 'party_leadership_position', 'ruca_code', 'disaster_incident_number',
      'idea_disability_category', 'cte_pathway', 'efc_sai_band', 'housing_status',
      'gold_star_relationship', 'guard_reserve_activation', 'religious_affiliation_other',
      'mission', 'primary_goal', 'target_population', 'geographic_focus', 'funding_amount_needed',
      'timeline', 'past_experience', 'unique_qualities', 'collaboration_partners', 
      'sustainability_plan', 'barriers_faced', 'special_circumstances', 'name', 'address',
      'city', 'state', 'zip', 'date_of_birth', 'intended_major', 'current_college',
      'financial_need_level', 'medicaid_waiver_program', 'immigration_status',
      'political_party_affiliation', 'civic_engagement_level', 'support_needs_level'];
    
    stringFields.forEach(field => {
      const value = finalData[field];
      if (value === '' || value === null || value === undefined) {
        delete finalData[field];
      } else if (typeof value !== 'string') {
        // Convert non-string values to string, or delete if it's an object/array
        if (typeof value === 'object') {
          delete finalData[field];
        } else {
          finalData[field] = String(value);
        }
      }
    });
    
    // Extra safety: ensure all remaining string-typed entity fields are actually strings
    Object.keys(finalData).forEach(key => {
      const val = finalData[key];
      // If it's an object but not an array and the field shouldn't be an object, delete it
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        // Only keep it if it's intentionally an object field (none in this entity)
        delete finalData[key];
      }
    });
    
    // Sanitize numeric fields - ensure they're numbers or null
    const numericFields = ['crs_score', 'hpsa_score', 'percent_ami', 'distance_to_services', 
      'broadband_speed', 'household_income', 'household_size', 'gpa', 'act_score', 'sat_score',
      'gre_score', 'gmat_score', 'lsat_score', 'mcat_score', 'community_service_hours',
      'va_disability_percent', 'farmer_acreage', 'years_in_office', 'years_in_ministry',
      'cancer_diagnosis_year', 'disaster_year', 'frpl_percentage', 'age'];
    
    numericFields.forEach(field => {
      if (finalData[field] === '' || finalData[field] === null || finalData[field] === undefined) {
        delete finalData[field];
      } else if (typeof finalData[field] === 'string') {
        const parsed = parseFloat(finalData[field]);
        if (!isNaN(parsed)) {
          finalData[field] = parsed;
        } else {
          delete finalData[field];
        }
      }
    });
    
    return finalData;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    // Calculate age from date of birth if provided
    let finalData = { ...formData };
    if (finalData.date_of_birth && !finalData.age) {
      const birthDate = new Date(finalData.date_of_birth);
      const today = new Date();
      const age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        finalData.age = age - 1;
      } else {
        finalData.age = age;
      }
    }
    
    // Auto-set age categories based on age
    if (finalData.age !== null) {
      finalData.minor_child = finalData.age < 18;
      finalData.young_adult = finalData.age >= 18 && finalData.age <= 24;
      finalData.senior_55_plus = finalData.age >= 55;
      finalData.senior_62_plus = finalData.age >= 62;
      finalData.senior_65_plus = finalData.age >= 65;
    }
    
    // Sanitize before submit
    finalData = sanitizeFormData(finalData);
    
    onSubmit(finalData);
  };
  
  const handleSaveProgress = () => {
    let dataToSave = sanitizeFormData(formData);
    // Mark as draft/incomplete
    dataToSave._isDraft = true;
    onSubmit(dataToSave);
  };

  const currentStepData = visibleSteps[currentStep];
  const CurrentIcon = currentStepData.icon;

  const isStudent = ['high_school_student', 'college_student', 'graduate_student', 'homeschool_family'].includes(formData.applicant_type);
  const isGraduateStudent = formData.applicant_type === 'graduate_student';

  return (
    <form onSubmit={handleSubmit} className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Progress Bar */}
      <div className="sticky top-0 bg-white z-10 pb-4 border-b">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-2xl font-bold">Comprehensive Application</h2>
          <Badge variant="outline">{currentStep + 1} of {visibleSteps.length}</Badge>
        </div>
        <Progress value={progress} className="h-2" />
        <div className="flex items-center gap-2 mt-3">
          <CurrentIcon className="w-5 h-5 text-blue-600" />
          <div>
            <p className="font-semibold">{currentStepData.title}</p>
            <p className="text-sm text-slate-600">{currentStepData.description}</p>
          </div>
        </div>
      </div>

      {/* Step Content */}
      <Card>
        <CardContent className="p-6 space-y-6">
          {/* STEP: Profile Type */}
          {currentStepData.id === 'type' && (
            <div className="space-y-6">
              <div>
                <CardTitle className="mb-2">Who are you applying as?</CardTitle>
                <CardDescription>Select the type that best describes you</CardDescription>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { value: 'high_school_student', label: 'High School Student', desc: 'Currently in grades 9-12' },
                  { value: 'college_student', label: 'College Student', desc: 'Undergraduate student' },
                  { value: 'graduate_student', label: 'Graduate Student', desc: 'Masters or PhD' },
                  { value: 'individual_need', label: 'Individual', desc: 'Seeking personal assistance' },
                  { value: 'medical_assistance', label: 'Medical Need', desc: 'Medical or health assistance' },
                  { value: 'family', label: 'Family', desc: 'Family seeking assistance' },
                ].map(type => (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => handleChange('applicant_type', type.value)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      formData.applicant_type === type.value
                        ? 'border-blue-600 bg-blue-50'
                        : 'border-slate-200 hover:border-blue-300'
                    }`}
                  >
                    <p className="font-semibold">{type.label}</p>
                    <p className="text-sm text-slate-600 mt-1">{type.desc}</p>
                  </button>
                ))}
              </div>

              <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                <div className="flex items-start gap-3 mb-3">
                  <Upload className="w-5 h-5 text-purple-600 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-purple-900">Upload Any Form with Personal Information</h4>
                    <p className="text-sm text-purple-700 mt-1">
                      Upload any completed application, intake form, medical form, or document with personal information. We'll extract all available data automatically.
                    </p>
                    <p className="text-xs text-purple-600 mt-2">
                      Accepted: Applications, intake forms, medical records, tax documents, IDs, transcripts, any form with personal data
                    </p>
                  </div>
                </div>
                <label htmlFor="app-upload" className="block">
                  <Button type="button" variant="outline" className="w-full" asChild>
                    <span>
                      <Upload className="w-4 h-4 mr-2" />
                      Upload Form or Document
                    </span>
                  </Button>
                </label>
                <input
                  id="app-upload"
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={(e) => {
                    // Trigger upload mode
                    if (e.target.files?.[0]) {
                      // Switch to upload form - don't call onCancel, let the parent handle the switch
                      const switchEvent = new CustomEvent('switch-to-upload', { detail: e.target.files[0] });
                      window.dispatchEvent(switchEvent);
                    }
                  }}
                />
              </div>
            </div>
          )}

          {/* STEP: Basic Information */}
          {currentStepData.id === 'basic' && (
            <div className="space-y-4">
              <CardTitle>Basic Information</CardTitle>
              <div>
                <Label htmlFor="name">Full Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                  placeholder="John Doe"
                  required
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="date_of_birth">Date of Birth</Label>
                  <Input
                    id="date_of_birth"
                    type="date"
                    value={formData.date_of_birth}
                    onChange={(e) => handleChange('date_of_birth', e.target.value)}
                  />
                  <p className="text-xs text-slate-500 mt-1">Used to determine age-based eligibility</p>
                </div>
                <div>
                  <Label htmlFor="email">Email Address</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => handleChange('email', e.target.value)}
                    placeholder="your@email.com"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="phone">Phone Number</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => handleChange('phone', e.target.value)}
                  placeholder="(555) 123-4567"
                />
              </div>
              {/* ADDED Website field */}
              <div>
                <Label htmlFor="website">Website / Portfolio (Optional)</Label>
                <Input
                  id="website"
                  type="url"
                  value={formData.website}
                  onChange={(e) => handleChange('website', e.target.value)}
                  placeholder="https://yourwebsite.com"
                />
              </div>
            </div>
          )}

          {/* STEP: Education (Students Only) */}
          {currentStepData.id === 'student' && isStudent && (
            <div className="space-y-6">
              <CardTitle>Education Details</CardTitle>
              
              <div>
                <Label>Grade Level(s) *</Label>
                <MultiSelectCombobox
                  options={GRADE_LEVELS}
                  selected={formData.student_grade_levels}
                  onSelectedChange={(values) => handleChange('student_grade_levels', values)}
                  placeholder="Select your grade level(s)"
                />
                <p className="text-xs text-slate-500 mt-1">Select all that apply</p>
              </div>
              
              {/* Education Type & Setting */}
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Education Type:</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'homeschool_family', label: 'Homeschool Student' },
                    { id: 'private_school_student', label: 'Private School' },
                    { id: 'charter_school_student', label: 'Charter/Micro-School' },
                    { id: 'virtual_academy_student', label: 'Virtual Academy' },
                    { id: 'parent_led_education', label: 'Parent-Led Education' },
                    { id: 'homeschool_coop_member', label: 'Homeschool Co-op Member' },
                    { id: 'esa_eligible', label: 'ESA Eligible' },
                    { id: 'education_choice_participant', label: 'Education Choice Participant' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>
              
              {(formData.applicant_type === 'college_student' || formData.applicant_type === 'graduate_student') && (
                <>
                  <div>
                    <Label htmlFor="current_college">Current College/University</Label>
                    <Input
                      id="current_college"
                      value={formData.current_college}
                      onChange={(e) => handleChange('current_college', e.target.value)}
                      placeholder="e.g., University of Tennessee"
                    />
                  </div>
                  <div>
                    <Label>Target/Interested Colleges</Label>
                    <MultiSelectCombobox
                      options={[]}
                      selected={formData.target_colleges}
                      onSelectedChange={(values) => handleChange('target_colleges', values)}
                      placeholder="Add colleges you're interested in..."
                      allowCustom
                    />
                  </div>
                </>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="intended_major">Intended Major</Label>
                  <Input
                    id="intended_major"
                    value={formData.intended_major}
                    onChange={(e) => handleChange('intended_major', e.target.value)}
                    placeholder="e.g., Computer Science"
                  />
                </div>
                <div>
                  <Label htmlFor="gpa">GPA</Label>
                  <Input
                    id="gpa"
                    type="number"
                    step="0.01"
                    value={formData.gpa || ""}
                    onChange={(e) => handleChange('gpa', parseFloat(e.target.value) || null)}
                    placeholder="3.75"
                  />
                </div>
              </div>

              {/* Test Scores */}
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Standardized Test Scores</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <Label htmlFor="act_score">ACT</Label>
                    <Input
                      id="act_score"
                      type="number"
                      value={formData.act_score || ""}
                      onChange={(e) => handleChange('act_score', parseInt(e.target.value) || null)}
                      placeholder="32"
                    />
                  </div>
                  <div>
                    <Label htmlFor="sat_score">SAT</Label>
                    <Input
                      id="sat_score"
                      type="number"
                      value={formData.sat_score || ""}
                      onChange={(e) => handleChange('sat_score', parseInt(e.target.value) || null)}
                      placeholder="1450"
                    />
                  </div>
                  <div>
                    <Label htmlFor="gre_score">GRE</Label>
                    <Input
                      id="gre_score"
                      type="number"
                      value={formData.gre_score || ""}
                      onChange={(e) => handleChange('gre_score', parseInt(e.target.value) || null)}
                      placeholder="320"
                    />
                  </div>
                  <div>
                    <Label htmlFor="gmat_score">GMAT</Label>
                    <Input
                      id="gmat_score"
                      type="number"
                      value={formData.gmat_score || ""}
                      onChange={(e) => handleChange('gmat_score', parseInt(e.target.value) || null)}
                      placeholder="650"
                    />
                  </div>
                </div>

                {isGraduateStudent && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="lsat_score">LSAT</Label>
                      <Input
                        id="lsat_score"
                        type="number"
                        value={formData.lsat_score || ""}
                        onChange={(e) => handleChange('lsat_score', parseInt(e.target.value) || null)}
                        placeholder="165"
                      />
                    </div>
                    <div>
                      <Label htmlFor="mcat_score">MCAT</Label>
                      <Input
                        id="mcat_score"
                        type="number"
                        value={formData.mcat_score || ""}
                        onChange={(e) => handleChange('mcat_score', parseInt(e.target.value) || null)}
                        placeholder="510"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <Label htmlFor="community_service_hours">Community Service Hours</Label>
                <Input
                  id="community_service_hours"
                  type="number"
                  value={formData.community_service_hours || ""}
                  onChange={(e) => handleChange('community_service_hours', parseInt(e.target.value) || null)}
                  placeholder="200"
                />
              </div>

              {/* Advanced Student Qualifiers */}
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Advanced Student Qualifiers:</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'title_i_school', label: 'Attends Title I School' },
                    { id: 'iep_504', label: 'IEP/504 Status' },
                    { id: 'dual_enrollment', label: 'Dual Enrollment / Early College' },
                    { id: 'rotc_jrotc', label: 'ROTC / JROTC Participation' },
                    { id: 'civil_air_patrol', label: 'Civil Air Patrol Involvement' },
                    { id: 'work_study_eligible', label: 'Work-Study Eligible' },
                    { id: 'faith_based_college', label: 'Faith-Based College' },
                    { id: 'athletics_commitment', label: 'Athletics Commitment' },
                    { id: 'arts_commitment', label: 'Arts Commitment' },
                    { id: 'pell_eligible', label: 'Pell Grant Eligible' },
                    { id: 'fafsa_completed', label: 'FAFSA Completed' },
                    { id: 'student_with_dependents', label: 'Student with Dependents' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
                
                {formData.title_i_school && ( // ADDED
                  <div>
                    <Label htmlFor="frpl_percentage">Free/Reduced Lunch Percentage</Label>
                    <Input
                      id="frpl_percentage"
                      type="number"
                      step="0.1"
                      value={formData.frpl_percentage || ""}
                      onChange={(e) => handleChange('frpl_percentage', parseFloat(e.target.value) || null)}
                      placeholder="e.g., 65.5"
                    />
                  </div>
                )}
                
                {formData.iep_504 && (
                  <div>
                    <Label htmlFor="idea_disability_category">IDEA Disability Category</Label>
                    <Input
                      id="idea_disability_category"
                      value={formData.idea_disability_category}
                      onChange={(e) => handleChange('idea_disability_category', e.target.value)}
                      placeholder="e.g., Specific Learning Disability, Autism"
                    />
                  </div>
                )}
                
                <div>
                  <Label htmlFor="cte_pathway">CTE Pathway</Label>
                  <Input
                    id="cte_pathway"
                    value={formData.cte_pathway}
                    onChange={(e) => handleChange('cte_pathway', e.target.value)}
                    placeholder="e.g., EMT, Welding, Cybersecurity"
                  />
                </div>
                
                <div>
                  <Label htmlFor="efc_sai_band">EFC/SAI Band</Label>
                  <Input
                    id="efc_sai_band"
                    value={formData.efc_sai_band}
                    onChange={(e) => handleChange('efc_sai_band', e.target.value)}
                    placeholder="e.g., 0-3000"
                  />
                </div>
                
                <div>
                  <Label htmlFor="housing_status">Student Housing Status</Label>
                  <Select
                    value={formData.housing_status}
                    onValueChange={(value) => handleChange('housing_status', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="on_campus">On-Campus Housing</SelectItem>
                      <SelectItem value="off_campus">Off-Campus Housing</SelectItem>
                      <SelectItem value="commuter">Commuter Student</SelectItem>
                      <SelectItem value="independent">Independent (Living Alone)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div>
                  <Label>Honor Societies</Label>
                  <MultiSelectCombobox
                    options={[]}
                    selected={formData.honor_societies}
                    onSelectedChange={(values) => handleChange('honor_societies', values)}
                    placeholder="e.g., NHS, Phi Theta Kappa"
                    allowCustom
                  />
                </div>
                
                <div>
                  <Label>Competitions/Awards</Label>
                  <MultiSelectCombobox
                    options={[]}
                    selected={formData.competitions_awards}
                    onSelectedChange={(values) => handleChange('competitions_awards', values)}
                    placeholder="e.g., Science Olympiad, HOSA"
                    allowCustom
                  />
                </div>
              </div>

              <div>
                <Label>Extracurricular Activities</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.extracurricular_activities}
                  onSelectedChange={(values) => handleChange('extracurricular_activities', values)}
                  placeholder="Add activities (soccer, band, debate, etc.)"
                  allowCustom
                />
              </div>

              <div>
                <Label>Achievements</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.achievements}
                  onSelectedChange={(values) => handleChange('achievements', values)}
                  placeholder="Add achievements..."
                  allowCustom
                />
              </div>

              {/* Academic Characteristics */}
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Academic Characteristics:</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'first_generation', label: 'First-Generation College Student' },
                    { id: 'stem_student', label: 'STEM Student' },
                    { id: 'arts_humanities_field', label: 'Arts/Humanities Field' },
                    { id: 'medical_nursing_field', label: 'Medical/Nursing/Allied Health' },
                    { id: 'education_social_work_field', label: 'Education/Social Work Field' },
                    { id: 'trade_apprenticeship_participant', label: 'Trade/Apprenticeship' },
                    { id: 'ged_graduate', label: 'GED Graduate' },
                    { id: 'returning_adult_student', label: 'Returning Adult Student' },
                    { id: 'recent_graduate', label: 'Recent Graduate' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP: Financial */}
          {currentStepData.id === 'financial' && (
            <div className="space-y-4">
              <CardTitle>Financial Situation</CardTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="household_income">Annual Household Income</Label>
                  <Input
                    id="household_income"
                    type="number"
                    value={formData.household_income || ""}
                    onChange={(e) => handleChange('household_income', parseFloat(e.target.value) || null)}
                    placeholder="50000"
                  />
                </div>
                <div>
                  <Label htmlFor="household_size">Household Size</Label>
                  <Input
                    id="household_size"
                    type="number"
                    value={formData.household_size || ""}
                    onChange={(e) => handleChange('household_size', parseInt(e.target.value) || null)}
                    placeholder="4"
                  />
                </div>
              </div>
              {/* ADDED percent_ami */}
              <div>
                <Label htmlFor="percent_ami">Percent of Area Median Income (AMI)</Label>
                <Input
                  id="percent_ami"
                  type="number"
                  step="0.1"
                  value={formData.percent_ami || ""}
                  onChange={(e) => handleChange('percent_ami', parseFloat(e.target.value) || null)}
                  placeholder="e.g., 80"
                />
              </div>
              <div>
                <Label htmlFor="financial_need_level">Financial Need Level</Label>
                <Select
                  value={formData.financial_need_level}
                  onValueChange={(value) => handleChange('financial_need_level', value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select level..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="moderate">Moderate</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <h3 className="font-semibold text-sm">Financial Challenges:</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'low_income', label: 'Low Income' },
                    { id: 'unemployed', label: 'Currently Unemployed' },
                    { id: 'underemployed', label: 'Underemployed' },
                    { id: 'displaced_worker', label: 'Displaced Worker' },
                    { id: 'job_retraining', label: 'Job Retraining Participant' },
                    { id: 'uninsured', label: 'Uninsured / Underinsured' },
                    { id: 'medical_debt', label: 'Medical Debt' },
                    { id: 'education_debt', label: 'Education Debt' },
                    { id: 'bankruptcy', label: 'Bankruptcy / Foreclosure' },
                    { id: 'first_time_homebuyer', label: 'First-Time Homebuyer' },
                    { id: 'rent_burdened', label: 'Rent-Burdened (>30%)' },
                    { id: 'severely_rent_burdened', label: 'Severely Rent-Burdened (>50%)' },
                    { id: 'utility_arrears', label: 'Utility Arrears' },
                    { id: 'transportation_insecurity', label: 'Transportation Insecurity' },
                    { id: 'childcare_cost_burden', label: 'Childcare Cost Burden' },
                    { id: 'recent_income_shock', label: 'Recent Income Shock' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP: Government Assistance */}
          {currentStepData.id === 'assistance' && (
            <div className="space-y-4">
              <CardTitle>Government Assistance Programs</CardTitle>
              <p className="text-sm text-slate-600">Select all programs you currently receive:</p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'medicaid_enrolled', label: 'Medicaid' },
                  { id: 'medicare_recipient', label: 'Medicare' },
                  { id: 'ssi_recipient', label: 'SSI' },
                  { id: 'ssdi_recipient', label: 'SSDI' },
                  { id: 'snap_recipient', label: 'SNAP (Food Stamps)' },
                  { id: 'tanf_recipient', label: 'TANF' },
                  { id: 'wic_recipient', label: 'WIC' },
                  { id: 'chip_recipient', label: 'CHIP' },
                  { id: 'head_start_participant', label: 'Head Start / Early Head Start' },
                  { id: 'section8_housing', label: 'Section 8 Housing' },
                  { id: 'public_housing_resident', label: 'Public Housing Resident' },
                  { id: 'liheap_recipient', label: 'LIHEAP' },
                  { id: 'lifeline_acp_recipient', label: 'Lifeline / ACP (Broadband)' },
                  { id: 'wioa_services', label: 'WIOA Services' },
                  { id: 'vocational_rehab', label: 'Vocational Rehabilitation' },
                  { id: 'eitc_eligible', label: 'EITC Eligible' },
                  { id: 'ryan_white', label: 'Ryan White HIV/AIDS Program' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                  </div>
                ))}
              </div>

              {formData.medicaid_enrolled && (
                <div className="space-y-4 p-4 bg-blue-50 rounded-lg">
                  <div>
                    <Label htmlFor="medicaid_waiver_program">Medicaid Waiver Program</Label>
                    <Select
                      value={formData.medicaid_waiver_program}
                      onValueChange={(value) => handleChange('medicaid_waiver_program', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="ecf_choices">ECF CHOICES (TN)</SelectItem>
                        <SelectItem value="katie_beckett">Katie Beckett</SelectItem>
                        <SelectItem value="self_determination">Self-Determination</SelectItem>
                        <SelectItem value="family_support">Family Support</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  {formData.medicaid_waiver_program === 'ecf_choices' && (
                    <div className="p-3 bg-green-100 border border-green-300 rounded-lg">
                      <div className="flex items-start gap-2">
                        <Heart className="w-5 h-5 text-green-600 mt-0.5" />
                        <div>
                          <p className="font-semibold text-green-900 text-sm">ECF CHOICES Enrolled</p>
                          <p className="text-xs text-green-800 mt-1">
                            You'll have access to the ECF CHOICES Services search, which finds TennCare-covered gyms, food banks, transportation, respite care, and DME suppliers in your area.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <div>
                    <Label htmlFor="tenncare_id">TennCare ID (if applicable)</Label>
                    <Input
                      id="tenncare_id"
                      value={formData.tenncare_id}
                      onChange={(e) => handleChange('tenncare_id', e.target.value)}
                      placeholder="Enter TennCare ID"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP: Health & Medical */}
          {currentStepData.id === 'health' && (
            <div className="space-y-6">
              <CardTitle>Health & Medical Conditions</CardTitle>
              <p className="text-sm text-slate-600">This helps us find specialized programs for you.</p>

              {/* Cancer Survivor Section */}
              <div className="p-4 bg-rose-50 rounded-lg border border-rose-200 space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="cancer_survivor"
                    checked={formData.cancer_survivor}
                    onCheckedChange={(checked) => handleChange('cancer_survivor', checked)}
                  />
                  <Label htmlFor="cancer_survivor" className="font-semibold">Cancer Survivor</Label>
                </div>
                {formData.cancer_survivor && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="cancer_type">Type of Cancer</Label>
                      <Input
                        id="cancer_type"
                        value={formData.cancer_type}
                        onChange={(e) => handleChange('cancer_type', e.target.value)}
                        placeholder="e.g., Breast, Lung"
                      />
                    </div>
                    <div>
                      <Label htmlFor="cancer_diagnosis_year">Year of Diagnosis</Label>
                      <Input
                        id="cancer_diagnosis_year"
                        type="number"
                        value={formData.cancer_diagnosis_year || ""}
                        onChange={(e) => handleChange('cancer_diagnosis_year', parseInt(e.target.value) || null)}
                        placeholder="2020"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Chronic Illness Section */}
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="chronic_illness"
                    checked={formData.chronic_illness}
                    onCheckedChange={(checked) => handleChange('chronic_illness', checked)}
                  />
                  <Label htmlFor="chronic_illness" className="font-semibold">Chronic Illness</Label>
                </div>
                {formData.chronic_illness && (
                  <div>
                    <Label htmlFor="chronic_illness_type">Type of Chronic Illness</Label>
                    <Input
                      id="chronic_illness_type"
                      value={formData.chronic_illness_type}
                      onChange={(e) => handleChange('chronic_illness_type', e.target.value)}
                      placeholder="e.g., Diabetes, Heart Disease"
                    />
                  </div>
                )}
              </div>

              {/* Rare Disease Section */} {/* MOVED/STYLED */}
              <div className="p-4 bg-purple-50 rounded-lg border border-purple-200 space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="rare_disease"
                    checked={formData.rare_disease}
                    onCheckedChange={(checked) => handleChange('rare_disease', checked)}
                  />
                  <Label htmlFor="rare_disease" className="font-semibold">Rare Disease</Label>
                </div>
                {formData.rare_disease && (
                  <div>
                    <Label htmlFor="rare_disease_type">Type of Rare Disease</Label>
                    <Input
                      id="rare_disease_type"
                      value={formData.rare_disease_type}
                      onChange={(e) => handleChange('rare_disease_type', e.target.value)}
                      placeholder="Name of rare disease"
                    />
                  </div>
                )}
              </div>

              {/* Other Health Conditions */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'dialysis_patient', label: 'Dialysis Patient' },
                  { id: 'organ_transplant', label: 'Organ Transplant Recipient' },
                  { id: 'hiv_aids', label: 'HIV/AIDS' },
                  { id: 'long_covid', label: 'Long COVID' },
                  { id: 'tbi_survivor', label: 'Traumatic Brain Injury' },
                  { id: 'amputee', label: 'Amputee' },
                  { id: 'neurodivergent', label: 'Neurodivergent (Autism, ADHD)' },
                  { id: 'visual_impairment', label: 'Visual Impairment' },
                  { id: 'hearing_impairment', label: 'Hearing Impairment' },
                  { id: 'wheelchair_user', label: 'Wheelchair User' },
                  { id: 'substance_recovery', label: 'Substance Recovery' },
                  { id: 'mental_health_condition', label: 'Mental Health Condition' },
                  { id: 'maternal_health', label: 'Maternal/Prenatal Health' },
                  { id: 'hospice_care', label: 'Hospice / Palliative Care' },
                  // Removed 'rare_disease' from this list as it now has its own section
                  { id: 'behavioral_health_smi', label: 'Serious Mental Illness (SMI)' },
                  { id: 'behavioral_health_sed', label: 'Serious Emotional Disturbance (SED)' },
                  { id: 'oud_moud_participant', label: 'OUD/MOUD Participant' },
                  { id: 'dental_need', label: 'Dental Need' },
                  { id: 'assistive_tech_need', label: 'Assistive Technology Need' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP: Demographics */}
          {currentStepData.id === 'demographics' && (
            <div className="space-y-6">
              <CardTitle>Demographics</CardTitle>
              
              <div>
                <Label htmlFor="immigration_status">Immigration/Citizenship Status</Label>
                <Select
                  value={formData.immigration_status}
                  onValueChange={(value) => handleChange('immigration_status', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="us_citizen">U.S. Citizen</SelectItem>
                    <SelectItem value="permanent_resident">Permanent Resident</SelectItem>
                    <SelectItem value="refugee">Refugee</SelectItem>
                    <SelectItem value="asylee">Asylee</SelectItem>
                    <SelectItem value="daca">DACA Recipient</SelectItem>
                    <SelectItem value="visa_holder">Visa Holder</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="new_immigrant"
                  checked={formData.new_immigrant}
                  onCheckedChange={(checked) => handleChange('new_immigrant', checked)}
                />
                <Label htmlFor="new_immigrant">New Immigrant (within last 5 years)</Label>
              </div>

              <div className="space-y-3">
                <p className="font-semibold text-sm">Race/Ethnicity (Check all that apply):</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'african_american', label: 'African American / Black' },
                    { id: 'hispanic_latino', label: 'Hispanic / Latino' },
                    { id: 'asian_american', label: 'Asian American' },
                    { id: 'pacific_islander', label: 'Pacific Islander / Native Hawaiian' },
                    { id: 'native_american', label: 'Native American / Alaska Native' },
                    { id: 'middle_eastern', label: 'Middle Eastern / North African' },
                    { id: 'white_caucasian', label: 'White / Caucasian' },
                    { id: 'multiracial', label: 'Multiracial / Mixed Heritage' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>

                {formData.native_american && (
                  <div>
                    <Label htmlFor="tribal_affiliation">Tribal Affiliation</Label>
                    <Input
                      id="tribal_affiliation"
                      value={formData.tribal_affiliation}
                      onChange={(e) => handleChange('tribal_affiliation', e.target.value)}
                      placeholder="Name of tribe"
                    />
                  </div>
                )}
              </div>

              {/* Cultural/Ethnic Heritage */}
              <div className="space-y-3 pt-3 border-t">
                <p className="font-semibold text-sm">Cultural/Ethnic Heritage:</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'jewish_heritage', label: 'Jewish Heritage' },
                    { id: 'irish_heritage', label: 'Irish Heritage' },
                    { id: 'italian_heritage', label: 'Italian Heritage' },
                    { id: 'polish_heritage', label: 'Polish Heritage' },
                    { id: 'greek_heritage', label: 'Greek Heritage' },
                    { id: 'armenian_heritage', label: 'Armenian Heritage' },
                    { id: 'cajun_creole_heritage', label: 'Cajun / Creole Heritage' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Religious Affiliations */}
              <div className="space-y-3 pt-3 border-t">
                <p className="font-semibold text-sm">Religious Affiliation (Check all that apply):</p>
                
                <div className="space-y-2">
                  <p className="text-sm font-medium">Christianity:</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 ml-4">
                    {[
                      { id: 'religious_affiliation_christian', label: 'Christian (General)' },
                      { id: 'religious_affiliation_catholic', label: 'Catholic' },
                      { id: 'religious_affiliation_protestant', label: 'Protestant' },
                      { id: 'religious_affiliation_baptist', label: 'Baptist' },
                      { id: 'religious_affiliation_methodist', label: 'Methodist' },
                      { id: 'religious_affiliation_lutheran', label: 'Lutheran' },
                      { id: 'religious_affiliation_presbyterian', label: 'Presbyterian' },
                      { id: 'religious_affiliation_pentecostal', label: 'Pentecostal' },
                      { id: 'religious_affiliation_orthodox', label: 'Orthodox Christian' },
                      { id: 'religious_affiliation_latter_day_saints', label: 'Latter-day Saints (Mormon)' },
                      { id: 'religious_affiliation_amish', label: 'Amish' },
                      { id: 'religious_affiliation_mennonite', label: 'Mennonite' },
                      { id: 'religious_affiliation_quaker', label: 'Quaker' },
                    ].map(item => (
                      <div key={item.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={item.id}
                          checked={formData[item.id]}
                          onCheckedChange={(checked) => handleChange(item.id, checked)}
                        />
                        <Label htmlFor={item.id} className="text-xs">{item.label}</Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">Judaism:</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 ml-4">
                    {[
                      { id: 'religious_affiliation_jewish', label: 'Jewish (General)' },
                      { id: 'religious_affiliation_reform_jewish', label: 'Reform Jewish' },
                      { id: 'religious_affiliation_conservative_jewish', label: 'Conservative Jewish' },
                      { id: 'religious_affiliation_orthodox_jewish', label: 'Orthodox Jewish' },
                    ].map(item => (
                      <div key={item.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={item.id}
                          checked={formData[item.id]}
                          onCheckedChange={(checked) => handleChange(item.id, checked)}
                        />
                        <Label htmlFor={item.id} className="text-xs">{item.label}</Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">Islam:</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 ml-4">
                    {[
                      { id: 'religious_affiliation_muslim', label: 'Muslim (General)' },
                      { id: 'religious_affiliation_sunni', label: 'Sunni Muslim' },
                      { id: 'religious_affiliation_shia', label: 'Shia Muslim' },
                    ].map(item => (
                      <div key={item.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={item.id}
                          checked={formData[item.id]}
                          onCheckedChange={(checked) => handleChange(item.id, checked)}
                        />
                        <Label htmlFor={item.id} className="text-xs">{item.label}</Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">Other Religions:</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 ml-4">
                    {[
                      { id: 'religious_affiliation_buddhist', label: 'Buddhist' },
                      { id: 'religious_affiliation_hindu', label: 'Hindu' },
                      { id: 'religious_affiliation_sikh', label: 'Sikh' },
                      { id: 'religious_affiliation_wiccan', label: 'Wiccan / Pagan' },
                      { id: 'religious_affiliation_unitarian', label: 'Unitarian Universalist' },
                    ].map(item => (
                      <div key={item.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={item.id}
                          checked={formData[item.id]}
                          onCheckedChange={(checked) => handleChange(item.id, checked)}
                        />
                        <Label htmlFor={item.id} className="text-xs">{item.label}</Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <Label htmlFor="religious_affiliation_other">Other Religious Affiliation</Label>
                  <Input
                    id="religious_affiliation_other"
                    value={formData.religious_affiliation_other}
                    onChange={(e) => handleChange('religious_affiliation_other', e.target.value)}
                    placeholder="Please specify"
                  />
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="lgbtq"
                  checked={formData.lgbtq}
                  onCheckedChange={(checked) => handleChange('lgbtq', checked)}
                />
                <Label htmlFor="lgbtq">LGBTQ+</Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="good_credit_score"
                  checked={formData.good_credit_score}
                  onCheckedChange={(checked) => handleChange('good_credit_score', checked)}
                />
                <Label htmlFor="good_credit_score">Good Credit Score (700+)</Label>
              </div>
            </div>
          )}

          {/* STEP: Family & Life */}
          {currentStepData.id === 'family' && (
            <div className="space-y-4">
              <CardTitle>Family & Life Situation</CardTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'single_parent', label: 'Single Parent' },
                  { id: 'foster_youth', label: 'Foster Youth / Former Foster Care' },
                  { id: 'orphan', label: 'Orphan' },
                  { id: 'adopted', label: 'Adopted' },
                  { id: 'foster_parent', label: 'Foster or Adoptive Parent' },
                  { id: 'caregiver', label: 'Family Caregiver' },
                  { id: 'kinship_care', label: 'Kinship Care' },
                  { id: 'widow_widower', label: 'Widow / Widower' },
                  { id: 'grandparent_raising_grandchildren', label: 'Grandparent Raising Grandchildren' },
                  { id: 'first_time_parent', label: 'First-Time Parent' },
                  { id: 'pregnancy_parenting_student', label: 'Pregnancy/Parenting Student' },
                  { id: 'homeless', label: 'Homeless / Housing Insecure' },
                  { id: 'runaway_homeless_youth', label: 'Runaway/Homeless Youth' },
                  { id: 'eviction_risk', label: 'Eviction Risk' },
                  { id: 'domestic_violence_survivor', label: 'Domestic Violence Survivor' },
                  { id: 'trafficking_survivor', label: 'Human Trafficking Survivor' },
                  { id: 'disaster_survivor', label: 'Disaster Survivor' },
                  { id: 'formerly_incarcerated', label: 'Formerly Incarcerated' },
                  { id: 'returning_citizen', label: 'Returning Citizen (Reentry)' },
                  { id: 'justice_impacted', label: 'Justice-Impacted' },
                  { id: 'minor_child', label: 'Minor Child (Under 18)' },
                  { id: 'young_adult', label: 'Young Adult (18-24)' },
                  { id: 'lep', label: 'Limited English Proficiency' },
                  { id: 'migrant_farmworker', label: 'Migrant/Seasonal Farmworker' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                  </div>
                ))}
              </div>
              
              {formData.disaster_survivor && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-amber-50 rounded-lg">
                  <div>
                    <Label htmlFor="disaster_incident_number">FEMA Disaster Incident Number</Label>
                    <Input
                      id="disaster_incident_number"
                      value={formData.disaster_incident_number}
                      onChange={(e) => handleChange('disaster_incident_number', e.target.value)}
                      placeholder="e.g., DR-4673"
                    />
                  </div>
                  <div>
                    <Label htmlFor="disaster_year">Disaster Year</Label>
                    <Input
                      id="disaster_year"
                      type="number"
                      value={formData.disaster_year || ""}
                      onChange={(e) => handleChange('disaster_year', parseInt(e.target.value) || null)}
                      placeholder="2024"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP: Military */}
          {currentStepData.id === 'military' && (
            <div className="space-y-6">
              <CardTitle>Military Service</CardTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'veteran', label: 'Veteran' },
                  { id: 'active_duty_military', label: 'Active Duty Military' },
                  { id: 'national_guard', label: 'National Guard / Reserve' },
                  { id: 'disabled_veteran', label: 'Disabled Veteran' },
                  { id: 'military_spouse', label: 'Military Spouse' },
                  { id: 'military_dependent', label: 'Military Dependent' },
                  { id: 'gold_star_family', label: 'Gold Star Family Member' },
                  { id: 'post_911_gi_bill', label: 'Post-9/11 GI Bill Recipient' },
                  { id: 'vr_and_e', label: 'VR&E (Veteran Readiness)' },
                  { id: 'champva', label: 'CHAMPVA Recipient' },
                  { id: 'vso_representation', label: 'VSO Representation' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                  </div>
                ))}
              </div>
              
              {formData.veteran && (
                <div className="space-y-4 p-4 bg-blue-50 rounded-lg">
                  <div>
                    <Label htmlFor="military_branch">Branch & MOS</Label>
                    <Input
                      id="military_branch"
                      value={formData.military_branch}
                      onChange={(e) => handleChange('military_branch', e.target.value)}
                      placeholder="e.g., Army - 11B Infantry"
                    />
                  </div>
                  <div>
                    <Label>Campaign Medals</Label>
                    <MultiSelectCombobox
                      options={[]}
                      selected={formData.campaign_medals}
                      onSelectedChange={(values) => handleChange('campaign_medals', values)}
                      placeholder="e.g., OEF, OIF, OND"
                      allowCustom
                    />
                  </div>
                  <div>
                    <Label htmlFor="character_of_discharge">Character of Discharge</Label>
                    <Input
                      id="character_of_discharge"
                      value={formData.character_of_discharge}
                      onChange={(e) => handleChange('character_of_discharge', e.target.value)}
                      placeholder="e.g., Honorable, General"
                    />
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="dd214_on_file"
                      checked={formData.dd214_on_file}
                      onCheckedChange={(checked) => handleChange('dd214_on_file', checked)}
                    />
                    <Label htmlFor="dd214_on_file">DD-214 on File</Label>
                  </div>
                </div>
              )}
              
              {formData.disabled_veteran && (
                <div>
                  <Label htmlFor="va_disability_percent">VA Disability Rating (%)</Label>
                  <Input
                    id="va_disability_percent"
                    type="number"
                    value={formData.va_disability_percent || ""}
                    onChange={(e) => handleChange('va_disability_percent', parseInt(e.target.value) || null)}
                    placeholder="e.g., 70"
                  />
                </div>
              )}
              
              {formData.national_guard && (
                <div>
                  <Label htmlFor="guard_reserve_activation">Recent Activation Date</Label>
                  <Input
                    id="guard_reserve_activation"
                    type="date"
                    value={formData.guard_reserve_activation}
                    onChange={(e) => handleChange('guard_reserve_activation', e.target.value)}
                  />
                </div>
              )}
              
              {formData.gold_star_family && (
                <div>
                  <Label htmlFor="gold_star_relationship">Relationship to Fallen Service Member</Label>
                  <Input
                    id="gold_star_relationship"
                    value={formData.gold_star_relationship}
                    onChange={(e) => handleChange('gold_star_relationship', e.target.value)}
                    placeholder="e.g., Spouse, Child, Parent"
                  />
                </div>
              )}
            </div>
          )}

          {/* STEP: Occupation */}
          {currentStepData.id === 'occupation' && (
            <div className="space-y-6">
              <CardTitle>Occupation & Work</CardTitle>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'healthcare_worker', label: 'Healthcare Worker (incl. PTA, EMT)' },
                  { id: 'educator', label: 'Teacher / Educator' },
                  { id: 'firefighter', label: 'Firefighter' },
                  { id: 'law_enforcement', label: 'Law Enforcement Officer' },
                  { id: 'public_servant', label: 'Public Servant / Government Employee' },
                  { id: 'clergy', label: 'Clergy / Religious Worker' },
                  { id: 'missionary', label: 'Missionary / Evangelist' },
                  { id: 'nonprofit_employee', label: 'Nonprofit Employee' },
                  { id: 'small_business_owner', label: 'Small Business Owner' },
                  { id: 'minority_owned_business', label: 'Minority-Owned Business' },
                  { id: 'women_owned_business', label: 'Women-Owned Business' },
                  { id: 'union_member', label: 'Union Member' },
                  { id: 'farmer', label: 'Farmer / Agricultural Worker' },
                  { id: 'truck_driver', label: 'Truck Driver / Transportation' },
                  { id: 'construction_trades_worker', label: 'Construction / Trades Worker' },
                  { id: 'researcher_scientist', label: 'Researcher / Scientist' },
                  { id: 'environmental_conservation_worker', label: 'Environmental / Conservation' },
                  { id: 'energy_sector_worker', label: 'Energy Sector Worker' },
                  { id: 'artist_musician_cultural_worker', label: 'Artist / Musician / Cultural Worker' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                  </div>
                ))}
              </div>

              {formData.healthcare_worker && (
                <div className="space-y-4 p-4 bg-green-50 rounded-lg">
                  <div>
                    <Label htmlFor="healthcare_worker_type">Type of Healthcare Worker</Label>
                    <Input
                      id="healthcare_worker_type"
                      value={formData.healthcare_worker_type}
                      onChange={(e) => handleChange('healthcare_worker_type', e.target.value)}
                      placeholder="e.g., RN, PTA, EMT-P, CNA, MD"
                    />
                  </div>
                  <div>
                    <Label>Licensure/Certifications</Label>
                    <MultiSelectCombobox
                      options={[]}
                      selected={formData.licensure_certs}
                      onSelectedChange={(values) => handleChange('licensure_certs', values)}
                      placeholder="e.g., RN, EMT-P, CNA"
                      allowCustom
                    />
                  </div>
                </div>
              )}
              
              {formData.union_member && (
                <div>
                  <Label htmlFor="union_local">Union Local & Apprenticeship Registration #</Label>
                  <Input
                    id="union_local"
                    value={formData.union_local}
                    onChange={(e) => handleChange('union_local', e.target.value)}
                    placeholder="e.g., Local 123"
                  />
                </div>
              )}
              
              {formData.farmer && (
                <div className="space-y-4 p-4 bg-amber-50 rounded-lg">
                  <div>
                    <Label htmlFor="farmer_acreage">Farm Acreage</Label>
                    <Input
                      id="farmer_acreage"
                      type="number"
                      value={formData.farmer_acreage || ""}
                      onChange={(e) => handleChange('farmer_acreage', parseFloat(e.target.value) || null)}
                      placeholder="e.g., 150"
                    />
                  </div>
                  <div>
                    <Label>USDA Programs</Label>
                    <MultiSelectCombobox
                      options={[]}
                      selected={formData.usda_programs}
                      onSelectedChange={(values) => handleChange('usda_programs', values)}
                      placeholder="e.g., EQIP, CSP, Organic, GAP"
                      allowCustom
                    />
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Additional Work Characteristics:</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'shift_work', label: 'Shift Work / Overtime Exposure' },
                    { id: 'high_hazard_industry', label: 'High-Hazard Industry' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP: Firearms / Second Amendment */}
          {currentStepData.id === 'firearms' && (
            <div className="space-y-6">
              <CardTitle>Firearms / Second Amendment</CardTitle>
              <p className="text-sm text-slate-600">
                Many shooting sports, hunting, and Second Amendment organizations offer scholarships and assistance programs.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'gun_owner', label: 'Gun Owner / Firearm Owner' },
                  { id: 'concealed_carry_permit', label: 'Concealed Carry Permit' },
                  { id: 'nra_member', label: 'NRA Member' },
                  { id: 'nra_certified_instructor', label: 'NRA Certified Instructor' },
                  { id: 'firearms_safety_instructor', label: 'Firearms Safety Instructor' },
                  { id: 'second_amendment_advocate', label: 'Second Amendment Advocate' },
                  { id: 'firearms_industry', label: 'Works in Firearms Industry' },
                  { id: 'competitive_shooter', label: 'Competitive Shooter' },
                  { id: 'hunter', label: 'Hunter' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                  </div>
                ))}
              </div>

              {formData.hunter && (
                <div className="p-4 bg-green-50 rounded-lg">
                  <Label htmlFor="hunting_license_state">State(s) Where Licensed to Hunt</Label>
                  <Input
                    id="hunting_license_state"
                    value={formData.hunting_license_state}
                    onChange={(e) => handleChange('hunting_license_state', e.target.value)}
                    placeholder="e.g., PA, WV, OH"
                  />
                </div>
              )}

              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="font-semibold text-sm mb-2">Funding Sources Available:</h4>
                <ul className="text-xs space-y-1 ml-4 list-disc">
                  <li>NRA Foundation - shooting sports, hunter education, safety programs</li>
                  <li>Second Amendment Foundation - legal defense and education</li>
                  <li>Safari Club International - hunting conservation scholarships</li>
                  <li>Ducks Unlimited, National Wild Turkey Federation - conservation</li>
                  <li>State rifle and pistol associations</li>
                  <li>Competitive shooting organizations (USPSA, IDPA, 3-Gun)</li>
                  <li>Youth shooting programs (4-H, Civilian Marksmanship Program)</li>
                </ul>
              </div>
            </div>
          )}

          {/* STEP: Political / Civic Engagement */}
          {currentStepData.id === 'political' && (
            <div className="space-y-6">
              <CardTitle>Political / Civic Engagement</CardTitle>
              <p className="text-sm text-slate-600">
                Elected officials, candidates, and civic leaders have access to specialized training, campaign support, and leadership development funding.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'elected_official', label: 'Current or Former Elected Official' },
                  { id: 'political_candidate', label: 'Political Candidate' },
                  { id: 'party_committee_member', label: 'Party Committee Member' },
                  { id: 'campaign_volunteer', label: 'Campaign Volunteer' },
                  { id: 'political_activist', label: 'Political Activist or Organizer' },
                  { id: 'municipal_official', label: 'Municipal/Local Official' },
                  { id: 'county_official', label: 'County Official' },
                  { id: 'state_official', label: 'State Official' },
                  { id: 'federal_official', label: 'Federal Official' },
                  { id: 'campaign_finance_experience', label: 'Campaign Finance Experience' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                  </div>
                ))}
              </div>

              {formData.elected_official && (
                <div className="space-y-4 p-4 bg-blue-50 rounded-lg">
                  <div>
                    <Label htmlFor="public_office_held">Office Held</Label>
                    <Input
                      id="public_office_held"
                      value={formData.public_office_held}
                      onChange={(e) => handleChange('public_office_held', e.target.value)}
                      placeholder="e.g., City Council Member, School Board, State Representative"
                    />
                  </div>
                  <div>
                    <Label htmlFor="years_in_office">Years in Office</Label>
                    <Input
                      id="years_in_office"
                      type="number"
                      value={formData.years_in_office || ""}
                      onChange={(e) => handleChange('years_in_office', parseInt(e.target.value) || null)}
                      placeholder="e.g., 4"
                    />
                  </div>
                </div>
              )}

              <div>
                <Label htmlFor="political_party_affiliation">Political Party Affiliation</Label>
                <Select
                  value={formData.political_party_affiliation}
                  onValueChange={(value) => handleChange('political_party_affiliation', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None / No Affiliation</SelectItem>
                    <SelectItem value="democratic">Democratic</SelectItem>
                    <SelectItem value="republican">Republican</SelectItem>
                    <SelectItem value="independent">Independent</SelectItem>
                    <SelectItem value="libertarian">Libertarian</SelectItem>
                    <SelectItem value="green">Green</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {formData.party_committee_member && (
                <div>
                  <Label htmlFor="party_leadership_position">Party Leadership Position</Label>
                  <Input
                    id="party_leadership_position"
                    value={formData.party_leadership_position}
                    onChange={(e) => handleChange('party_leadership_position', e.target.value)}
                    placeholder="e.g., Chair, Vice-Chair, Treasurer"
                  />
                </div>
              )}

              <div>
                <Label htmlFor="civic_engagement_level">Level of Civic/Political Engagement</Label>
                <Select
                  value={formData.civic_engagement_level}
                  onValueChange={(value) => handleChange('civic_engagement_level', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="voter">Voter</SelectItem>
                    <SelectItem value="volunteer">Volunteer</SelectItem>
                    <SelectItem value="activist">Activist</SelectItem>
                    <SelectItem value="candidate">Candidate</SelectItem>
                    <SelectItem value="official">Elected Official</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Policy Expertise Areas</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.policy_expertise_areas}
                  onSelectedChange={(values) => handleChange('policy_expertise_areas', values)}
                  placeholder="e.g., Education, Healthcare, Economic Development, Public Safety"
                  allowCustom
                />
              </div>

              <div className="p-4 bg-indigo-50 rounded-lg border border-indigo-200">
                <h4 className="font-semibold text-sm mb-2">Funding Sources Available:</h4>
                <ul className="text-xs space-y-1 ml-4 list-disc">
                  <li>National League of Cities - training and leadership development</li>
                  <li>U.S. Conference of Mayors - programs for municipal leaders</li>
                  <li>National Association of Counties (NACo) - county officials support</li>
                  <li>State municipal leagues and county associations</li>
                  <li>Political party committees (DNC, RNC, DLCC, RSLC) - campaign support</li>
                  <li>Leadership PACs - from senior elected officials</li>
                  <li>Young Elected Officials (YEO) Network - emerging leaders</li>
                  <li>Harvard Kennedy School - executive education for public servants</li>
                  <li>Policy institutes (Brookings, AEI, CAP) - research and analysis</li>
                </ul>
              </div>
            </div>
          )}

          {/* STEP: Location */}
          {currentStepData.id === 'location' && (
            <div className="space-y-4">
              <CardTitle>Location</CardTitle>
              <div>
                <Label htmlFor="address">Street Address</Label>
                <Input
                  id="address"
                  value={formData.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                  placeholder="123 Main St"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="city">City *</Label>
                  <Input
                    id="city"
                    value={formData.city}
                    onChange={(e) => handleChange('city', e.target.value)}
                    placeholder="Nashville"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="state">State *</Label>
                  <Select
                    value={formData.state}
                    onValueChange={(value) => handleChange('state', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select State" />
                    </SelectTrigger>
                    <SelectContent>
                      {US_STATES.map(state => (
                        <SelectItem key={state} value={state}>{state}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="zip">ZIP Code</Label>
                  <Input
                    id="zip"
                    value={formData.zip}
                    onChange={(e) => handleChange('zip', e.target.value)}
                    placeholder="37203"
                  />
                </div>
              </div>

              <div className="space-y-3 pt-4">
                <p className="font-semibold text-sm">Geographic Characteristics:</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'rural_resident', label: 'Rural Area Resident' },
                    { id: 'frontier_county', label: 'Frontier County' },
                    { id: 'appalachian_region', label: 'Appalachian Region' },
                    { id: 'urban_underserved', label: 'Urban Underserved Area' },
                    { id: 'qct', label: 'Qualified Census Tract (QCT)' },
                    { id: 'opportunity_zone', label: 'Opportunity Zone' },
                    { id: 'ej_area', label: 'EPA Environmental Justice Area' },
                    { id: 'persistent_poverty_county', label: 'Persistent-Poverty County' },
                    { id: 'tribal_land', label: 'Tribal Reservation/Trust Land' },
                    { id: 'us_territory', label: 'U.S. Territory (PR, GU, etc.)' },
                    { id: 'fema_disaster_area', label: 'FEMA Disaster Area' },
                    { id: 'promise_zone', label: 'Promise Zone' },
                    { id: 'choice_neighborhood', label: 'Choice Neighborhood' },
                    { id: 'delta_regional_authority', label: 'Delta Regional Authority' },
                    { id: 'northern_border_commission', label: 'Northern Border Commission' },
                    { id: 'denali_commission', label: 'Denali Commission (Alaska)' },
                    { id: 'colonias', label: 'Colonias (Border Community)' },
                    { id: 'nmtc_eligible', label: 'NMTC Eligible Tract' },
                    { id: 'brownfield_site', label: 'Brownfield Site' },
                    { id: 'broadband_unserved', label: 'Broadband-Unserved' },
                    { id: 'wui_risk', label: 'Wildland-Urban Interface Fire Risk' },
                    { id: 'floodplain', label: 'Floodplain Location' },
                    { id: 'mua_status', label: 'Medically Underserved Area' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
            </div>
            </div>
          )}

          {/* STEP: Narrative */}
          {currentStepData.id === 'narrative' && (
            <div className="space-y-4">
              <CardTitle>Tell Us Your Story</CardTitle>
              <p className="text-sm text-slate-600">
                These narrative responses help us find the most relevant opportunities for you.
              </p>

              <div>
                <Label htmlFor="mission">About You / Your Bio *</Label>
                <Textarea
                  id="mission"
                  value={formData.mission}
                  onChange={(e) => handleChange('mission', e.target.value)}
                  placeholder="Tell us about yourself, your background, and what makes you unique..."
                  rows={4}
                />
                <p className="text-xs text-slate-500 mt-1">
                  This helps us understand who you are and match you with the right opportunities
                </p>
              </div>

              <div>
                <Label htmlFor="primary_goal">What are your goals? *</Label>
                <Textarea
                  id="primary_goal"
                  value={formData.primary_goal}
                  onChange={(e) => handleChange('primary_goal', e.target.value)}
                  placeholder="Describe what you hope to achieve..."
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="target_population">Who you are / Your background</Label>
                <Textarea
                  id="target_population"
                  value={formData.target_population}
                  onChange={(e) => handleChange('target_population', e.target.value)}
                  placeholder="Tell us about your background, identity, and community..."
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="funding_amount_needed">How much funding do you need?</Label>
                <Input
                  id="funding_amount_needed"
                  value={formData.funding_amount_needed}
                  onChange={(e) => handleChange('funding_amount_needed', e.target.value)}
                  placeholder="e.g., $5,000 for tuition"
                />
              </div>

              <div>
                <Label htmlFor="timeline">Timeline / When do you need funding?</Label>
                <Input
                  id="timeline"
                  value={formData.timeline}
                  onChange={(e) => handleChange('timeline', e.target.value)}
                  placeholder="e.g., Fall 2025 semester"
                />
              </div>

              <div>
                <Label htmlFor="past_experience">Past Experience / Track Record</Label>
                <Textarea
                  id="past_experience"
                  value={formData.past_experience}
                  onChange={(e) => handleChange('past_experience', e.target.value)}
                  placeholder="Describe relevant achievements, experiences, or accomplishments..."
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="unique_qualities">What makes you unique?</Label>
                <Textarea
                  id="unique_qualities"
                  value={formData.unique_qualities}
                  onChange={(e) => handleChange('unique_qualities', e.target.value)}
                  placeholder="What sets you apart from other applicants?"
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="barriers_faced">Challenges or Barriers</Label>
                <Textarea
                  id="barriers_faced"
                  value={formData.barriers_faced}
                  onChange={(e) => handleChange('barriers_faced', e.target.value)}
                  placeholder="What obstacles have you faced or are currently facing?"
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="special_circumstances">Special Circumstances</Label>
                <Textarea
                  id="special_circumstances"
                  value={formData.special_circumstances}
                  onChange={(e) => handleChange('special_circumstances', e.target.value)}
                  placeholder="Describe any special circumstances, challenges overcome, or unique aspects of your situation..."
                  rows={4}
                />
              </div>

              <div>
                <Label>Keywords & Interests</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.keywords}
                  onSelectedChange={(values) => handleChange('keywords', values)}
                  placeholder="Add keywords (e.g., education, healthcare, community service)..."
                  allowCustom
                />
              </div>

              <div>
                <Label>Focus Areas</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.focus_areas}
                  onSelectedChange={(values) => handleChange('focus_areas', values)}
                  placeholder="Add focus areas (e.g., youth development, mental health)..."
                  allowCustom
                />
              </div>

              <div>
                <Label htmlFor="geographic_focus">Geographic Focus</Label>
                <Textarea
                  id="geographic_focus"
                  value={formData.geographic_focus}
                  onChange={(e) => handleChange('geographic_focus', e.target.value)}
                  placeholder="What geographic areas or communities do you focus on?"
                  rows={2}
                />
              </div>

              <div>
                <Label htmlFor="collaboration_partners">Support System / Partners</Label>
                <Textarea
                  id="collaboration_partners"
                  value={formData.collaboration_partners}
                  onChange={(e) => handleChange('collaboration_partners', e.target.value)}
                  placeholder="Who supports you? Mentors, organizations, family members..."
                  rows={2}
                />
              </div>

              <div>
                <Label htmlFor="sustainability_plan">Long-term Plans</Label>
                <Textarea
                  id="sustainability_plan"
                  value={formData.sustainability_plan}
                  onChange={(e) => handleChange('sustainability_plan', e.target.value)}
                  placeholder="What are your plans after receiving funding?"
                  rows={2}
                />
              </div>
            </div>
          )}

          {/* STEP: Review */}
          {currentStepData.id === 'review' && (
            <div className="space-y-6">
              <CardTitle>Review Your Application</CardTitle>
              
              <div className="space-y-4">
                <div className="p-4 bg-slate-50 rounded-lg">
                  <h4 className="font-semibold mb-2">Basic Information</h4>
                  <p><strong>Name:</strong> {formData.name || 'Not provided'}</p>
                  <p><strong>Type:</strong> {formData.applicant_type || 'Not selected'}</p>
                  <p><strong>Location:</strong> {formData.city && formData.state ? `${formData.city}, ${formData.state}` : 'Not provided'}</p>
                </div>

                {isStudent && (
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <h4 className="font-semibold mb-2">Education</h4>
                    <p><strong>Grade Levels:</strong> {formData.student_grade_levels.join(', ') || 'Not selected'}</p>
                    {formData.current_college && <p><strong>Current College:</strong> {formData.current_college}</p>}
                    {formData.target_colleges.length > 0 && (
                      <p><strong>Target Colleges:</strong> {formData.target_colleges.join(', ')}</p>
                    )}
                    {formData.gpa && <p><strong>GPA:</strong> {formData.gpa}</p>}
                  </div>
                )}

                <div className="p-4 bg-green-50 rounded-lg">
                  <h4 className="font-semibold mb-2">Qualifiers Found</h4>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {Object.entries(formData).filter(([key, value]) => 
                      value === true && key !== 'applicant_type'
                    ).map(([key]) => (
                      <Badge key={key} variant="secondary">
                        {key.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5" />
                    <div>
                      <h4 className="font-semibold text-yellow-900">Ready to Submit?</h4>
                      <p className="text-sm text-yellow-800 mt-1">
                        After submission, we'll match you with all funding opportunities you're eligible for.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Navigation Buttons */}
      <div className="flex justify-between sticky bottom-0 bg-white border-t pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={handleBack}
          disabled={currentStep === 0}
        >
          <ChevronLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleSaveProgress}
            disabled={isSubmitting || !formData.name}
          >
            Save Progress
          </Button>
          
          {currentStep < visibleSteps.length - 1 ? (
            <Button
              type="button"
              onClick={handleNext}
              className="bg-blue-600 hover:bg-blue-700"
            >
              Next
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-green-600 hover:bg-green-700"
            >
              {isSubmitting ? 'Submitting...' : 'Submit Application'}
              <CheckCircle className="w-4 h-4 ml-2" />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}