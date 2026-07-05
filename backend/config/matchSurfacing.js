/**
 * matchSurfacing.js — SINGLE SOURCE OF TRUTH for "what surfaces to a profile".
 *
 * GrantFlow's recurring recall bug: the rule for WHICH persisted matches are
 * shown to a profile was re-encoded independently in every read path
 * (matching.js, discovery.js, realCrawlers.js, fundingSources.js,
 * crawlerPlanService.js, crawlerOsCompatibility.js, hamiltonFundingSourcePolicy.js).
 * Those copies drifted into THREE different `matcher_version` allowlists:
 *   - `= 'crawler-os'`                              (dropped xmatch AND web-llm)
 *   - `IN ('crawler-os','crawler-os-xmatch')`       (dropped web-llm)
 *   - (the intended) crawler-os + xmatch + web-llm
 * The net effect: a profile's real, high-scoring `web-llm` scholarship matches
 * (e.g. Robert White's 80+ EMS scholarships) were persisted but NEVER read
 * back, so the pipeline looked nearly empty.
 *
 * Per the repo invariant rule ("a machine-checkable product rule must be
 * re-asserted in ONE place"), every read/surface path MUST import from here
 * instead of inlining a matcher_version list or a score-floor predicate.
 *
 * IMPORTANT: this governs READ/SURFACE paths only. The crawler-os RECONCILE
 * delete scope (crawlerOsPersistence.js) and the xmatch cleanup (robertAgent.js)
 * deliberately EXCLUDE 'web-llm' so web-discovered matches are never wiped by a
 * reconcile — do NOT wire this constant into those delete paths.
 */

import { REVIEW_SCORE } from './matchThresholds.js'

/**
 * Matcher versions that represent legitimate, profile-scoped matches meant to
 * be shown to the user:
 *   - crawler-os        : the primary Crawler OS discovery/matching authority
 *   - crawler-os-xmatch : cross-profile matches (Robert's cross-matching)
 *   - web-llm           : Brave/SearXNG + LLM web scholarship discovery,
 *                         persisted specifically to survive the OS reconcile
 */
export const SURFACED_MATCHER_VERSIONS = Object.freeze([
  'crawler-os',
  'crawler-os-xmatch',
  'web-llm',
])

/**
 * SQL fragment for `matcher_version IN (...)`. Built from the constant above —
 * all values are compile-time literals (no user input), so inlining is safe.
 * Use as:  `WHERE m.profile_id = ? AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}`
 */
export const SURFACED_MATCHER_VERSIONS_SQL = `(${SURFACED_MATCHER_VERSIONS.map((v) => `'${v}'`).join(',')})`

/**
 * Whether a scored row should be SHOWN to the profile, given the requested
 * display floor.
 *
 * A row surfaces when ANY of:
 *   1. It is a directory/referral scoring at least DIRECTORY_MIN_SCORE (or
 *      never scored) — mission rule: directories survive the display floor,
 *      BUT an engine score below the REVIEW band means the engine affirmatively
 *      judged it irrelevant to this profile (e.g. a federal student-aid
 *      directory scored 0 for a senior citizen). Those stay hidden.
 *   2. The engine's own decision is ACCEPT — an ACCEPT is only produced at
 *      score >= ACCEPT_SCORE (70) AND after every hard-eligibility / geo /
 *      population gate, and is downgraded to REVIEW when it lacks a URL, has a
 *      blank profile, or has incomplete eligibility. So an ACCEPT is a strong
 *      certification of a real, eligible, actionable match. Hiding the engine's
 *      OWN accepts behind a stricter *display* floor (75) was pure incoherence:
 *      core in-state awards (e.g. Anastasia White's HOPE Scholarship, TN
 *      Student Assistance Award — all ACCEPT at 72) were silently buried.
 *   3. Its score clears the requested display floor.
 *
 * This raises recall WITHOUT lowering the quality bar: REVIEW / weak matches
 * below the floor still do not surface here — only the engine-certified ACCEPTs.
 *
 * @param {{is_directory?: boolean, match_decision?: string, match_score?: number|string}} row
 * @param {number} minScore requested display floor
 * @returns {boolean}
 */
/**
 * Directories bypass the requested display floor but not the engine's own
 * REVIEW band: a scored directory below this is an affirmative "irrelevant to
 * this profile" judgment (e.g. student-aid directory scored 0 for a senior),
 * not a borderline match.
 */
export const DIRECTORY_MIN_SCORE = REVIEW_SCORE

export function qualifiesForDisplay(row, minScore) {
  if (!row) return false
  if (row.is_directory) {
    // Never-scored (null/blank) ≠ scored-irrelevant: Number(null) is 0, so an
    // unscored directory must be detected BEFORE numeric coercion or it would
    // be hidden as if the engine had judged it a zero.
    const raw = row.match_score
    if (raw === null || raw === undefined || raw === '') return true
    const dirScore = Number(raw)
    return !Number.isFinite(dirScore) || dirScore >= DIRECTORY_MIN_SCORE
  }
  if (String(row.match_decision || '').toUpperCase() === 'ACCEPT') return true
  const score = Number(row.match_score)
  return Number.isFinite(score) && score >= Number(minScore)
}

export default {
  SURFACED_MATCHER_VERSIONS,
  SURFACED_MATCHER_VERSIONS_SQL,
  DIRECTORY_MIN_SCORE,
  qualifiesForDisplay,
}
