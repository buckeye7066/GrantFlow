/**
 * stageOfLifeEligibility.js — the ACADEMIC-STAGE eligibility gate.
 *
 * THE DEFECT, measured read-only in prod 2026-08-02 on Demo Tennessee STEM Student
 * (`c4a92724-…`, a 17-year-old dual-enrolled HIGH-SCHOOL SENIOR in TN whose
 * derived stage is `dual_enrolled_incoming_freshman`):
 *
 *   The recall key that finally reaches her state's flagship award (TN HOPE)
 *   — in-state + a student-aid title + the aid taxonomy — also hands her
 *
 *     "Vanderbilt School of Medicine Merit Scholarship"          ACCEPT 84
 *     "Osher Reentry Scholarship" (nontraditional students)      ACCEPT 84
 *     "International Student Doctor of Chiropractic Scholarship" ACCEPT 81
 *     "Tennessee HOPE Scholarship - Nontraditional"              ACCEPT 84
 *     "UAB Blazer Graduate Research Fellowship"                  ACCEPT 40
 *
 *   and the engine ACCEPTS every one. The engine had no notion that a
 *   high-school senior cannot receive a graduate/professional award or an
 *   adult-reentry award. That is not a recall problem — no recall key can be
 *   made safe while the decision layer will endorse a medical-school
 *   scholarship for a seventeen-year-old.
 *
 * THE RULE. Reject ONLY when the opportunity DECLARES, in words its own source
 * published, a stage requirement the profile's DERIVED stage provably cannot
 * meet. Three things follow from that sentence and each is load-bearing:
 *
 *   1. SILENCE IS NEVER A DENIAL. An award that says nothing about academic
 *      stage is untouched. This is the same rule that stops `not_listed` from
 *      becoming `none_published` and stops a re-crawl clearing an amount it
 *      knows nothing about. Prod evidence for why it matters here: of the rows
 *      this gate was measured against, `eligibility_text` and
 *      `eligibility_bullets` are EMPTY on 100% of them — the ONLY stage
 *      statement lives in the title, the sponsor, or the extracted summary.
 *      A gate that treated absence as a bar would reject nearly the whole
 *      catalog.
 *
 *   2. THE GATE REFUSES; IT NEVER ASSERTS. There is no "this profile CAN have
 *      this award" verdict here. `stageOfLifeConflict` returns a conflict or
 *      null, and null means "this gate has nothing to say", never "eligible".
 *
 *   3. ONLY PROVABLE IMPOSSIBILITY. `STAGE_REQUIREMENT_CLASSES[].barredStages`
 *      lists only stages that structurally cannot occupy the declared one. A
 *      high-school senior has no bachelor's degree, so a graduate/professional
 *      program is closed to her, and she has no interrupted post-secondary
 *      career, so a reentry award is closed to her. An UNDERGRADUATE is NOT
 *      barred from a graduate award (a graduating senior applying to grad
 *      school is a real applicant) and is NOT barred from reentry (a returning
 *      adult IS an undergraduate) — those are deliberately left alone. Only the
 *      postdoctoral class bars undergraduates, because nobody holds a doctorate
 *      without first holding a bachelor's.
 *
 * FRAGMENTS ARE TESTED SEPARATELY (#1086). `[title, sponsor, ...bullets].join(' ')`
 * makes the boundary between two independent values indistinguishable from the
 * space inside a real phrase, which is exactly how `family` + `caregiver`
 * fabricated "family caregiver" and cost two owner-verified profiles their ECF
 * CHOICES coverage. Every fragment here is matched on its own, so the only
 * phrases that can fire are ones a single field actually contains.
 *
 * NEGATION IS A REVERSAL, NOT A DECLARATION. "open to undergraduates; graduate
 * students are not eligible" declares the OPPOSITE of what the bare pattern
 * says. A hit whose preceding window carries a negation marker is discarded.
 * (Measured: 2 active prod rows carry such a phrase — small, but a gate that
 * inverts its own evidence is not a gate.)
 *
 * THE STAGE ITSELF IS NEVER RE-DERIVED HERE. `deriveStageOfLife`
 * (`profileDerivedFacts.js`, shipped in #1091) is the single owner of the
 * profile-side taxonomy; this module consumes its output and would break
 * loudly rather than silently if a new stage were added — see
 * `stageOfLifeEligibility.test.js`'s totality test, which asserts every value
 * `deriveStageOfLife` can return is classified by `STAGE_KNOWN` here.
 */

