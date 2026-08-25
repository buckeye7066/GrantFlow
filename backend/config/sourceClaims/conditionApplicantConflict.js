/**
 * conditionApplicantConflict.js — SCOPE-AWARE condition conflict, the condition
 * twin of core.fieldOfStudyApplicantConflict (Stage-2 evidence model; see core.js).
 *
 * A disease-specific award that requires a NAMED condition the profile provably
 * does not have is an applicant conflict. This comparator keeps the delicate
 * alignment/neutrality semantics of `conditionSpecificity.js` exactly:
 *
 *   - The profile's NAMED conditions are read through the canonical
 *     `namedProfileConditions` (which drops generic descriptors and negated
 *     prose — "No confirmed medical conditions" names nothing), fed from
 *     `buildProfileSignals().health_conditions` (the diagnosis-provenance set),
 *     so no second condition taxonomy is forked.
 *   - A profile that names NO condition — a bare "Has disability" flag, or no
 *     health signal at all — is NEUTRAL toward a disease-specific award. This is
 *     the `unnamed`/`none` case of `conditionSpecificAlignment`, never a reject.
 *   - Only when the profile names ≥1 condition and the award's own condition
 *     matches NONE of them is there a PROVABLE mismatch → conflict. Alignment is
 *     decided by the SAME `opportunityStatesCondition` matcher the alignment
 *     helper uses (token-boundary, generic-word-dropped), so the two can never
 *     drift.
 */

import emitCondition from './emitCondition.js'
import { APPLICANT_SCOPES } from './core.js'
import { namedProfileConditions, opportunityStatesCondition } from '../conditionSpecificity.js'
import { buildProfileSignals } from '../../services/profileHelpers.js'

/**
 * conditionApplicantConflict — does a disease-specific award require a condition
 * the profile's NAMED conditions provably do not include?
 *
 * @param {object} sections     the profile's sections map
 * @param {object} opportunity  the catalog/candidate row
 * @returns {null|{value,phrase,field,reason}}
 */
export function conditionApplicantConflict(sections, opportunity = {}) {
  let claims
  try { claims = emitCondition(opportunity) } catch { return null }
  const applicant = (claims || []).filter(
    (c) => c && c.dimension === 'condition' && APPLICANT_SCOPES.includes(c.scope),
  )
  if (applicant.length === 0) return null // not disease-specific / no concrete condition → neutral

  let signals
  try {
    signals = buildProfileSignals({ profile: sections?.profile || {}, sections: sections ?? {} })
  } catch { return null }
  const named = namedProfileConditions(null, signals)
  if (!named || named.length === 0) return null // profile names no condition → NEUTRAL (unnamed/none)

  // ALIGNMENT: does the award's own condition state one of the profile's named
  // conditions? Reuses the alignment matcher so the semantics cannot drift.
  const awardConditionText = applicant.map((c) => c.value).join(' ')
  if (opportunityStatesCondition(awardConditionText, named)) return null // aligned → keep

  // The profile names conditions, NONE of which this disease-specific award
  // requires → a provable mismatch.
  const c = applicant[0]
  return {
    value: c.value,
    phrase: c.evidence.text,
    field: c.evidence.field,
    reason:
      `Condition: this award is specific to ${c.value} — its own ${c.evidence.field} says `
      + `"${c.evidence.text}" — and the profile's named condition(s) (${named.join(', ')}) do not include it`,
  }
}

export default conditionApplicantConflict
