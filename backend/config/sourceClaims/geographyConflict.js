/**
 * geographyConflict.js — the SCOPE-AWARE geography gate, the third dimension of
 * the source-claims evidence model (Stage-2; see core.js and emitJurisdiction.js).
 *
 * emitJurisdiction produces THREE geographic claim kinds and TWO of them are
 * applicant-exclusive — this is why geography is NOT a field/profession-style
 * single-scope drop-in:
 *
 *   • residency / applicant   — the row states a residency REQUIREMENT on the
 *     APPLICANT ("Ohio Residents Only"). An out-of-state applicant cannot
 *     RECEIVE it. Owned by `residencyApplicantConflict` (#1367).
 *   • jurisdiction / service_area — the award SERVES a place ("Polk County, TN —
 *     assistance"). A program that serves a specific place is PROVABLY exclusive
 *     to that place: an applicant outside the served state cannot receive it.
 *     This is DISTINCT from a residency requirement (the row never says the word
 *     "resident") but has the SAME reject effect for geography — a county
 *     directory is not a program that "may still be accessible" from another
 *     state, it is a locator for one county's agencies. `serviceAreaConflict`
 *     (new here) owns it.
 *   • jurisdiction / sponsor  — a foreign administering body. About the FUNDER,
 *     never an applicant residency bar. The existing foreign-jurisdiction gate in
 *     `matchEngine.makeDecision` (`detectForeignOpportunity`, ~line 3905) owns it
 *     and runs BEFORE this gate, so a foreign row is rejected there and never
 *     reaches here — this module deliberately IGNORES the sponsor claim so the
 *     two can never double-reject.
 *
 * The value is compared against the PROFILE's states exactly the way matchEngine
 * resolves them; the caller threads its already-resolved list in via
 * `deps.profileStates` so the reject side and the engine's own geo tier can never
 * disagree. A conflict fires ONLY on a PROVABLE mismatch: BOTH the row's declared
 * state AND the profile's states are non-empty and the row's state is not among
 * them. Silence on either side is NEUTRAL (the canonical "missing = neutral"
 * rule) — a stateless profile loses nothing, and a row that declares no place
 * (its bare `state` column is crawl provenance, NOT a claim it made about itself)
 * yields no claim and so no reject.
 *
 * Like emitJurisdiction, this module lives in config/ and must NOT import
 * services/matchEngine.js (the config↔services boot-crash cycle).
 */

import emitJurisdiction from './emitJurisdiction.js'
import { residencyApplicantConflict } from './residencyApplicantConflict.js'

/**
 * SCOPE-AWARE service-area conflict.
 *
 * Runs emitJurisdiction(opportunity), keeps ONLY the jurisdiction/service_area
 * claims (the row DECLARES the place it serves, in a "<Place>, ST —" title), and
 * returns a conflict when the served state is not among the profile's states.
 * residency/applicant claims are `residencyApplicantConflict`'s and
 * jurisdiction/sponsor (foreign) claims are the foreign gate's — both ignored
 * here.
 *
 * @param {object} sections  profile sections
 * @param {object} opportunity
 * @param {object} deps  { profileStates(sections) => string[] } — 2-letter uppercase
 * @returns {null|{state,servedState,phrase,field,scope,reason}}
 */
export function serviceAreaConflict(sections, opportunity = {}, deps = {}) {
  let claims
  try { claims = emitJurisdiction(opportunity) } catch { return null }
  const serviceArea = (claims || []).filter(
    (c) => c && c.dimension === 'jurisdiction' && c.scope === 'service_area',
  )
  if (serviceArea.length === 0) return null // no declared service area → neutral

  let profileStateList = []
  try {
    profileStateList = deps.profileStates ? deps.profileStates(sections) : []
  } catch { return null }
  const profileStates = new Set(
    (profileStateList || []).map((x) => String(x).toUpperCase()),
  )
  if (profileStates.size === 0) return null // profile declares no state → neutral

  for (const c of serviceArea) {
    const servedState = String(c.value).toUpperCase()
    if (!profileStates.has(servedState)) {
      return {
        state: servedState,
        servedState,
        phrase: c.evidence.text,
        field: c.evidence.field,
        scope: 'service_area',
        reason:
          `Service area: this award serves ${servedState} — its own ${c.evidence.field} says `
          + `"${c.evidence.text}" — and the profile's state is not ${servedState}`,
      }
    }
  }
  return null
}

/**
 * geographyConflict — the combined applicant-exclusive geography gate.
 *
 * Rejects on residency-applicant OR service_area mismatch. Returns the first
 * conflict found (residency is checked first because a stated residency bar
 * supersedes a mere service-area locator — emitJurisdiction only emits a
 * service_area claim when the row states NO residency requirement, so at most one
 * fires, but the order is defensive). The foreign/sponsor claim is deliberately
 * NOT acted on here — the existing foreign-jurisdiction gate owns it and runs
 * first, so this never double-rejects a foreign row.
 *
 * @param {object} sections  profile sections
 * @param {object} opportunity
 * @param {object} deps  { profileStates(sections) => string[] } — 2-letter uppercase
 * @returns {null|{scope,phrase,field,reason,...}}
 */
export function geographyConflict(sections, opportunity = {}, deps = {}) {
  const residency = residencyApplicantConflict(sections, opportunity, deps)
  if (residency) return { ...residency, scope: 'residency' }
  const service = serviceAreaConflict(sections, opportunity, deps)
  if (service) return service
  return null
}

/**
 * declaredApplicantStates — the states the row DECLARES about ITSELF in an
 * applicant-exclusive scope (residency/applicant + jurisdiction/service_area),
 * as an uppercase Set. This is the row's REAL, evidenced geography — NOT the bare
 * `state` column, which is crawl provenance.
 *
 * The engine uses it to rank: when the row declares a real geography that a
 * profile's state SATISFIES, the crawl-stamped column must not drag the row down
 * to a geographic REVIEW note. An empty Set means the row made no geographic
 * claim about itself, and the column is then a weak fallback only.
 *
 * @param {object} opportunity
 * @returns {Set<string>}  2-letter uppercase state codes
 */
export function declaredApplicantStates(opportunity = {}) {
  let claims
  try { claims = emitJurisdiction(opportunity) } catch { return new Set() }
  const out = new Set()
  for (const c of claims || []) {
    if (!c) continue
    const isResidencyApplicant = c.dimension === 'residency' && c.scope === 'applicant'
    const isServiceArea = c.dimension === 'jurisdiction' && c.scope === 'service_area'
    if (isResidencyApplicant || isServiceArea) out.add(String(c.value).toUpperCase())
  }
  return out
}

export default {
  serviceAreaConflict,
  geographyConflict,
  declaredApplicantStates,
}
