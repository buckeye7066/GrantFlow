/**
 * studentBridgeFunding/calendar.js
 *
 * Derives the academic-cycle calendar for a student profile so that every
 * downstream template can normalize its deadlines to the student's actual
 * Fall enrollment year — instead of guessing.
 *
 * Goal: bridge the cash-flow gap between move-in (~July of enrollmentYear)
 * and Title IV refund disbursement (~late August of enrollmentYear).
 *
 * Returns:
 *   {
 *     isStudent: boolean,
 *     enrollmentYear: 2026,                  // calendar year of Fall start
 *     academicCycle: '2026-27',
 *     classesStartEstimate: 'YYYY-MM-DD',    // mid-Aug heuristic, school-overridable
 *     moveInWindow: { start, end },          // ~6 weeks before classes start
 *     refundWindow: { start, end },          // ~7-21 days after classes start
 *     bridgeGapDays: number,
 *     cycleDeadlines: {
 *       fafsa_priority: 'YYYY-MM-DD',        // informational; many state priority dates
 *       fafsa_close:    'YYYY-MM-DD',        // June 30 of award-year+1
 *       state_aid_priority: 'YYYY-MM-DD',
 *       state_grant_app:    'YYYY-MM-DD',    // Aug 1 default for HOPE-style awards
 *       school_priority:    null,            // school-specific overrides handled in templates
 *     },
 *     reasoning: string[],                    // explain how we picked enrollmentYear
 *   }
 */

import { extractStateFromContext } from '../profileHelpers.js'

