/**
 * individualAwardCeiling.js — the canonical "no person receives this much" bar.
 *
 * `enforceIndividualAmountCeiling()` (startup/enforceInvariants.js) has purged
 * above-ceiling rows from an INDIVIDUAL's *pipeline* since the "$3M in a person's
 * pipeline" class. It reaches `grants` only — the profile↔opportunity MATCH store
 * that feeds the owner-facing Funding Sources list was never held to the same bar,
 * so the same institutional money the pipeline refuses is displayed as a match.
 *
 * Prod 2026-08-01: 174 match rows across 28 of 39 profiles pair a person-type
 * profile with an award ceiling above this bar — NSF Oceanographic Facilities
 * ($47.5M), HUD PRO Housing ($10M), USDA AFRI ($10M), Title X ($22M), and the
 * HUD Fair Housing Initiatives Program ($1.25M) the owner reported.
 *
 * WHY AN AMOUNT AND NOT ELIGIBILITY TEXT: `applicantTypeGate` decides from
 * eligibility prose, and these rows carry none — FHIP in prod has
 * `eligibility_text NULL`, `eligibility_bullets []`, `entity_types_allowed []`.
 * A text gate can never reach them. The per-award ceiling is a structural fact
 * the row does publish, and an award an individual cannot physically receive is
 * institutional money regardless of what the page says about applicants.
 *
 * The value and its env override are deliberately IDENTICAL to the pipeline
 * sweep's, so one bar cannot drift into two. A static tripwire test asserts it
 * (backend/tests/individualAwardCeiling.test.js).
 */

/** Dollar ceiling above which an award cannot be an individual's. */
export const INDIVIDUAL_AWARD_CEILING_DEFAULT = 100000

/** Env override, shared verbatim with enforceIndividualAmountCeiling(). */
export const INDIVIDUAL_AWARD_CEILING_ENV = 'INDIVIDUAL_PIPELINE_AMOUNT_CEILING'

/** Resolve the ceiling at call time so ops/tests can tune it without a deploy. */
export function resolveIndividualAwardCeiling() {
  const v = Number.parseInt(process.env[INDIVIDUAL_AWARD_CEILING_ENV] || '', 10)
  return Number.isFinite(v) && v > 0 ? v : INDIVIDUAL_AWARD_CEILING_DEFAULT
}

/**
 * The largest per-award figure a row states, or null when it states none.
 * Silence is NOT a violation — a row with no amount is never judged by this bar.
 */
export function statedAwardCeiling(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') return null
  const candidates = [opportunity.amount_max, opportunity.amount_min]
  let best = null
  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue
    const n = Number(c)
    if (!Number.isFinite(n) || n <= 0) continue
    if (best === null || n > best) best = n
  }
  return best
}

/**
 * Does this opportunity's stated award exceed what a person can receive?
 * `false` whenever the row states no amount (silence is not a denial).
 */
export function exceedsIndividualAwardCeiling(opportunity, ceiling = resolveIndividualAwardCeiling()) {
  const stated = statedAwardCeiling(opportunity)
  return stated !== null && stated > ceiling
}

export default {
  INDIVIDUAL_AWARD_CEILING_DEFAULT,
  INDIVIDUAL_AWARD_CEILING_ENV,
  resolveIndividualAwardCeiling,
  statedAwardCeiling,
  exceedsIndividualAwardCeiling,
}
