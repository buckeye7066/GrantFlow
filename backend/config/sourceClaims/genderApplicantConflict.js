/**
 * genderApplicantConflict.js — SCOPE-AWARE gender conflict, the gender twin of
 * core.fieldOfStudyApplicantConflict (Stage-2 evidence model; see core.js).
 *
 * A gender-exclusive award ("women only" / "men only") hard-rejects a profile
 * whose KNOWN gender does not match, and is NEUTRAL when the profile's gender is
 * unknown — exactly the `matchEngine` posture (`requiresWomen`/`requiresGender`
 * reject only on a KNOWN mismatch; missing gender is a REVIEW field). Because the
 * detection phrases are inherently applicant bars, every `emitGender` claim is
 * applicant-scoped; this comparator adds only the profile-side read.
 *
 * The profile gender is read the SAME way `profileNormalizer`/`matchEngine`
 * resolve it — `basic_information.gender` then `demographics.gender`, classified
 * by `profileGenderIsFemale`'s female/male word rule — so no second gender
 * taxonomy is forked.
 */

import emitGender from './emitGender.js'
import { APPLICANT_SCOPES } from './core.js'

/**
 * The profile's gender as 'female' | 'male' | null, resolved the SAME way
 * profileNormalizer does: `basic_information.gender` (primary) then
 * `demographics.gender`, each accepting an `answers` wrapper.
 */
export function profileGenderFromSections(sections = {}) {
  const s = sections && typeof sections === 'object' ? sections : {}
  const read = (section) => {
    if (!section || typeof section !== 'object') return null
    const a = section.answers ?? section
    return typeof a?.gender === 'string' ? a.gender.toLowerCase() : null
  }
  const g = read(s.basic_information) || read(s.demographics)
  if (!g) return null
  if (/\bfemale\b|\bwoman\b|\bwomen\b|\bgirl\b/.test(g)) return 'female'
  if (/\bmale\b|\bman\b|\bmen\b|\bboy\b/.test(g)) return 'male'
  return null
}

/**
 * genderApplicantConflict — does the award make an APPLICANT-scoped gender claim
 * the profile's KNOWN gender provably cannot meet?
 *
 * @param {object} sections     the profile's sections map
 * @param {object} opportunity  the catalog/candidate row
 * @returns {null|{value,phrase,field,reason}}
 */
export function genderApplicantConflict(sections, opportunity = {}) {
  let claims
  try { claims = emitGender(opportunity) } catch { return null }
  const applicant = (claims || []).filter(
    (c) => c && c.dimension === 'gender' && APPLICANT_SCOPES.includes(c.scope),
  )
  if (applicant.length === 0) return null // no gender bar → neutral

  const profileGender = profileGenderFromSections(sections ?? {})
  if (!profileGender) return null // gender unknown → neutral (never reject)

  for (const c of applicant) {
    if (c.value !== profileGender) {
      const label = c.value === 'female' ? 'women/female' : 'men/male'
      return {
        value: c.value,
        phrase: c.evidence.text,
        field: c.evidence.field,
        reason:
          `Gender: this award is restricted to ${label} applicants — its own ${c.evidence.field} says `
          + `"${c.evidence.text}" — and the profile's gender is ${profileGender}`,
      }
    }
  }
  return null
}

export default genderApplicantConflict
