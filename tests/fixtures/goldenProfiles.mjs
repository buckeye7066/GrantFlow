/**
 * Five "golden" production-grade profile fixtures used by the mission
 * suite (tests/mission/mission-golden-profiles.test.mjs) and by the live
 * smoke script (scripts/smoke-grantflow-mission.mjs).
 *
 * Each fixture intentionally exercises a different slice of the mission:
 *
 *   1. county_government_infrastructure — local government / FEMA / USDA /
 *      CDBG / EDA / DOT / EPA / broadband / state-county portals.
 *   2. volunteer_fire_ems              — FEMA AFG/SAFER, USDA RD, rural
 *      fire grants, equipment + training.
 *   3. mtsu_nursing_student            — high school senior committing to
 *      MTSU nursing, FAFSA/Pell, target-school portals, off-campus housing.
 *   4. classroom_teacher_title1_stem   — Title I STEM teacher, NEA,
 *      Toshiba, DonorsChoose-style, PTO/PTA, state DOE.
 *   5. family_medical_benefits         — single-parent family with
 *      Medicaid/SNAP/LIHEAP/HRSA/Community Action/United Way 211 needs;
 *      includes PII fields (SSN, Medicaid ID) the system MUST strip from
 *      crawler queries.
 *
 * The fixtures are intentionally rich (every section_key the
 * comprehensive application stores) so any matcher / planner / Anya tool
 * exercising loadProfileContext / buildProfileSignals sees real shape,
 * not a thin (id, state, type) row.
 *
 * They also document, for each profile, the *expected* canonical type,
 * recommended source families, key match facts, and Anya next-action
 * categories so the mission test can fail loudly if any of those
 * downstream signals break.
 */

