/**
 * Match Decision Engine — Single Source of Truth
 *
 * Historically this module carried its own copy of the match/decision logic.
 * That drifted from matchEngine.js (different MATCHER_VERSION and scoring).
 * Callers now get the exact same functions matchEngine exports.
 */

export {
  normalizeProfile,
  computeProfileFingerprint,
  normalizeOpportunity,
  computeOpportunityFingerprint,
  MATCHER_VERSION,
  calculateSourceTrust,
  evaluateEligibility,
  calculateNeedAlignment,
  computeMatchDecision,
  scoreOpportunity,
  matchOpportunities,
  makeDecision,
} from './matchEngine.js'
