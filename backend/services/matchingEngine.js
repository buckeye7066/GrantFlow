/**
 * DEPRECATED compatibility shim.
 *
 * New code MUST import from `backend/services/matchEngine.js` (canonical)
 * or `backend/services/matchDecisionEngine.js` (re-export shim) directly.
 *
 * This file exists only for:
 *   - Historical tests that pin the shim semantics
 *     (tests/unit/canonical-authority-sweep.test.mjs,
 *      tests/unit/scoring-consolidation.test.mjs,
 *      tests/unit/strict-matching-discovery.test.mjs)
 *   - Any long-lived external integration that imported
 *     `calculateMatchScore` before the canonical rename.
 *
 * Scoring is NON-AUTHORITATIVE: `calculateMatchScore` returns the raw
 * subscale + reasons from the canonical engine. It must never be used as an
 * acceptance or rejection gate. Only `computeMatchDecision` in
 * `matchEngine.js` is allowed to decide ACCEPT / REVIEW / REJECT.
 *
 * DO NOT add new exports, logic, or thresholds to this file. Any heuristic
 * that needs to live in one place belongs in `matchEngine.js`.
 *
 * Migration path:
 *   // Old:
 *   import { calculateMatchScore } from '.../backend/services/matchingEngine.js'
 *   const { score, reasons } = calculateMatchScore(profile, opp)
 *
 *   // New (non-authoritative ranking/prefilter):
 *   import { scoreOpportunity } from '.../backend/services/matchEngine.js'
 *   const { score, reasons } = scoreOpportunity(profile, opp)
 *
 *   // New (acceptance authority):
 *   import { computeMatchDecision } from '.../backend/services/matchEngine.js'
 *   const decision = computeMatchDecision(profile, opp)
 */

import { scoreOpportunity as _scoreOpportunity } from './matchEngine.js'

/**
 * @deprecated Use `scoreOpportunity` (non-authoritative) or
 * `computeMatchDecision` (authoritative) from
 * `backend/services/matchEngine.js`. This function is preserved only so that
 * older callers do not break; it is NOT an acceptance authority.
 *
 * @param {Object} profile - User/organization profile
 * @param {Object} opportunity - Funding opportunity
 * @returns {{ score: number, reasons: string[], match_explain: object }}
 */
export function calculateMatchScore(profile, opportunity) {
  return _scoreOpportunity(profile, opportunity)
}

export default {
  calculateMatchScore,
}
