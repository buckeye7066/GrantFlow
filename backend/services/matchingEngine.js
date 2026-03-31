/**
 * matchingEngine.js — DEPRECATED SHIM
 *
 * All matching/scoring logic has been consolidated into matchEngine.js (v3.0.0).
 * This file exists solely for backward compatibility — do not add logic here.
 * Import from ./matchEngine.js directly for all new code.
 *
 * Callers expecting calculateMatchScore() get scoreOpportunity() under that name.
 */
export {
  scoreOpportunity as calculateMatchScore,
  matchOpportunities,
  makeDecision,
  computeMatchDecision,
  MATCHER_VERSION,
} from './matchEngine.js'
