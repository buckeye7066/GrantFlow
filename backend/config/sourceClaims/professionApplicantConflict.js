/**
 * professionApplicantConflict.js — SCOPE-AWARE profession conflict, the profession
 * twin of core.fieldOfStudyApplicantConflict (Stage-2 evidence model; see core.js).
 *
 * A profession word ("nursing", "dentistry") is only a hard eligibility bar when
 * it names WHO MAY RECEIVE the award ("Nurse Corps Scholarship", "Grant for
 * Licensed Nurses", "Master of Science in Nursing"). The SAME word is NOT a bar
 * when it is part of the FUNDER's identity ("American Dental Association
 * Foundation Grant", "National Nurses United Scholarship") — a professional
 * society funding students does not bar non-members. The scope carried by each
 * emitProfession claim is exactly this distinction, so this comparator fires only
 * on an APPLICANT-scoped claim.
 *
 * Both sides must be non-empty for a conflict: an award that names no profession,
 * or a profile that declares no recognised profession, yields silence (null) —
 * the same "both sides specific, no overlap" rule the field twin uses, and the
 * same conservative posture as assessProfessionEligibility (never reject on a
 * profile whose field is unknown).
 */

import emitProfession from './emitProfession.js'
import { APPLICANT_SCOPES } from './core.js'
import {
  resolveProfileProfessions,
  professionSignalTextFromSections,
} from '../../services/eligibility/professionEligibility.js'

/**
 * professionApplicantConflict — does the award make an APPLICANT-scoped
 * profession claim whose value is NOT among the profile's declared professions?
 *
 * @param {object} sections     the profile's sections (curated identity fields)
 * @param {object} opportunity  the catalog/candidate row (title, sponsor, funder, organization)
 * @returns {null|{profession,value,phrase,field,reason}}
 */
export function professionApplicantConflict(sections, opportunity = {}) {
  let claims
  try { claims = emitProfession(opportunity) } catch { return null }

  const applicant = (claims || []).filter(
    (c) => c && c.dimension === 'profession' && APPLICANT_SCOPES.includes(c.scope),
  )
  if (applicant.length === 0) return null // no applicant-scoped profession claim → neutral

  const professions = resolveProfileProfessions(professionSignalTextFromSections(sections))
  if (!professions || professions.size === 0) return null // profile declares no profession → neutral

  const declared = new Set([...professions].map((p) => String(p).toLowerCase()))
  for (const c of applicant) {
    if (!declared.has(String(c.value).toLowerCase())) {
      return {
        profession: c.value,
        value: c.value,
        phrase: c.evidence.text,
        field: c.evidence.field,
        reason:
          `Profession: this award is restricted to ${c.value} — its own ${c.evidence.field} says `
          + `"${c.evidence.text}" — and the profile's declared profession does not include it`,
      }
    }
  }
  return null
}

export default professionApplicantConflict
