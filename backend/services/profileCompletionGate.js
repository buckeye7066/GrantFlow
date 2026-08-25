/**
 * profileCompletionGate.js — the PROFILE-COMPLETION GATE.
 *
 * Owner directive (verbatim intent): a profile user cannot proceed/continue
 * until they finish filling out their profile with the information RELEVANT TO
 * THEIR PROFILE TYPE. On next login, Anya presents all the missing information
 * as a SERIES OF QUESTIONS — explaining this info is needed before they can
 * proceed — and each question shows a running count "1 of N", "2 of N", … where
 * N = the number of needed (still-missing) data points.
 *
 * This module is PURE and unit-tested. It answers three questions for one
 * profile:
 *
 *   1. REQUIRED — given the profile's RESOLVED effective type, which data points
 *      are REQUIRED for a usable profile of that type? "Relevant to their
 *      profile type" is already modelled by PROFILE_SCHEMA `applies_to` and the
 *      profileTypeRegistry; this file layers a conservative, per-type
 *      "required-for-a-usable-profile" policy on top of that structural model.
 *   2. MISSING — which of those required data points are empty on the profile
 *      (read across every alias location the rest of the app writes them to).
 *   3. QUESTIONS — the ordered missing data points, each turned into a question
 *      carrying `index` and `total` (N) so the UI renders "1 of N".
 *
 * The gate is BLOCKING while required-but-missing > 0. The per-profile result is
 * surfaced through the existing onboarding-gate payload (buildUserPayload) so
 * the frontend that already reads that payload can enforce the gate on next
 * login. Admins are NEVER gated (see resolveProfileCompletionForUser), matching
 * the standing "never re-interview admins" rule (onboardingGates.js).
 *
 * No DB, no network in the pure core — safe to import anywhere and to unit-test.
 */

import {
  ALL_PERSON_TYPES,
  STUDENT_TYPES,
  ALL_ORG_TYPES,
  BUSINESS_TYPES,
} from '../../shared/profileSectionApplicability.js'
import { canonicalizeProfileTypeId } from '../../shared/profileTypeOptions.js'
import { resolveEffectiveProfileType } from './profileHelpers.js'
import { isAdminUserRow } from './onboardingGates.js'

const PERSON_SET = new Set(ALL_PERSON_TYPES)
const STUDENT_SET = new Set(STUDENT_TYPES)
const ORG_SET = new Set(ALL_ORG_TYPES)
const BUSINESS_SET = new Set(BUSINESS_TYPES)

// Generic/placeholder organization_type values that are NOT a real answer to
// "what kind of organization is this?" — mirror resolveEffectiveProfileType's
// notion of a non-specific type so a bare "organization" never counts as filled.
const GENERIC_ORG_TYPE_VALUES = new Set([
  '', 'organization', 'other', 'unknown', 'individual', 'general', 'n/a', 'na',
])

function canonical(raw) {
  return canonicalizeProfileTypeId(raw) || String(raw || '').trim().toLowerCase()
}

/**
 * Classify a resolved effective type into the coarse buckets the required-set
 * policy keys on. Unknown / "other" falls through to the person baseline so we
 * never UNDER-ask (a profile we cannot classify still owes name + location +
 * a need), and never ask org questions of an individual.
 */
export function classifyProfileType(effectiveType) {
  const c = canonical(effectiveType)
  const isStudent = STUDENT_SET.has(c)
  const isOrg = ORG_SET.has(c)
  const isBusiness = BUSINESS_SET.has(c)
  let isPerson = PERSON_SET.has(c) || isStudent
  if (!isPerson && !isOrg) isPerson = true // unclassified → individual baseline
  return { canonical: c, isPerson, isStudent, isOrg, isBusiness }
}

// --- section/value readers (operate on RAW sections, tolerating either the
//     `{ section_key: data }` or `{ section_key: { data } }` shape) ----------

function sectionData(sections, key) {
  const raw = sections?.[key]
  if (!raw || typeof raw !== 'object') return {}
  if (raw.data && typeof raw.data === 'object') return raw.data
  return raw
}

function filledString(value) {
  return typeof value === 'string' ? value.trim().length > 0 : false
}
function filledArray(value) {
  return Array.isArray(value) && value.filter((v) => filledString(v) || typeof v === 'number').length > 0
}
function filledNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string' && value.trim() !== '') return Number.isFinite(Number(value))
  return false
}
function anyFilled(...vals) {
  return vals.some((v) => {
    if (Array.isArray(v)) return filledArray(v)
    if (typeof v === 'number') return Number.isFinite(v)
    return filledString(v)
  })
}

