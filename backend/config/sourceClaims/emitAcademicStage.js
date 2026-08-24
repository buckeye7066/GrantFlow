/**
 * emitAcademicStage.js — the `academic_stage` CLAIM emitter (Stage-2 evidence model).
 *
 * An academic-stage phrase ("graduate students", "postdoctoral", "dual
 * enrollment", "adult reentry") is only a hard eligibility bar when it names WHO
 * MAY RECEIVE the award. The very same words describe an AWARDEE / institution
 * when they sit in a school's name — an NIH abstract's "Awardee: JOHNS HOPKINS
 * UNIVERSITY SCHOOL OF MEDICINE" or a sponsor "Vanderbilt University, School of
 * Medicine" says nothing about who may apply, yet the highest-value existing gate
 * (`stageOfLifeEligibility`) treats a sponsor "School of Medicine" as an audience
 * bar. This emitter makes that gate SCOPE-AWARE.
 *
 * The stage VOCABULARY (the VALUE) is REUSED wholesale from
 * `stageOfLifeEligibility.js` — `STAGE_REQUIREMENT_CLASSES` /
 * `detectDeclaredStageRequirement`, which already carry the `inclusionGuard`
 * (a list "…undergraduate AND graduate students" is not exclusive) and the
 * negation windows ("graduate students are NOT eligible") that separate a real
 * bar from a list. This file forks no second stage taxonomy; it only adds the
 * scope heuristic:
 *
 *   - applicant   → an audience bar stated by a stage `pattern`
 *                   ("Scholarship for graduate students", "postdoctoral
 *                    fellowship"). This is the only scope that can hard-reject.
 *   - institution → the phrase is an INSTITUTION NAME (`identityPatterns`:
 *                   "School of Medicine", "medical school") sitting in the row's
 *                   own identity fields. It names the SCHOOL/awardee, never an
 *                   applicant trait — so it can never hard-reject.
 *
 * The profile side (`deriveStageOfLife`) stays in `stageOfLifeEligibility.js`;
 * the conflict comparator lives in `academicStageApplicantConflict.js`.
 */

import { makeClaim } from './core.js'
import {
  STAGE_REQUIREMENT_CLASSES,
  detectDeclaredStageRequirement,
} from '../stageOfLifeEligibility.js'

const DIMENSION = 'academic_stage'

/**
 * emitAcademicStage — the academic-stage claim an opportunity makes about itself.
 *
 * At most ONE claim: `detectDeclaredStageRequirement` returns the first declared
 * stage across the row's own fields, already inclusion/negation-guarded. The
 * scope is decided from the phrase that matched — an `identityPatterns` hit
 * (a school name) is INSTITUTION scope; every other stage pattern is an
 * APPLICANT audience bar.
 *
 * @param {object} opportunity  the catalog/candidate row (title, sponsor, eligibility_*)
 * @returns {import('./core.js').Claim[]}
 */
export default function emitAcademicStage(opportunity = {}) {
  const o = opportunity && typeof opportunity === 'object' ? opportunity : {}
  const declared = detectDeclaredStageRequirement(o)
  if (!declared.declared) return []

  const cls = STAGE_REQUIREMENT_CLASSES.find((c) => c.id === declared.classId)
  if (!cls) return []

  // A phrase that matches one of the class's INSTITUTION-name patterns
  // ("School of Medicine") names a school/awardee, not the applicant. This is
  // the awardee-vs-audience distinction the scoped model exists to make: it is
  // NEVER an applicant bar.
  const isInstitutionName = Array.isArray(cls.identityPatterns)
    && cls.identityPatterns.some((rx) => new RegExp(rx.source, rx.flags).test(declared.phrase))

  const scope = isInstitutionName ? 'institution' : 'applicant'
  const strength = isInstitutionName ? 'detected' : 'explicit'

  const claim = makeClaim({
    dimension: DIMENSION,
    value: declared.classId,
    scope,
    strength,
    evidence: { field: declared.field, text: declared.phrase },
  })
  return claim ? [claim] : []
}
