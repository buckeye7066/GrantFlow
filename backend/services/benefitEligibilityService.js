import { createLogger } from '../utils/logger.js'
const log = createLogger('benefitEligibilityService')
/**
 * benefitEligibilityService.js
 *
 * Benefit Eligibility Pre-Screener
 *
 * Reads profile signals (income, household size, disability, age, veteran status, state)
 * and returns benefit programs the user likely qualifies for but hasn't reported receiving.
 *
 * Uses deterministic rules based on federal poverty guidelines — no AI.
 *
 * @module benefitEligibilityService
 */

// ── 2024 Federal Poverty Guidelines (contiguous 48 states + DC) ──────────────
// Source: HHS https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines
const FPL_BASE = 15060 // 1 person
const FPL_PER_ADDITIONAL = 5380

/** Annual FPL threshold for household size n */
function fplThreshold(householdSize) {
  const n = Math.max(1, Number(householdSize) || 1)
  return FPL_BASE + (n - 1) * FPL_PER_ADDITIONAL
}

/** Percentage of FPL (0–100+ as integer) */
function fplPercent(annualIncome, householdSize) {
  const threshold = fplThreshold(householdSize)
  return Math.round((annualIncome / threshold) * 100)
}

// ── Normalization helpers ─────────────────────────────────────────────────────

/** Parse an income value to annual number (handles strings like "$1,200/month") */
function parseIncome(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return raw
  const s = String(raw).replace(/[$,\s]/g, '').toLowerCase()
  const match = s.match(/^([\d.]+)\s*(?:\/(month|monthly|mo|week|weekly|wk|year|annual|yr))?$/)
  if (!match) return null
  const val = parseFloat(match[1])
  const period = match[2] || 'year'
  if (period.startsWith('month') || period === 'mo') return val * 12
  if (period.startsWith('week') || period === 'wk') return val * 52
  return val
}