/**
 * REQUIRED_DATA_POINTS — the ordered, per-type "required for a usable profile"
 * policy. Each entry:
 *
 *   id         stable id (also the question id)
 *   label      short human label (owner-facing)
 *   appliesTo  (cls) => boolean — is this data point required for this type?
 *   present    (profile, sections) => boolean — already answered anywhere?
 *   question   { type, prompt, writes:{ section, field } } — how Anya asks +
 *              where a POSTed answer is persisted.
 *
 * The set is deliberately conservative and sensible per type:
 *   - EVERY profile owes its name + its state (the one field every entry in
 *     profileTypeRegistry lists in requiredProfileFields, and what every geo
 *     gate reads).
 *   - A PERSON additionally owes the NEED it is seeking help with and a
 *     financial-need signal (the north-star "determine the need").
 *   - A STUDENT additionally owes its education level + intended field of study
 *     (what the student-aid recall + matching read).
 *   - An ORG additionally owes its organization type, its mission, and its
 *     program focus areas (organization_details + mission/type).
 */
export const REQUIRED_DATA_POINTS = Object.freeze([
  {
    id: 'full_name',
    label: 'Name',
    appliesTo: () => true,
    present: (profile, sections) => {
      const basic = sectionData(sections, 'basic_information')
      return anyFilled(profile?.display_name, basic.full_name, basic.name)
    },
    question: {
      type: 'text',
      prompt: 'What name should this profile be under (the applicant or primary contact)?',
      writes: { section: 'basic_information', field: 'full_name' },
    },
  },
  {
    id: 'state',
    label: 'State / location',
    appliesTo: () => true,
    present: (profile, sections) => {
      const basic = sectionData(sections, 'basic_information')
      const loc = sectionData(sections, 'location_focus')
      return anyFilled(profile?.state, basic.state, loc.state, loc.geographic_focus)
    },
    question: {
      type: 'text',
      prompt: 'Which US state do you live in (or primarily serve)? This unlocks state and local funding.',
      writes: { section: 'basic_information', field: 'state' },
    },
  },
  {
    id: 'need_categories',
    label: 'What you need help with',
    appliesTo: (cls) => cls.isPerson,
    present: (_profile, sections) => {
      const fin = sectionData(sections, 'financial_information')
      const needs = sectionData(sections, 'funding_needs')
      const health = sectionData(sections, 'health_medical')
      return anyFilled(fin.assistance_needs, needs.need_categories, fin.funding_needs, health.support_needs)
    },
    question: {
      type: 'text',
      prompt:
        'What do you most need help with right now? (for example: housing, utilities, medical bills, food, education, disability support, emergency assistance)',
      writes: { section: 'financial_information', field: 'assistance_needs' },
    },
  },
  {
    id: 'financial_need',
    label: 'Financial need',
    appliesTo: (cls) => cls.isPerson,
    present: (_profile, sections) => {
      const fin = sectionData(sections, 'financial_information')
      const narrative = sectionData(sections, 'narrative')
      const level = String(fin.financial_need_level || '').trim().toLowerCase()
      const hasLevel = level.length > 0 && level !== 'unknown'
      return (
        hasLevel ||
        fin.low_income === true ||
        filledNumber(fin.household_income) ||
        anyFilled(narrative.funding_amount_needed, fin.funding_needs)
      )
    },
    question: {
      type: 'text',
      prompt: 'Roughly how urgent is your financial need — low, moderate, high, or urgent?',
      writes: { section: 'financial_information', field: 'financial_need_level' },
    },
  },
  {
    id: 'education_level',
    label: 'Education level',
    appliesTo: (cls) => cls.isStudent,
    present: (_profile, sections) => {
      const edu = sectionData(sections, 'education')
      const basic = sectionData(sections, 'basic_information')
      const academic = basic.academic_status && typeof basic.academic_status === 'object' ? basic.academic_status : {}
      return anyFilled(edu.highest_level, edu.current_institution, academic.education_level)
    },
    question: {
      type: 'text',
      prompt: 'What is your current grade or education level (e.g. high school senior, college sophomore, graduate student)?',
      writes: { section: 'education', field: 'highest_level' },
    },
  },
  {
    id: 'intended_major',
    label: 'Field of study',
    appliesTo: (cls) => cls.isStudent,
    present: (_profile, sections) => {
      const edu = sectionData(sections, 'education')
      return anyFilled(edu.intended_major, edu.cte_pathway)
    },
    question: {
      type: 'text',
      prompt: 'What do you plan to study — your intended major or field?',
      writes: { section: 'education', field: 'intended_major' },
    },
  },
  {
    id: 'organization_type',
    label: 'Organization type',
    appliesTo: (cls) => cls.isOrg,
    present: (_profile, sections) => {
      const org = sectionData(sections, 'organization_details')
      const value = String(org.organization_type || '').trim().toLowerCase()
      return value.length > 0 && !GENERIC_ORG_TYPE_VALUES.has(value)
    },
    question: {
      type: 'text',
      prompt: 'What kind of organization is this? (nonprofit, church, school, business, agency, foundation…)',
      writes: { section: 'organization_details', field: 'organization_type' },
    },
  },
  {
    id: 'mission',
    label: 'Mission',
    appliesTo: (cls) => cls.isOrg,
    present: (_profile, sections) => {
      const narrative = sectionData(sections, 'narrative')
      const org = sectionData(sections, 'organization_details')
      const essays = sectionData(sections, 'essays')
      return anyFilled(narrative.mission, org.mission, essays.primary, essays.personal_statement)
    },
    question: {
      type: 'text',
      prompt: 'In a sentence, what is your organization’s mission or main focus?',
      writes: { section: 'narrative', field: 'mission' },
    },
  },
  {
    id: 'focus_areas',
    label: 'Program focus areas',
    appliesTo: (cls) => cls.isOrg,
    present: (_profile, sections) => {
      const programs = sectionData(sections, 'programs_services')
      return anyFilled(programs.focus_areas, programs.interests, programs.keywords)
    },
    question: {
      type: 'text',
      prompt: 'What are your main program focus areas or who do you serve? (list a few)',
      writes: { section: 'programs_services', field: 'focus_areas' },
    },
  },
])