const HS_SENIOR_PATTERNS = [
  /high\s*school\s*senior/i,
  /\bhs\s*senior\b/i,
  /senior\s+\(\s*high\s*school/i,
  /grade\s*12\b/i,
  /12th\s*grade/i,
]
const HS_JUNIOR_PATTERNS = [
  /high\s*school\s*junior/i,
  /\bhs\s*junior\b/i,
  /grade\s*11\b/i,
  /11th\s*grade/i,
]
const HS_SOPH_PATTERNS = [
  /high\s*school\s*sophomore/i,
  /grade\s*10\b/i,
  /10th\s*grade/i,
]
const COLLEGE_FRESHMAN_PATTERNS = [
  /college\s*freshman/i,
  /first[-\s]?year\s+college/i,
  /freshman\s+\(\s*college/i,
]
const COLLEGE_SOPH_PATTERNS = [/college\s*sophomore/i, /second[-\s]?year/i]
const COLLEGE_JUNIOR_PATTERNS = [/college\s*junior/i, /third[-\s]?year/i]
const COLLEGE_SENIOR_PATTERNS = [/college\s*senior/i, /fourth[-\s]?year/i]
const GRAD_PATTERNS = [
  /graduate\s*student/i,
  /\bmasters?\b/i,
  /\bphd\b/i,
  /doctoral/i,
  /post[-\s]?baccalaureate/i,
]

function findString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

function classifyEducationLevel(level) {
  if (!level) return null
  if (HS_SENIOR_PATTERNS.some((re) => re.test(level))) return 'hs_senior'
  if (HS_JUNIOR_PATTERNS.some((re) => re.test(level))) return 'hs_junior'
  if (HS_SOPH_PATTERNS.some((re) => re.test(level))) return 'hs_sophomore'
  if (COLLEGE_FRESHMAN_PATTERNS.some((re) => re.test(level))) return 'college_freshman'
  if (COLLEGE_SOPH_PATTERNS.some((re) => re.test(level))) return 'college_sophomore'
  if (COLLEGE_JUNIOR_PATTERNS.some((re) => re.test(level))) return 'college_junior'
  if (COLLEGE_SENIOR_PATTERNS.some((re) => re.test(level))) return 'college_senior'
  if (GRAD_PATTERNS.some((re) => re.test(level))) return 'grad'
  return null
}

/**
 * Heuristic: from the student's current academic level (graduating senior /
 * already enrolled / etc.) and today's date, pick the calendar year of the
 * NEXT Fall semester they need money for.
 *
 * - HS Senior: graduating in May → enrolling Fall of currentYear if today < Aug 1 currentYear,
 *   else Fall of currentYear + 1 (gap year / late filing).
 * - HS Junior: graduating next May → enrolling Fall of currentYear + 1.
 * - College student already enrolled: next Fall (this year or next).
 * - Grad student: next Fall.
 * - Unknown but has target_colleges: behave like HS Senior (be optimistic).
 */
function pickEnrollmentYear({ classification, hasTargets, today }) {
  const year = today.getUTCFullYear()
  const aug1 = new Date(Date.UTC(year, 7, 1)) // Aug 1 of current year

  switch (classification) {
    case 'hs_senior':
      return today < aug1 ? year : year + 1
    case 'hs_junior':
      return year + 1
    case 'hs_sophomore':
      return year + 2
    case 'college_freshman':
    case 'college_sophomore':
    case 'college_junior':
    case 'college_senior':
    case 'grad':
      return today < aug1 ? year : year + 1
    default:
      return hasTargets ? (today < aug1 ? year : year + 1) : null
  }
}

/**
 * Per-state map of "student aid award priority dates" expressed as MM-DD that
 * we'll combine with the resolved enrollment year. The default keeps reach
 * deliberately wide so non-listed states fall back to a national default
 * pattern (FAFSA priority Mar 1, state aid Apr 15, state grant Aug 1).
 *
 * Sources verified May 2026 — keep dates conservative and prefer "still open"
 * deadlines over priority cut-offs that have already passed for the cycle.
 */
const STATE_AID_PRIORITY_MMDD = {
  TN: { state_aid: '04-15', state_grant: '08-01' },     // TSAA priority Apr 15; HOPE Aug 1
  GA: { state_aid: '06-01', state_grant: '09-01' },     // GA HOPE / Zell Miller
  FL: { state_aid: '04-30', state_grant: '08-01' },     // Florida Bright Futures
  TX: { state_aid: '04-15', state_grant: '07-15' },     // TEXAS Grant
  CA: { state_aid: '03-02', state_grant: '09-02' },     // Cal Grant Mar 2
  NY: { state_aid: '06-30', state_grant: '08-31' },     // TAP
  IL: { state_aid: '04-01', state_grant: '08-15' },     // MAP Grant
  PA: { state_aid: '05-01', state_grant: '08-01' },     // PA State Grant
  OH: { state_aid: '10-01', state_grant: '07-01' },     // OCOG
  KY: { state_aid: '04-15', state_grant: '08-01' },     // KEES
  AL: { state_aid: '04-15', state_grant: '08-01' },     // generic
  NC: { state_aid: '03-01', state_grant: '08-15' },     // NC Need-Based
  VA: { state_aid: '07-31', state_grant: '08-15' },     // VGAP / COCA
  CT: { state_aid: '03-15', state_grant: '08-01' },     // Roberta B. Willis
  MA: { state_aid: '05-01', state_grant: '08-01' },     // MASSGrant
  LA: { state_aid: '07-01', state_grant: '07-15' },     // TOPS
  MS: { state_aid: '03-31', state_grant: '09-15' },     // MTAG
  AR: { state_aid: '06-01', state_grant: '08-01' },     // Arkansas Lottery Scholarship
  OK: { state_aid: '03-01', state_grant: '07-01' },     // Oklahoma's Promise
  MO: { state_aid: '04-01', state_grant: '07-31' },     // Access Missouri
  IN: { state_aid: '04-15', state_grant: '08-15' },     // Frank O'Bannon Grant
  WI: { state_aid: '04-15', state_grant: '08-01' },     // Wisconsin Higher Education
  MI: { state_aid: '03-01', state_grant: '08-01' },     // Michigan Tuition Grant
  MN: { state_aid: '06-30', state_grant: '08-01' },     // MN State Grant
  WV: { state_aid: '04-15', state_grant: '08-01' },     // PROMISE
  SC: { state_aid: '06-30', state_grant: '08-01' },     // SC LIFE
}

const DEFAULT_STATE_AID = { state_aid: '04-15', state_grant: '08-01' }

function isoDate(year, mmdd) {
  return `${year}-${mmdd}`
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime()
  return Math.round(ms / (1000 * 60 * 60 * 24))
}

/**
 * @param {Object} args
 * @param {Object} args.profile
 * @param {Object} args.sections - keyed by section_key
 * @param {Date} [args.today]
 * @returns {object}
 */
export function deriveStudentCycle({ profile, sections = {}, today: todayInput }) {
  const today = todayInput || new Date()
  const reasoning = []

  if (!profile) return { isStudent: false, reasoning: ['no_profile'] }

  const basic = sections?.basic_information ?? {}
  const education = sections?.education ?? {}
  const universityApps = sections?.university_applications ?? {}

  const eduLevel = findString(
    education?.highest_level,
    education?.education_level,
    basic?.academic_status?.education_level,
    basic?.education_level,
  )

  const classification = classifyEducationLevel(eduLevel)
  if (classification) reasoning.push(`education_level="${eduLevel}" → ${classification}`)

  const hasTargets =
    Array.isArray(education?.target_colleges) && education.target_colleges.length > 0
  const hasUniversityApps =
    Array.isArray(universityApps?.applications) && universityApps.applications.length > 0
  if (hasTargets) reasoning.push(`has ${education.target_colleges.length} target college(s)`)
  if (hasUniversityApps) reasoning.push(`has ${universityApps.applications.length} university application(s)`)

  const studentTagged = (() => {
    const t = String(profile?.primary_type || '').toLowerCase()
    return t.includes('student') || t.includes('high_school') || t.includes('college') || t.includes('graduate_student')
  })()

  const isStudent =
    Boolean(classification) || hasTargets || hasUniversityApps || studentTagged
  if (!isStudent) {
    return { isStudent: false, reasoning: ['no_student_signal'] }
  }

  const enrollmentYear = pickEnrollmentYear({ classification, hasTargets, today })
  if (!enrollmentYear) {
    return { isStudent: true, enrollmentYear: null, reasoning: [...reasoning, 'cannot_determine_enrollment_year'] }
  }
  reasoning.push(`enrollmentYear=${enrollmentYear}`)

  // Aug 24 is the median first-day-of-classes for U.S. universities (BLS).
  // Templates are free to override per-school in their own metadata.
  const classesStart = new Date(Date.UTC(enrollmentYear, 7, 24)) // Aug 24
  const moveInStart = new Date(Date.UTC(enrollmentYear, 6, 15))  // Jul 15
  const moveInEnd = new Date(Date.UTC(enrollmentYear, 7, 20))    // Aug 20
  // Title IV disbursement: schools may pay 10 days before classes; refund 14
  // days after disbursement → typical refund window late Aug to mid Sep.
  const refundStart = new Date(Date.UTC(enrollmentYear, 7, 25))  // Aug 25
  const refundEnd = new Date(Date.UTC(enrollmentYear, 8, 15))    // Sep 15
  const bridgeGapDays = Math.max(0, daysBetween(moveInStart, refundEnd))

  const state = (extractStateFromContext({ profile, sections }) || '').toUpperCase()
  const aid = STATE_AID_PRIORITY_MMDD[state] || DEFAULT_STATE_AID

  const cycleDeadlines = {
    fafsa_priority: isoDate(enrollmentYear, '03-01'),
    fafsa_close: isoDate(enrollmentYear + 1, '06-30'),
    state_aid_priority: isoDate(enrollmentYear, aid.state_aid),
    state_grant_app: isoDate(enrollmentYear, aid.state_grant),
    school_priority: null,
  }

  const academicCycle = `${enrollmentYear}-${String((enrollmentYear + 1) % 100).padStart(2, '0')}`

  return {
    isStudent: true,
    enrollmentYear,
    academicCycle,
    classesStartEstimate: classesStart.toISOString().slice(0, 10),
    moveInWindow: {
      start: moveInStart.toISOString().slice(0, 10),
      end: moveInEnd.toISOString().slice(0, 10),
    },
    refundWindow: {
      start: refundStart.toISOString().slice(0, 10),
      end: refundEnd.toISOString().slice(0, 10),
    },
    bridgeGapDays,
    cycleDeadlines,
    state,
    classification,
    reasoning,
  }
}
