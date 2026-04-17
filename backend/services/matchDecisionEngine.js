/**
 * Match Decision Engine — Single Source of Truth
 *
 * Historically this module carried its own copy of the match/decision logic.
 * That drifted from matchEngine.js (different MATCHER_VERSION, subtly different
 * scoring) and caused the anti-drift tests to fail. Callers now get the exact
 * same functions matchEngine exports, so there is exactly ONE implementation.
 *
 * Re-exports everything the previous file shipped plus scoreOpportunity, which
 * callers migrating off the old API can now use.
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
