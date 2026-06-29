/**
 * syntheticProfileCatalog.js
 *
 * The catalog of synthetic GrantFlow profile scenarios Amy uses to exercise the
 * crawlers. Each category maps a real-world applicant type to schema-accurate
 * section data (field names come straight from backend/config/profileSchema.js).
 *
 * HARD RULE — NO REAL PII. All identities are obviously synthetic:
 *   - display/full names: "Amy Synthetic — <Label> #<n>"
 *   - emails: amy+<scenario>@synthetic.grantflow.invalid  (.invalid is reserved)
 *   - phones: 555-01xx  (555-0100..0199 are reserved fictional numbers)
 *   - locations: a small fixed list of real US cities for geo realism only.
 *
 * Variation: each category can emit N variants. A seeded RNG (per run id) picks
 * the location and tweaks need amounts so a run is varied yet reproducible.
 */

import { makeSeededRng } from './amyMetadata.js'

/** Real US locations used purely for geographic realism (no personal data). */
const LOCATIONS = [
  { state: 'TN', city: 'Nashville', zip: '37203', county: 'Davidson' },
  { state: 'OH', city: 'Columbus', zip: '43215', county: 'Franklin' },
  { state: 'CA', city: 'Fresno', zip: '93721', county: 'Fresno' },
  { state: 'TX', city: 'El Paso', zip: '79901', county: 'El Paso' },
  { state: 'NY', city: 'Buffalo', zip: '14202', county: 'Erie' },
  { state: 'MT', city: 'Billings', zip: '59101', county: 'Yellowstone' },
  { state: 'GA', city: 'Albany', zip: '31701', county: 'Dougherty' },
  { state: 'NM', city: 'Gallup', zip: '87301', county: 'McKinley' },
  { state: 'WV', city: 'Beckley', zip: '25801', county: 'Raleigh' },
  { state: 'FL', city: 'Pensacola', zip: '32502', county: 'Escambia' },
]

const FUNDING_BANDS = ['$5,000', '$15,000', '$25,000', '$50,000', '$100,000', '$250,000']

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length]
}

/**
 * Category catalog. Each entry: { label, primary_type, kind, build(ctx) }.
 * build returns ONLY the section overrides (merged over schema defaults by the
 * profile store). ctx = { rng, location, index, syntheticEmail }.
 */
