/**
 * Legacy scoring engine — delegates to the canonical matchEngine.js (v4).
 * Preserved for backward compatibility with existing importers.
 * @param {Object} profile - User/organization profile
 * @param {Object} opportunity - Funding opportunity
 * @returns {Object} { score: number (0-100), reasons: string[], match_explain: object }
 */
export function calculateMatchScore(profile, opportunity) {
  return _scoreOpportunity(profile, opportunity)
}

import { scoreOpportunity as _scoreOpportunity } from './matchEngine.js'


export default {
  calculateMatchScore
}
