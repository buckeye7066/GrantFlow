/**
 * profileGapAnalyzer.js
 *
 * Profile Gap Analyzer
 *
 * Compares a profile's filled/empty sections against known program requirements.
 * Returns actionable gap messages telling the user which missing fields would
 * unlock specific grants, and quantifies the potential impact.
 *
 * @module profileGapAnalyzer
 */

// ── Section metadata ───────────────────────────────────────────────────────────

/**
 * Map of section keys to human-readable labels, importance, missing-field hints,
 * and programs that become available when the section is completed.
 */
const SECTION_SPECS = [
  {
    sectionKey: 'military_service',
    sectionLabel: 'Military Service',
    importance: 'high',
    requiredFields: ['veteran', 'branch', 'discharge_status'],
    programsUnlocked: [
      'VA Benefits', 'VA Healthcare', 'VA Pension', 'HUD-VASH',
      'SSVF (Supportive Services for Veteran Families)',
      'VR&E (Vocational Rehabilitation & Employment)',
      'Post-9/11 GI Bill', 'Folds of Honor', 'Pat Tillman Foundation',
      'DAV Grants', 'VFW Unmet Needs Program', 'American Legion Auxiliary',
    ],
    actionMessage:
      'You have no military_service data. If you or a family member is a veteran, filling this section would unlock VA, SSVF, and HUD-VASH programs.',
  },
  {
    sectionKey: 'health_medical',
    sectionLabel: 'Health & Medical',
    importance: 'high',
    requiredFields: ['disability_type', 'chronic_illness', 'conditions'],
    programsUnlocked: [
      'SSI (Disability)', 'SSDI', 'Medicaid Waiver Programs',
      'ABLE Accounts', 'Ryan White HIV/AIDS Program',
      'Easterseals Grants', 'National MS Society', 'ALS Association',
      'Cancer Care Financial Assistance', 'Patient Advocate Foundation',
      'NeedyMeds Prescription Assistance', 'State Developmental Disability Services',
      'Home & Community Based Services (HCBS)', 'Assistive Technology Programs',
    ],
    actionMessage:
      'Completing your health_medical section could unlock ~15 additional disability and chronic-illness programs.',
  },
  {
    sectionKey: 'financial_information',
    sectionLabel: 'Financial Information',
    importance: 'high',
    requiredFields: ['annual_income', 'household_income', 'employment_status'],
    programsUnlocked: [
      'SNAP', 'TANF', 'LIHEAP', 'Medicaid', 'CHIP',
      'Section 8 / HCV', 'EITC', 'WIC', 'Lifeline',
      'Community Action Agency Emergency Assistance',
      'United Way Financial Stability Programs',
      'Emergency Rental Assistance (ERA)',
    ],
    actionMessage:
      'Income and household data enables eligibility screening for SNAP, Medicaid, LIHEAP, Section 8, and EITC. Without it, most need-based programs cannot be matched.',
  },
  {
    sectionKey: 'family_life',
    sectionLabel: 'Family Life',
    importance: 'high',
    requiredFields: ['household_size', 'number_of_children', 'single_parent'],
    programsUnlocked: [
      'TANF', 'WIC', 'CCDF (Child Care)', 'Free School Meals',
      'Head Start / Early Head Start', 'CHIP',
      'Family Violence Prevention Services',
      'Healthy Families America', 'Parents as Teachers',
      'Child Welfare Assistance Programs',
    ],
    actionMessage:
      'Family composition data (children, single-parent status, household size) unlocks TANF, WIC, childcare subsidies, and Head Start programs.',
  },
  {
    sectionKey: 'education',
    sectionLabel: 'Education',
    importance: 'medium',
    requiredFields: ['highest_education', 'enrollment_status', 'intended_major'],
    programsUnlocked: [
      'Federal Pell Grant', 'Federal SEOG Grant', 'Work-Study',
      'State Need-Based Aid', 'TRIO Programs (Upward Bound, SSS)',
      'QuestBridge National College Match', 'Gates Scholarship',
      'Dell Scholars Program', 'Coca-Cola Scholars Foundation',
      'Tennessee Promise', 'Tennessee Student Assistance Awards',
    ],
    actionMessage:
      'Education enrollment data unlocks Pell Grants, TRIO programs, state scholarships, and institution-specific aid worth thousands annually.',
  },
  {
    sectionKey: 'housing',
    sectionLabel: 'Housing',
    importance: 'medium',
    requiredFields: ['housing_status', 'rent_burden', 'risk_of_homelessness'],
    programsUnlocked: [
      'Emergency Rental Assistance (ERA)', 'HOME Investment Partnerships',
      'Section 8 / HCV Priority', 'CoC Homeless Assistance Grants',
      'ESG (Emergency Solutions Grants)', 'USDA Rural Housing Programs',
      'State Housing Finance Agency Programs', 'HUD-VASH (if veteran)',
    ],
    actionMessage:
      'Housing status data enables matching with emergency rental assistance, HUD programs, and homelessness-prevention grants.',
  },
  {
    sectionKey: 'employment',
    sectionLabel: 'Employment',
    importance: 'medium',
    requiredFields: ['employment_status', 'occupation', 'job_skills'],
    programsUnlocked: [
      'WIOA Workforce Training', 'Trade Adjustment Assistance (TAA)',
      'Second Chance Employment Grants', 'Registered Apprenticeship Programs',
      'YouthBuild', 'Job Corps', 'Senior Community Service Employment Program (SCSEP)',
      'Tennessee Promise Plus', 'CareerOneStop Local Workforce Programs',
    ],
    actionMessage:
      'Employment data unlocks workforce development, job training grants (WIOA), and sector-specific career programs.',
  },
  {
    sectionKey: 'demographics',
    sectionLabel: 'Demographics',
    importance: 'medium',
    requiredFields: ['age', 'race_ethnicity', 'gender'],
    programsUnlocked: [
      'Minority Business Development Agency (MBDA) Grants',
      'Hispanic Scholarship Fund', 'UNCF (United Negro College Fund)',
      'AARP Foundation Grants (55+)', 'Elder Care Programs',
      'Native American Tribal Grants', 'Women-Owned Business Programs',
      'Girl Scouts / Boys & Girls Clubs Scholarships',
    ],
    actionMessage:
      'Demographics data enables race/ethnicity and age-specific grant matching, including minority scholarships and senior programs.',
  },
  {
    sectionKey: 'immigration_status',
    sectionLabel: 'Immigration Status',
    importance: 'low',
    requiredFields: ['immigration_status', 'visa_type', 'country_of_origin'],
    programsUnlocked: [
      'DACA-Specific Scholarships (TheDream.US)', 'Immigrant Services Programs',
      'State-Funded Healthcare for Immigrants', 'International Institute Assistance',
      'Catholic Charities Immigration Services', 'New American Workforce Programs',
    ],
    actionMessage:
      'Immigration status data can unlock DACA-specific scholarships and immigrant services that are otherwise invisible to the matcher.',
  },
  {
    sectionKey: 'small_business',
    sectionLabel: 'Small Business',
    importance: 'low',
    requiredFields: ['business_name', 'business_type', 'number_of_employees'],
    programsUnlocked: [
      'SBA Small Business Grants', 'SBIR/STTR Research Grants',
      'State Small Business Credit Initiative (SSBCI)',
      'USDA Rural Business Development Grants', 'Minority Business Grants',
      'Women-Owned Small Business Federal Contracting',
    ],
    actionMessage:
      'Small business data unlocks SBA programs, SBIR R&D grants, and state business development funds.',
  },
]