import { deriveStageOfLife } from './profileDerivedFacts.js'
import {
  deriveWebsitePurpose,
  websitePurposeConflict,
} from './profileWebsitePurpose.js'

/**
 * Every stage `deriveStageOfLife` can return. Totality-tested against that
 * function's own literals so a new stage cannot silently fall through this gate
 * as "unknown ⇒ never barred" without somebody deciding that on purpose.
 */
export const STAGE_KNOWN = Object.freeze([
  'high_school_student',
  'dual_enrolled_incoming_freshman',
  'undergraduate',
  'graduate_student',
  'unclassified',
])

/** Human labels for the derived stages, for reason text only. */
export const STAGE_LABELS = Object.freeze({
  high_school_student: 'a high-school student',
  dual_enrolled_incoming_freshman: 'a dual-enrolled high-school student entering college',
  undergraduate: 'an undergraduate',
  graduate_student: 'a graduate student',
  unclassified: 'of an unstated academic stage',
})

/** Stages that are pre-baccalaureate by construction. */
const PRE_BACCALAUREATE = Object.freeze(['high_school_student', 'dual_enrolled_incoming_freshman'])

/**
 * The stages that make a profile a STUDENT for lane-selection purposes.
 * `unclassified` is deliberately absent — it means the profile said something
 * this taxonomy could not read, which is not a declaration of studenthood.
 */
export const STUDENT_STAGES = Object.freeze([
  'high_school_student',
  'dual_enrolled_incoming_freshman',
  'undergraduate',
  'graduate_student',
])

export function isStudentStage(stage) {
  return STUDENT_STAGES.includes(String(stage ?? ''))
}

/**
 * Need categories a crawler SOURCE declares when it serves student aid.
 *
 * Used by `crawler-os/planner.js` to rank a declared student stage's own lanes
 * ahead of lanes admitted only by a generic need token. Bare `education` is
 * INCLUDED here but is never sufficient on its own — the planner also requires
 * the source to serve `student` applicants — because `education` is what a
 * church, a homeschool fund and a workforce board also declare (the same
 * over-breadth `matchEngine.isStudentAidOpportunity` documents), while the
 * federal aid portal `studentaid_gov` declares `education` and nothing else.
 * `laneSelectionRanking.test.js` asserts every entry is declared by at least one
 * registry source, so this cannot drift into a set that selects nothing.
 */
export const STUDENT_AID_NEED_CATEGORIES = Object.freeze([
  'scholarship', 'tuition', 'fafsa', 'pell', 'education',
])

/**
 * THE REGISTRY. One entry per class of academic stage an opportunity can
 * DECLARE about its audience.
 *
 * `patterns` — matched against ONE fragment at a time (never a join).
 * `inclusionGuard` — a phrase in the SAME fragment that proves the audience is
 *   NOT exclusive to this class, so the hit declares nothing. Measured against
 *   prod 2026-08-02, this is what separates a real bar from a list: Federal
 *   Work-Study's page says "part-time jobs for UNDERGRADUATE AND GRADUATE
 *   students", and without this guard the gate refused a 100-scoring, entirely
 *   correct award to a high-school senior on the strength of the word that
 *   INCLUDED her. Same for NSF's "REU Site: Undergraduate Research Experiences
 *   … graduate research ambassadors" and StudentScholarships.org's "high
 *   school, undergraduate, and graduate students".
 * `barredStages` — profile stages that provably cannot occupy this class.
 *   Anything not listed is untouched: this list is an allow-list of denials.
 */