/**
 * Resolve the ordered REQUIRED data points for a resolved effective type.
 * Pure. Exposed for tests and for callers that only need the required set.
 */
export function resolveRequiredDataPoints(effectiveType) {
  const cls = classifyProfileType(effectiveType)
  return REQUIRED_DATA_POINTS.filter((dp) => dp.appliesTo(cls))
}

/**
 * computeProfileCompletionGate — PURE. Given a raw profile row + raw sections
 * map, decide whether the profile is complete enough to proceed, and if not,
 * produce the ordered NUMBERED questions Anya asks to fill the gaps.
 *
 * @param {object} profile   raw profile row (display_name, primary_type, state…)
 * @param {object} [sections] raw sections keyed by section_key
 * @param {object} [opts]
 * @param {string} [opts.effectiveType]  override the resolved type (else derived)
 * @param {string} [opts.displayName]
 * @returns {{
 *   effective_type: string|null,
 *   type_class: object,
 *   required: Array<{id,label,section,field,present}>,
 *   required_total: number,
 *   filled_count: number,
 *   missing: Array<object>,
 *   complete: boolean,
 *   blocked: boolean,
 *   intro: string,
 *   questions: Array<{index,total,id,type,prompt,writes,label,section,field}>,
 * }}
 */
export function computeProfileCompletionGate(profile, sections = {}, opts = {}) {
  const effectiveType = opts.effectiveType ?? resolveEffectiveProfileType(profile ?? {}, sections ?? {})
  const cls = classifyProfileType(effectiveType)
  const requiredDefs = REQUIRED_DATA_POINTS.filter((dp) => dp.appliesTo(cls))

  const required = requiredDefs.map((dp) => ({
    id: dp.id,
    label: dp.label,
    section: dp.question.writes.section,
    field: dp.question.writes.field,
    present: Boolean(dp.present(profile ?? {}, sections ?? {})),
  }))

  const missingDefs = requiredDefs.filter((dp) => !dp.present(profile ?? {}, sections ?? {}))
  const total = missingDefs.length // N = number of NEEDED (still-missing) data points
  const filledCount = requiredDefs.length - total

  const questions = missingDefs.map((dp, i) => ({
    index: i + 1,
    total,
    id: dp.id,
    type: dp.question.type,
    prompt: dp.question.prompt,
    writes: dp.question.writes,
    label: dp.label,
    section: dp.question.writes.section,
    field: dp.question.writes.field,
  }))

  const complete = total === 0
  const displayName = String(opts.displayName || profile?.display_name || '').trim().split(/\s+/)[0] || 'there'
  const intro = complete
    ? null
    : `Hi ${displayName} — before I can find funding that actually fits, I need a few more details about this profile. ` +
      `Please answer these ${total} question${total === 1 ? '' : 's'} to finish setting it up; you cannot proceed until your profile is complete.`

  return {
    effective_type: effectiveType ?? null,
    type_class: cls,
    required,
    required_total: requiredDefs.length,
    filled_count: filledCount,
    missing: missingDefs.map((dp) => ({ id: dp.id, label: dp.label, section: dp.question.writes.section, field: dp.question.writes.field })),
    complete,
    blocked: !complete,
    intro,
    questions,
  }
}

