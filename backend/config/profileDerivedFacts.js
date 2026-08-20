/**
 * profileDerivedFacts.js — SINGLE SOURCE OF TRUTH for "what does this profile
 * actually SAY about itself", derived with PROVENANCE.
 *
 * THE OWNER'S RULE (2026-08-01): "GrantFlow will find real relatable sources
 * that meet the needs of the profile. It will determine the need, run the
 * correct crawlers, and use the profile information in finding the funding
 * source." And: "The crawlers will always pull information from the profile
 * prior to crawling. They will determine which crawlers are appropriate for the
 * needs of the profile."
 *
 * THE DEFECT THIS EXISTS FOR, measured read-only in prod 2026-08-02 on
 * Demo Tennessee STEM Student (`c4a92724-…`, `education.intended_major = "Forensic Science"`,
 * `education.interests = [Forensic Science, Criminal Justice, STEM, DNA
 * Analysis, Crime Scene Investigation]`):
 *
 *   buildThesis's `interest_terms` — the ONLY topical seed the open-web query
 *   builder consumes — resolved to:
 *
 *     ['demo_stem_student','nicole','white','female','woman','women','girl','girls',
 *      'female-led','led','female identifying','identifying']
 *
 *   Her NAME and twelve gender synonyms. Not one word about forensic science.
 *
 * THE MECHANISM. `buildProfileSignals` returns `signals.keywords` as ONE
 * undifferentiated 453-entry bag: display-name tokens, gender synonyms, prose
 * fragments ("acts as translator and advocate."), bare stopwords ("with", "and",
 * "the", "who", "has", "line"), AND — at positions 127-160 — her real field
 * vocabulary. `profileContextToThesisInput` pours that bag into `tags`, and
 * `buildThesis` takes `.slice(0, 12)` of it. The 12-slot topical budget is spent
 * before the first real fact is reached. The system HELD the fact and did not
 * REASON from it: it took the first twelve items off an unranked pile.
 *
 * A DERIVED FACT IS A CLAIM WITH AN ADDRESS. Every fact this module returns
 * carries the REGISTRY FIELD ID it came from. There is no inference without
 * provenance, because a fact whose source cannot be named is a fact nobody can
 * check, correct, or refuse — and the whole class of bug above is what happens
 * when "the profile says so" is asserted rather than derived.
 *
 * REGISTRY + TOTALITY (CLAUDE.md). `DERIVED_FACT_FIELDS` is the enumerable
 * inventory; `profileDerivedFacts.test.js` asserts every entry is consulted by
 * `deriveProfileFacts` and reachable by at least one consumer, so a new profile
 * field cannot silently fall out of query building, lane selection or recall.
 *
 * WHAT THIS MODULE DOES NOT DO. It never decides a match, never asserts
 * eligibility, and never invents an award. `services/matchEngine.js` stays the
 * sole decision authority — these facts only tell the system what to LOOK for
 * and which pairs are worth LOOKING at.
 *
 * DELEGATION, NOT FORKING. Institutions come from `profileInstitutions.js`
 * (#1089/#1090's attendance-vs-aspiration registry) and accepted aid types from
 * `aidTypePreferences.js`. Re-deriving either here would be a second door onto a
 * rule that already has one.
 */

import {
  resolveAttendedInstitutions,
  resolveAspirationalInstitutions,
} from './profileInstitutions.js'
import { resolveAcceptedAidTypes, AID_TYPE_KEYS } from './aidTypePreferences.js'
import { STATE_REGISTRY } from '../services/shared/data/stateRegistry.js'
import { deriveWebsitePurpose } from './profileWebsitePurpose.js'

/** Coerce a section value to a plain object (may be an object or a JSON string). */
function obj(v) {
  if (!v) return {}
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} }
  }
  return typeof v === 'object' ? v : {}
}

function list(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) return v.split(',')
  return []
}

