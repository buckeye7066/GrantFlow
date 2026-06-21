/**
 * Golden-profile SCORING fixtures (matchEngine regression guards).
 *
 * These are distinct from tests/fixtures/goldenProfiles.mjs (which pins the
 * DISCOVERY/mission contract — source families + Anya actions). This file pins
 * the SCORING/EXPLAINABILITY contract of backend/services/matchEngine.js's
 * canonical `scoreOpportunity`.
 *
 * Each golden profile below is seeded into the test DB as a real
 * (profiles row + profile_sections) so backend/tests/goldenProfiles.test.js can
 * load it through the REAL builders (loadProfileContext → buildProfileSignals →
 * normalizeProfile → buildProfileFacets) and score it against the inline,
 * fully-offline opportunity fixtures.
 *
 * Profiles store location ONLY in `basic_information` (state/city/zip) because
 * the `profiles` table itself has no state/city/zip columns — location flows
 * through sections into signals.location, exactly like production.
 */

// ---------------------------------------------------------------------------
// Golden profiles — one per representative profile TYPE.
// ---------------------------------------------------------------------------

export const GOLDEN_SCORING_PROFILES = Object.freeze([
  // 1) STUDENT — Robert White archetype: paramedic-track student, Cleveland TN /
  //    Bradley County, financial need, STEM/EMS interests.
  {
    key: 'student_paramedic_tn',
    display_name: 'Robert White',
    primary_type: 'high_school_student',
    sections: {
      basic_information: {
        first_name: 'Robert',
        last_name: 'White',
        state: 'TN',
        city: 'Cleveland',
        zip: '37311',
        county: 'Bradley County',
        profile_category: 'student',
      },
      education: {
        highest_level: 'high school',
        grade_level: '12',
        intended_major: 'Paramedic / Emergency Medical Services',
        gpa: 3.6,
        act_score: 27,
        first_generation: true,
        stem_student: true,
      },
      financial_information: {
        financial_need_level: 'high',
        is_low_income: true,
        household_income: 31000,
      },
      programs_services: {
        focus_areas: ['ems', 'paramedic', 'emergency medical', 'stem', 'health science', 'scholarship'],
      },
    },
  },

  // 2) INDIVIDUAL / FAMILY — low-income, housing/food/medical needs.
  {
    key: 'individual_family_lowincome',
    display_name: 'Johnson Household',
    primary_type: 'family',
    sections: {
      basic_information: {
        first_name: 'Maria',
        last_name: 'Johnson',
        state: 'OH',
        city: 'Columbus',
        zip: '43215',
        county: 'Franklin County',
        profile_category: 'family',
      },
      household: {
        household_size: 4,
        single_parent: true,
        children_under_18: 3,
      },
      financial_information: {
        financial_need_level: 'high',
        is_low_income: true,
        below_poverty_line: true,
        household_income: 22000,
      },
      needs_assessment: {
        needs: ['housing', 'food', 'medical', 'utilities'],
      },
    },
  },

  // 3) CHURCH / FAITH-BASED ORG.
  {
    key: 'church_faith_org',
    display_name: 'Grace Community Church',
    primary_type: 'nonprofit',
    sections: {
      basic_information: {
        legal_name: 'Grace Community Church',
        organization_type: 'church',
        state: 'TX',
        city: 'Waco',
        zip: '76701',
        county: 'McLennan County',
      },
      organization: {
        organization_type: 'church',
        faith_based: true,
        denomination: 'Baptist',
      },
      nonprofit_compliance: {
        has_501c3: true,
      },
      mission: {
        focus: 'Faith-based community outreach, food pantry, and youth ministry',
      },
      programs_services: {
        focus_areas: ['faith', 'church', 'ministry', 'community', 'food', 'youth'],
      },
    },
  },

  // 4) VOLUNTEER FIRE / EMS ORG.
  {
    key: 'volunteer_fire_ems',
    display_name: 'Bradley County Volunteer Fire & EMS',
    primary_type: 'volunteer_fire_department',
    sections: {
      basic_information: {
        legal_name: 'Bradley County VFD Inc.',
        organization_type: 'volunteer_fire_department',
        state: 'TN',
        city: 'Cleveland',
        zip: '37311',
        county: 'Bradley County',
      },
      government_registrations: {
        has_uei: true,
        sam_gov_registered: true,
        sam_gov_status: 'active',
      },
      nonprofit_compliance: {
        has_501c3: true,
      },
      mission: {
        focus: 'Volunteer fire, rescue, and EMS for rural Bradley County',
      },
      programs_services: {
        focus_areas: ['fire', 'ems', 'rescue', 'equipment', 'training', 'safety', 'rural', 'first responder'],
      },
    },
  },

  // 5) NONPROFIT (501c3).
  {
    key: 'nonprofit_501c3',
    display_name: 'Bright Futures Youth Services',
    primary_type: 'nonprofit',
    sections: {
      basic_information: {
        legal_name: 'Bright Futures Youth Services',
        organization_type: 'nonprofit',
        ein: '47-1234567',
        state: 'TN',
        city: 'Nashville',
        zip: '37203',
        county: 'Davidson County',
      },
      nonprofit_compliance: {
        has_501c3: true,
      },
      mission: {
        focus: 'After-school education and youth development for under-served students',
      },
      programs_services: {
        focus_areas: ['education', 'youth', 'after school', 'tutoring', 'community', 'low_income'],
      },
    },
  },
])

