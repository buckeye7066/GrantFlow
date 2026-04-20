/**
 * DEPRECATED compatibility shim.
 *
 * Historical home of `calculateMatchScore(opportunity, profile)` and a handful
 * of crawler-side profile helpers. The scoring path was consolidated into
 * `backend/services/matchEngine.js` (canonical authority). This module is
 * preserved so that legacy verification scripts, long-lived operational
 * tools, and external integrations that still import from this exact path
 * continue to work across logins, machines, and deployments WITHOUT silent
 * breakage (tests: tests/unit/legacy-module-resilience.test.mjs).
 *
 * Rules for this file:
 *   • Scoring is NON-AUTHORITATIVE. `calculateMatchScore` delegates to
 *     canonical `scoreOpportunity` and must never be used as an ACCEPT /
 *     REJECT gate — only `computeMatchDecision` in `matchEngine.js` is.
 *   • Do not add new exports, new heuristics, or new thresholds here.
 *   • The `(opportunity, profile)` argument order is intentional: it matches
 *     the historical public signature so pinned callers do not need to change.
 *
 * If you are writing new code: import from `matchEngine.js` directly instead.
 */

import { scoreOpportunity as _canonicalScoreOpportunity } from '../matchEngine.js'

/**
 * @deprecated Use `scoreOpportunity(profile, opportunity)` from
 * `backend/services/matchEngine.js` directly. This wrapper exists only for
 * legacy callers pinned to the historical `(opportunity, profile)` order.
 *
 * @param {Object} opportunity - Raw funding opportunity row
 * @param {Object} profile - Profile (optionally with a `signals` bag attached)
 * @returns {{ score: number, reasons: string[], matchedSignals: string[] }}
 */
export function calculateMatchScore(opportunity, profile) {
  // Canonical scorer uses (profile, opportunity) order — adapt.
  const result = _canonicalScoreOpportunity(profile || {}, opportunity || {})

  // Historical shape included `matchedSignals` built from profile keyword hits.
  // The canonical scorer does not emit this field, so we reconstruct it here
  // for legacy observers that depend on it (e.g. drift-comparison scripts).
  const matchedSignals = []
  const signals = profile && typeof profile === 'object' ? profile.signals : null
  const keywordSet =
    signals && signals.keywordSet instanceof Set
      ? signals.keywordSet
      : Array.isArray(signals?.keywords)
        ? new Set(signals.keywords.map((k) => String(k).toLowerCase()))
        : new Set()

  const oppText = [opportunity?.title, opportunity?.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  for (const kw of keywordSet) {
    const needle = String(kw).toLowerCase()
    if (needle && oppText.includes(needle)) matchedSignals.push(`kw:${kw}`)
  }

  return {
    score: Number(result?.score) || 0,
    reasons: Array.isArray(result?.reasons) ? result.reasons : [],
    matchedSignals,
  }
}

export default {
  calculateMatchScore,
}
