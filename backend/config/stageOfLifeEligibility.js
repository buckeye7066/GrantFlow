/**
 * stageOfLifeEligibility.js — the ACADEMIC-STAGE eligibility gate.
 *
 * Also applies website-purpose conflicts via stageOfLifeConflictForSections
 * (owner 2026-08-20): profile website URL states what the org IS.
 *
 * See CLAUDE.md / docs for the full stage-of-life gate rationale.
 */

import { deriveStageOfLife } from './profileDerivedFacts.js'
import {
  deriveWebsitePurpose,
  websitePurposeConflict,
} from './profileWebsitePurpose.js'

export const STAGE_KNOWN = Object.freeze([
  'high_school_student',
  'dual_enrolled_incoming_freshman',
  'undergraduate',
  'graduate_student',
  'unclassified',
])

export const STAGE_LABELS = Object.freeze({
  high_school_student: 'a high-school student',
  dual_enrolled_incoming_freshman: 'a dual-enrolled high-school student entering college',
  undergraduate: 'an undergraduate',
  graduate_student: 'a graduate student',
  unclassified: 'of an unstated academic stage',
})

const PRE_BACCALAUREATE = Object.freeze(['high_school_student', 'dual_enrolled_incoming_freshman'])

export const STUDENT_STAGES = Object.freeze([
  'high_school_student',
  'dual_enrolled_incoming_freshman',
  'undergraduate',
  'graduate_student',
])

export function isStudentStage(stage) {
  return STUDENT_STAGES.includes(String(stage ?? ''))
}

export const STUDENT_AID_NEED_CATEGORIES = Object.freeze([
  'scholarship', 'tuition', 'fafsa', 'pell', 'education',
])

export const STAGE_REQUIREMENT_CLASSES = Object.freeze([
  Object.freeze({
    id: 'graduate_or_professional',
    label: 'graduate or professional school',
    patterns: Object.freeze([
      /\bgraduate\s+(?:students?|studies|school|fellowships?|research|degrees?|programs?|level|candidates?|scholars?|assistantships?)\b/i,
      /\bgraduate\s+and\s+professional\b/i,
      /\bpost-?graduate\b/i,
      /\bdoctoral\b/i,
      /\bdoctorate\b/i,
      /\bph\.?\s?d\.?\b/i,
      /\bdoctor\s+of\s+[a-z]+/i,
      /\bmaster'?s?\s+(?:degrees?|programs?|students?|candidates?|level|thesis)\b/i,
      /\bm\.?b\.?a\.?\s+(?:students?|candidates?|programs?|degrees?)\b/i,
      /\bresident\s+physicians?\b/i,
    ]),
    identityPatterns: Object.freeze([
      /\b(?:medical|law|dental|veterinary|pharmacy)\s+school\b/i,
      /\bschool\s+of\s+(?:medicine|law|dentistry|veterinary\s+medicine|pharmacy)\b/i,
    ]),
    inclusionGuard: /\b(?:undergraduates?|undergraduate\s+students?|baccalaureate|bachelor'?s?|high\s+school|freshm[ae]n|sophomores?|associate'?s?\s+degrees?|community\s+college)\b/i,
    barredStages: Object.freeze([...PRE_BACCALAUREATE]),
  }),
  Object.freeze({
    id: 'postdoctoral',
    label: 'postdoctoral training',
    patterns: Object.freeze([
      /\bpost-?doctoral\b/i,
      /\bpost-?docs?\b/i,
    ]),
    inclusionGuard: /\b(?:undergraduates?|baccalaureate|bachelor'?s?|high\s+school)\b/i,
    barredStages: Object.freeze([...PRE_BACCALAUREATE, 'undergraduate']),
  }),
  Object.freeze({
    id: 'dual_enrollment',
    label: 'dual-enrolled high-school students',
    patterns: Object.freeze([
      /\bdual[\s-]enroll(?:ment|ed)\b/i,
      /\bdually[\s-]enrolled\b/i,
    ]),
    inclusionGuard: /\b(?:current(?:ly)?[\s-]enrolled\s+college|college\s+students?|undergraduates?|graduate\s+students?|all\s+students?)\b/i,
    barredStages: Object.freeze(['undergraduate', 'graduate_student']),
  }),
  Object.freeze({
    id: 'adult_reentry',
    label: 'adult / returning-student reentry',
    patterns: Object.freeze([
      /\bre-?entry\s+(?:students?|scholars?|scholarships?)\b/i,
      /\b(?:adult|student|non-?traditional)\s+re-?entry\b/i,
      /\bnon-?traditional\s+(?:students?|age|learners?|undergraduates?|scholars?|applicants?)\b/i,
      /\b(?:scholarships?|awards?|grants?)\s+for\s+non-?traditional\b/i,
      /\breturning\s+adults?\b/i,
      /\badult\s+learners?\b/i,
      /\badults?\s+returning\b/i,
      /\breturning\s+to\s+(?:college|school|education)\b/i,
      /\bre-?enroll(?:ing|ment|ed)?\s+after\b/i,
    ]),
    inclusionGuard: /\b(?:high\s+school\s+(?:seniors?|students?|graduates?)|incoming\s+freshm[ae]n|graduating\s+seniors?|traditional\s+and\s+non-?traditional)\b/i,
    barredStages: Object.freeze([...PRE_BACCALAUREATE]),
  }),
])

export const STAGE_DECLARATION_LIKE_PATTERNS = Object.freeze([
  '%graduate%',
  '%doctor%',
  '%ph d%', '%ph.d%', '%phd%',
  '%master%',
  '%mba%',
  '%medical school%', '%law school%', '%dental school%',
  '%veterinary school%', '%pharmacy school%',
  '%school of medicine%', '%school of law%', '%school of dentistry%',
  '%school of veterinary%', '%school of pharmacy%',
  '%resident physician%',
  '%postdoc%', '%post-doc%',
  '%reentry%', '%re-entry%',
  '%nontraditional%', '%non-traditional%',
  '%returning adult%', '%adults returning%', '%adult learner%',
  '%returning to college%', '%returning to school%', '%returning to education%',
  '%reenroll%', '%re-enroll%',
  '%dual enroll%', '%dual-enroll%', '%dually enrolled%', '%dually-enrolled%',
])

const NEGATION_WINDOW = 44
const NEGATION_BEFORE_RX = /\b(?:not|never|ineligible|excluding|excludes|excluded|except|other\s+than|rather\s+than|neither|nor|no)\b[^.]{0,20}$/i
const NEGATION_AFTER_RX = /^[^.]{0,24}?\b(?:not|never|ineligible|excluded|may\s+not|are\s+not|is\s+not|cannot)\b/i

export const IDENTITY_FIELDS = Object.freeze(['title', 'sponsor'])

function evidenceFragments(opportunity = {}) {
  const o = opportunity || {}
  const out = []
  const push = (field, value) => {
    const s = String(value ?? '').trim()
    if (s) out.push({ field, text: s, identity: IDENTITY_FIELDS.includes(field) })
  }
  push('title', o.title)
  push('sponsor', o.sponsor ?? o.funder ?? o.organization)
  push('eligibility_text', o.eligibility_text ?? o.eligibilityText)
  const bullets = Array.isArray(o.eligibility_bullets)
    ? o.eligibility_bullets
    : Array.isArray(o.eligibilityBullets) ? o.eligibilityBullets : []
  bullets.forEach((b, i) => push(`eligibility_bullets[${i}]`, b))
  push('description', o.description ?? o.summary)
  return out
}

export function detectDeclaredStageRequirement(opportunity = {}) {
  const fragments = evidenceFragments(opportunity)
  for (const cls of STAGE_REQUIREMENT_CLASSES) {
    for (const fragment of fragments) {
      if (cls.inclusionGuard && cls.inclusionGuard.test(fragment.text)) continue
      const applicable = fragment.identity && cls.identityPatterns
        ? [...cls.patterns, ...cls.identityPatterns]
        : cls.patterns
      for (const rx of applicable) {
        const m = rx.exec(fragment.text)
        if (!m) continue
        const before = fragment.text.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index)
        if (NEGATION_BEFORE_RX.test(before)) continue
        const after = fragment.text.slice(m.index + m[0].length, m.index + m[0].length + NEGATION_WINDOW)
        if (NEGATION_AFTER_RX.test(after)) continue
        return {
          declared: true,
          classId: cls.id,
          label: cls.label,
          phrase: m[0].trim(),
          field: fragment.field,
        }
      }
    }
  }
  return { declared: false, classId: null, label: null, phrase: null, field: null }
}

