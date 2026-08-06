import fs from 'fs'
import path from 'path'

function profile({
  id,
  display_name,
  primary_type,
  tags = [],
  cityState = '',
  goal = 'Find aligned funding without storing private client details in source control.',
  sections = {},
  owner_email = null,
}) {
  return {
    id,
    display_name,
    primary_type,
    status: 'active',
    tags: ['designated', 'source-safe', ...tags],
    ...(owner_email ? { owner_email } : {}),
    sections: {
      basic_information: {
        full_name: display_name,
        email: '',
        phone: '',
        website: '',
        address: cityState,
        notes: 'Source-safe synthetic seed. Real client details must live in a private store, not the public repo.',
      },
      location_focus: {
        geographic_focus: cityState || 'United States',
        notes: 'Synthetic location signal for crawler and matcher coverage.',
      },
      narrative: {
        mission: goal,
        primary_goal: goal,
        funding_amount_needed: '',
      },
      ...sections,
    },
  }
}

function loadPrivateDesignatedProfiles(filePath) {
  if (!filePath) return null
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
    if (!fs.existsSync(resolved)) return null
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'))
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.profiles)) return parsed.profiles
  } catch (error) {
    console.warn('[designatedProfiles] Ignoring private designated profile file:', error?.message || error)
  }
  return null
}