/**
 * Load one profile's raw sections and compute its completion gate. Async
 * (single DB read); returns null on any error so a caller can fail-open.
 *
 * @param {object} db       request/boot-scoped DB handle
 * @param {object} profile  a profile row (id, display_name, primary_type…)
 */
export async function computeProfileCompletionGateFromDb(db, profile) {
  if (!db || !profile?.id) return null
  const rows = await db
    .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
    .all(profile.id)
  const sections = {}
  for (const row of rows || []) {
    try {
      sections[row.section_key] = row?.data ? JSON.parse(row.data) : {}
    } catch {
      sections[row.section_key] = {}
    }
  }
  return computeProfileCompletionGate(profile, sections, { displayName: profile.display_name })
}

/**
 * resolveProfileCompletionForUser — the per-USER summary the auth/onboarding
 * payload advertises so the frontend can enforce the gate on next login.
 *
 * ADMINS ARE NEVER GATED. Mirrors the standing "never re-interview admins" rule
 * (onboardingGates.resolveGuidedCycleTourStatus / enforceAdminReinterviewSuppression):
 * an owner-admin working across many client profiles must not be blocked by any
 * one of them being incomplete. Returns `{ active:false, blocked:false,
 * exempt:'admin' }` for admins.
 *
 * For a non-admin, scans the user's own profiles (bounded, skipping synthetic
 * agent:amy + deleted rows) and reports which are incomplete plus the first
 * incomplete profile's gate as `next`. Fail-OPEN: any error resolves to an
 * inert `{ active:false, blocked:false }` so login can never break on this.
 *
 * @param {object} db
 * @param {object} userRow    users row (needs is_admin)
 * @param {Array}  profiles   the user's profile rows (id, display_name, primary_type, status, created_by)
 * @param {object} [opts]
 * @param {number} [opts.limit=5]
 */
export async function resolveProfileCompletionForUser(db, userRow, profiles, opts = {}) {
  try {
    if (isAdminUserRow(userRow)) {
      return { active: false, blocked: false, exempt: 'admin', profiles: [], next: null }
    }
    const limit = Number.isFinite(opts.limit) ? opts.limit : 5
    const candidates = (Array.isArray(profiles) ? profiles : [])
      .filter((p) => p && p.id)
      .filter((p) => String(p.created_by || '') !== 'agent:amy')
      .filter((p) => String(p.status || '') !== 'deleted')
      .slice(0, limit)

    const results = []
    let nextProfile = null
    let nextGate = null
    for (const profile of candidates) {
      const gate = await computeProfileCompletionGateFromDb(db, profile)
      if (!gate) continue
      results.push({
        profile_id: profile.id,
        display_name: profile.display_name ?? null,
        complete: gate.complete,
        remaining: gate.questions.length,
        required_total: gate.required_total,
        filled_count: gate.filled_count,
      })
      if (!gate.complete && !nextGate) {
        nextProfile = profile
        nextGate = gate
      }
    }

    return {
      active: true,
      blocked: results.some((r) => !r.complete),
      exempt: null,
      profiles: results,
      next: nextGate ? { profile_id: nextProfile.id, ...nextGate } : null,
    }
  } catch {
    return { active: false, blocked: false, exempt: null, profiles: [], next: null }
  }
}

export default {
  REQUIRED_DATA_POINTS,
  classifyProfileType,
  resolveRequiredDataPoints,
  computeProfileCompletionGate,
  computeProfileCompletionGateFromDb,
  resolveProfileCompletionForUser,
}
