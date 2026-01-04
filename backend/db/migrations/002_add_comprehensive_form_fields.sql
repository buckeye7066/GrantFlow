-- Migration: Add comprehensive application form fields
-- Created: 2026-01-04
-- Description: Adds new fields to support the enhanced comprehensive application form

-- Organization-specific fields
ALTER TABLE organizations ADD COLUMN ntee_code TEXT;
ALTER TABLE organizations ADD COLUMN evidence_based_program TEXT;
ALTER TABLE organizations ADD COLUMN sam_gov_registered BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN grants_gov_active BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN hipaa_compliant BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN ferpa_compliant BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN faith_based_organization BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN serves_rural_area BOOLEAN DEFAULT FALSE;

-- Insurance & Risk Management
ALTER TABLE organizations ADD COLUMN liability_insurance BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN liability_coverage_limit TEXT;
ALTER TABLE organizations ADD COLUMN directors_officers_insurance BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN workers_comp_insurance BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN professional_liability_insurance BOOLEAN DEFAULT FALSE;

-- Business Certifications
ALTER TABLE organizations ADD COLUMN business_501c3_certified BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN business_501c4_certified BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN minority_owned_certification BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN women_owned_certification BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN veteran_owned_business BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN promise_zone_designation BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN opportunity_zone_designation BOOLEAN DEFAULT FALSE;

-- Additional student fields
ALTER TABLE organizations ADD COLUMN stem_student BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN extracurricular_activities TEXT DEFAULT '[]';
ALTER TABLE organizations ADD COLUMN achievements TEXT DEFAULT '[]';
ALTER TABLE organizations ADD COLUMN community_service_hours INTEGER;

-- Financial fields
ALTER TABLE organizations ADD COLUMN financial_need_level TEXT;
ALTER TABLE organizations ADD COLUMN low_income BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN unemployed BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN displaced_worker BOOLEAN DEFAULT FALSE;

-- Government assistance details
ALTER TABLE organizations ADD COLUMN medicaid_waiver_program TEXT;
ALTER TABLE organizations ADD COLUMN tenncare_id TEXT;

-- Immigration & Citizenship
ALTER TABLE organizations ADD COLUMN immigration_status TEXT DEFAULT 'us_citizen';
ALTER TABLE organizations ADD COLUMN permanent_resident BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN refugee BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN new_immigrant BOOLEAN DEFAULT FALSE;

-- Demographics
ALTER TABLE organizations ADD COLUMN african_american BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN hispanic_latino BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN asian_american BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN native_american BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN tribal_affiliation TEXT;
ALTER TABLE organizations ADD COLUMN lgbtq BOOLEAN DEFAULT FALSE;

-- Health & Medical (additional)
ALTER TABLE organizations ADD COLUMN cancer_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN cancer_type TEXT;
ALTER TABLE organizations ADD COLUMN cancer_diagnosis_year INTEGER;
ALTER TABLE organizations ADD COLUMN chronic_illness BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN chronic_illness_type TEXT;
ALTER TABLE organizations ADD COLUMN disability_type TEXT DEFAULT '[]';
ALTER TABLE organizations ADD COLUMN support_needs_level TEXT;
ALTER TABLE organizations ADD COLUMN dialysis_patient BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN organ_transplant BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN hiv_aids BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN tbi_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN amputee BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN neurodivergent BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN visual_impairment BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN hearing_impairment BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN wheelchair_user BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN substance_recovery BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN mental_health_condition BOOLEAN DEFAULT FALSE;

-- Family & Life Situation (additional)
ALTER TABLE organizations ADD COLUMN orphan BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN adopted BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN foster_parent BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN caregiver BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN widow_widower BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN grandparent_raising_grandchildren BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN first_time_parent BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN domestic_violence_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN trafficking_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN disaster_survivor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN formerly_incarcerated BOOLEAN DEFAULT FALSE;

-- Military (additional)
ALTER TABLE organizations ADD COLUMN active_duty_military BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN national_guard BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN military_dependent BOOLEAN DEFAULT FALSE;

-- Occupation & Work
ALTER TABLE organizations ADD COLUMN healthcare_worker BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN healthcare_worker_type TEXT;
ALTER TABLE organizations ADD COLUMN ems_worker BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN educator BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN firefighter BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN law_enforcement BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN public_servant BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN clergy BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN missionary BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN nonprofit_employee BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN small_business_owner BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN minority_owned_business BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN women_owned_business BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN union_member BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN farmer BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN truck_driver BOOLEAN DEFAULT FALSE;

-- Education Level
ALTER TABLE organizations ADD COLUMN ged_graduate BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN returning_adult_student BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN recent_graduate BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN job_retraining BOOLEAN DEFAULT FALSE;

-- Geographic
ALTER TABLE organizations ADD COLUMN rural_resident BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN appalachian_region BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN urban_underserved BOOLEAN DEFAULT FALSE;

-- Other
ALTER TABLE organizations ADD COLUMN minor_child BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN young_adult BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN business_affected_covid BOOLEAN DEFAULT FALSE;

-- Firearms / Second Amendment
ALTER TABLE organizations ADD COLUMN second_amendment_supporter BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN gun_owner BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN concealed_carry_permit BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN nra_member BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN firearm_instructor BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN competitive_shooter BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN hunting_license BOOLEAN DEFAULT FALSE;

-- Political / Civic Engagement
ALTER TABLE organizations ADD COLUMN registered_voter BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN political_party TEXT;
ALTER TABLE organizations ADD COLUMN politically_active BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN community_organizer BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN advocacy_work BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN civic_volunteer BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN election_worker BOOLEAN DEFAULT FALSE;

-- Narrative fields (additional)
ALTER TABLE organizations ADD COLUMN target_population TEXT;
ALTER TABLE organizations ADD COLUMN geographic_focus TEXT;
ALTER TABLE organizations ADD COLUMN funding_amount_needed TEXT;
ALTER TABLE organizations ADD COLUMN timeline TEXT;
ALTER TABLE organizations ADD COLUMN past_experience TEXT;
ALTER TABLE organizations ADD COLUMN unique_qualities TEXT;
ALTER TABLE organizations ADD COLUMN collaboration_partners TEXT;
ALTER TABLE organizations ADD COLUMN sustainability_plan TEXT;
ALTER TABLE organizations ADD COLUMN barriers_faced TEXT;
ALTER TABLE organizations ADD COLUMN special_circumstances TEXT;
ALTER TABLE organizations ADD COLUMN focus_areas TEXT DEFAULT '[]';

-- Student grade levels
ALTER TABLE organizations ADD COLUMN student_grade_levels TEXT DEFAULT '[]';