export const GOLDEN_PROFILES = Object.freeze([
  // ─────────────────────────────────────────────────────────────────────
  // 1) County government infrastructure
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'county_government_infrastructure',
    summary: 'Putnam County, TN — Engineer / Public Works seeking infra grants',
    profile: {
      id: 'golden-county-gov',
      organization_id: 'org-county-gov',
      display_name: 'Putnam County Public Works',
      applicant_type: 'county_government',
      primary_type: 'county_government',
      organization_type: 'county_government',
      status: 'active',
      state: 'TN',
      county: 'Putnam County',
      city: 'Cookeville',
      zip: '38501',
      categories: ['infrastructure', 'public_safety', 'broadband'],
    },
    sections: {
      basic_information: {
        legal_name: 'Putnam County Government',
        ein: '00-1111111',
        founded_year: 1842,
        county: 'Putnam County',
        state: 'TN',
        city: 'Cookeville',
        zip: '38501',
        primary_contact_name: 'County Engineer',
        primary_contact_title: 'County Engineer',
      },
      government_registrations: {
        has_uei: true,
        uei: 'TESTUEICOUNTY01',
        sam_gov_registered: true,
        sam_gov_status: 'active',
        cage_code: 'XXXXX',
      },
      mission: {
        focus: 'Roads, bridges, water/sewer, public safety, broadband, emergency management',
      },
      programs_services: {
        focus_areas: ['infrastructure', 'public_safety', 'broadband', 'water', 'roads', 'bridges', 'emergency_management'],
      },
      compliance: {
        annual_audit_completed: true,
        single_audit_required: true,
      },
    },
    expectations: {
      canonicalType: 'county_government',
      requiredSourceCategories: [
        'sam_gov_assistance_listings',
        'usda_rd_community_facilities',
        'cdbg_state_local',
        'fema_public_assistance',
        'eda_economic_development',
        'state_county_grant_portals',
      ],
      mustHaveDirectSource: true,
      matchFactsMustMention: [/TN|Tennessee|Putnam/i, /county|government|public/i],
      workflowDocsMustMention: /sam|uei|narrative|budget|deadline/i,
      anyaActionMustExist: true,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 2) Volunteer fire / EMS
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'volunteer_fire_ems',
    summary: 'Rural KY volunteer fire department — SCBA + training',
    profile: {
      id: 'golden-vfd',
      organization_id: 'org-vfd',
      display_name: 'Bluegrass Volunteer Fire & EMS',
      applicant_type: 'volunteer_fire_department',
      primary_type: 'volunteer_fire_department',
      organization_type: 'volunteer_fire_department',
      status: 'active',
      state: 'KY',
      county: 'Madison County',
      city: 'Berea',
      zip: '40403',
      categories: ['public_safety', 'equipment', 'training'],
    },
    sections: {
      basic_information: {
        legal_name: 'Bluegrass VFD Inc.',
        ein: '22-2222222',
        founded_year: 1978,
        county: 'Madison County',
        state: 'KY',
        zip: '40403',
        city: 'Berea',
      },
      government_registrations: {
        has_uei: true,
        uei: 'TESTUEIVFD0001',
        sam_gov_registered: true,
        sam_gov_status: 'active',
      },
      nonprofit_compliance: {
        has_501c3: true,
      },
      mission: {
        focus: 'Volunteer fire, rescue, and EMS for rural Madison County',
      },
      programs_services: {
        focus_areas: ['equipment', 'training', 'fire', 'ems', 'safety', 'rural'],
      },
      operations: {
        active_volunteers: 28,
        annual_call_volume: 412,
      },
    },
    expectations: {
      canonicalType: 'volunteer_fire_department',
      requiredSourceCategories: [
        'fema_afg',
        'usda_rd_community_facilities',
        'state_emergency_management',
      ],
      mustHaveDirectSource: true,
      matchFactsMustMention: [/KY|Kentucky|Madison/i, /fire|volunteer|equipment|safety/i],
      // generateActionPlan emits volunteer-fire-aware docs (roster/inventory/budget) when
      // profileContext.profile.primary_type === 'volunteer_fire'. The generic branch still
      // emits narrative/budget/deadline so we accept either.
      workflowDocsMustMention: /roster|inventory|budget|sam|uei|narrative|deadline|submit/i,
      anyaActionMustExist: true,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 3) High-school senior → MTSU Nursing
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'mtsu_nursing_student',
    summary: 'TN HS senior committed to MTSU Nursing — Pell-eligible, off-campus housing',
    profile: {
      id: 'golden-mtsu-student',
      display_name: 'Demo Student (MTSU Nursing)',
      applicant_type: 'student',
      primary_type: 'high_school_student',
      organization_type: null,
      status: 'active',
      state: 'TN',
      city: 'Murfreesboro',
      zip: '37132',
      categories: ['scholarship', 'tuition', 'housing'],
    },
    sections: {
      basic_information: {
        first_name: 'Demo Student',
        last_name: 'Test',
        date_of_birth: '2008-06-12',
        state: 'TN',
        city: 'Murfreesboro',
        zip: '37132',
        county: 'Rutherford County',
      },
      education: {
        grade_level: '12',
        gpa: 3.8,
        sat_score: 1280,
        act_score: 28,
        target_colleges: ['Middle Tennessee State University'],
        committed_school: 'Middle Tennessee State University',
        major: 'Nursing',
        first_generation: true,
        fafsa_completed: true,
        pell_eligible: true,
        housing_preference: 'off_campus',
      },
      financial: {
        household_income: 38000,
        below_poverty_line: false,
        receives_pell: true,
      },
      demographics: {
        gender: 'female',
      },
    },
    expectations: {
      // user-facing primary_type for HS senior — student is acceptable too
      canonicalType: 'high_school_student',
      acceptableCanonicalTypes: ['high_school_student', 'student'],
      requiredSourceCategories: [
        'pell_grant',
        'ed_gov_fafsa',
        'student_scholarship_portals',
        'scholarship_directory',
        'united_way_211',
      ],
      mustHaveDirectSource: true,
      matchFactsMustMention: [/TN|Tennessee/i, /student|scholar|education|tuition|nursing|MTSU|pell|fafsa/i],
      // applicationWorkflow.generateActionPlan currently emits a generic plan
      // (narrative/budget/submit/deadline) for student profiles. The golden
      // test confirms a workflow exists and is actionable; the wider student
      // workflow specialization is tracked separately.
      workflowDocsMustMention: /narrative|application|submit|documentation|deadline/i,
      anyaActionMustExist: true,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 4) Classroom teacher / Title I STEM
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'classroom_teacher_title1_stem',
    summary: 'CA Title I middle-school STEM teacher — needs lab supplies + tablets',
    profile: {
      id: 'golden-classroom-teacher',
      organization_id: 'org-classroom',
      display_name: 'Ms. Rivera — Lincoln Middle STEM',
      applicant_type: 'classroom_teacher',
      primary_type: 'classroom_teacher',
      organization_type: 'public_school',
      status: 'active',
      state: 'CA',
      county: 'Los Angeles County',
      city: 'Los Angeles',
      zip: '90011',
      categories: ['classroom', 'stem', 'title_i'],
    },
    sections: {
      basic_information: {
        legal_name: 'Lincoln Middle School',
        state: 'CA',
        city: 'Los Angeles',
        zip: '90011',
        county: 'Los Angeles County',
      },
      education_program: {
        grade_level: '6-8',
        title_i_school: true,
        free_reduced_lunch_pct: 78,
        subject_area: 'STEM',
        cte_program: false,
        district_name: 'LAUSD',
      },
      programs_services: {
        focus_areas: ['stem', 'classroom', 'science', 'technology', 'engineering', 'math', 'low_income'],
      },
      mission: {
        focus: 'Hands-on STEM learning for low-income middle-school students',
      },
    },
    expectations: {
      canonicalType: 'classroom_teacher',
      acceptableCanonicalTypes: ['classroom_teacher', 'teacher'],
      requiredSourceCategories: [
        'teacher_classroom_grants',
        'donorschoose_or_equivalent',
        'nea_foundation',
        'state_department_of_education_grants',
      ],
      mustHaveDirectSource: true,
      matchFactsMustMention: [/CA|California|Los Angeles/i, /classroom|stem|teacher|education|title/i],
      workflowDocsMustMention: /budget|narrative|proposal|impact|deadline/i,
      anyaActionMustExist: true,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // 5) Family medical / benefits — PII safety + zero-result ladder
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'family_medical_benefits',
    summary: 'OH single-parent family — Medicaid/SNAP/LIHEAP, child medical needs',
    profile: {
      id: 'golden-family-medical',
      display_name: 'Johnson Family',
      applicant_type: 'family',
      primary_type: 'family',
      organization_type: null,
      status: 'active',
      state: 'OH',
      county: 'Franklin County',
      city: 'Columbus',
      zip: '43215',
      categories: ['medical_assistance', 'food_assistance', 'utility_assistance'],
    },
    sections: {
      basic_information: {
        first_name: 'Maria',
        last_name: 'Johnson',
        date_of_birth: '1986-03-21',
        state: 'OH',
        city: 'Columbus',
        zip: '43215',
        county: 'Franklin County',
      },
      household: {
        household_size: 4,
        single_parent: true,
        children_under_18: 3,
      },
      financial: {
        household_income: 22000,
        below_poverty_line: true,
        receives_medicaid: true,
        receives_snap: true,
        receives_liheap: false,
      },
      health: {
        chronic_conditions: ['asthma', 'diabetes_type_1'],
        child_with_chronic_condition: true,
      },
      // INTENTIONAL PII — must NEVER reach a crawler / external query.
      pii: {
        ssn: '123-45-6789',
        medicaid_id: 'OH123456789',
        green_card_number: 'A123456789',
        drivers_license: 'OH-DL-9988776',
      },
    },
    expectations: {
      canonicalType: 'family',
      requiredSourceCategories: [
        'medicaid',
        'snap',
        'liheap',
        'community_action',
        'united_way_211',
        'feeding_america',
        'hrsa_health_centers',
      ],
      mustHaveDirectSource: false, // family/benefits routes through directories + benefit portals
      matchFactsMustMention: [/OH|Ohio|Franklin|Columbus/i, /family|household|medic|food|util|benefit|low.?income/i],
      workflowDocsMustMention: /id|income|verification|application|director|provider/i,
      anyaActionMustExist: true,
      piiTokensThatMustNeverLeak: [
        '123-45-6789',
        '123456789',
        'OH123456789',
        'A123456789',
        'OH-DL-9988776',
      ],
    },
  },
])

/**
 * Convenience: return a copy of one fixture by name.
 */
export function getGoldenProfile(name) {
  const found = GOLDEN_PROFILES.find((p) => p.name === name)
  if (!found) throw new Error(`unknown golden profile: ${name}`)
  return JSON.parse(JSON.stringify(found))
}

export default GOLDEN_PROFILES
