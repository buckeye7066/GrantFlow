/**
 * fieldOfStudyEligibility.js — the FIELD-OF-STUDY eligibility gate.
 *
 * THE DEFECT, measured 2026-08-23 on Robert Michael White
 * (`6b3c75ec-…`, a paramedic student at Cleveland State):
 *
 *   Robert declares `education.intended_major = "Paramedic"` and
 *   `student_portal_plan.major = "Paramedic"` (career goal "Critical Care
 *   Paramedic"). A Hamilton autopilot pursuit was pointed at the
 *   "Marybelle Huggins Memorial NURSING Scholarship" (bold.org) — nursing and
 *   paramedicine are DIFFERENT health credentials, so the profile does not
 *   qualify, yet nothing in the engine said so: the row's `eligibility_text`,
 *   `eligibility_bullets`, `categories` and `entity_types_allowed` are all EMPTY
 *   and the ONLY nursing statement lives in the TITLE. The applicant-type gate
 *   reads structured types, the stage gate reads academic stage — neither knows
 *   a nursing-restricted award is closed to a paramedic. This is the field-of-
 *   study twin of the stage-of-life defect (#1092): a restriction stated only in
 *   the title, provably unmeetable, and unreachable by every existing gate.
 *
 * THE RULE, mirroring `stageOfLifeEligibility.js` exactly:
 *
 *   1. SILENCE IS NEVER A DENIAL. An award whose title names no specific
 *      vocational field is untouched. A profile that declares no structured
 *      major is untouched. Only a PROVABLE conflict — the award names field X,
 *      the profile declares a DIFFERENT specific field Y, and X and Y are both
 *      recognised distinct vocational fields — rejects.
 *
 *   2. THE GATE REFUSES; IT NEVER ASSERTS. `fieldOfStudyConflict` returns a
 *      conflict or null. Null means "this gate has nothing to say", never
 *      "eligible".
 *
 *   3. ONLY PROVABLE, SPECIFIC-vs-SPECIFIC MISMATCH. Both sides must resolve to
 *      an entry in `FIELD_CLASSES` — a named vocational field (nursing,
 *      paramedic/EMS, engineering, law, …). A BROAD word ("healthcare", "STEM",
 *      "business") is deliberately NOT a class, so a "Healthcare Scholarship"
 *      never fires against a paramedic (under-reach is safe; over-reach on a
 *      fleet-wide engine gate is not). A profile major that maps to no class
 *      (Biology, Psychology, an undeclared major) leaves the gate silent.
 *
 * FRAGMENTS ARE TESTED SEPARATELY (#1086) and the required field is read ONLY
 * from the row's IDENTITY fields (title, sponsor). A field named in DESCRIPTION
 * prose is overwhelmingly context, not a restriction ("students who share her
 * passion for nursing" describes the DONOR's intent, not an eligibility bar);
 * the load-bearing signal is the title, where "<Field> Scholarship" is how a
 * field-restricted award names itself.
 *
 * THE PROFILE SIDE IS STRUCTURED-ONLY and read through the SAME
 * `DERIVED_FACT_FIELDS` registry the recall lane and the stage gate consume, so
 * a new major field cannot reach discovery and silently miss this gate. Never
 * prose — a mission narrative that mentions "nursing homes" must not mint a
 * nursing major.
 */

import { DERIVED_FACT_FIELDS } from './profileDerivedFacts.js'

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/**
 * THE REGISTRY. One entry per specific vocational field an award can restrict
 * itself to and a profile can declare a major in. `patterns` are matched with
 * word boundaries against a single fragment at a time (never a join).
 *
 * Deliberately SPECIFIC and mutually distinct — two different entries firing on
 * the two sides is exactly the provable mismatch this gate exists to catch.
 * Broad umbrella words ("healthcare", "STEM", "business", "science") are NOT
 * here: they name a category, not a field, and cannot prove a conflict.
 */
