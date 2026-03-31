/**
 * matchDecisionEngine.js — DEPRECATED SHIM
 *
 * All matching logic has been consolidated into matchEngine.js (v3.0.0).
 * This file exists solely for backward compatibility — do not add logic here.
 * Import from ./matchEngine.js directly for all new code.
 */
export {
  MATCHER_VERSION,
  scoreOpportunity,
  matchOpportunities,
  makeDecision,
  computeMatchDecision,
  normalizeProfile,
  computeProfileFingerprint,
  normalizeOpportunity,
  computeOpportunityFingerprint,
  calculateSourceTrust,
  evaluateEligibility,
  calculateNeedAlignment,
} from './matchEngine.js'