export function normalizeTerm(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const NON_TOPICAL_TERMS = Object.freeze(new Set([
  'financial aid', 'financial assistance', 'financial support', 'financial need',
  'funding opportunities', 'funding opportunity', 'grant funding', 'grant program',
  'research and development', 'community support', 'community empowerment',
  'community engagement', 'community development', 'community service',
  'social impact', 'general studies', 'liberal arts', 'higher education',
  'academic excellence', 'academic achievement', 'student leadership',
  'leadership development', 'professional development', 'career development',
  'educational equity', 'education and training', 'college readiness',
  'high school', 'high school senior', 'high school student', 'college bound',
  'first generation', 'second generation', 'need based', 'need based aid',
  'cost of attendance', 'room and board', 'student housing', 'student aid',
]))

export const PLACE_TERMS = Object.freeze(new Set([
  ...Object.values(STATE_REGISTRY).map((s) => normalizeTerm(s?.name)).filter(Boolean),
  'puerto rico', 'guam', 'virgin islands', 'american samoa', 'northern mariana islands',
]))

export const MIN_TERM_LENGTH = 5
export const MAX_TERM_LENGTH = 40
export const MAX_TOPICAL_TERMS = 12

export const DERIVED_FACT_FIELDS = Object.freeze([
  Object.freeze({
    id: 'education.intended_major',
    fact: 'field_of_study',
    recallSafe: true,
    read: (s) => [obj(s.education).intended_major],
  }),
  Object.freeze({
    id: 'education.major',
    fact: 'field_of_study',
    recallSafe: true,
    read: (s) => [obj(s.education).major],
  }),
  Object.freeze({
    id: 'student_portal_plan.major',
    fact: 'field_of_study',
    recallSafe: true,
    read: (s) => [obj(s.student_portal_plan).major],
  }),
  Object.freeze({
    id: 'education.interests',
    fact: 'field_of_study',
    recallSafe: true,
    read: (s) => list(obj(s.education).interests),
  }),
  Object.freeze({
    id: 'programs_services.interests',
    fact: 'topic',
    recallSafe: false,
    read: (s) => list(obj(s.programs_services).interests),
  }),
  Object.freeze({
    id: 'programs_services.keywords',
    fact: 'topic',
    recallSafe: false,
    read: (s) => list(obj(s.programs_services).keywords),
  }),
  Object.freeze({
    id: 'education.highest_level',
    fact: 'stage_of_life',
    recallSafe: false,
    read: (s) => [obj(s.education).highest_level],
  }),
  Object.freeze({
    id: 'basic_information.academic_status.education_level',
    fact: 'stage_of_life',
    recallSafe: false,
    read: (s) => [obj(obj(s.basic_information).academic_status).education_level],
  }),
  Object.freeze({
    id: 'basic_information.academic_status.college_courses',
    fact: 'stage_of_life',
    recallSafe: false,
    read: (s) => [obj(obj(s.basic_information).academic_status).college_courses],
  }),
  Object.freeze({
    id: 'education.gpa',
    fact: 'academic_standing',
    recallSafe: false,
    read: (s) => [obj(s.education).gpa ?? obj(obj(s.basic_information).academic_status).gpa],
  }),
  Object.freeze({
    id: 'education.act_score',
    fact: 'academic_standing',
    recallSafe: false,
    read: (s) => [obj(s.education).act_score ?? obj(obj(s.basic_information).academic_status).act_score],
  }),
  Object.freeze({
    id: 'education.sat_score',
    fact: 'academic_standing',
    recallSafe: false,
    read: (s) => [obj(s.education).sat_score || obj(obj(s.basic_information).academic_status).sat_score],
  }),
  Object.freeze({
    id: 'education.aid_types_accepted',
    fact: 'accepted_aid_types',
    recallSafe: false,
    read: (s) => list(obj(s.education).aid_types_accepted),
  }),
  Object.freeze({
    id: 'basic_information.website',
    fact: 'topic',
    recallSafe: false,
    read: (s) => [obj(s.basic_information).website],
  }),
  Object.freeze({
    id: 'organization_details.website',
    fact: 'topic',
    recallSafe: false,
    read: (s) => [obj(s.organization_details).website, obj(s.organization_details).website_url],
  }),
  Object.freeze({
    id: 'organization_details.website_excerpt',
    fact: 'topic',
    recallSafe: false,
    read: (s) => [obj(s.organization_details).website_excerpt, obj(s.organization_details).website_about],
  }),
])

const TOPICAL_FIELDS = DERIVED_FACT_FIELDS.filter((f) => f.fact === 'field_of_study' || f.fact === 'topic')

export function isTopicalTerm(term) {
  const t = normalizeTerm(term)
  if (t.length < MIN_TERM_LENGTH || t.length > MAX_TERM_LENGTH) return false
  if (!t.includes(' ')) return false
  if (NON_TOPICAL_TERMS.has(t)) return false
  if (PLACE_TERMS.has(t)) return false
  return true
}

function readTopicalTerms(sections) {
  const byTerm = new Map()
  for (const field of TOPICAL_FIELDS) {
    let raw = []
    try { raw = field.read(sections ?? {}) ?? [] } catch { raw = [] }
    for (const value of raw) {
      const term = normalizeTerm(value)
      if (!isTopicalTerm(term)) continue
      if (byTerm.has(term)) continue
      byTerm.set(term, Object.freeze({
        term,
        evidence: field.id,
        fact: field.fact,
        recallSafe: field.recallSafe === true,
      }))
    }
  }
  return [...byTerm.values()].slice(0, MAX_TOPICAL_TERMS)
}

function firstString(sections, fieldIds) {
  for (const id of fieldIds) {
    const field = DERIVED_FACT_FIELDS.find((f) => f.id === id)
    if (!field) continue
    let raw = []
    try { raw = field.read(sections ?? {}) ?? [] } catch { raw = [] }
    for (const v of raw) {
      const s = String(v ?? '').trim()
      if (s) return { value: s, evidence: id }
    }
  }
  return null
}

function firstNumber(sections, fieldId) {
  const field = DERIVED_FACT_FIELDS.find((f) => f.id === fieldId)
  if (!field) return null
  let raw = []
  try { raw = field.read(sections ?? {}) ?? [] } catch { raw = [] }
  for (const v of raw) {
    const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''))
    if (Number.isFinite(n) && n > 0) return { value: n, evidence: fieldId }
  }
  return null
}

