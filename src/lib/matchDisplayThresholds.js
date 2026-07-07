/**
 * Frontend match display thresholds.
 *
 * These MUST stay in sync with backend/config/matchThresholds.js.
 * Do not hardcode score cutoffs in components — import from here.
 */

// DATA-POINT SCALE (owner directive 2026-07-06 evening) — keep in sync with
// backend/config/matchThresholds.js. The score is the share of the profile's
// ENTIRE data-point inventory the source matches, gated by eligibility and
// geography ("88 data points, source matches 44 → 50"). Real profiles carry
// 50–150 data points, so absolute scores run low: bands are empirically
// calibrated (prod p50=8, p90=15, max=47 — see backend calibration block).
export const AUTO_ADD_SCORE = 8
export const STRONG_MATCH_SCORE = 14
export const GOOD_MATCH_SCORE = 11
export const MODERATE_MATCH_SCORE = 7
export const SCORE_FLOOR = 2

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
  excellent: 14, // top ~10% of real matches (old 75)
  good: 11,      // top ~quarter (old 50)
  fair: 8,       // pipeline-bar coverage (old 25)
  potential: 7,  // partial coverage worth a look (old 15)
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
