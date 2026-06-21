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

// ── Confidence (orthogonal to MATCH score) ──────────────────────────────
//
// Architecture point #7: MATCH score answers "how well does this fit the
// profile?" (need/eligibility/geo/category weights above). CONFIDENCE answers
// a DIFFERENT question — "how sure are we this is real and actionable?" — and
// is computed from signals ORTHOGONAL to fit. A result can be a 92 MATCH but
// only a 55 CONFIDENCE when its source is weak or its eligibility text is
// incomplete. Confidence NEVER alters the match score; it is additive metadata.
//
// Confidence is a weighted average of four 0-100 component subscales:
//   sourceTrust   — official API / verified / directory / community / unknown
//   actionability — has a real, non-placeholder application/source URL
//   eligibility   — do we actually have eligibility text, or are we guessing
//   freshness     — rolling/ongoing or a future deadline vs unknown/expired
// The component weights below must sum to 1.0.

export const CONF_W_SOURCE = 0.35
export const CONF_W_ACTIONABILITY = 0.25
export const CONF_W_ELIGIBILITY = 0.20
export const CONF_W_FRESHNESS = 0.20

/** Source-trust tier → 0-100 confidence subscale (keys from opportunityTrust). */
export const CONFIDENCE_SOURCE_TRUST_SCORE = {
  official: 100,
  verified: 90,
  directory: 60,
  community: 40,
  unknown: 25,
}

/** Actionability subscale: real usable URL vs none. */
export const CONFIDENCE_ACTIONABLE_FULL = 100
export const CONFIDENCE_ACTIONABLE_NONE = 20

/** Eligibility-text completeness subscale. */
export const CONFIDENCE_ELIGIBILITY_FULL = 100   // rich, multi-bullet eligibility text
export const CONFIDENCE_ELIGIBILITY_PARTIAL = 65 // some eligibility signal present
export const CONFIDENCE_ELIGIBILITY_NONE = 35    // no eligibility info — we are guessing

/** Number of eligibility bullets at/above which eligibility text is "full". */
export const CONFIDENCE_ELIGIBILITY_FULL_BULLETS = 2

/** Freshness / deadline-validity subscale, keyed by normalized deadline status. */
export const CONFIDENCE_FRESHNESS_SCORE = {
  rolling: 100, // rolling / ongoing — always actionable
  open: 90,     // a real future deadline
  unknown: 50,  // no deadline info either way
  closed: 10,   // expired / past deadline
}

/** Confidence band cutoffs (inclusive lower bounds). */
export const CONFIDENCE_BAND_HIGH = 75
export const CONFIDENCE_BAND_MEDIUM = 50

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