const DUAL_ENROLLED_RX = /^\s*(y|yes|true|1)\s*$/i
const HS_RX = /high school|secondary|senior|junior|sophomore|freshman \(hs\)/i
const GRAD_RX = /master|doctor|phd|post-?graduate|(?<!high school |hs |college )(?<![a-z])graduate(?!d)|grad school|professional degree/i
const UNDERGRAD_RX = /associate|bachelor|undergraduate|some college|college/i

export function deriveStageOfLife(sections = {}) {
  const level = firstString(sections, [
    'basic_information.academic_status.education_level',
    'education.highest_level',
  ])
  const dual = firstString(sections, ['basic_information.academic_status.college_courses'])
  const evidence = [level?.evidence, dual?.evidence].filter(Boolean)
  const levelText = String(level?.value ?? '')
  const isDual = DUAL_ENROLLED_RX.test(String(dual?.value ?? ''))
  if (!levelText && !isDual) return null
  if (GRAD_RX.test(levelText)) return { value: 'graduate_student', evidence }
  if (HS_RX.test(levelText)) {
    return { value: isDual ? 'dual_enrolled_incoming_freshman' : 'high_school_student', evidence }
  }
  if (UNDERGRAD_RX.test(levelText)) return { value: 'undergraduate', evidence }
  return levelText ? { value: 'unclassified', evidence } : null
}

export function deriveProfileFacts(profile = {}, sections = {}) {
  const s = sections ?? {}
  const terms = readTopicalTerms(s)
  const basic = obj(s.basic_information)
  const loc = obj(basic.location)
  const education = obj(s.education)
  const declaredAid = list(education.aid_types_accepted)
  const websitePurpose = deriveWebsitePurpose({ profile, sections: s })
  const websiteEvidence = websitePurpose.url
    ? (obj(s.basic_information).website ? 'basic_information.website' : 'organization_details.website')
    : 'website_or_mission_text'
  const websiteTerms = (websitePurpose.terms || []).map((term) => Object.freeze({
    term: normalizeTerm(term),
    evidence: websiteEvidence,
    fact: 'topic',
    recallSafe: false,
  })).filter((t) => t.term && isTopicalTerm(t.term))
  const mergedTerms = []
  const seen = new Set()
  for (const t of [...websiteTerms, ...terms]) {
    if (seen.has(t.term)) continue
    seen.add(t.term)
    mergedTerms.push(t)
  }

  return Object.freeze({
    topicalTerms: Object.freeze(mergedTerms),
    recallTerms: Object.freeze(mergedTerms.filter((t) => t.recallSafe)),
    institutions: Object.freeze({
      attended: Object.freeze(resolveAttendedInstitutions(s)),
      aspirational: Object.freeze(resolveAspirationalInstitutions(s)),
      evidence: 'config/profileInstitutions.PROFILE_INSTITUTION_FIELDS',
    }),
    stageOfLife: deriveStageOfLife(s),
    academicStanding: Object.freeze({
      gpa: firstNumber(s, 'education.gpa'),
      act: firstNumber(s, 'education.act_score'),
      sat: firstNumber(s, 'education.sat_score'),
    }),
    acceptedAidTypes: Object.freeze({
      value: Object.freeze(resolveAcceptedAidTypes(education)),
      declared: declaredAid.length > 0,
      evidence: declaredAid.length > 0 ? 'education.aid_types_accepted' : null,
    }),
    place: Object.freeze({
      city: loc.city || basic.city || profile?.city || null,
      state: loc.state || basic.state || profile?.state || null,
      county: loc.county || basic.county || null,
      zip: loc.zip_code || basic.zip_code || profile?.postal_code || null,
      evidence: 'basic_information.location',
    }),
    websitePurpose,
  })
}

export function searchTermsFromFacts(facts) {
  return (facts?.topicalTerms ?? []).map((t) => t.term)
}

export function titleStatesTerm(term, title) {
  const t = normalizeTerm(term)
  if (!t) return false
  const hay = ` ${normalizeTerm(title)} `
  return hay.includes(` ${t} `)
}

export function termLikePattern(term) {
  const t = normalizeTerm(term)
  return t ? `%${t}%` : null
}

export default {
  DERIVED_FACT_FIELDS,
  NON_TOPICAL_TERMS,
  PLACE_TERMS,
  MIN_TERM_LENGTH,
  MAX_TERM_LENGTH,
  MAX_TOPICAL_TERMS,
  AID_TYPE_KEYS,
  normalizeTerm,
  isTopicalTerm,
  deriveStageOfLife,
  deriveProfileFacts,
  searchTermsFromFacts,
  titleStatesTerm,
  termLikePattern,
}