export const CATEGORY_CATALOG = Object.freeze({
  business: {
    label: 'Small Business',
    primary_type: 'small_business',
    kind: 'org',
    build: ({ location, rng }) => ({
      organization_details: {
        organization_type: 'small business',
        small_business_owner: true,
        annual_budget: 250000,
        staff_count: 8,
        sam_gov_registered: true,
      },
      occupation: { small_business_owner: true },
      narrative: {
        mission: 'Grow a local small business and create jobs.',
        primary_goal: 'Working capital and equipment grants for expansion.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['small_business', 'economic_development'],
        interests: ['working capital', 'equipment', 'hiring'],
        keywords: ['small business grant', 'startup', 'expansion'],
      },
      location_focus: { geographic_focus: `${location.city}, ${location.state}` },
    }),
  },

  nonprofit: {
    label: 'Nonprofit Organization',
    primary_type: 'nonprofit',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: {
        organization_type: 'nonprofit',
        is_501c3_public_charity: true,
        ntee_code: 'P20',
        sam_gov_registered: true,
        grants_gov_account: true,
        annual_budget: 750000,
      },
      occupation: { nonprofit_employee: true },
      narrative: {
        mission: 'Community human-services nonprofit serving low-income families.',
        primary_goal: 'Program and capacity-building funding.',
        target_population: 'Low-income families',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['human_services', 'capacity_building'],
        interests: ['program funding', 'general operating', 'capacity'],
        keywords: ['nonprofit grant', 'community programs', 'human services'],
      },
    }),
  },

  school_district: {
    label: 'School District',
    primary_type: 'school_district',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: {
        organization_type: 'school district',
        sam_gov_registered: true,
        grants_gov_account: true,
      },
      narrative: {
        mission: 'Public school district improving student outcomes.',
        primary_goal: 'STEM, literacy, and facilities funding.',
        target_population: 'K-12 students',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['education', 'k12', 'stem'],
        interests: ['title I', 'literacy', 'facilities'],
        keywords: ['school district grant', 'K-12', 'education'],
      },
    }),
  },

  college_university: {
    label: 'College / University',
    primary_type: 'higher_education_institution',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: {
        organization_type: 'university',
        sam_gov_registered: true,
        grants_gov_account: true,
        era_commons_account: true,
      },
      narrative: {
        mission: 'Higher-education institution advancing research and access.',
        primary_goal: 'Research and student-access funding.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['higher_education', 'research'],
        interests: ['research', 'student access', 'TRIO'],
        keywords: ['university grant', 'research funding', 'higher education'],
      },
    }),
  },

  high_school_student: {
    label: 'High School Student',
    primary_type: 'high_school_student',
    kind: 'individual',
    build: () => ({
      education: {
        highest_level: 'high school (in progress)',
        intended_major: 'Computer Science',
        gpa: 3.6,
        pell_grant_eligible: true,
        fafsa_completed: false,
      },
      narrative: {
        mission: 'First-generation student pursuing a STEM degree.',
        primary_goal: 'Scholarships for college tuition.',
      },
      programs_services: {
        focus_areas: ['scholarship', 'education'],
        interests: ['scholarship', 'tuition', 'STEM'],
        keywords: ['high school scholarship', 'college tuition', 'STEM'],
      },
    }),
  },

  college_student: {
    label: 'College Student',
    primary_type: 'college_student',
    kind: 'individual',
    build: () => ({
      education: {
        highest_level: 'undergraduate (in progress)',
        current_institution: 'State University',
        intended_major: 'Nursing',
        gpa: 3.4,
        pell_grant_eligible: true,
        fafsa_completed: true,
      },
      narrative: {
        mission: 'Undergraduate nursing student.',
        primary_goal: 'Scholarships and emergency tuition aid.',
      },
      programs_services: {
        focus_areas: ['scholarship', 'nursing'],
        interests: ['scholarship', 'tuition', 'nursing'],
        keywords: ['college scholarship', 'nursing', 'tuition assistance'],
      },
    }),
  },

  graduate_student: {
    label: 'Graduate Student',
    primary_type: 'graduate_student',
    kind: 'individual',
    build: () => ({
      education: {
        highest_level: "master's (in progress)",
        current_institution: 'State University',
        intended_major: 'Public Health',
        gpa: 3.8,
        fafsa_completed: true,
      },
      narrative: {
        mission: 'Graduate researcher in public health.',
        primary_goal: 'Fellowships and research stipends.',
      },
      programs_services: {
        focus_areas: ['fellowship', 'research'],
        interests: ['fellowship', 'research stipend', 'public health'],
        keywords: ['graduate fellowship', 'research grant', 'stipend'],
      },
    }),
  },

  homeschool_family: {
    label: 'Homeschool Family',
    primary_type: 'homeschool_family',
    kind: 'individual',
    build: () => ({
      family: { household_size: 5, responsibilities: 'Parent homeschooling three children.' },
      education: { highest_level: 'homeschool (K-12)', cte_pathway: 'General' },
      narrative: {
        mission: 'Homeschooling family seeking curriculum and enrichment funding.',
        primary_goal: 'Curriculum, technology, and enrichment grants.',
      },
      programs_services: {
        focus_areas: ['education', 'homeschool'],
        interests: ['curriculum', 'enrichment', 'technology'],
        keywords: ['homeschool grant', 'curriculum', 'education'],
      },
    }),
  },

  individual_assistance: {
    label: 'Individual Seeking Assistance',
    primary_type: 'individual_need',
    kind: 'individual',
    build: ({ rng }) => ({
      financial_information: {
        household_income: 22000,
        household_size: 3,
        financial_need_level: 'high',
        low_income: true,
      },
      government_assistance: { snap_recipient_self: true },
      housing: { status: 'at-risk', type: 'rent' },
      narrative: {
        mission: 'Individual facing financial hardship.',
        primary_goal: 'Rent, utility, and food assistance.',
        funding_amount_needed: pick(rng, ['$1,500', '$3,000', '$5,000']),
      },
      programs_services: {
        focus_areas: ['emergency_assistance', 'housing'],
        interests: ['rent', 'utilities', 'food'],
        keywords: ['emergency assistance', 'rent help', 'utility assistance'],
      },
    }),
  },

  cancer_patient: {
    label: 'Cancer Patient',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      health_medical: {
        conditions: [{ name: 'breast cancer', stage: 'II' }],
        chronic_illness: true,
        chronic_illness_type: 'cancer',
      },
      financial_information: { has_medical_debt: true, financial_need_level: 'high', low_income: true },
      narrative: {
        mission: 'Cancer patient managing treatment costs.',
        primary_goal: 'Medical, travel, and living-expense assistance during treatment.',
      },
      programs_services: {
        focus_areas: ['medical_assistance', 'cancer'],
        interests: ['cancer', 'treatment costs', 'patient assistance'],
        keywords: ['cancer patient grant', 'medical assistance', 'copay relief'],
      },
    }),
  },

  chronic_illness_patient: {
    label: 'Chronic Illness Patient',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      health_medical: {
        chronic_illness: true,
        chronic_illness_type: 'multiple sclerosis',
        conditions: [{ name: 'multiple sclerosis' }],
      },
      financial_information: { has_medical_debt: true, financial_need_level: 'moderate' },
      narrative: {
        mission: 'Person managing a chronic illness.',
        primary_goal: 'Help with medication, equipment, and living costs.',
      },
      programs_services: {
        focus_areas: ['medical_assistance', 'chronic_illness'],
        interests: ['medication', 'medical equipment', 'patient assistance'],
        keywords: ['chronic illness grant', 'patient assistance', 'medication'],
      },
    }),
  },

  disabled_person: {
    label: 'Disabled Person',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      health_medical: { disability_type: ['mobility', 'vision'], support_needs: ['assistive technology'] },
      government_assistance: { ssi_recipient_self: true, ssdi_recipient_self: true },
      narrative: {
        mission: 'Person with disabilities seeking independence supports.',
        primary_goal: 'Assistive technology, home modification, and transportation.',
      },
      programs_services: {
        focus_areas: ['disability', 'accessibility'],
        interests: ['assistive technology', 'home modification', 'transportation'],
        keywords: ['disability grant', 'assistive technology', 'accessibility'],
      },
    }),
  },

  veteran: {
    label: 'Veteran',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      military_service: { veteran: true, disabled_veteran: true, notes: 'Army, 2008–2016, 40% rating.' },
      narrative: {
        mission: 'Veteran transitioning to civilian life.',
        primary_goal: 'Housing, education, and small-business support for veterans.',
      },
      programs_services: {
        focus_areas: ['veteran', 'transition'],
        interests: ['veteran housing', 'GI Bill', 'veteran business'],
        keywords: ['veteran grant', 'VA benefits', 'veteran assistance'],
      },
    }),
  },

  military_family: {
    label: 'Military Spouse / Dependent',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      military_service: { military_spouse: true, military_dependent: false, active_duty_military: false },
      narrative: {
        mission: 'Military spouse pursuing education and career portability.',
        primary_goal: 'Spouse scholarships and career/licensing support.',
      },
      programs_services: {
        focus_areas: ['military_family', 'education'],
        interests: ['spouse scholarship', 'MyCAA', 'licensing'],
        keywords: ['military spouse grant', 'MyCAA', 'dependent scholarship'],
      },
    }),
  },

  single_parent: {
    label: 'Single Parent',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      family: { household_size: 3, responsibilities: 'Single parent of two young children.' },
      financial_information: { financial_need_level: 'high', low_income: true, household_size: 3 },
      government_assistance: { tanf_recipient_self: true, snap_recipient_self: true },
      narrative: {
        mission: 'Single parent balancing work and childcare.',
        primary_goal: 'Childcare, education, and emergency assistance.',
      },
      programs_services: {
        focus_areas: ['family', 'childcare'],
        interests: ['childcare', 'single parent scholarship', 'emergency assistance'],
        keywords: ['single parent grant', 'childcare assistance', 'family support'],
      },
    }),
  },

  grandparent_caregiver: {
    label: 'Grandparent Raising Grandchildren',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      family: { household_size: 4, responsibilities: 'Grandparent raising two grandchildren (kinship care).' },
      financial_information: { financial_need_level: 'moderate', household_size: 4 },
      narrative: {
        mission: 'Grandparent providing kinship care.',
        primary_goal: 'Kinship-care support, childcare, and basic needs.',
      },
      programs_services: {
        focus_areas: ['family', 'kinship_care'],
        interests: ['kinship care', 'childcare', 'basic needs'],
        keywords: ['kinship care grant', 'grandparent caregiver', 'family support'],
      },
    }),
  },

  foster_youth: {
    label: 'Foster / Former Foster Youth',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      narrative: {
        mission: 'Former foster youth pursuing education and stability.',
        primary_goal: 'Education, housing, and transition support for foster youth.',
        special_circumstances: 'Aged out of foster care; eligible for ETV and foster-youth programs.',
      },
      education: { highest_level: 'undergraduate (in progress)', pell_grant_eligible: true },
      programs_services: {
        focus_areas: ['foster_youth', 'education'],
        interests: ['foster youth scholarship', 'ETV', 'transition housing'],
        keywords: ['foster youth grant', 'education and training voucher', 'transition'],
      },
    }),
  },

  domestic_violence_survivor: {
    label: 'Domestic Violence Survivor',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      housing: { status: 'transitional', type: 'shelter' },
      narrative: {
        mission: 'Survivor rebuilding safety and independence.',
        primary_goal: 'Emergency housing, legal aid, and relocation assistance.',
        special_circumstances: 'Domestic violence survivor seeking safe relocation.',
        barriers_faced: 'Safety, housing instability, legal needs.',
      },
      programs_services: {
        focus_areas: ['domestic_violence', 'emergency_assistance'],
        interests: ['safe housing', 'legal aid', 'relocation'],
        keywords: ['domestic violence grant', 'survivor assistance', 'emergency housing'],
      },
    }),
  },

  disaster_survivor: {
    label: 'Disaster Survivor',
    primary_type: 'individual_need',
    kind: 'individual',
    build: () => ({
      location_focus: { notes: 'FEMA-declared disaster area.' },
      narrative: {
        mission: 'Household recovering from a natural disaster.',
        primary_goal: 'Disaster recovery: housing repair, replacement of essentials.',
        special_circumstances: 'Impacted by a FEMA-declared disaster.',
      },
      programs_services: {
        focus_areas: ['disaster_recovery', 'housing'],
        interests: ['disaster relief', 'home repair', 'FEMA'],
        keywords: ['disaster recovery grant', 'FEMA assistance', 'rebuild'],
      },
    }),
  },

  faith_based_org: {
    label: 'Faith-Based Organization',
    primary_type: 'faith_based',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: { organization_type: 'church', is_faith_based: true, is_501c3_public_charity: true },
      occupation: { clergy: true },
      narrative: {
        mission: 'Faith-based organization serving the community.',
        primary_goal: 'Community outreach, food, and housing ministry funding.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['faith_based', 'community'],
        interests: ['food ministry', 'housing', 'youth programs'],
        keywords: ['faith-based grant', 'church grant', 'community ministry'],
      },
    }),
  },

  tribal_org: {
    label: 'Tribal Organization',
    primary_type: 'tribal_organization',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: { organization_type: 'tribal government', is_tribal_government: true, sam_gov_registered: true },
      demographics: { native_american: true, tribal_affiliation: 'Synthetic Nation (test)' },
      narrative: {
        mission: 'Tribal organization advancing community wellbeing.',
        primary_goal: 'Housing, health, and economic-development funding for tribal members.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['tribal', 'community_development'],
        interests: ['tribal housing', 'tribal health', 'economic development'],
        keywords: ['tribal grant', 'Native American funding', 'tribal government'],
      },
    }),
  },

  rural_health_clinic: {
    label: 'Rural Health Clinic',
    primary_type: 'healthcare_organization',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: {
        organization_type: 'rural health clinic',
        is_rural_health_clinic: true,
        is_rural_serving: true,
        sam_gov_registered: true,
      },
      location_focus: { rural_resident: true, geographic_focus: 'Rural service area' },
      narrative: {
        mission: 'Rural health clinic expanding access to care.',
        primary_goal: 'Equipment, telehealth, and workforce funding.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['rural_health', 'healthcare'],
        interests: ['telehealth', 'medical equipment', 'workforce'],
        keywords: ['rural health grant', 'clinic funding', 'telehealth'],
      },
    }),
  },

  research_lab: {
    label: 'Research Lab',
    primary_type: 'research_institution',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: {
        organization_type: 'research laboratory',
        era_commons_account: true,
        sam_gov_registered: true,
        cert_sbir_sttr: true,
      },
      narrative: {
        mission: 'Applied research laboratory.',
        primary_goal: 'Federal research funding (NIH/NSF/SBIR).',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['research', 'innovation'],
        interests: ['SBIR', 'STTR', 'R01', 'NSF'],
        keywords: ['research grant', 'SBIR', 'federal research funding'],
      },
    }),
  },

  community_development_corp: {
    label: 'Community Development Corporation',
    primary_type: 'nonprofit',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: {
        organization_type: 'community development corporation',
        is_community_action_agency: true,
        is_501c3_public_charity: true,
        sam_gov_registered: true,
      },
      narrative: {
        mission: 'CDC revitalizing neighborhoods and building affordable housing.',
        primary_goal: 'Affordable housing and community-development funding.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['community_development', 'affordable_housing'],
        interests: ['CDBG', 'affordable housing', 'economic development'],
        keywords: ['community development grant', 'CDBG', 'affordable housing'],
      },
    }),
  },

  housing_authority: {
    label: 'Housing Authority',
    primary_type: 'government_agency',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: {
        organization_type: 'public housing authority',
        is_housing_authority: true,
        sam_gov_registered: true,
        grants_gov_account: true,
      },
      narrative: {
        mission: 'Public housing authority serving low-income residents.',
        primary_goal: 'HUD capital and resident-services funding.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['housing', 'public_housing'],
        interests: ['HUD', 'capital fund', 'resident services'],
        keywords: ['housing authority grant', 'HUD', 'public housing'],
      },
    }),
  },

  agricultural_cooperative: {
    label: 'Agricultural Cooperative',
    primary_type: 'cooperative',
    kind: 'org',
    build: ({ location, rng }) => ({
      organization_details: { organization_type: 'agricultural cooperative', is_cooperative: true, is_rural_serving: true },
      occupation: { farmer: true },
      location_focus: { rural_resident: true, geographic_focus: `${location.county} County, ${location.state}` },
      narrative: {
        mission: 'Farmer-owned agricultural cooperative.',
        primary_goal: 'USDA rural co-op, value-added, and equipment funding.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['agriculture', 'rural_cooperative'],
        interests: ['USDA', 'value-added producer', 'farm equipment'],
        keywords: ['agricultural cooperative grant', 'USDA rural', 'value-added'],
      },
    }),
  },

  workforce_org: {
    label: 'Workforce / Apprenticeship Organization',
    primary_type: 'nonprofit',
    kind: 'org',
    build: ({ rng }) => ({
      organization_details: {
        organization_type: 'workforce development board',
        is_workforce_dev_board: true,
        sam_gov_registered: true,
        grants_gov_account: true,
      },
      narrative: {
        mission: 'Workforce organization running apprenticeships and training.',
        primary_goal: 'WIOA, apprenticeship, and reskilling funding.',
        funding_amount_needed: pick(rng, FUNDING_BANDS),
      },
      programs_services: {
        focus_areas: ['workforce', 'apprenticeship'],
        interests: ['WIOA', 'apprenticeship', 'job training'],
        keywords: ['workforce grant', 'apprenticeship', 'WIOA'],
      },
    }),
  },
})

