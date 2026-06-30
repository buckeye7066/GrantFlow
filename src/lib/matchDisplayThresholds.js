/**
 * Frontend match display thresholds.
 *
 * These MUST stay in sync with backend/config/matchThresholds.js.
 * Do not hardcode score cutoffs in components — import from here.
 */

// Aligned to the 75 quality bar (owner directive 2026-06-23) — keep in sync
// with backend/config/matchThresholds.js.
export const AUTO_ADD_SCORE = 75
export const STRONG_MATCH_SCORE = 85
export const GOOD_MATCH_SCORE = 75
export const MODERATE_MATCH_SCORE = 40
export const SCORE_FLOOR = 5

/**
 * Map a numeric score to a display label.
 */
export function scoreToLabel(score) {
  if (score >= STRONG_MATCH_SCORE) return 'Strong'
  if (score >= GOOD_MATCH_SCORE) return 'Good'
  if (score >= MODERATE_MATCH_SCORE) return 'Moderate'
  return 'Weak'
}

/**
 * Canonical "<Tier> Match" label used on grant cards, the grant detail header,
 * the AI Match Score card, and the profile matcher. These were four divergent
 * copies (e.g. 59% read "Good Match" on the detail card but "Fair Match" in the
 * header) — this is the single source so the same score always reads the same
 * label everywhere. Tiers are display-only and intentionally finer-grained than
 * the matching/auto-add thresholds above.
 */
export const MATCH_DISPLAY_TIERS = Object.freeze({
  excellent: 80,
  good: 65,
  fair: 50,
  potential: 35,
})

export function scoreToMatchLabel(score) {
  const s = Number(score)
  if (!Number.isFinite(s)) return 'Low Match'
  if (s >= MATCH_DISPLAY_TIERS.excellent) return 'Excellent Match'
  if (s >= MATCH_DISPLAY_TIERS.good) return 'Good Match'
  if (s >= MATCH_DISPLAY_TIERS.fair) return 'Fair Match'
  if (s >= MATCH_DISPLAY_TIERS.potential) return 'Potential Match'
  return 'Low Match'
}

/**
 * Check if a URL is renderable (not a placeholder).
 * Single source for frontend URL validation — mirrors backend urlRules.js.
 */
const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'example.net', 'placeholder.com', 'placeholder']

export function isRenderableUrl(url) {
  if (!url || typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  const lower = trimmed.toLowerCase()
  return !PLACEHOLDER_HOSTS.some((h) => lower.includes(h))
}