export const STAGE_REQUIREMENT_CLASSES = Object.freeze([
  Object.freeze({
    id: 'graduate_or_professional',
    label: 'graduate or professional school',
    // `\bgraduate\b` deliberately does NOT match "graduates" — prod's real
    // "eligible Tennessee high school graduates and some adult students"
    // (the TSAC HOPE row) must stay untouched.
    patterns: Object.freeze([
      /\bgraduate\s+(?:students?|studies|school|fellowships?|research|degrees?|programs?|level|candidates?|scholars?|assistantships?)\b/i,
      /\bgraduate\s+and\s+professional\b/i,
      /\bpost-?graduate\b/i,
      /\bdoctoral\b/i,
      /\bdoctorate\b/i,
      /\bph\.?\s?d\.?\b/i,
      /\bdoctor\s+of\s+[a-z]+/i,
      /\bmaster'?s?\s+(?:degrees?|programs?|students?|candidates?|level|thesis)\b/i,
      // `MBA` bare is the Mortgage Bankers Association in this catalog
      // ("MBA Opens Doors Grant") — the degree sense needs its own noun.
      /\bm\.?b\.?a\.?\s+(?:students?|candidates?|programs?|degrees?)\b/i,
      /\bresident\s+physicians?\b/i,
    ]),
    // Matched ONLY against the row's own IDENTITY fields (title, sponsor). A
    // professional school named inside DESCRIPTION prose is overwhelmingly the
    // AWARDEE — NIH abstracts read "Awardee: JOHNS HOPKINS UNIVERSITY SCHOOL OF
    // MEDICINE" — which says nothing about who may apply. As a sponsor
    // ("Vanderbilt University, School of Medicine") it names the audience.
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
    // Dual enrollment is BEING IN HIGH SCHOOL while taking college classes —
    // an enrolled undergraduate or graduate student structurally cannot be one
    // (2026-08-03: "Cleveland State Foundation Dual Enrollment Scholarships"
    // surfaced ACCEPT 53 to Demo College Student Persona, a full-time enrolled college
    // student, through the institution-attendance recall net — the engine had
    // no notion that a dual-enrollment award's audience excludes him).
    // `high_school_student` and `dual_enrolled_incoming_freshman` are the
    // audience and stay untouched; `unclassified` stays neutral as always.
    patterns: Object.freeze([
      /\bdual[\s-]enroll(?:ment|ed)\b/i,
      /\bdually[\s-]enrolled\b/i,
    ]),
    // "for dual enrollment AND current college students" proves the audience
    // is not exclusive. `college\s+students?` requires the noun — "earn
    // college credit", the phrase every dual-enrollment page contains, must
    // NOT trip the guard.
    inclusionGuard: /\b(?:current(?:ly)?[\s-]enrolled\s+college|college\s+students?|undergraduates?|graduate\s+students?|all\s+students?)\b/i,
    barredStages: Object.freeze(['undergraduate', 'graduate_student']),
  }),
  Object.freeze({
    id: 'adult_reentry',
    label: 'adult / returning-student reentry',
    // The reentry vocabulary must sit next to a STUDENT-AID word. Bare
    // `reentry` is the CRIMINAL-JUSTICE sense across most of this catalog
    // ("Reentry Employment Opportunities Program", "Second Chance Act
    // Improving Reentry Education"), and bare `nontraditional` is a wildlife
    // term ("Cooperative Endangered Species Conservation Fund: HCP Land
    // Acquisition (Nontraditional Section 6)"). Refusing a 17-year-old a
    // habitat-conservation grant for being too young to be a returning adult
    // reaches the right answer through a false statement, which is worse than
    // no gate. "adult student" ALONE is likewise absent: the TSAC HOPE row
    // says "…high school graduates AND SOME ADULT STUDENTS" — an INCLUSION.
    patterns: Object.freeze([
      // NOT `reentry grants/awards` — "National Reentry Resource Center …
      // Reentry grants" is the CRIMINAL-JUSTICE sense, and so is most of this
      // catalog's `reentry` vocabulary.
      /\bre-?entry\s+(?:students?|scholars?|scholarships?)\b/i,
      /\b(?:adult|student|non-?traditional)\s+re-?entry\b/i,
      /\bnon-?traditional\s+(?:students?|age|learners?|undergraduates?|scholars?|applicants?)\b/i,
      /\b(?:scholarships?|awards?|grants?)\s+for\s+non-?traditional\b/i,
      /\breturning\s+adults?\b/i,
      /\badult\s+learners?\b/i,
      /\badults?\s+returning\b/i,
      /\breturning\s+to\s+(?:college|school|education)\b/i,
      // "Tennessee residents aged 25+ or RE-ENROLLING AFTER a two-year gap"
      // (the second, nationwide TSAC HOPE-Nontraditional row). Bare
      // "re-enrolling" is routine registrar vocabulary; "after" is what makes
      // it a statement about an interrupted career.
      /\bre-?enroll(?:ing|ment|ed)?\s+after\b/i,
    ]),
    inclusionGuard: /\b(?:high\s+school\s+(?:seniors?|students?|graduates?)|incoming\s+freshm[ae]n|graduating\s+seniors?|traditional\s+and\s+non-?traditional)\b/i,
    barredStages: Object.freeze([...PRE_BACCALAUREATE]),
  }),
])