const PUBLIC_FIXTURE_PROFILES = [
  profile({
    id: 'profile-demo-individual',
    display_name: 'Demo Individual',
    primary_type: 'individual',
    tags: ['individual', 'demo'],
    cityState: 'Nashville, Tennessee',
    goal: 'Validate GrantFlow intake, crawler, document, and application flows with non-real demo data.',
    sections: {
      financial_information: {
        financial_need_level: 'unknown',
        notes: 'Demo-only financial signal.',
      },
    },
  }),
  profile({
    id: 'profile-demo-research-organization',
    display_name: 'Demo Research Organization',
    primary_type: 'organization',
    tags: ['organization', 'research'],
    cityState: 'Tennessee',
    goal: 'Find research, workforce, and community-health funding aligned with a small science organization.',
    sections: {
      organization_details: {
        organization_type: 'Biotechnology / research organization',
        mission: 'Advance applied science and community health through research, education, and service.',
      },
    },
  }),
  profile({
    id: 'profile-demo-wellness-business',
    display_name: 'Demo Wellness Business',
    primary_type: 'small_business',
    tags: ['wellness', 'small_business'],
    cityState: 'Pennsylvania',
    goal: 'Expand a wellness practice with equipment, facility improvements, and community health programming.',
    sections: {
      organization_details: {
        organization_type: 'Holistic wellness collective',
        mission: 'Provide accessible wellness and trauma-informed services.',
      },
      financial_information: {
        financial_need_level: 'moderate',
        notes: 'Synthetic small-business expansion need.',
      },
    },
  }),
  profile({
    id: 'profile-demo-senior-accessibility',
    // Fictional test persona: the applicant receives accessibility support and
    // is not a caregiver. This distinction protects the eligibility-direction
    // regression without encoding a real person's correction history.
    display_name: 'Designated Disability & Senior Support Profile',
    primary_type: 'individual',
    tags: ['disability', 'senior', 'appalachian'],
    cityState: 'Cleveland, Tennessee',
    goal: 'Find disability-support, senior/aging, accessibility, utility, food, and housing stability resources.',
    sections: {
      family_life: { caregiver: false },
      demographics: {
        disability_status: 'Has disability',
        age_group: 'Senior 62+',
      },
      health_medical: {
        disability_type: ['mobility impairment'],
        support_needs_level: 'high',
      },
      financial_information: {
        financial_need_level: 'high',
        notes: 'Low-income disabled senior household; prioritize disability, aging, and household-stability support.',
      },
    },
  }),
  profile({
    id: 'profile-demo-assistive-technology',
    display_name: 'Designated Disability Support Profile',
    primary_type: 'individual',
    tags: ['disability', 'assistive_technology', 'appalachian'],
    cityState: 'Cleveland, Tennessee',
    goal: 'Find assistive technology, accessibility, transportation, and health-support funding.',
    sections: {
      demographics: { disability_status: 'Has disability' },
      health_medical: {
        disability_type: ['Mobility support need'],
        support_needs_level: 'moderate',
        notes: 'Synthetic disability-support profile. No real diagnosis is stored here.',
      },
      government_assistance: {
        other_programs: 'Synthetic public-benefit signal.',
      },
    },
  }),
  profile({
    id: 'profile-demo-caregiver-household',
    display_name: 'Designated Caregiver Household Profile',
    primary_type: 'family',
    tags: ['caregiver', 'family_assistance'],
    cityState: 'Ohio',
    goal: 'Find family stabilization, childcare, transportation, and emergency-assistance resources.',
    sections: {
      financial_information: {
        financial_need_level: 'high',
        notes: 'Synthetic caregiver household need.',
      },
      family_life: { caregiver: true, first_time_parent: false },
    },
  }),
  profile({
    id: 'profile-demo-veteran-community',
    display_name: 'Designated Veteran Community Profile',
    primary_type: 'individual',
    tags: ['veteran', 'community_service'],
    cityState: 'Tennessee',
    goal: 'Find veteran, family, debt-relief, housing, and community-service funding.',
    sections: {
      occupation: { public_servant: true },
      demographics: { veteran_status: true },
      health_medical: {
        support_needs_level: 'moderate',
        notes: 'Synthetic veteran-support profile.',
      },
    },
  }),
  profile({
    id: 'profile-demo-faith-nonprofit',
    display_name: 'Demo Faith-Based Nonprofit',
    primary_type: 'nonprofit',
    tags: ['faith_based', 'human_services', 'food_security'],
    cityState: 'Tennessee',
    goal: 'Find nonprofit, ministry, food-security, mentoring, and community-service funding.',
    sections: {
      organization_details: {
        organization_type: 'Faith-based nonprofit',
        mission: 'Serve families through food, mentoring, counseling, and community support.',
      },
    },
  }),
  profile({
    id: 'profile-demo-health-education',
    display_name: 'Demo Health Education Profile',
    primary_type: 'individual',
    tags: ['health_education', 'food_security', 'community_health'],
    cityState: 'Tennessee',
    goal: 'Find health education, nutrition, workforce training, and community-service funding.',
    sections: {
      occupation: { healthcare_worker: true, educator: true },
      narrative: {
        mission: 'Use health education and science communication to improve community outcomes.',
        primary_goal: 'Build health education and food-security programs with accountable funding.',
        funding_amount_needed: '',
      },
    },
  }),
  profile({
    id: 'profile-demo-workforce-training',
    display_name: 'Designated Workforce Profile',
    primary_type: 'individual',
    tags: ['workforce', 'training'],
    cityState: 'United States',
    goal: 'Find workforce training, emergency assistance, and credential-support funding.',
  }),
  profile({
    id: 'profile-demo-healthcare-workforce',
    display_name: 'Designated Healthcare Workforce Profile',
    primary_type: 'individual',
    tags: ['healthcare_worker', 'training'],
    cityState: 'United States',
    goal: 'Find healthcare workforce, licensing, continuing education, and professional-development funding.',
    sections: {
      occupation: { healthcare_worker: true },
    },
  }),
  profile({
    id: 'profile-demo-education-support',
    display_name: 'Designated Education Support Profile',
    primary_type: 'individual',
    tags: ['education', 'career_training'],
    cityState: 'United States',
    goal: 'Find education, career training, and household-stability resources.',
  }),
  profile({
    id: 'profile-demo-tennessee-stem-student',
    display_name: 'Demo Tennessee STEM Student',
    primary_type: 'high_school_student',
    tags: ['student', 'student_aid', 'stem', 'forensic_science', 'appalachian'],
    cityState: 'Cleveland, Tennessee',
    goal: 'Find college, scholarship, cost-of-attendance, and off-campus living support for a Tennessee STEM student.',
    sections: {
      basic_information: {
        full_name: 'Demo Tennessee STEM Student',
        email: '',
        phone: '',
        website: '',
        address: 'Cleveland, Tennessee',
        notes: 'Synthetic high school senior taking college-level classes.',
      },
      demographics: {
        gender: 'Female',
        ethnicity: 'Polish heritage',
        immigrant_status: 'second-generation',
        notes: 'Synthetic profile signal: Polish heritage; multilingual English/Russian household support.',
      },
      location_focus: {
        rural_resident: true,
        appalachian_region: true,
        geographic_focus: 'Cleveland, Tennessee',
        notes: 'Synthetic rural/Appalachian student-aid signal.',
      },
      financial_information: {
        household_income: 56000,
        household_size: 7,
        financial_need_level: 'moderate',
        low_income: false,
        notes: 'Synthetic moderate-need student aid profile.',
      },
      government_assistance: {
        ssdi_recipient: true,
        other_programs: 'Synthetic dependent-benefit signal for student-aid matching.',
      },
      family_life: {
        caregiver: true,
        notes: 'Synthetic family translation/caregiver responsibility signal.',
      },
      education: {
        highest_level: 'High School Senior (with college courses)',
        current_institution: 'Cleveland State Community College',
        gpa: '3.84',
        act_score: '28',
        intended_major: 'Forensic Science',
        interests: ['Forensic Science', 'Criminal Justice', 'STEM', 'DNA Analysis', 'Crime Scene Investigation'],
        target_colleges: ['Middle Tennessee State University'],
      },
      university_applications: {
        applications: [
          { name: 'Middle Tennessee State University', status: 'planning' },
          { name: 'University of Tennessee Chattanooga', status: 'planning' },
          { name: 'University of Tennessee Knoxville', status: 'planning' },
        ],
      },
      narrative: {
        mission: 'Pursue forensic science while advocating for educational access for multilingual and rural students in STEM.',
        primary_goal: 'Secure financial assistance for higher education, including cost-of-attendance and student living expenses.',
        target_population: 'Rural, multilingual, and first-generation-adjacent students pursuing STEM pathways.',
        funding_amount_needed: '',
        timeline: 'Apply to colleges and scholarships during senior year; begin undergraduate studies after graduation.',
        past_experience: 'Balancing rigorous high school coursework with college-level classes.',
        unique_qualities: 'Multilingual student with strong academic performance and family-support responsibilities.',
        collaboration_partners: '',
        sustainability_plan: 'Maintain strong academic performance and build mentorship/community support networks during college.',
        barriers_faced: 'Cost of attendance, housing, transportation, and family-support responsibilities.',
        special_circumstances: 'Large household and dependent-benefit context are synthetic test signals.',
      },
    },
  }),
  profile({
    id: 'profile-demo-basic-needs',
    display_name: 'Designated Basic Needs Profile',
    primary_type: 'individual',
    tags: ['basic_needs', 'emergency_assistance'],
    cityState: 'Tennessee',
    goal: 'Find emergency assistance, health support, and household-stability resources.',
  }),
  profile({
    id: 'profile-demo-hcbs-support',
    display_name: 'Designated HCBS Support Profile',
    primary_type: 'individual',
    tags: ['disability', 'hcbs_waiver', 'medical_assistance'],
    cityState: 'Tennessee',
    goal: 'Find disability, HCBS, dental, assistive technology, and community-engagement resources.',
    sections: {
      demographics: {
        disability_status: true,
        notes: 'Synthetic adult disability-support profile.',
      },
      government_assistance: {
        ssi_recipient_self: true,
        other_programs: 'Synthetic HCBS waiver signal.',
      },
      health_medical: {
        disability_type: ['Developmental disability support need'],
        notes: 'Synthetic health-support need. No real diagnosis is stored here.',
      },
      employment: {
        current_status: 'unable_to_work',
      },
    },
  }),
  profile({
    id: 'profile-demo-senior-medical',
    display_name: 'Designated Senior Medical Profile',
    primary_type: 'individual',
    tags: ['senior', 'medical_assistance'],
    cityState: 'Tennessee',
    goal: 'Find senior medical, transportation, rehabilitation, and household support resources.',
    sections: {
      demographics: { age_group: 'Senior 62+' },
      health_medical: {
        support_needs_level: 'high',
        notes: 'Synthetic senior medical-support profile.',
      },
    },
  }),
  profile({
    id: 'profile-demo-tennessee-college-student',
    display_name: 'Demo Tennessee College Student',
    primary_type: 'college_student',
    tags: ['student', 'ems', 'healthcare_training'],
    cityState: 'Tennessee',
    goal: 'Find paramedicine, EMS, textbook, equipment, and workforce-training funding.',
    sections: {
      education: {
        highest_level: 'College Student',
        intended_major: 'Paramedicine',
        target_colleges: ['Cleveland State Community College'],
      },
      occupation: { ems_worker: true, healthcare_worker: true },
    },
  }),
  profile({
    id: 'profile-demo-career-support',
    display_name: 'Designated Career Support Profile',
    primary_type: 'individual',
    tags: ['career_training', 'basic_needs'],
    cityState: 'United States',
    goal: 'Find career training, household-stability, and emergency-assistance resources.',
  }),
  profile({
    id: 'profile-demo-general-support',
    display_name: 'Designated General Support Profile',
    primary_type: 'individual',
    tags: ['general_support'],
    cityState: 'United States',
    owner_email: 'demo.general-support@example.invalid',
    goal: 'Find eligible benefits, grants, and community programs without exposing private details in source.',
  }),
  profile({
    id: 'profile-demo-general-funding',
    display_name: 'Designated General Funding Profile',
    primary_type: 'individual',
    tags: ['general_support'],
    cityState: 'United States',
    goal: 'Find aligned grants, benefits, scholarships, and services after private intake is completed.',
  }),
]