export const CATEGORY_IDS = Object.freeze(Object.keys(CATEGORY_CATALOG))

/**
 * Compute how many variants to make per category.
 *  - targetCount (when set): distribute EXACTLY that many profiles across the
 *    categories round-robin (e.g. 100/day spread evenly over 27 categories).
 *  - else: `perCategory` variants for every category.
 *
 * @returns {Record<string, number>} category id → variant count
 */
export function planVariantCounts({ categories = CATEGORY_IDS, perCategory = 1, targetCount = null } = {}) {
  const ids = Array.isArray(categories) && categories.length > 0 ? categories.filter((c) => CATEGORY_CATALOG[c]) : CATEGORY_IDS
  const counts = {}
  for (const c of ids) counts[c] = 0

  if (Number.isFinite(Number(targetCount)) && Number(targetCount) > 0) {
    const total = Math.max(1, Math.min(5000, Math.floor(Number(targetCount))))
    for (let i = 0; i < total; i++) {
      const c = ids[i % ids.length]
      counts[c] += 1
    }
  } else {
    const variants = Math.max(1, Math.min(50, Number(perCategory) || 1))
    for (const c of ids) counts[c] = variants
  }
  return counts
}

/**
 * Generate synthetic profile scenarios.
 *
 * @param {object} opts
 * @param {string} opts.runId        - the Amy run id (seeds the RNG).
 * @param {string[]} [opts.categories] - subset of CATEGORY_IDS (default: all).
 * @param {number} [opts.perCategory=1] - variants per category (ignored when
 *        targetCount is set).
 * @param {number} [opts.targetCount] - exact total number of profiles to make,
 *        distributed across categories (e.g. 100/day). Takes precedence.
 * @returns {Array<object>} scenarios with { scenario_id, category, label,
 *          primary_type, kind, display_name, sections, expected }.
 */
