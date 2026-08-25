/**
 * academicStageApplicantConflict.js — SCOPE-AWARE academic-stage conflict, the
 * academic-stage twin of core.fieldOfStudyApplicantConflict (Stage-2 evidence
 * model; see core.js).
 *
 * The highest-value existing eligibility gate is `stageOfLifeConflict` — it stops
 * a high-school senior from being handed a graduate/professional or adult-reentry
 * award. This comparator makes that gate SCOPE-AWARE: it fires only on an
 * APPLICANT-scoped academic-stage claim, so a "School of Medicine" SPONSOR (an
 * awardee/institution name) no longer counts as an audience bar. The stage VALUE
 * and the profile-side stage taxonomy are BOTH reused unchanged
 * (`STAGE_REQUIREMENT_CLASSES.barredStages` + `deriveStageOfLife`); this file
 * only adds the scope filter.
 *
 * REFUSES; NEVER ASSERTS. Silence on either side is neutral: a row that declares
 * no applicant stage bar, an `unclassified`/absent profile stage, or a stage the
 * class does not bar all yield null — exactly the `stageOfLifeConflict` posture.
 */

import emitAcademicStage from './emitAcademicStage.js'
import { APPLICANT_SCOPES } from './core.js'
import { STAGE_REQUIREMENT_CLASSES, STAGE_LABELS } from '../stageOfLifeEligibility.js'
import { deriveStageOfLife } from '../profileDerivedFacts.js'

/**
 * academicStageApplicantConflict — does the award make an APPLICANT-scoped
 * academic-stage claim whose class the profile's DERIVED stage provably cannot
 * occupy?
 *
 * @param {object} sections     the profile's sections map
 * @param {object} opportunity  the catalog/candidate row
 * @returns {null|{classId,value,phrase,field,reason}}
 */
export function academicStageApplicantConflict(sections, opportunity = {}) {
  let claims
  try { claims = emitAcademicStage(opportunity) } catch { return null }

  const applicant = (claims || []).filter(
    (c) => c && c.dimension === 'academic_stage' && APPLICANT_SCOPES.includes(c.scope),
  )
  if (applicant.length === 0) return null // no applicant stage bar → neutral

  let stage
  try { stage = deriveStageOfLife(sections ?? {})?.value ?? null } catch { return null }
  const s = String(stage ?? '').trim()
  if (!s || s === 'unclassified') return null // profile stage silent/unreadable → neutral

  for (const c of applicant) {
    const cls = STAGE_REQUIREMENT_CLASSES.find((k) => k.id === c.value)
    if (cls && cls.barredStages.includes(s)) {
      return {
        classId: cls.id,
        value: cls.id,
        phrase: c.evidence.text,
        field: c.evidence.field,
        reason:
          `Academic stage: this award is for ${cls.label} — its own ${c.evidence.field} says `
          + `"${c.evidence.text}" — and the profile is ${STAGE_LABELS[s] ?? s}`,
      }
    }
  }
  return null
}

export default academicStageApplicantConflict