export const FIELD_CLASSES = Object.freeze([
  Object.freeze({
    id: 'nursing',
    label: 'nursing',
    patterns: Object.freeze([/\bnursing\b/i, /\bnurse\b/i, /\bnurses\b/i, /\bbsn\b/i, /\brn\b/i, /\blpn\b/i]),
  }),
  Object.freeze({
    id: 'paramedic_ems',
    label: 'paramedicine / emergency medical services',
    patterns: Object.freeze([/\bparamedic\b/i, /\bparamedics\b/i, /\bparamedicine\b/i, /\bemergency\s+medical\b/i, /\bE\.?M\.?S\.?\b/, /\bE\.?M\.?T\.?\b/]),
  }),
  Object.freeze({
    id: 'medicine_physician',
    label: 'medicine (physician track)',
    patterns: Object.freeze([/\bmedical\s+school\b/i, /\bpre-?med\b/i, /\bpremedical\b/i, /\bphysician\b/i, /\bschool\s+of\s+medicine\b/i, /\bdoctor\s+of\s+medicine\b/i]),
  }),
  Object.freeze({
    id: 'dentistry',
    label: 'dentistry',
    patterns: Object.freeze([/\bdental\b/i, /\bdentistry\b/i, /\bdentist\b/i, /\bdental\s+hygiene\b/i]),
  }),
  Object.freeze({
    id: 'pharmacy',
    label: 'pharmacy',
    patterns: Object.freeze([/\bpharmacy\b/i, /\bpharmacist\b/i, /\bpharmaceutical\s+sciences?\b/i]),
  }),
  Object.freeze({
    id: 'veterinary',
    label: 'veterinary medicine',
    patterns: Object.freeze([/\bveterinary\b/i, /\bveterinarian\b/i]),
  }),
  Object.freeze({
    id: 'physical_therapy',
    label: 'physical therapy',
    patterns: Object.freeze([/\bphysical\s+therapy\b/i, /\bphysical\s+therapist\b/i]),
  }),
  Object.freeze({
    id: 'social_work',
    label: 'social work',
    patterns: Object.freeze([/\bsocial\s+work\b/i, /\bsocial\s+worker\b/i, /\bmsw\b/i]),
  }),
  Object.freeze({
    id: 'engineering',
    label: 'engineering',
    patterns: Object.freeze([/\bengineering\b/i, /\bengineer\b/i]),
  }),
  Object.freeze({
    id: 'computer_science',
    label: 'computer science / software',
    patterns: Object.freeze([/\bcomputer\s+science\b/i, /\bsoftware\s+(?:engineering|development)\b/i, /\bcomputer\s+programming\b/i]),
  }),
  Object.freeze({
    id: 'law',
    label: 'law',
    patterns: Object.freeze([/\blaw\s+school\b/i, /\blegal\s+studies\b/i, /\bjuris\s+doctor\b/i, /\bparalegal\b/i]),
  }),
  Object.freeze({
    id: 'accounting',
    label: 'accounting',
    patterns: Object.freeze([/\baccounting\b/i, /\baccountant\b/i, /\bc\.?p\.?a\.?\b/i]),
  }),
  Object.freeze({
    id: 'teaching_education',
    label: 'teaching / education',
    patterns: Object.freeze([/\bteaching\b/i, /\bteacher\b/i, /\belementary\s+education\b/i, /\bsecondary\s+education\b/i, /\beducation\s+major\b/i]),
  }),
  Object.freeze({
    id: 'culinary',
    label: 'culinary arts',
    patterns: Object.freeze([/\bculinary\b/i, /\bcookery\b/i]),
  }),
  Object.freeze({
    id: 'aviation',
    label: 'aviation',
    patterns: Object.freeze([/\baviation\b/i, /\baeronautics?\b/i, /\bpilot\s+training\b/i]),
  }),
  Object.freeze({
    id: 'cosmetology',
    label: 'cosmetology',
    patterns: Object.freeze([/\bcosmetology\b/i, /\bcosmetologist\b/i]),
  }),
])

/** The IDENTITY fields whose text the row publishes as its own name. */
export const IDENTITY_FIELDS = Object.freeze(['title', 'sponsor'])

/**
 * SQL LIKE superset for "this row's title/sponsor NAMES a specific vocational
 * field". Candidate discovery in the boot net must be a SQL predicate, never a
 * post-LIMIT JS filter (#944); the JS detector re-adjudicates. Every FIELD_CLASS
 * contributes at least one entry — asserted by the totality test.
 */
export const FIELD_DECLARATION_LIKE_PATTERNS = Object.freeze([
  '%nursing%', '%nurse%',
  '%paramedic%', '%emergency medical%',
  '%medical school%', '%pre-med%', '%premed%', '%physician%', '%school of medicine%',
  '%dental%', '%dentistry%', '%dentist%',
  '%pharmacy%', '%pharmacist%', '%pharmaceutical science%',
  '%veterinary%', '%veterinarian%',
  '%physical therapy%', '%physical therapist%',
  '%social work%',
  '%engineering%', '%engineer%',
  '%computer science%', '%software engineering%', '%software development%',
  '%law school%', '%legal studies%', '%juris doctor%', '%paralegal%',
  '%accounting%', '%accountant%',
  '%teaching%', '%teacher%', '%elementary education%', '%secondary education%',
  '%culinary%',
  '%aviation%', '%aeronautic%', '%pilot training%',
  '%cosmetology%', '%cosmetologist%',
])

/** A negation adjacent to a hit reverses it, on EITHER side (mirrors the stage gate). */
const NEGATION_WINDOW = 40
const NEGATION_BEFORE_RX = /\b(?:not|never|ineligible|excluding|excludes|excluded|except|other\s+than|non|no)\b[^.]{0,18}$/i
const NEGATION_AFTER_RX = /^[^.]{0,22}?\b(?:not|never|ineligible|excluded|may\s+not|are\s+not|is\s+not|cannot)\b/i