export function generateScenarios({ runId, categories = CATEGORY_IDS, perCategory = 1, targetCount = null } = {}) {
  const ids = Array.isArray(categories) && categories.length > 0 ? categories.filter((c) => CATEGORY_CATALOG[c]) : CATEGORY_IDS
  const counts = planVariantCounts({ categories: ids, perCategory, targetCount })
  const scenarios = []

  for (const category of ids) {
    const def = CATEGORY_CATALOG[category]
    if (!def) continue
    const variants = counts[category] || 0
    for (let v = 0; v < variants; v++) {
      const scenarioId = `${category}-v${v + 1}`
      const rng = makeSeededRng(`${runId}:${scenarioId}`)
      const location = LOCATIONS[Math.floor(rng() * LOCATIONS.length) % LOCATIONS.length]
      const syntheticEmail = `amy+${scenarioId}@synthetic.grantflow.invalid`
      const displayName = `Amy Synthetic — ${def.label} #${v + 1}`

      const overrides = def.build({ rng, location, index: v, syntheticEmail }) || {}

      // Every profile gets a clearly-synthetic basic_information block with a
      // real-but-generic location so geo matching has something to work with.
      const basic = {
        full_name: displayName,
        email: syntheticEmail,
        phone: `555-01${String((v % 100)).padStart(2, '0')}`,
        city: location.city,
        state: location.state,
        zip: location.zip,
        profile_category: def.primary_type,
        notes: 'SYNTHETIC training profile generated by Amy. Not a real person/org. Safe for Sam cleanup.',
        ...(overrides.basic_information || {}),
      }

      const sections = { ...overrides, basic_information: basic }

      scenarios.push({
        scenario_id: scenarioId,
        category,
        label: def.label,
        primary_type: def.primary_type,
        kind: def.kind,
        display_name: displayName,
        sections,
        expected: {
          state: location.state,
          zip: location.zip,
          needs: (sections.programs_services?.interests || []).slice(0, 4),
        },
      })
    }
  }

  return scenarios
}

export default { CATEGORY_CATALOG, CATEGORY_IDS, generateScenarios, planVariantCounts }
