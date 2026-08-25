/**
 * aidTypeApplicantConflict.js — SCOPE-AWARE aid-type conflict, the aid-type twin
 * of core.fieldOfStudyApplicantConflict (Stage-2 evidence model; see core.js).
 *
 * An award whose classified aid type is one the profile has DECLINED
 * (`education.aid_types_accepted`) is a hard applicant conflict — a loan or
 * work-study for a household that accepts only grants/endowments/scholarships.
 * The profile's accepted set is read through the canonical
 * `resolveAcceptedAidTypes` (`aidTypePreferences.js`), whose "unset ⇒ everything
 * except debt" default is its own documented rule — so a profile that has stated
 * no preference still declines loans, matching the discovery reality gate.
 *
 * Silence is neutral: an award whose aid type is `unknown` emits no claim, and a
 * profile with no education section defaults to the standard accepted set.
 */

import emitAidType from './emitAidType.js'
import { APPLICANT_SCOPES } from './core.js'
import { resolveAcceptedAidTypes, AID_TYPES } from '../aidTypePreferences.js'

const LABEL = Object.fromEntries(AID_TYPES.map((t) => [t.key, t.label]))

/**
 * aidTypeApplicantConflict — does the award's classified aid type fall outside
 * the profile's accepted aid types?
 *
 * @param {object} sections     the profile's sections map (reads `education`)
 * @param {object} opportunity  the catalog/candidate row
 * @returns {null|{value,phrase,field,reason}}
 */
export function aidTypeApplicantConflict(sections, opportunity = {}) {
  let claims
  try { claims = emitAidType(opportunity) } catch { return null }
  const applicant = (claims || []).filter(
    (c) => c && c.dimension === 'aid_type' && APPLICANT_SCOPES.includes(c.scope),
  )
  if (applicant.length === 0) return null // aid type unknown → neutral

  const education = sections?.education ?? {}
  let accepted
  try { accepted = resolveAcceptedAidTypes(education) } catch { return null }
  const acceptedSet = new Set(accepted)

  for (const c of applicant) {
    if (!acceptedSet.has(c.value)) {
      return {
        value: c.value,
        phrase: c.evidence.text,
        field: c.evidence.field,
        reason:
          `Aid type: this award is a ${LABEL[c.value] ?? c.value} — its own ${c.evidence.field} says `
          + `"${c.evidence.text}" — and the profile accepts only ${accepted.map((k) => LABEL[k] ?? k).join(', ')}`,
      }
    }
  }
  return null
}

export default aidTypeApplicantConflict