/**
 * SQL LIKE superset for "this row DECLARES an academic stage somewhere".
 *
 * Candidate discovery must be a SQL PREDICATE, never a post-`LIMIT` JS filter
 * (#944). Every pattern above contributes at least one entry here, and
 * `stageOfLifeEligibility.test.js` asserts that totality mechanically — a new
 * class whose vocabulary has no covering LIKE would be invisible to the boot
 * sweep while the per-call gate kept working, which is exactly the kind of
 * half-enforced rule this repo's invariant doctrine exists to prevent.
 * Coarse by design: `detectDeclaredStageRequirement` is the adjudicator.
 */
export const STAGE_DECLARATION_LIKE_PATTERNS = Object.freeze([
  '%graduate%',       // graduate students/school/…, postgraduate, post-graduate
  '%doctor%',         // doctoral, doctorate, doctor of X
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

/**
 * A negation marker adjacent to a hit reverses its meaning, and English puts it
 * on EITHER side: "excluding graduate students" and "graduate students are not
 * eligible" say the same thing about the same award. Both windows are short on
 * purpose — a "not" three sentences away says nothing about this phrase — and
 * neither crosses a sentence boundary.
 */
const NEGATION_WINDOW = 44
const NEGATION_BEFORE_RX = /\b(?:not|never|ineligible|excluding|excludes|excluded|except|other\s+than|rather\s+than|neither|nor|no)\b[^.]{0,20}$/i
const NEGATION_AFTER_RX = /^[^.]{0,24}?\b(?:not|never|ineligible|excluded|may\s+not|are\s+not|is\s+not|cannot)\b/i

/** The row's own IDENTITY fields — a name it publishes for itself. */
export const IDENTITY_FIELDS = Object.freeze(['title', 'sponsor'])

/** Fields whose text the SOURCE itself published about this opportunity. */
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

/**
 * Does this opportunity DECLARE a stage-of-life requirement, and in which of
 * its own fields?
 *
 * @returns {{declared:boolean, classId:string|null, label:string|null, phrase:string|null, field:string|null}}
 */
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

/**
 * stageOfLifeConflict — the gate.
 *
 * @param {string|null} stage a value from `deriveStageOfLife` (`.value`)
 * @param {object} opportunity the catalog/candidate row
 * @returns {null|{classId:string,label:string,phrase:string,field:string,reason:string}}
 *   null means THIS GATE HAS NOTHING TO SAY — never "eligible".
 */
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
 * Convenience for callers that hold SECTIONS rather than a resolved stage.
 * Derives through the canonical `deriveStageOfLife` — never a second taxonomy.
 *
 * Also applies website-purpose conflicts (owner 2026-08-20): the profile URL
 * states what the org IS (Axiom BioLabs → CAR-T / transplant), so opportunities
 * locked to unrelated purposes (Title X, CACFP, …) REJECT here — the same
 * hard-stop shape matchEngine already consumes via this function. Missing
 * website / missing purpose remains neutral.
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
