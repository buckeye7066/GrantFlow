import { createLogger } from '../utils/logger.js'
const log = createLogger('seasonalCrawlCalendar')
/**
 * seasonalCrawlCalendar.js
 *
 * Seasonal Crawl Calendar
 *
 * Curated registry of major benefit programs and grant cycles with known
 * open/close periods. Provides functions to determine which programs are
 * currently open, opening soon, or recently closed, and generates boosted
 * crawl queries for timing-sensitive opportunities.
 *
 * @module seasonalCrawlCalendar
 */

// ── Program registry ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} SeasonalProgram
 * @property {string} id
 * @property {string} programName
 * @property {number} openMonth   - 1-indexed month when applications open
 * @property {number} closeMonth  - 1-indexed month when applications close (inclusive)
 * @property {string} description
 * @property {string[]|'all'} states
 * @property {string[]} profileTypes - Applicable profile types
 * @property {'high'|'medium'|'low'} crawlPriority
 * @property {string[]} searchTerms
 * @property {string} applicationUrl
 */

/** @type {SeasonalProgram[]} */
const SEASONAL_PROGRAMS = [
  // ── Financial Aid / Education ─────────────────────────────────────────────
  {
    id: 'fafsa',
    programName: 'FAFSA (Free Application for Federal Student Aid)',
    openMonth: 10,
    closeMonth: 6,  // Spans October to ~June 30 for most states
    description:
      'Opens October 1 each year for the following academic year. Deadlines vary by state and institution — earlier is better.',
    states: 'all',
    profileTypes: ['student', 'high_school_student', 'college_student', 'individual'],
    crawlPriority: 'high',
    searchTerms: ['FAFSA federal student aid', 'financial aid deadline', 'Pell grant application'],
    applicationUrl: 'https://studentaid.gov/h/apply-for-aid/fafsa',
  },
  {
    id: 'pell_grant',
    programName: 'Federal Pell Grant',
    openMonth: 10,
    closeMonth: 6,
    description:
      'Pell Grant eligibility determined via FAFSA. File FAFSA starting October 1 for next aid year.',
    states: 'all',
    profileTypes: ['student', 'college_student'],
    crawlPriority: 'high',
    searchTerms: ['Pell grant award', 'federal student grant deadline'],
    applicationUrl: 'https://studentaid.gov/understand-aid/types/grants/pell',
  },
  {
    id: 'tennessee_promise',
    programName: 'Tennessee Promise Scholarship',
    openMonth: 9,
    closeMonth: 10,  // Deadline typically early November, safer to show as closed by November
    description:
      'Tennessee Promise applications open in September for high school seniors. Scholarship covers last-dollar tuition at TN community colleges.',
    states: ['tn'],
    profileTypes: ['high_school_student', 'student'],
    crawlPriority: 'high',
    searchTerms: ['Tennessee Promise scholarship deadline', 'TN free community college'],
    applicationUrl: 'https://www.tn.gov/tnpromise',
  },
  {
    id: 'tennessee_reconnect',
    programName: 'Tennessee Reconnect',
    openMonth: 1,
    closeMonth: 7,
    description:
      'Tennessee Reconnect (adult learner free community college) typically has spring and summer application windows.',
    states: ['tn'],
    profileTypes: ['individual', 'student'],
    crawlPriority: 'medium',
    searchTerms: ['Tennessee Reconnect adult learner scholarship', 'TN free college adults'],
    applicationUrl: 'https://www.tn.gov/collegepays/financial-aid-programs/tn-reconnect.html',
  },

  // ── Healthcare ────────────────────────────────────────────────────────────
  {
    id: 'aca_marketplace',
    programName: 'ACA Health Insurance Marketplace Open Enrollment',
    openMonth: 11,
    closeMonth: 1,
    description:
      'ACA Marketplace open enrollment runs November 1 – January 15. Special enrollment available after life events.',
    states: 'all',
    profileTypes: ['individual', 'family'],
    crawlPriority: 'high',
    searchTerms: ['ACA health insurance open enrollment', 'marketplace health plan deadline'],
    applicationUrl: 'https://www.healthcare.gov/',
  },
  {
    id: 'medicare_open_enrollment',
    programName: 'Medicare Annual Enrollment Period',
    openMonth: 10,
    closeMonth: 12,
    description:
      'Medicare annual enrollment runs October 15 – December 7. Beneficiaries can change Part D and Medicare Advantage plans.',
    states: 'all',
    profileTypes: ['senior', 'individual'],
    crawlPriority: 'high',
    searchTerms: ['Medicare annual enrollment Part D Medicare Advantage change'],
    applicationUrl: 'https://www.medicare.gov/basics/get-started-with-medicare/medicare-basics/when-does-medicare-coverage-start',
  },
  {
    id: 'chip_medicaid_renewal',
    programName: 'Medicaid / CHIP Annual Renewal',
    openMonth: 1,
    closeMonth: 12,
    description:
      'Medicaid and CHIP renewal is ongoing but many states have annual renewal windows. Loss of COVID continuous enrollment meant mass renewals 2023-2024.',
    states: 'all',
    profileTypes: ['individual', 'family'],
    crawlPriority: 'medium',
    searchTerms: ['Medicaid renewal CHIP re-enrollment income verification'],
    applicationUrl: 'https://www.medicaid.gov/',
  },

  // ── Energy Assistance ─────────────────────────────────────────────────────
  {
    id: 'liheap',
    programName: 'LIHEAP (Low Income Home Energy Assistance)',
    openMonth: 9,
    closeMonth: 3,
    description:
      'LIHEAP heating season assistance typically opens in October. Cooling assistance often opens in summer. Funding is limited — apply early.',
    states: 'all',
    profileTypes: ['individual', 'family', 'senior'],
    crawlPriority: 'high',
    searchTerms: ['LIHEAP energy assistance application', 'heating bill help low income'],
    applicationUrl: 'https://www.acf.hhs.gov/ocs/low-income-home-energy-assistance-program-liheap',
  },
  {
    id: 'liheap_cooling',
    programName: 'LIHEAP Cooling Assistance',
    openMonth: 5,
    closeMonth: 8,
    description:
      'Summer cooling assistance through LIHEAP or state programs. Available in many states May–August.',
    states: 'all',
    profileTypes: ['individual', 'family', 'senior'],
    crawlPriority: 'medium',
    searchTerms: ['LIHEAP cooling assistance summer electric bill help'],
    applicationUrl: 'https://www.acf.hhs.gov/ocs/low-income-home-energy-assistance-program-liheap',
  },

  // ── Tax Programs ──────────────────────────────────────────────────────────
  {
    id: 'vita_tax_prep',
    programName: 'VITA (Volunteer Income Tax Assistance)',
    openMonth: 1,
    closeMonth: 4,
    description:
      'Free tax preparation for low-income, disabled, and limited-English taxpayers. Sites open January–April 15.',
    states: 'all',
    profileTypes: ['individual', 'family'],
    crawlPriority: 'high',
    searchTerms: ['VITA free tax preparation low income', 'free tax help EITC filing'],
    applicationUrl: 'https://www.irs.gov/individuals/free-tax-return-preparation-for-qualifying-taxpayers',
  },
  {
    id: 'eitc',
    programName: 'EITC (Earned Income Tax Credit) Filing Season',
    openMonth: 1,
    closeMonth: 4,
    description:
      'EITC is claimed on annual tax return. Filing season opens late January. EITC refunds typically arrive late February–March.',
    states: 'all',
    profileTypes: ['individual', 'family'],
    crawlPriority: 'high',
    searchTerms: ['EITC earned income tax credit filing deadline', 'refundable tax credit low income'],
    applicationUrl: 'https://www.irs.gov/credits-deductions/individuals/earned-income-tax-credit-eitc',
  },

  // ── Housing ───────────────────────────────────────────────────────────────
  {
    id: 'section8_waitlist',
    programName: 'Section 8 / HCV Waitlist Openings',
    openMonth: 1,
    closeMonth: 12,
    description:
      'Housing Choice Voucher waitlists open irregularly. Some PHAs open briefly 1-2x per year. Monitor local PHA websites.',
    states: 'all',
    profileTypes: ['individual', 'family'],
    crawlPriority: 'high',
    searchTerms: ['Section 8 waitlist open HCV housing choice voucher', 'public housing authority application'],
    applicationUrl: 'https://www.hud.gov/topics/housing_choice_voucher_program_section_8',
  },
  {
    id: 'usda_rural_housing',
    programName: 'USDA Section 502 Rural Housing Loans / Grants',
    openMonth: 2,
    closeMonth: 9,
    description:
      'USDA rural housing repair grants and loans typically have spring and summer application periods.',
    states: 'all',
    profileTypes: ['individual', 'family'],
    crawlPriority: 'medium',
    searchTerms: ['USDA rural housing repair grant 504 loan', 'rural home repair assistance'],
    applicationUrl: 'https://www.rd.usda.gov/programs-services/single-family-housing-programs',
  },

  // ── Veteran ───────────────────────────────────────────────────────────────
  {
    id: 'va_benefits_enrollment',
    programName: 'VA Healthcare Enrollment',
    openMonth: 1,
    closeMonth: 12,
    description:
      'VA healthcare enrollment is open year-round. Open enrollment for veterans with no service-connected disabilities runs in priority groups.',
    states: 'all',
    profileTypes: ['veteran', 'individual'],
    crawlPriority: 'medium',
    searchTerms: ['VA healthcare enrollment veteran apply', 'veteran health care eligibility'],
    applicationUrl: 'https://www.va.gov/health-care/apply/application/',
  },
  {
    id: 'folds_of_honor',
    programName: 'Folds of Honor Scholarship',
    openMonth: 1,
    closeMonth: 3,
    description:
      'Folds of Honor scholarships for military family members. Applications typically open January–March.',
    states: 'all',
    profileTypes: ['veteran', 'individual', 'student'],
    crawlPriority: 'medium',
    searchTerms: ['Folds of Honor scholarship military family application'],
    applicationUrl: 'https://www.foldsofhonor.org/scholarships/',
  },

  // ── Food Programs ─────────────────────────────────────────────────────────
  {
    id: 'snap_back_to_school',
    programName: 'Summer EBT / Back-to-School SNAP Benefits',
    openMonth: 5,
    closeMonth: 8,
    description:
      'Summer EBT (SUN Bucks) programs provide food benefits during summer when schools are not in session. Application periods vary by state.',
    states: 'all',
    profileTypes: ['family', 'individual'],
    crawlPriority: 'medium',
    searchTerms: ['Summer EBT SUN Bucks program children food assistance', 'back to school food benefits'],
    applicationUrl: 'https://www.fns.usda.gov/sebt',
  },

  // ── Child Development ─────────────────────────────────────────────────────
  {
    id: 'head_start_enrollment',
    programName: 'Head Start / Early Head Start Enrollment',
    openMonth: 2,
    closeMonth: 5,
    description:
      'Head Start programs typically enroll for the fall in spring. Applications often open February–May for September start.',
    states: 'all',
    profileTypes: ['family', 'individual'],
    crawlPriority: 'medium',
    searchTerms: ['Head Start enrollment preschool low income application', 'Early Head Start enrollment'],
    applicationUrl: 'https://eclkc.ohs.acf.hhs.gov/center-locator',
  },

  // ── Broadband / Digital ────────────────────────────────────────────────────
  {
    id: 'acp_broadband',
    programName: 'Affordable Connectivity Program (ACP) — ENDED',
    openMonth: 1,
    closeMonth: 12,
    description:
      'WARNING: The ACP ended in June 2024 — new enrollments are no longer accepted. ' +
      'Households should look for the successor Broadband Equity, Access, and Deployment (BEAD) ' +
      'state programs or the Lifeline program as alternatives. See https://www.fcc.gov/acp',
    states: 'all',
    profileTypes: ['individual', 'family'],
    crawlPriority: 'low',
    searchTerms: ['broadband internet discount low income Lifeline BEAD program'],
    applicationUrl: 'https://www.lifelinesupport.org/',
  },

  // ── State-Specific Programs (Tennessee) ───────────────────────────────────
  {
    id: 'tn_tenncare_enrollment',
    programName: 'TennCare (Tennessee Medicaid) Enrollment',
    openMonth: 1,
    closeMonth: 12,
    description:
      'TennCare enrollment is year-round for qualifying Tennesseans. Income limits and eligible categories updated annually.',
    states: ['tn'],
    profileTypes: ['individual', 'family'],
    crawlPriority: 'high',
    searchTerms: ['TennCare Medicaid Tennessee enrollment apply income'],
    applicationUrl: 'https://www.tn.gov/tenncare',
  },
  {
    id: 'tn_snap',
    programName: 'Tennessee SNAP (Supplemental Nutrition)',
    openMonth: 1,
    closeMonth: 12,
    description: 'Tennessee SNAP applications accepted year-round at DHS offices and online.',
    states: ['tn'],
    profileTypes: ['individual', 'family'],
    crawlPriority: 'high',
    searchTerms: ['Tennessee SNAP food stamps DHS application', 'TN EBT food assistance apply'],
    applicationUrl: 'https://www.tn.gov/humanservices/for-families/supplemental-nutrition-assistance-program-snap.html',
  },
  {
    id: 'tn_liheap',
    programName: 'Tennessee LIHEAP / THAP Energy Assistance',
    openMonth: 10,
    closeMonth: 3,
    description:
      'Tennessee Home Energy Assistance Program (THAP) opens each fall for heating season. Applications through local community action agencies.',
    states: ['tn'],
    profileTypes: ['individual', 'family', 'senior'],
    crawlPriority: 'high',
    searchTerms: ['Tennessee THAP LIHEAP energy assistance heating', 'TN utility assistance program'],
    applicationUrl: 'https://www.tn.gov/humanservices/for-families/community-services-block-grant-csbg/energy-assistance.html',
  },
  {
    id: 'tn_ccdf',
    programName: 'Tennessee CCDF Child Care Subsidy',
    openMonth: 1,
    closeMonth: 12,
    description:
      'Tennessee Child Care Certificate Program provides childcare subsidies year-round for working families.',
    states: ['tn'],
    profileTypes: ['family', 'individual'],
    crawlPriority: 'medium',
    searchTerms: ['Tennessee childcare certificate subsidy CCDF working parent'],
    applicationUrl: 'https://www.tn.gov/humanservices/for-families/child-care-services.html',
  },

  // ── Disaster Relief ───────────────────────────────────────────────────────
  {
    id: 'fema_individual_assistance',
    programName: 'FEMA Individual Assistance (Disaster Relief)',
    openMonth: 1,
    closeMonth: 12,
    description:
      'FEMA Individual Assistance opens after major disaster declarations. Not seasonal — disaster-triggered. Deadline typically 60 days post-declaration.',
    states: 'all',
    profileTypes: ['individual', 'family'],
    crawlPriority: 'high',
    searchTerms: ['FEMA individual assistance disaster relief declaration apply', 'FEMA flood hurricane grant'],
    applicationUrl: 'https://www.disasterassistance.gov/',
  },
]

