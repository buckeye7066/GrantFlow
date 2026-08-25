/**
 * residencyApplicantConflict.js — the SCOPE-AWARE residency conflict, the
 * geography twin of core.fieldOfStudyApplicantConflict.
 *
 * emitJurisdiction (the geography/residency emitter) produces THREE geographic
 * claim kinds and only ONE of them is an applicant bar:
 *
 *   • residency / applicant   — the row states a residency REQUIREMENT on the
 *     APPLICANT ("Ohio Residents Only"). This is the only geographic claim that
 *     can hard-reject a profile, and the only one this gate acts on.
 *   • jurisdiction / service_area — the award SERVES a place ("Polk County, TN —
 *     assistance") but states no applicant residency bar. A soft geo signal;
 *     NOT an applicant reject. The existing geo tier in matchEngine (~line 4260)
 *     owns it, and this gate deliberately ignores it.
 *   • jurisdiction / sponsor  — a foreign administering body. About the FUNDER;
 *     the foreign-jurisdiction gate owns it and stays as-is. Ignored here.
 *
 * The value is compared against the PROFILE's states, resolved exactly the way
 * matchEngine does (signals.location.state + signals.states). A conflict fires
 * only on a PROVABLE mismatch: BOTH the required state and the profile's states
 * are non-empty and the required state is not among them. Silence on either
 * side is NEUTRAL (the canonical "missing = neutral" rule).
 *
 * Like emitJurisdiction, this module lives in config/ and must NOT import
 * services/matchEngine.js: matchEngine imports config/, so importing it back
 * here would close a config↔services cycle (the ESM import-time boot-crash
 * class). The convenience resolver therefore reads the profile's states from
 * buildProfileSignals directly, mirroring matchEngine.profileStates.
 */

import emitJurisdiction from './emitJurisdiction.js'
import { buildProfileSignals } from '../../services/profileHelpers.js'
import { normalizeState } from '../../utils/stateNormalization.js'

/**
 * The profile's states as 2-letter uppercase codes, resolved the SAME way
 * matchEngine.profileStates does: signals.location.state (primary) followed by
 * signals.states, each normalized and deduped. Empty array ⇒ no known state
 * (the caller treats empty as NEUTRAL, never a penalty).
 *
 * @param {object} sections  profile sections
 * @returns {string[]} normalized 2-letter state codes, primary first, deduped
 */
export function profileStatesFromSections(sections = {}) {
  const s = sections && typeof sections === 'object' ? sections : {}
  let signals
  try {
    signals = buildProfileSignals({ profile: s.profile || {}, sections: s })
  } catch {
    return []
  }
  const out = []
  const add = (v) => {
    const norm = normalizeState(v)
    if (norm && !out.includes(norm)) out.push(norm)
  }
  const primary = signals?.location?.state ?? null
  if (primary) add(primary)
  if (Array.isArray(signals?.states)) {
    for (const st of signals.states) add(st)
  }
  return out
}

/**
 * SCOPE-AWARE residency conflict.
 *
 * Runs emitJurisdiction(opportunity), keeps ONLY the residency/applicant claims
 * (an explicit applicant residency requirement), and returns a conflict when the
 * required state is not among the profile's states. service_area and
 * sponsor/foreign claims are out of scope for this slice and are never acted on.
 *
 * @param {object} sections  profile sections
 * @param {object} opportunity
 * @param {object} deps  { profileStates(sections) => string[] } — 2-letter uppercase
 * @returns {null|{state,requiredState,phrase,field,reason}}
 */
export function residencyApplicantConflict(sections, opportunity = {}, deps = {}) {
  let claims
  try { claims = emitJurisdiction(opportunity) } catch { return null }
  const applicant = (claims || []).filter(
    (c) => c && c.dimension === 'residency' && c.scope === 'applicant',
  )
  if (applicant.length === 0) return null // no applicant residency requirement → neutral

  let profileStateList = []
  try {
    profileStateList = deps.profileStates ? deps.profileStates(sections) : []
  } catch { return null }
  const profileStates = new Set(
    (profileStateList || []).map((x) => String(x).toUpperCase()),
  )
  if (profileStates.size === 0) return null // profile declares no state → neutral

  for (const c of applicant) {
    const requiredState = String(c.value).toUpperCase()
    if (!profileStates.has(requiredState)) {
      return {
        state: requiredState,
        requiredState,
        phrase: c.evidence.text,
        field: c.evidence.field,
        reason:
          `Residency: this award requires ${requiredState} residency — its own ${c.evidence.field} says `
          + `"${c.evidence.text}" — and the profile's state is not ${requiredState}`,
      }
    }
  }
  return null
}

/**
 * Convenience wrapper that resolves the profile's states itself (the SAME way
 * matchEngine does), so a caller need not thread deps.
 *
 * @param {object} sections  profile sections
 * @param {object} opportunity
 * @returns {null|{state,requiredState,phrase,field,reason}}
 */
export function residencyApplicantConflictFromSections(sections, opportunity = {}) {
  return residencyApplicantConflict(sections, opportunity, {
    profileStates: profileStatesFromSections,
  })
}

export default {
  residencyApplicantConflict,
  residencyApplicantConflictFromSections,
  profileStatesFromSections,
}