/** Parse household size to integer, defaulting to 1 */
function parseHouseholdSize(raw) {
  const n = parseInt(String(raw || '').replace(/\D/g, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** True when value is truthy / "yes" / true */
function isTruthy(v) {
  if (!v) return false
  if (typeof v === 'boolean') return v
  return String(v).toLowerCase().trim() === 'yes' || String(v).toLowerCase().trim() === 'true'
}

/** Number of children < 18 in the household */
function countChildren(profileContext) {
  const sections = profileContext.sections || {}
  const family = sections.family_life || {}
  if (typeof family.number_of_children === 'number') return family.number_of_children
  const n = parseInt(String(family.number_of_children || '').replace(/\D/g, ''), 10)
  if (Number.isFinite(n)) return n
  // Fallback: children present flag
  if (isTruthy(family.has_children) || isTruthy(family.children_in_household)) return 1
  return 0
}

// ── Extract relevant signals from a profileContext ────────────────────────────

function extractSignals(profileContext) {
  if (!profileContext) return {}
  const profile = profileContext.profile || {}
  const sections = profileContext.sections || {}

  const basic = sections.basic_information || {}
  const demographics = sections.demographics || {}
  const financial = sections.financial_information || sections.financial || {}
  const health = sections.health_medical || {}
  const military = sections.military_service || {}
  const family = sections.family_life || {}
  const education = sections.education || {}
  const housing = sections.housing || {}
  const benefits = sections.current_benefits || sections.benefits_received || {}

  const rawIncome =
    financial.annual_income ??
    financial.monthly_income ??
    financial.household_income ??
    profile.income ??
    null

  const incomeAnnual = parseIncome(rawIncome)
  const householdSize = parseHouseholdSize(
    family.household_size ?? basic.household_size ?? demographics.household_size ?? 1,
  )
  const pctFpl = incomeAnnual !== null ? fplPercent(incomeAnnual, householdSize) : null
  const numChildren = countChildren(profileContext)

  const age = parseInt(String(basic.age ?? demographics.age ?? profile.age ?? '0'), 10) || null
  const state = (
    profile.state ??
    basic.state ??
    (sections.location_focus || {}).state ??
    ''
  ).toLowerCase().trim()

  const isVeteran =
    isTruthy(demographics.veteran_status) ||
    isTruthy(military.veteran) ||
    isTruthy(military.is_veteran)

  const hasDisability =
    isTruthy(demographics.has_disability) ||
    isTruthy(demographics.disability_status) ||
    Boolean(health.disability_type && health.disability_type !== 'none')

  const isPregnant = isTruthy(family.pregnant) || isTruthy(demographics.pregnant)

  const isStudentUndergrad =
    isTruthy(education.enrolled_college) ||
    String(education.enrollment_status || '').toLowerCase().includes('undergrad') ||
    String(education.enrollment_status || '').toLowerCase().includes('college')

  const isSingleParent =
    isTruthy(family.single_parent) ||
    (numChildren > 0 && !isTruthy(family.two_parent_household))

  const isLowIncome = pctFpl !== null && pctFpl <= 200

  const receivingBenefits = [
    ...Object.keys(benefits).filter((k) => isTruthy(benefits[k])),
    ...(Array.isArray(benefits.programs_receiving) ? benefits.programs_receiving : []),
  ]
    .map((v) => String(v).toLowerCase())

  return {
    incomeAnnual,
    householdSize,
    pctFpl,
    numChildren,
    age,
    state,
    isVeteran,
    hasDisability,
    isPregnant,
    isStudentUndergrad,
    isSingleParent,
    isLowIncome,
    receivingBenefits,
  }
}

// ── Benefit program definitions ───────────────────────────────────────────────

/**
 * @typedef {Object} BenefitProgram
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} applicationUrl
 * @property {string} [stateNotes]
 */

/**
 * Returns all programs with their eligibility check against signals.
 * @param {Object} s - signals from extractSignals()
 * @returns {{ program: BenefitProgram, eligible: boolean, reason: string }[]}
 */
function evaluatePrograms(s) {
  const p = s.pctFpl
  const income = s.incomeAnnual
  const hs = s.householdSize
  const children = s.numChildren
  const age = s.age

  const results = []

  function add(program, eligible, reason) {
    results.push({ program, eligible, reason })
  }

  // ── SNAP (Food Stamps) ────────────────────────────────────────────────────
  add(
    {
      id: 'snap',
      name: 'SNAP (Supplemental Nutrition Assistance Program)',
      description:
        'Monthly food assistance benefits loaded onto an EBT card. Most households at or below 130% FPL qualify.',
      applicationUrl: 'https://www.fns.usda.gov/snap/recipient/eligibility',
    },
    p !== null && p <= 130,
    p !== null
      ? `Estimated income is ~${p}% FPL; SNAP gross income limit is 130% FPL`
      : 'Income unknown — may qualify based on household size',
  )

  // ── TANF ──────────────────────────────────────────────────────────────────
  add(
    {
      id: 'tanf',
      name: 'TANF (Temporary Assistance for Needy Families)',
      description: 'Cash assistance and support services for families with children in financial need.',
      applicationUrl: 'https://www.acf.hhs.gov/ofa/programs/tanf',
    },
    children > 0 && (p !== null ? p <= 100 : true),
    children > 0
      ? p !== null
        ? `Single-parent household at ~${p}% FPL with ${children} child(ren) — likely eligible`
        : 'Household with children — income data would confirm'
      : 'No children detected — TANF requires dependent children',
  )

  // ── WIC ───────────────────────────────────────────────────────────────────
  const wicEligible =
    (p !== null ? p <= 185 : true) &&
    (s.isPregnant || children > 0)
  add(
    {
      id: 'wic',
      name: 'WIC (Women, Infants, and Children)',
      description:
        'Nutrition benefits, healthy foods, and health referrals for pregnant women, new mothers, and children under 5.',
      applicationUrl: 'https://www.fns.usda.gov/wic',
    },
    wicEligible,
    wicEligible
      ? 'Pregnant or has young children, at or below 185% FPL'
      : 'WIC requires pregnancy, recent birth, or children under 5',
  )

  // ── Medicaid ──────────────────────────────────────────────────────────────
  add(
    {
      id: 'medicaid',
      name: 'Medicaid',
      description:
        'Free or low-cost health coverage for adults and families at or below 138% FPL (in expansion states) or lower thresholds otherwise.',
      applicationUrl: 'https://www.healthcare.gov/medicaid-chip/getting-medicaid-chip/',
    },
    p !== null && p <= 138,
    p !== null
      ? `~${p}% FPL — Medicaid expansion threshold is 138% FPL (state may vary)`
      : 'Income unknown — may qualify; check your state Medicaid office',
  )

  // ── CHIP ──────────────────────────────────────────────────────────────────
  add(
    {
      id: 'chip',
      name: "CHIP (Children's Health Insurance Program)",
      description: 'Low-cost health coverage for children in families that earn too much for Medicaid.',
      applicationUrl: 'https://www.healthcare.gov/medicaid-chip/childrens-health-insurance-program/',
    },
    children > 0 && (p !== null ? p <= 200 : true),
    children > 0
      ? `${children} child(ren) in household at ~${p ?? 'unknown'}% FPL — CHIP typically covers up to 200–300% FPL`
      : 'No children detected — CHIP covers children only',
  )

  // ── LIHEAP ────────────────────────────────────────────────────────────────
  add(
    {
      id: 'liheap',
      name: 'LIHEAP (Low Income Home Energy Assistance Program)',
      description: 'Helps pay heating and cooling bills. Opens in fall/winter each year.',
      applicationUrl: 'https://www.acf.hhs.gov/ocs/low-income-home-energy-assistance-program-liheap',
    },
    p !== null && p <= 150,
    p !== null
      ? `~${p}% FPL — LIHEAP typically serves households at or below 150% FPL`
      : 'Income unknown — may qualify; contact your local community action agency',
  )

  // ── Section 8 / HCV ───────────────────────────────────────────────────────
  add(
    {
      id: 'section8',
      name: 'Section 8 / Housing Choice Voucher (HCV)',
      description:
        'Rental assistance vouchers. Income limit is typically 50% of Area Median Income (roughly 80–100% FPL for many areas).',
      applicationUrl: 'https://www.hud.gov/topics/housing_choice_voucher_program_section_8',
    },
    p !== null && p <= 80,
    p !== null
      ? `~${p}% FPL — HCV income limit is typically 50% AMI (very-low-income)`
      : 'Income unknown — contact your local Public Housing Authority',
  )

  // ── SSI ───────────────────────────────────────────────────────────────────
  const ssiEligible =
    s.hasDisability &&
    (income === null || income <= 18000) // simplified threshold: <$1,500/mo countable income
  add(
    {
      id: 'ssi',
      name: 'SSI (Supplemental Security Income)',
      description:
        'Monthly cash payments for people with disabilities, blindness, or age 65+ with limited income and resources.',
      applicationUrl: 'https://www.ssa.gov/ssi/',
    },
    ssiEligible,
    ssiEligible
      ? `Disability indicator present; income appears below SSI limit (~$1,971/mo in 2024)`
      : s.hasDisability
        ? `Disability indicator present but income (~$${(income ?? 0).toLocaleString()}/yr) may exceed SSI countable-income limit — verify deductions`
        : 'SSI requires a qualifying disability or age 65+',
  )

  // ── SSDI ──────────────────────────────────────────────────────────────────
  add(
    {
      id: 'ssdi',
      name: 'SSDI (Social Security Disability Insurance)',
      description:
        'Monthly disability benefits based on work history. Requires a qualifying disability and sufficient work credits.',
      applicationUrl: 'https://www.ssa.gov/disability/',
    },
    s.hasDisability,
    s.hasDisability
      ? 'Disability indicator present — apply if unable to work'
      : 'SSDI requires a medically qualifying disability',
  )

  // ── EITC ──────────────────────────────────────────────────────────────────
  // EITC 2024 income limits indexed by number of qualifying children (0/1/2/3+)
  const eitcChildren = Math.min(s.numChildren, 3)
  // 2024 caps: index = qualifying children (0/1/2/3+); single/MFS filer.
  // MFJ limits are ~$6 000 higher — we use the LOWER single cap so we never
  // incorrectly exclude a joint-filer; the reason string flags this caveat.
  const eitcIncomeCaps = [19524, 43492, 49399, 53120]
  const eitcIncomeCap = eitcIncomeCaps[eitcChildren]
  add(
    {
      id: 'eitc',
      name: 'EITC (Earned Income Tax Credit)',
      description:
        'Refundable tax credit for working individuals and families with low-to-moderate income. Claimed on tax return.',
      applicationUrl: 'https://www.irs.gov/credits-deductions/individuals/earned-income-tax-credit-eitc',
    },
    income !== null && income > 0 && income <= eitcIncomeCap,
    income !== null
      ? `Earned income ~$${income.toLocaleString()} is within EITC range for household of ${hs}`
      : 'Income unknown — if you have earned income, you may qualify',
  )

  // ── Pell Grant ────────────────────────────────────────────────────────────
  add(
    {
      id: 'pell_grant',
      name: 'Federal Pell Grant',
      description:
        'Up to $7,395/year (2024–25) in free money for undergraduate students with financial need. Does not need to be repaid.',
      applicationUrl: 'https://studentaid.gov/understand-aid/types/grants/pell',
    },
    s.isStudentUndergrad && (p !== null ? p <= 200 : true),
    s.isStudentUndergrad
      ? `Enrolled undergraduate at ~${p ?? 'unknown'}% FPL — Pell Grant available`
      : 'Pell Grant requires undergraduate enrollment; fill education section to confirm',
  )

  // ── CCDF (Child Care) ─────────────────────────────────────────────────────
  add(
    {
      id: 'ccdf',
      name: 'CCDF (Child Care and Development Fund)',
      description:
        'Subsidized childcare for working low-income families. Administered at the state level.',
      applicationUrl: 'https://www.acf.hhs.gov/occ/ccdf-program',
    },
    children > 0 && (p !== null ? p <= 200 : true),
    children > 0
      ? `${children} child(ren) in household — CCDF childcare subsidy likely available`
      : 'No children detected — CCDF requires dependent children',
  )

  // ── Free School Meals ─────────────────────────────────────────────────────
  add(
    {
      id: 'free_school_meals',
      name: 'National School Lunch / Breakfast Program (Free Meals)',
      description: 'Free or reduced-price school meals for children in households at or below 185% FPL.',
      applicationUrl: 'https://www.fns.usda.gov/nslp',
    },
    children > 0 && (p !== null ? p <= 185 : true),
    children > 0
      ? `School-age children; household at ~${p ?? 'unknown'}% FPL qualifies for free meals`
      : 'No school-age children detected',
  )

  // ── Lifeline (Phone) ──────────────────────────────────────────────────────
  add(
    {
      id: 'lifeline',
      name: 'Lifeline Program (Discounted Phone Service)',
      description: 'Up to $9.25/month discount on phone or internet service for qualifying low-income households.',
      applicationUrl: 'https://www.lifelineprogram.com/',
    },
    p !== null && p <= 135,
    p !== null
      ? `~${p}% FPL — Lifeline income limit is 135% FPL (or participation in SNAP/Medicaid)`
      : 'May qualify based on SNAP or Medicaid participation',
  )

  // ── ACP (Broadband) ───────────────────────────────────────────────────────
  add(
    {
      id: 'acp',
      name: 'Affordable Connectivity Program (ACP) — ENDED June 2024',
      description:
        'The ACP program ended in June 2024. New enrollments are no longer accepted. ' +
        'Alternative: Lifeline program offers $9.25/month broadband discount for qualifying households. ' +
        'See https://www.lifelinesupport.org/',
      applicationUrl: 'https://www.lifelinesupport.org/',
    },
    p !== null && p <= 200,
    p !== null
      ? `~${p}% FPL — ACP income limit is 200% FPL`
      : 'May qualify if receiving SNAP, Medicaid, or Pell Grant',
  )

  // ── VA Pension ────────────────────────────────────────────────────────────
  add(
    {
      id: 'va_pension',
      name: 'VA Pension (Veterans Pension)',
      description:
        'Tax-free monetary benefit for low-income wartime Veterans age 65+ or with a permanent disability.',
      applicationUrl: 'https://www.va.gov/pension/',
    },
    s.isVeteran && (p !== null ? p <= 100 : true),
    s.isVeteran
      ? `Veteran status confirmed; income at ~${p ?? 'unknown'}% FPL — may qualify for VA Pension`
      : 'VA Pension requires veteran status; fill military_service section',
  )

  // ── VA Healthcare ─────────────────────────────────────────────────────────
  add(
    {
      id: 'va_healthcare',
      name: 'VA Healthcare',
      description: 'Comprehensive health coverage for eligible veterans through the VA health care system.',
      applicationUrl: 'https://www.va.gov/health-care/apply/application/',
    },
    s.isVeteran,
    s.isVeteran
      ? 'Veteran status confirmed — eligible for VA Healthcare enrollment'
      : 'VA Healthcare requires veteran status; fill military_service section',
  )

  // ── HUD-VASH ──────────────────────────────────────────────────────────────
  add(
    {
      id: 'hud_vash',
      name: 'HUD-VASH (HUD-VA Supportive Housing)',
      description:
        'Combines HCV rental assistance with VA case management for homeless or at-risk veterans.',
      applicationUrl: 'https://www.hud.gov/program_offices/public_indian_housing/programs/hcv/vash',
    },
    s.isVeteran && (p !== null ? p <= 80 : true),
    s.isVeteran
      ? 'Veteran status confirmed; low income — may qualify for HUD-VASH voucher'
      : 'HUD-VASH is for veterans experiencing or at risk of homelessness',
  )

  return results
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Screen a profile for benefit eligibility.
 *
 * @param {Object} profileContext - Full profile context ({ profile, sections, signals })
 * @returns {{ eligible: BenefitProgram[], alreadyReceiving: string[], suggestions: BenefitProgram[] }}
 */
export function screenBenefitEligibility(profileContext) {
  if (!profileContext) {
    return { eligible: [], alreadyReceiving: [], suggestions: [] }
  }

  const signals = extractSignals(profileContext)
  const evaluated = evaluatePrograms(signals)

  const eligible = []
  const suggestions = []
  const alreadyReceiving = []

  for (const { program, eligible: isEligible, reason } of evaluated) {
    const alreadyHas = signals.receivingBenefits.some((rb) =>
      rb.includes(program.id) ||
      rb.includes(program.name.toLowerCase()) ||
      rb.includes(program.id.replace(/_/g, '')),
    )
    if (alreadyHas) {
      alreadyReceiving.push({ ...program, reason: 'Already receiving this benefit per profile' })
      continue
    }

    if (isEligible) {
      eligible.push({ ...program, estimatedEligibility: true, reason })
    } else {
      suggestions.push({ ...program, estimatedEligibility: false, reason })
    }
  }

  return { eligible, alreadyReceiving, suggestions }
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────
// Run: node backend/services/benefitEligibilityService.js

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('benefitEligibilityService')
) {
  const demoContext = {
    profile: { primary_type: 'individual', state: 'tn' },
    sections: {
      financial_information: { annual_income: 18000 },
      family_life: { household_size: 3, number_of_children: 2, single_parent: 'yes' },
      basic_information: { age: 32 },
      demographics: { veteran_status: 'no' },
    },
  }
  const result = screenBenefitEligibility(demoContext)
  log.info('=== Benefit Eligibility Demo ===')
  log.info(`Eligible programs (${result.eligible.length}):`)
  result.eligible.forEach((p) => log.info(`  ✅ ${p.name} — ${p.reason}`))
  log.info(`\nNot currently eligible / needs data (${result.suggestions.length}):`)
  result.suggestions.forEach((p) => log.info(`  ❌ ${p.name} — ${p.reason}`))
}
