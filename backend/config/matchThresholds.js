/**
 * Centralized match scoring thresholds.
 *
 * ALL match/score threshold constants live here. Any file that uses a
 * numeric score cutoff for matching, filtering, or display MUST import
 * from this module. Inline magic numbers are forbidden.
 *
 * Anti-drift rule: if you need a new threshold, add it here with a
 * descriptive name — do not hardcode it in a route or component.
 */

// ── Scoring ─────────────────────────────────────────────────────────────

/** Minimum score any validated opportunity can receive (floor guarantee) */
export const SCORE_FLOOR = 5

/** Weighted component weights (must sum to 1.0) */
export const W_NEED = 0.35
export const W_ELIGIBILITY = 0.25
export const W_GEO = 0.20
export const W_CATEGORY = 0.20

// ── Discovery / Comprehensive Match ─────────────────────────────────────

/** Default minimum score for discovery results */
export const DEFAULT_MIN_SCORE = 50

/**
 * Number of matched profile needs that earns FULL need-alignment credit.
 * The need subscale is `min(1, needHits / min(needTotal, NEED_FULL_CREDIT_HITS))`,
 * so a profile that lists many needs is not penalized: a funder realistically
 * addresses a few of a person's needs, and matching this many strongly is a
 * complete need match. Raising this makes scoring stricter (harder to reach the
 * 80% slider); lowering it makes strong matches surface more readily.
 */
export const NEED_FULL_CREDIT_HITS = 4

/** Progressive relaxation steps when results are too few.
 *  Tried in order; first to yield results wins. */
export const RELAX_THRESHOLDS = [30, 15, 0]

/** When all thresholds exhausted, return top N by score */
export const FALLBACK_TOP_N = 20

// ── Decision Engine ─────────────────────────────────────────────────────

/** Score above which an opportunity is auto-accepted (ACCEPT decision) */
export const ACCEPT_SCORE = 70

/** Score above which an opportunity enters review (REVIEW decision) */
export const REVIEW_SCORE = 35

/** Minimum score for ACCEPT in the structured decision pipeline */
export const DECISION_ACCEPT_MIN = 40

/** Minimum confidence for ACCEPT in the structured decision pipeline */
export const DECISION_CONFIDENCE_MIN = 50

// ── Admin / Seeding ─────────────────────────────────────────────────────

/** Minimum score for admin seed-to-pipeline operations */
export const ADMIN_SEED_MIN_SCORE = 45

// ── Frontend Display (sync with src/lib/matchDisplayThresholds.js) ──────

/** Score at which results are auto-added to pipeline */
export const AUTO_ADD_SCORE = 70

/** Strong match bucket threshold */
export const STRONG_MATCH_SCORE = 85

/** Good match bucket threshold */
export const GOOD_MATCH_SCORE = 70

/** Moderate match bucket threshold */
export const MODERATE_MATCH_SCORE = 40