// ── Field presence helpers ─────────────────────────────────────────────────────

function hasValue(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

function countFilledFields(obj) {
  if (!obj || typeof obj !== 'object') return 0
  return Object.values(obj).filter(hasValue).length
}

function totalFieldCount(obj) {
  if (!obj || typeof obj !== 'object') return 0
  return Object.keys(obj).length
}

// ── Completion percentage ─────────────────────────────────────────────────────

/**
 * Calculate overall profile completion percentage.
 * Uses weighted section importance: high=3, medium=2, low=1.
 */
function calculateCompletion(sections) {
  const weights = { high: 3, medium: 2, low: 1 }
  let totalWeight = 0
  let filledWeight = 0

  for (const spec of SECTION_SPECS) {
    const w = weights[spec.importance] ?? 1
    totalWeight += w

    const sectionData = sections[spec.sectionKey]
    if (!sectionData || typeof sectionData !== 'object') continue

    const requiredPresent = spec.requiredFields.filter((f) => hasValue(sectionData[f])).length
    const ratio = requiredPresent / spec.requiredFields.length
    filledWeight += w * ratio
  }

  if (totalWeight === 0) return 0
  return Math.round((filledWeight / totalWeight) * 100)
}

// ── Gap detection ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Gap
 * @property {string} sectionKey
 * @property {string} sectionLabel
 * @property {'high'|'medium'|'low'} importance
 * @property {string[]} missingFields
 * @property {string[]} programsUnlocked
 * @property {string} actionMessage
 */

/**
 * Analyze a profile's sections and return gaps.
 *
 * @param {Object} profileContext - Full profile context ({ profile, sections, signals })
 * @returns {{ gaps: Gap[], completionPercentage: number, potentialProgramsUnlocked: number }}
 */
export function analyzeProfileGaps(profileContext) {
  if (!profileContext) {
    return { gaps: [], completionPercentage: 0, potentialProgramsUnlocked: 0 }
  }

  const sections = profileContext.sections || {}
  const gaps = []

  for (const spec of SECTION_SPECS) {
    const sectionData = sections[spec.sectionKey]

    // Determine which required fields are missing
    const missingFields = spec.requiredFields.filter((f) => {
      if (!sectionData || typeof sectionData !== 'object') return true
      return !hasValue(sectionData[f])
    })

    // Gap exists when at least one required field is absent
    if (missingFields.length > 0) {
      // Refine action message to name the missing fields
      const fieldList = missingFields.join(', ')
      const enrichedMessage =
        missingFields.length === spec.requiredFields.length
          ? `${spec.sectionLabel} section is empty. ${spec.actionMessage}`
          : `${spec.sectionLabel} section is partially filled — missing: ${fieldList}. ${spec.actionMessage}`

      gaps.push({
        sectionKey: spec.sectionKey,
        sectionLabel: spec.sectionLabel,
        importance: spec.importance,
        missingFields,
        programsUnlocked: spec.programsUnlocked,
        actionMessage: enrichedMessage,
      })
    }
  }

  const completionPercentage = calculateCompletion(sections)
  const potentialProgramsUnlocked = gaps.reduce((sum, g) => sum + g.programsUnlocked.length, 0)

  return { gaps, completionPercentage, potentialProgramsUnlocked }
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────
// Run: node backend/services/profileGapAnalyzer.js

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('profileGapAnalyzer')
) {
  const demoContext = {
    profile: { primary_type: 'individual', state: 'tn' },
    sections: {
      financial_information: { annual_income: 18000 },
      family_life: { household_size: 3 },
      basic_information: { age: 32 },
    },
  }
  const result = analyzeProfileGaps(demoContext)
  console.log('=== Profile Gap Analysis Demo ===')
  console.log(`Completion: ${result.completionPercentage}%`)
  console.log(`Programs potentially unlocked by completing gaps: ${result.potentialProgramsUnlocked}`)
  console.log(`\nGaps (${result.gaps.length}):`)
  result.gaps.forEach((g) =>
    console.log(`  [${g.importance.toUpperCase()}] ${g.sectionLabel}: ${g.actionMessage}`),
  )
}
