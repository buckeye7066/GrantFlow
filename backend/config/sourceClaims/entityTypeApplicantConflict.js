/**
 * entityTypeApplicantConflict.js — SCOPE-AWARE entity-type conflict, the
 * entity-type twin of core.fieldOfStudyApplicantConflict (Stage-2 evidence
 * model; see core.js).
 *
 * An entity-type restriction ("nonprofit organizations", "institutions of higher
 * education") is only a hard bar when it names WHO MAY RECEIVE the award — the
 * STRUCTURED `entity_types_allowed` list. This comparator fires ONLY on an
 * APPLICANT-scoped entity_type claim, so an institutional word in the FUNDER's
 * name or in prose (which `applicantTypeGate`'s free-text patterns would have
 * hard-rejected on) no longer bars an individual/family/business/farm applicant.
 *
 * The bucket taxonomy is reused UNCHANGED from `applicantTypeGate`
 * (`resolveProfileBuckets`) and the profile type from `resolveEffectiveProfileType`
 * — this file forks no second applicant-type vocabulary. A conflict fires only on
 * a PROVABLE mismatch: the award's allowed set resolves to at least one bucket,
 * the profile resolves to at least one bucket, and they do not intersect. Silence
 * on either side is NEUTRAL.
 */

import emitEntityType from './emitEntityType.js'
import { APPLICANT_SCOPES } from './core.js'
import { resolveProfileBuckets } from '../../services/applicantTypeGate.js'
import { resolveEffectiveProfileType } from '../../services/profileHelpers.js'

/**
 * The applicant BUCKETS an award's structured allow-list resolves to (a subset
 * of individual|org|business|farm), reusing the same reader the gate uses on the
 * profile side so the two taxonomies can never drift.
 */
function awardAllowedBuckets(applicantClaims) {
  const tokens = applicantClaims.map((c) => c.value)
  try {
    return resolveProfileBuckets(tokens)
  } catch {
    return new Set()
  }
}

/**
 * entityTypeApplicantConflict — does the award's structured entity-type bar
 * exclude every applicant identity the profile can prove?
 *
 * @param {object} sections     the profile's sections map
 * @param {object} opportunity  the catalog/candidate row
 * @param {object} [deps]       { profile } — the profiles row (location fallbacks only)
 * @returns {null|{value,phrase,field,reason}}
 */
export function entityTypeApplicantConflict(sections, opportunity = {}, deps = {}) {
  let claims
  try { claims = emitEntityType(opportunity) } catch { return null }

  const applicant = (claims || []).filter(
    (c) => c && c.dimension === 'entity_type' && APPLICANT_SCOPES.includes(c.scope),
  )
  if (applicant.length === 0) return null // no structured entity-type bar → neutral

  const awardBuckets = awardAllowedBuckets(applicant)
  if (awardBuckets.size === 0) return null // unrecognised allow-list → neutral (never guess)

  const profile = deps.profile ?? sections?.profile ?? null
  let profileType
  try { profileType = resolveEffectiveProfileType(profile, sections ?? {}) } catch { return null }
  let profileBuckets
  try { profileBuckets = resolveProfileBuckets(profileType, { sections, profile }) } catch { return null }
  if (!profileBuckets || profileBuckets.size === 0) return null // profile type unknown → neutral

  // Any single profile identity the award serves carries the whole profile.
  for (const b of profileBuckets) {
    if (awardBuckets.has(b)) return null
  }

  const ev = applicant[0].evidence
  const served = [...awardBuckets].join('/')
  const holds = [...profileBuckets].join('/')
  return {
    value: served,
    phrase: ev.text,
    field: ev.field,
    reason:
      `Entity type: this award is restricted to ${served} applicants — its own ${ev.field} says `
      + `"${ev.text}" — and the profile is ${holds}`,
  }
}

export default entityTypeApplicantConflict