export function stageOfLifeConflict(stage, opportunity = {}) {
  const s = String(stage ?? '').trim()
  if (!s || s === 'unclassified') return null
  const declared = detectDeclaredStageRequirement(opportunity)
  if (!declared.declared) return null
  const cls = STAGE_REQUIREMENT_CLASSES.find((c) => c.id === declared.classId)
  if (!cls || !cls.barredStages.includes(s)) return null
  return {
    classId: cls.id,
    label: cls.label,
    phrase: declared.phrase,
    field: declared.field,
    reason:
      `Academic stage: this award is for ${cls.label} — its own ${declared.field} says ` +
      `"${declared.phrase}" — and the profile is ${STAGE_LABELS[s] ?? s}`,
  }
}

/**
 * Stage gate + website-purpose gate (Axiom BioLabs / research orgs).
 * matchEngine already calls this; website URL mismatches REJECT here.
 */
export function stageOfLifeConflictForSections(sections, opportunity = {}) {
  const derived = deriveStageOfLife(sections ?? {})
  const stage = stageOfLifeConflict(derived?.value ?? null, opportunity)
  if (stage) return stage
  const purpose = deriveWebsitePurpose({ sections: sections ?? {} })
  const site = websitePurposeConflict({ purpose, opportunity })
  if (!site) return null
  return {
    classId: 'website_purpose',
    label: 'website purpose',
    phrase: site.lock,
    field: 'profile.website',
    reason: site.reason,
    lock: site.lock,
  }
}

export default {
  STAGE_KNOWN,
  STAGE_LABELS,
  STUDENT_STAGES,
  STUDENT_AID_NEED_CATEGORIES,
  isStudentStage,
  STAGE_REQUIREMENT_CLASSES,
  STAGE_DECLARATION_LIKE_PATTERNS,
  IDENTITY_FIELDS,
  detectDeclaredStageRequirement,
  stageOfLifeConflict,
  stageOfLifeConflictForSections,
}