// ── Date / month logic ────────────────────────────────────────────────────────

/**
 * True if a program's open/close window includes `month` (1-indexed).
 * Handles programs that wrap across year end (e.g., openMonth=10, closeMonth=3).
 */
function isProgramOpenInMonth(program, month) {
  const { openMonth, closeMonth } = program
  if (openMonth <= closeMonth) {
    return month >= openMonth && month <= closeMonth
  }
  // Wraps across year boundary
  return month >= openMonth || month <= closeMonth
}

/**
 * True if the program opens within the next `withinDays` days from today.
 */
function isOpeningSoon(program, currentMonth, withinMonths = 1) {
  if (isProgramOpenInMonth(program, currentMonth)) return false // Already open
  // Check next month(s)
  for (let offset = 1; offset <= withinMonths; offset++) {
    const nextMonth = ((currentMonth - 1 + offset) % 12) + 1
    if (nextMonth === program.openMonth) return true
  }
  return false
}

/**
 * True if the program closed within the last `recentMonths` months.
 */
function isRecentlyClosed(program, currentMonth, recentMonths = 1) {
  if (isProgramOpenInMonth(program, currentMonth)) return false // Still open
  for (let offset = 1; offset <= recentMonths; offset++) {
    const prevMonth = ((currentMonth - 1 - offset + 12) % 12) + 1
    if (prevMonth === program.closeMonth) return true
  }
  return false
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Get programs by seasonal status.
 *
 * @param {number} [month] - 1-indexed month (defaults to current month)
 * @returns {{ currentlyOpen: SeasonalProgram[], openingSoon: SeasonalProgram[], recentlyClosed: SeasonalProgram[] }}
 */
export function getSeasonalPrograms(month) {
  const currentMonth = month ?? new Date().getMonth() + 1

  const currentlyOpen = []
  const openingSoon = []
  const recentlyClosed = []

  for (const program of SEASONAL_PROGRAMS) {
    if (isProgramOpenInMonth(program, currentMonth)) {
      currentlyOpen.push(program)
    } else if (isOpeningSoon(program, currentMonth)) {
      openingSoon.push(program)
    } else if (isRecentlyClosed(program, currentMonth)) {
      recentlyClosed.push(program)
    }
  }

  return { currentlyOpen, openingSoon, recentlyClosed }
}

/**
 * @typedef {Object} SeasonalBoostQuery
 * @property {string} query
 * @property {string} programId
 * @property {string} programName
 * @property {'high'|'medium'|'low'} crawlPriority
 * @property {string} timing - 'open' | 'opening_soon'
 */

/**
 * Generate boosted crawl queries for programs that are currently open or opening soon,
 * filtered by relevance to the profile.
 *
 * @param {Object} profileContext - Full profile context ({ profile, sections, signals })
 * @param {number} [month] - 1-indexed month override
 * @returns {{ boostedQueries: SeasonalBoostQuery[], reason: string }}
 */
export function getSeasonalCrawlBoosts(profileContext, month) {
  const currentMonth = month ?? new Date().getMonth() + 1
  const { currentlyOpen, openingSoon } = getSeasonalPrograms(currentMonth)

  const profile = profileContext?.profile || {}
  const signals = profileContext?.signals || {}
  const profileState = (profile.state || signals.location?.state || '').toLowerCase().trim()
  const profileType = (profile.primary_type || '').toLowerCase()
  const profileApplicantTypes = new Set(
    Array.isArray(signals.applicantTypes)
      ? signals.applicantTypes.map((v) => String(v).toLowerCase())
      : [],
  )

  function isRelevant(program) {
    // State filter
    if (program.states !== 'all') {
      const programStates = Array.isArray(program.states)
        ? program.states.map((s) => s.toLowerCase())
        : []
      // If profileState is unknown, exclude state-specific programs to avoid wrong-state junk
      if (!profileState) {
  // State unknown — skipping state-specific program to avoid wrong-state matches
  // (Goal 10: caller should prompt user to complete state field)
  return false;
}
if (!programStates.includes(profileState)) return false
    }

    // Profile type filter — if profileTypes list is restrictive, skip non-matching profiles
    if (program.profileTypes && program.profileTypes.length > 0) {
      const types = program.profileTypes.map((t) => t.toLowerCase())
      const profileMatches =
        types.includes(profileType) ||
        types.includes('all') ||
        types.some((t) => profileApplicantTypes.has(t))
      if (!profileMatches) return false
    }

    return true
  }

  const boostedQueries = []

  for (const program of currentlyOpen) {
    if (!isRelevant(program)) continue
    for (const searchTerm of program.searchTerms) {
      boostedQueries.push({
        query: searchTerm,
        programId: program.id,
        programName: program.programName,
        crawlPriority: program.crawlPriority,
        timing: 'open',
        applicationUrl: program.applicationUrl,
      })
    }
  }

  for (const program of openingSoon) {
    if (!isRelevant(program)) continue
    for (const searchTerm of program.searchTerms) {
      boostedQueries.push({
        query: searchTerm,
        programId: program.id,
        programName: program.programName,
        crawlPriority: program.crawlPriority,
        timing: 'opening_soon',
        applicationUrl: program.applicationUrl,
      })
    }
  }

  // Sort: high priority first, then open before opening_soon
  const priorityOrder = { high: 0, medium: 1, low: 2 }
  const timingOrder = { open: 0, opening_soon: 1 }
  boostedQueries.sort(
    (a, b) =>
      (priorityOrder[a.crawlPriority] ?? 2) - (priorityOrder[b.crawlPriority] ?? 2) ||
      (timingOrder[a.timing] ?? 1) - (timingOrder[b.timing] ?? 1),
  )

  const openCount = boostedQueries.filter((q) => q.timing === 'open').length
  const soonCount = boostedQueries.filter((q) => q.timing === 'opening_soon').length
  const reason =
    `Month ${currentMonth}: ${openCount} queries for currently-open programs, ` +
    `${soonCount} queries for programs opening soon.`

  return { boostedQueries, reason }
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────
// Run: node backend/services/seasonalCrawlCalendar.js

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('seasonalCrawlCalendar')
) {
  const month = parseInt(process.argv[2] || '', 10) || new Date().getMonth() + 1
  const { currentlyOpen, openingSoon, recentlyClosed } = getSeasonalPrograms(month)

  log.info(`=== Seasonal Crawl Calendar (Month ${month}) ===`)
  log.info(`\nCurrently Open (${currentlyOpen.length}):`)
  currentlyOpen.forEach((p) => log.info(`  [${p.crawlPriority.toUpperCase()}] ${p.programName}`))

  log.info(`\nOpening Soon (${openingSoon.length}):`)
  openingSoon.forEach((p) => log.info(`  [${p.crawlPriority.toUpperCase()}] ${p.programName}`))

  log.info(`\nRecently Closed (${recentlyClosed.length}):`)
  recentlyClosed.forEach((p) => log.info(`  [${p.crawlPriority.toUpperCase()}] ${p.programName}`))

  const demoContext = {
    profile: { primary_type: 'individual', state: 'tn' },
    signals: { location: { state: 'tn' }, applicantTypes: ['individual'] },
  }
  const { boostedQueries, reason } = getSeasonalCrawlBoosts(demoContext, month)
  log.info(`\n${reason}`)
  log.info(`Top boosted queries:`)
  boostedQueries.slice(0, 5).forEach((q) =>
    log.info(`  [${q.timing}][${q.crawlPriority}] ${q.query}`),
  )
}
