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
// calibrated (prod, re-measured 2026-07-31: p50=6, p75=13, p90=17, p95=23,
// max=85 over 5,706 non-synthetic scored matches — see backend calibration
// block; the previous fit was p50=8, p90=15, max=47).
export const AUTO_ADD_SCORE = 8
export const STRONG_MATCH_SCORE = 17
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
// Re-calibrated 2026-07-31 against 5,706 non-synthetic scored prod matches.
// Only `excellent` moved. Measured share at each bar BEFORE the remap:
//   >=8  42.4%   >=11 28.6%   >=14 15.4%   >=17 11.8%
// `excellent` claimed to be "top ~10%" while labelling 15.4% of matches —
// roughly one in six read "Excellent Match". 17 restores the documented
// intent at 11.8%. `good` (28.6% vs "top ~quarter") is within tolerance AND
// equals ACCEPT_SCORE, and `fair` is the PIPELINE BAR, not a percentile —
// dropping it to the measured p50 of 6 would label rows that never cleared
// admission, so both stay put. Per the calibration doctrine: re-run
// backend/scripts/score-distribution.mjs and re-map; never hand-tune one bar.
export const MATCH_DISPLAY_TIERS = Object.freeze({
  excellent: 17, // top ~10% of real matches (measured 11.8%)
  good: 11,      // top ~quarter (measured 28.6%) — also ACCEPT_SCORE
  fair: 8,       // pipeline-bar coverage (structural, not a percentile)
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
 * Canonical display TIER key for a score ('excellent' | 'good' | 'fair' |
 * 'potential' | 'low'). Components that color-code score badges must key their
 * palette off this tier instead of hardcoding numeric cutoffs — the old-scale
 * inline `>= 75 / >= 50 / >= 25` color ladders went stale when the scale moved.
 */
export function scoreToMatchTier(score) {
  const s = Number(score)
  if (!Number.isFinite(s)) return 'low'
  if (s >= MATCH_DISPLAY_TIERS.excellent) return 'excellent'
  if (s >= MATCH_DISPLAY_TIERS.good) return 'good'
  if (s >= MATCH_DISPLAY_TIERS.fair) return 'fair'
  if (s >= MATCH_DISPLAY_TIERS.potential) return 'potential'
  return 'low'
}

/**
 * Render a persisted canonical match outcome without running a second
 * eligibility or admission trial in the browser. A numeric score is only a
 * display tier after the backend decision is known. Missing/unknown decisions
 * remain visibly unrated instead of being promoted from their score alone.
 */
export function canonicalMatchDisplay({ score, decision } = {}) {
  const normalizedDecision = String(decision || '').trim().toUpperCase()
  const hasScore = score !== null && score !== undefined && score !== ''
    && Number.isFinite(Number(score))
  const numericScore = hasScore ? Number(score) : null

  if (normalizedDecision === 'REJECT') {
    return { label: 'Not eligible', tier: 'rejected', decision: 'REJECT', score: numericScore }
  }
  if (normalizedDecision === 'REVIEW') {
    return { label: 'Needs review', tier: 'review', decision: 'REVIEW', score: numericScore }
  }
  if (normalizedDecision !== 'ACCEPT' || numericScore === null) {
    return {
      label: 'Unrated',
      tier: 'unrated',
      decision: normalizedDecision || null,
      score: numericScore,
    }
  }
  return {
    label: scoreToMatchLabel(numericScore),
    tier: scoreToMatchTier(numericScore),
    decision: 'ACCEPT',
    score: numericScore,
  }
}

// ── Minimum-match-score slider (data-point scale) ────────────────────────
//
// Track upper bound for every "Minimum match score" control. 30 sits above
// the prod p99 (23); the right end renders as "30+" meaning "only the very
// best". The retired 0–100 track (with 25/50/75/85 stops) is DEAD on this
// scale — a slider at 85 could never return anything (max real score ≈ 58).
export const MIN_SCORE_SLIDER_MAX = 30

/** Shared helper copy under every min-score slider. */
export const MIN_SCORE_SLIDER_HELP =
  'The score is the share of everything in this profile the source matches — real matches mostly land between 5 and 25.'

/**
 * Band segments for the slider guidance band, driven by the canonical
 * thresholds above so the next recalibration moves the slider automatically.
 */
export const MIN_SCORE_GUIDANCE_ZONES = Object.freeze([
  { min: 0, max: MODERATE_MATCH_SCORE, label: 'Broad matches', hint: 'Wide net' },
  { min: MODERATE_MATCH_SCORE, max: GOOD_MATCH_SCORE, label: 'Good matches', hint: 'Worth a look' },
  { min: GOOD_MATCH_SCORE, max: STRONG_MATCH_SCORE, label: 'Strong matches', hint: 'Solid fit' },
  { min: STRONG_MATCH_SCORE, max: MIN_SCORE_SLIDER_MAX, label: 'Best matches', hint: 'Closest fit' },
])

/** Band label for a slider value ("Score ≥ 14 · Best matches" chips). */
export function minScoreBandLabel(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return MIN_SCORE_GUIDANCE_ZONES[0].label
  for (let i = MIN_SCORE_GUIDANCE_ZONES.length - 1; i >= 0; i--) {
    if (v >= MIN_SCORE_GUIDANCE_ZONES[i].min) return MIN_SCORE_GUIDANCE_ZONES[i].label
  }
  return MIN_SCORE_GUIDANCE_ZONES[0].label
}

/**
 * One-time migration for persisted OLD-SCALE minimum-score preferences
 * (need-anchored 0–100 values, e.g. the owner's stuck "85"). Any stored value
 * above MIN_SCORE_SLIDER_MAX cannot be a data-point-scale choice — translate
 * it to the equivalent band instead of letting it starve results forever:
 *   ≥75 (old strong/best) → STRONG_MATCH_SCORE (14)
 *   31–74 (old good/broad-ish) → GOOD_MATCH_SCORE (11)
 * Values ≤ 30 pass through untouched (already on the live scale). Mirrors
 * translateLegacyMinScore in backend/config/matchThresholds.js.
 */
export function translateLegacyMinScore(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return v
  if (v <= MIN_SCORE_SLIDER_MAX) return v
  if (v >= 75) return STRONG_MATCH_SCORE
  return GOOD_MATCH_SCORE
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