function isDeployedRuntime(env = process.env) {
  return (
    String(env.NODE_ENV || '').trim().toLowerCase() === 'production' ||
    Boolean(String(env.RAILWAY_ENVIRONMENT_ID || '').trim()) ||
    Boolean(String(env.RAILWAY_DEPLOYMENT_ID || '').trim())
  )
}

const privateDesignatedProfiles = loadPrivateDesignatedProfiles(process.env.DESIGNATED_PROFILES_FILE)
const deployedRuntime = isDeployedRuntime()

// Public fixtures are for local development and tests only. A deployed runtime
// must receive its legacy ids and any real client facts from a private mounted
// file. If that file is absent or invalid, fail closed with an empty roster:
// boot may continue against existing database rows, but source fixtures cannot
// create or mutate a real-person profile.
export const DESIGNATED_PROFILES_SOURCE = privateDesignatedProfiles
  ? 'private_file'
  : deployedRuntime
    ? 'disabled_missing_private_file'
    : 'public_fixture'

export const DESIGNATED_PROFILES = privateDesignatedProfiles || (deployedRuntime ? [] : PUBLIC_FIXTURE_PROFILES)

if (DESIGNATED_PROFILES_SOURCE === 'disabled_missing_private_file') {
  console.error(
    '[designatedProfiles] Private designated-profile configuration is unavailable in a deployed runtime. ' +
      'Designated seeding and alias repair are disabled; configure a readable DESIGNATED_PROFILES_FILE.',
  )
}