/**
 * Every FIELD_CLASS this text names (negation-aware), de-duplicated by class id.
 * Returns ALL distinct fields so a single fragment naming two ("Nursing and
 * Engineering Scholarship") can be recognised as ambiguous rather than
 * collapsing to whichever pattern happened to match first.
 */
function detectFieldsInText(text) {
  const s = String(text ?? '')
  if (!s.trim()) return []
  const hits = new Map()
  for (const cls of FIELD_CLASSES) {
    for (const rx of cls.patterns) {
      const m = rx.exec(s)
      if (!m) continue
      const before = s.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index)
      if (NEGATION_BEFORE_RX.test(before)) continue
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + NEGATION_WINDOW)
      if (NEGATION_AFTER_RX.test(after)) continue
      if (!hits.has(cls.id)) hits.set(cls.id, { id: cls.id, label: cls.label, phrase: m[0].trim() })
      break
    }
  }
  return [...hits.values()]
}

/** The single FIELD_CLASS this text names, or null when it names zero or 2+. */
function detectFieldInText(text) {
  const hits = detectFieldsInText(text)
  return hits.length === 1 ? hits[0] : null
}

/**
 * The single specific vocational field an opportunity RESTRICTS itself to, read
 * ONLY from its identity fields (title, sponsor). Returns null when the row
 * names no recognised field, or when its identity names TWO different fields
 * (an ambiguous "Nursing & Engineering Scholarship" is not a single restriction
 * and must not fire).
 *
 * @returns {{id:string,label:string,phrase:string,field:string}|null}
 */
export function detectRequiredField(opportunity = {}) {
  const o = opportunity || {}
  const fragments = [
    ['title', o.title],
    ['sponsor', o.sponsor ?? o.funder ?? o.organization],
  ]
  let found = null
  for (const [field, value] of fragments) {
    const hit = detectFieldInText(value)
    if (!hit) continue
    if (found && found.id !== hit.id) return null // ambiguous: two distinct fields named
    if (!found) found = { ...hit, field }
  }
  return found
}

/**
 * The specific vocational field(s) a profile DECLARES — structured majors only,
 * read through `DERIVED_FACT_FIELDS` (fact === 'field_of_study'), each mapped to
 * a FIELD_CLASS. `education.interests` is deliberately excluded: an interest is
 * not a declared course of study, and a paramedic INTERESTED in nursing is not
 * barred from a nursing award.
 *
 * @returns {Set<string>} FIELD_CLASS ids
 */
export function declaredProfileFields(sections = {}) {
  const s = sections && typeof sections === 'object' ? sections : {}
  const out = new Set()
  const MAJOR_FIELD_IDS = new Set(['education.intended_major', 'education.major', 'student_portal_plan.major'])
  for (const entry of DERIVED_FACT_FIELDS) {
    if (entry.fact !== 'field_of_study') continue
    if (!MAJOR_FIELD_IDS.has(entry.id)) continue
    let values = []
    try { values = entry.read(s) } catch { values = [] }
    for (const v of values) {
      const hit = detectFieldInText(v)
      if (hit) out.add(hit.id)
    }
  }
  return out
}

/**
 * fieldOfStudyConflict — the gate.
 *
 * @param {object} sections `{ section_key: parsedData }`
 * @param {object} opportunity the catalog/candidate row
 * @returns {null|{classId:string,label:string,phrase:string,field:string,reason:string}}
 *   null means THIS GATE HAS NOTHING TO SAY — never "eligible".
 */
export function fieldOfStudyConflict(sections, opportunity = {}) {
  const required = detectRequiredField(opportunity)
  if (!required) return null // silence on the award side
  const declared = declaredProfileFields(sections)
  if (declared.size === 0) return null // silence on the profile side
  if (declared.has(required.id)) return null // the profile studies exactly this field
  // The profile declares one or more specific fields, none of which is the
  // field this award restricts itself to → provable mismatch.
  const declaredLabels = [...declared]
    .map((id) => FIELD_CLASSES.find((c) => c.id === id)?.label ?? id)
    .join(', ')
  return {
    classId: required.id,
    label: required.label,
    phrase: required.phrase,
    field: required.field,
    reason:
      `Field of study: this award is for ${required.label} — its own ${required.field} says ` +
      `"${required.phrase}" — and the profile's declared major is ${declaredLabels}`,
  }
}

export default {
  FIELD_CLASSES,
  IDENTITY_FIELDS,
  FIELD_DECLARATION_LIKE_PATTERNS,
  detectRequiredField,
  declaredProfileFields,
  fieldOfStudyConflict,
}