// ---------------------------------------------------------------------------
// Opportunity fixtures — fully inline, never hit the network.
//
// Each carries enough shape (title/description/keywords/categories/geography/
// eligibility/url) for the real matchEngine to score it. They are grouped by
// the profile they are "clearly relevant" or "clearly irrelevant" to.
// ---------------------------------------------------------------------------

export const OPP = Object.freeze({
  // EMS / education scholarship — clearly relevant to the student.
  emsEducationScholarshipTN: {
    id: 'opp-ems-edu',
    title: 'Tennessee EMS & Paramedic Student Scholarship',
    description:
      'Scholarship for Tennessee students pursuing paramedic and emergency medical services (EMS) training. ' +
      'Supports tuition and certification for health science and STEM students. Open to enrolled students.',
    sponsor: 'Tennessee Health Foundation',
    keywords: ['scholarship', 'ems', 'paramedic', 'emergency medical', 'student', 'tuition', 'stem', 'health science'],
    categories: ['education', 'scholarship', 'student_aid'],
    state: 'TN',
    is_national: false,
    opportunity_type: 'scholarship',
    application_url: 'https://www.tn.gov/health/ems-scholarship',
    eligibility_bullets: ['Enrolled students pursuing EMS/paramedic training', 'Tennessee residents'],
    deadline_type: 'rolling',
  },

  // National Pell-style student aid — clearly relevant to the student.
  pellGrantNational: {
    id: 'opp-pell',
    title: 'Federal Pell Grant',
    description:
      'Need-based federal student aid (Pell Grant) for low-income undergraduate students. ' +
      'Helps cover tuition and cost of attendance via FAFSA. Open to enrolled college students nationwide.',
    sponsor: 'U.S. Department of Education',
    keywords: ['pell', 'fafsa', 'student aid', 'tuition', 'scholarship', 'cost of attendance', 'undergraduate'],
    categories: ['education', 'student_aid'],
    is_national: true,
    opportunity_type: 'grant',
    application_url: 'https://studentaid.gov/fafsa',
    eligibility_bullets: ['Low-income undergraduate students', 'FAFSA required'],
    deadline_type: 'rolling',
  },

  // Commercial fishery grant — clearly IRRELEVANT to the student (and the family).
  fisheryGrantAK: {
    id: 'opp-fishery',
    title: 'Alaska Commercial Fishery Modernization Grant',
    description:
      'Capital grant for Alaska commercial fishing vessel operators to modernize fishing fleets and ' +
      'cold-storage processing facilities. For established commercial fishery businesses only.',
    sponsor: 'Alaska Department of Fish and Game',
    keywords: ['fishery', 'commercial fishing', 'vessel', 'seafood', 'aquaculture'],
    categories: ['agriculture', 'business'],
    state: 'AK',
    is_national: false,
    opportunity_type: 'grant',
    application_url: 'https://www.adfg.alaska.gov/fishery-grant',
    eligibility_bullets: ['Licensed Alaska commercial fishing operators'],
    deadline_type: 'rolling',
  },

  // Low-income family rent/utility/food emergency assistance — relevant to family.
  familyEmergencyAssistanceOH: {
    id: 'opp-family-ea',
    title: 'Franklin County Emergency Rent, Utility & Food Assistance',
    description:
      'Emergency financial assistance for low-income households and families facing eviction, utility ' +
      'shutoff, or food insecurity. Helps with rent, utilities, and food for residents in need.',
    sponsor: 'Ohio Community Action Agency',
    keywords: ['rent', 'eviction', 'utility', 'food', 'household', 'low income', 'emergency', 'family'],
    categories: ['housing', 'utilities', 'food', 'financial_assistance'],
    state: 'OH',
    is_national: false,
    opportunity_type: 'assistance',
    funding_type: 'cost_coverage',
    application_url: 'https://www.communityactionohio.org/apply',
    eligibility_bullets: ['Low-income households', 'Ohio residents', 'Families with children'],
    deadline_type: 'rolling',
  },

  // 501(c)(3)-only capacity grant — NOT a strong match for an individual/family.
  nonprofitOnlyCapacityGrant: {
    id: 'opp-501c3-only',
    title: 'Nonprofit Capacity Building Grant (501(c)(3) Organizations Only)',
    description:
      'Operating and capacity-building grant exclusively for 501(c)(3) nonprofit organizations. ' +
      'Funds staff, infrastructure, and program expansion for charitable nonprofits. For nonprofits only.',
    sponsor: 'Regional Community Foundation',
    keywords: ['nonprofit', '501(c)(3)', 'capacity building', 'charitable', 'organization', 'operating'],
    categories: ['nonprofit', 'capacity_building'],
    is_national: true,
    opportunity_type: 'grant',
    requires_501c3: 1,
    application_url: 'https://www.communityfoundation.org/nonprofit-grant',
    eligibility_bullets: ['501(c)(3) nonprofit organizations only', 'For nonprofits only'],
    deadline_type: 'rolling',
  },

  // Faith-based community grant — relevant to the church.
  faithBasedCommunityGrantTX: {
    id: 'opp-faith',
    title: 'Faith-Based Community Outreach & Food Ministry Grant',
    description:
      'Grant for churches, ministries, and faith-based congregations operating food pantries and youth ' +
      'outreach. Supports faith-based community programs serving local families.',
    sponsor: 'Texas Faith Alliance',
    keywords: ['faith', 'church', 'ministry', 'congregation', 'food pantry', 'community', 'youth', 'religious'],
    categories: ['faith_based', 'community', 'food'],
    state: 'TX',
    is_national: false,
    funding_category: 'faith_based',
    opportunity_type: 'grant',
    application_url: 'https://www.texasfaithalliance.org/grant',
    eligibility_bullets: ['Churches and faith-based organizations', 'Texas-based congregations'],
    deadline_type: 'rolling',
  },

  // FEMA AFG fire/EMS equipment grant — relevant to volunteer fire/EMS.
  femaAfgFireEquipment: {
    id: 'opp-afg',
    title: 'Assistance to Firefighters Grant (AFG) — Equipment & Training',
    description:
      'Federal grant for fire departments and EMS organizations to purchase firefighting and rescue ' +
      'equipment, SCBA, and to fund training for first responders. Supports volunteer fire departments.',
    sponsor: 'FEMA',
    keywords: ['fire department', 'ems', 'first responder', 'equipment', 'training', 'rescue', 'scba', 'volunteer fire'],
    categories: ['public_safety', 'equipment', 'training'],
    is_national: true,
    opportunity_type: 'grant',
    application_url: 'https://www.fema.gov/grants/preparedness/firefighters',
    eligibility_bullets: ['Fire departments and EMS organizations', 'Volunteer fire departments eligible'],
    deadline_type: 'rolling',
  },

  // Youth education / after-school nonprofit program grant — relevant to nonprofit.
  youthEducationNonprofitGrant: {
    id: 'opp-youth-edu',
    title: 'After-School Youth Education & Development Program Grant',
    description:
      'Program grant for nonprofit organizations running after-school education, tutoring, and youth ' +
      'development programs for under-served and low-income students. For nonprofit community organizations.',
    sponsor: 'National Youth Development Fund',
    keywords: ['youth', 'education', 'after school', 'tutoring', 'nonprofit', 'community', 'low income', 'development'],
    categories: ['education', 'youth', 'nonprofit'],
    is_national: true,
    opportunity_type: 'grant',
    application_url: 'https://www.youthdevelopmentfund.org/apply',
    eligibility_bullets: ['Nonprofit organizations', 'Youth-serving programs'],
    deadline_type: 'rolling',
  },

  // A bare, generic opportunity with NO need types / categories — used to confirm
  // missing/sparse opportunity data still scores (floor + neutral baselines), never 0.
  genericNoSignalGrant: {
    id: 'opp-generic',
    title: 'General Community Support Fund',
    description: 'A general fund providing support to community members.',
    sponsor: 'Anonymous Donor Fund',
    keywords: [],
    categories: [],
    is_national: true,
    opportunity_type: 'grant',
    application_url: 'https://example.org/general-fund',
    eligibility_bullets: [],
    deadline_type: 'rolling',
  },
})

export default GOLDEN_SCORING_PROFILES
