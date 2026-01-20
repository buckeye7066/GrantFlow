-- Postgres migration 0004: Add comprehensive application form fields
-- Mirrors sqlite migration: backend/db/migrations/002_add_comprehensive_form_fields.sql
--
-- Notes:
-- - Uses ADD COLUMN IF NOT EXISTS to stay deterministic across environments
-- - JSON arrays are stored as TEXT with default '[]' (keeps runtime behavior consistent)

-- Organization-specific fields
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ntee_code TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS evidence_based_program TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sam_gov_registered BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS grants_gov_active BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS hipaa_compliant BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ferpa_compliant BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS faith_based_organization BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS serves_rural_area BOOLEAN DEFAULT FALSE;

-- Insurance & Risk Management
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS liability_insurance BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS liability_coverage_limit TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS directors_officers_insurance BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS workers_comp_insurance BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS professional_liability_insurance BOOLEAN DEFAULT FALSE;

-- Business Certifications
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_501c3_certified BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_501c4_certified BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS minority_owned_certification BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS women_owned_certification BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS veteran_owned_business BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS promise_zone_designation BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS opportunity_zone_designation BOOLEAN DEFAULT FALSE;

-- Additional student fields
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stem_student BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS extracurricular_activities TEXT DEFAULT '[]';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS achievements TEXT DEFAULT '[]';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS community_service_hours INTEGER;

-- Financial fields
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS financial_need_level TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS low_income BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS unemployed BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS displaced_worker BOOLEAN DEFAULT FALSE;

-- Government assistance details
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS medicaid_waiver_program TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tenncare_id TEXT;

-- Immigration & Citizenship
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS immigration_status TEXT DEFAULT 'us_citizen';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS permanent_resident BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS refugee BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS new_immigrant BOOLEAN DEFAULT FALSE;

-- Demographics
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS african_american BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS hispanic_latino BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS asian_american BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS native_american BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tribal_affiliation TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lgbtq BOOLEAN DEFAULT FALSE;

-- Health & Medical (additional)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cancer_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cancer_type TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cancer_diagnosis_year INTEGER;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS chronic_illness BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS chronic_illness_type TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS disability_type TEXT DEFAULT '[]';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS support_needs_level TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS dialysis_patient BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS organ_transplant BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS hiv_aids BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tbi_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS amputee BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS neurodivergent BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS visual_impairment BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS hearing_impairment BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS wheelchair_user BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS substance_recovery BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS mental_health_condition BOOLEAN DEFAULT FALSE;

-- Family & Life Situation (additional)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS orphan BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS adopted BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS foster_parent BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS caregiver BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS widow_widower BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS grandparent_raising_grandchildren BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS first_time_parent BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domestic_violence_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trafficking_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS disaster_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS formerly_incarcerated BOOLEAN DEFAULT FALSE;

-- Military (additional)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS active_duty_military BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS national_guard BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS military_dependent BOOLEAN DEFAULT FALSE;

-- Occupation & Work
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS healthcare_worker BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS healthcare_worker_type TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ems_worker BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS educator BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS firefighter BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS law_enforcement BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS public_servant BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS clergy BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS missionary BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS nonprofit_employee BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS small_business_owner BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_minority_owned_business_owner BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_women_owned_business_owner BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS union_member BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS farmer BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS truck_driver BOOLEAN DEFAULT FALSE;

-- Education Level
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ged_graduate BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS returning_adult_student BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS recent_graduate BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS job_retraining BOOLEAN DEFAULT FALSE;

-- Geographic
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS rural_resident BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS appalachian_region BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS urban_underserved BOOLEAN DEFAULT FALSE;

-- Other
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS minor_child BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS young_adult BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_affected_covid BOOLEAN DEFAULT FALSE;

-- Firearms / Second Amendment
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS second_amendment_supporter BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS gun_owner BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS concealed_carry_permit BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS nra_member BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS firearm_instructor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS competitive_shooter BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS hunting_license BOOLEAN DEFAULT FALSE;

-- Political / Civic Engagement
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS registered_voter BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS political_party TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS politically_active BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS community_organizer BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS advocacy_work BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS civic_volunteer BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS election_worker BOOLEAN DEFAULT FALSE;

-- Narrative fields (additional)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS target_population TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS geographic_focus TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS timeline TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS past_experience TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS unique_qualities TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS collaboration_partners TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sustainability_plan TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS barriers_faced TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS special_circumstances TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS focus_areas TEXT DEFAULT '[]';

-- Student grade levels
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS student_grade_levels TEXT DEFAULT '[]';

