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

/**
 * Hard floor for the discovery bar. The documented product standard (owner
 * directive 2026-06-23) is 75, and the code MUST NOT surface matches below it.
 * This is the lowest value DEFAULT_MIN_SCORE can ever take, regardless of env.
 */
export const DISCOVERY_MIN_SCORE_FLOOR = 75

/**
 * Default minimum score for discovery results — the "slider" default.
 * Owner directive (2026-06-23): the bar for what surfaces in a profile's
 * pipeline/discovery view is 75. Anything below is NOT junk — it stays in the
 * master funding_opportunities catalog (deduped) so it can match another
 * profile later — it just doesn't clutter THIS profile's pipeline.
 *
 * Configurable via GRANTFLOW_DISCOVERY_MIN_SCORE, but CLAMPED to
 * [DISCOVERY_MIN_SCORE_FLOOR, 100] — an owner may TIGHTEN the bar (e.g. 85) but
 * can never drop it below the documented 75. Prefer gaining breadth from the
 * discovery lanes/queries over loosening this.
 *
 * NOTE (2026-07-01): the legacy `ANYA_MATCH_THRESHOLD` env var (env.example /
 * docs said "80") is NOT read anywhere in the code — it is inert. The single
 * source of truth for the discovery bar is THIS constant. The effective prod bar
 * has therefore always been 75, not 80.
 */
function resolveDefaultMinScore() {
  const raw = Number(process.env.GRANTFLOW_DISCOVERY_MIN_SCORE)
  if (Number.isFinite(raw)) return Math.max(DISCOVERY_MIN_SCORE_FLOOR, Math.min(100, raw))
  return DISCOVERY_MIN_SCORE_FLOOR
}
export const DEFAULT_MIN_SCORE = resolveDefaultMinScore()

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

// ── User-behavior learning (SOFT preference signals — architecture #12) ──
//
// When a user SAVES / APPLIES-TO / DISMISSES-REJECTS opportunities, those
// actions nudge future matching toward what they value. This is SOFT
// preference learning, NOT hard filtering: it can only add/subtract a small,
// clamped number of points AFTER the weighted score, and it NEVER eliminates a
// match or changes a score when there is no behavior data (zero-default).
//
// The whole feature is gated behind BEHAVIOR_LEARNING_ENABLED (see
// behaviorLearning.js → isBehaviorLearningEnabled()); when off, the preference
// vector is empty and the nudge is exactly 0 for every opportunity.
//
// Bounds below are intentionally tiny so a user's history can only tip a
// borderline match, never override the substantive need/eligibility/geo/category
// model. Each individual signal is clamped to ±BEHAVIOR_SIGNAL_MAX, and the SUM
// of all applied nudges for one opportunity is clamped to ±BEHAVIOR_NUDGE_MAX.

/** Per-signal clamp: a single category/need/source/locality nudge in points. */
export const BEHAVIOR_SIGNAL_MAX = 4

/** Total per-opportunity nudge clamp (sum of all signals), in points. */
export const BEHAVIOR_NUDGE_MAX = 8

/**
 * Points contributed per positive interaction (save/apply) and per negative
 * interaction (dismiss/ignore) BEFORE recency decay + clamping. Apply is
 * weighted more strongly than a save because it is a stronger intent signal.
 */
export const BEHAVIOR_WEIGHT_APPLIED = 2.0
export const BEHAVIOR_WEIGHT_SAVED = 1.0
export const BEHAVIOR_WEIGHT_DISMISSED = -1.5
export const BEHAVIOR_WEIGHT_IGNORED = -0.75

/** Recency: events older than this many days are dropped from the aggregate. */
export const BEHAVIOR_RECENCY_WINDOW_DAYS = 180

/** Half-life (days) for the exponential recency decay applied to each event. */
export const BEHAVIOR_DECAY_HALF_LIFE_DAYS = 45

/** Max number of recent events aggregated per profile (bounds the read). */
export const BEHAVIOR_MAX_EVENTS = 500

// ── Post-weight signal boosts (applied AFTER the weighted component score) ──
//
// These were previously scattered as inline magic numbers inside
// scoreOpportunity()'s "housing-aware signal bonuses" block — the most
// impactful knobs in the engine, yet the only ones NOT centralized here. They
// are intentionally SOFT and bounded: each can lift a borderline match over a
// threshold, but the substance of the score is the weighted
// need/eligibility/geo/category model above (W_NEED/W_ELIGIBILITY/W_GEO/
// W_CATEGORY). Values are unchanged from the historical inline literals — this
// block centralizes them so they can be reviewed and re-tuned in one place.
//
// Stacking note (max realistic post-weight swing): the boosts are largely
// mutually exclusive by profile type. The largest student stack is roughly
// GPA_BOOST_HIGH(12)+HOPE_SCHOLARSHIP_BOOST(15)+MAJOR_INTEREST_STACK_MAX(20)+
// TN_GEO_BOOST(8)+HOUSING_USABLE_BOOST(10); the largest org/individual stack is
// roughly NEED_GEO_FIT_MAX(24)+POPULATION_MISSION_BOOST_MAX(8)+
// WORKFORCE_BOOST_MAX(8)+FAITH_MATCH_BOOST(10). Everything is clamped to 0-100
// at the end, so no stack can exceed the score ceiling.

/** Profile-depth multiplier: richest profiles get up to +DEPTH_BONUS_MAX_PCT. */
export const DEPTH_BONUS_MAX_PCT = 0.10
/** Divisor mapping depth (0-100) → fractional bonus (depth/DIVISOR, capped). */
export const DEPTH_BONUS_DIVISOR = 1000

/** Ceiling for a non-student profile matched against a student-aid opportunity. */
export const STUDENT_AID_NONSTUDENT_CAP = 40

/**
 * Ceiling for a profile with NO senior/aging/caregiving signal matched against
 * a senior-services program (Area Agency on Aging, eldercare locators, Meals on
 * Wheels). Mirrors STUDENT_AID_NONSTUDENT_CAP: population mismatches reduce
 * score rather than hard-reject (canonical G4), but an 18-year-old student must
 * not see eldercare directories ACCEPT at 75.
 */
export const SENIOR_PROGRAM_MISMATCH_CAP = 40

/** Workforce / pro-bono service-term alignment boost (per term hit, and cap). */
export const WORKFORCE_BOOST_PER_HIT = 3
export const WORKFORCE_BOOST_MAX = 8

/** GPA merit boosts for scholarship/merit opportunities, by GPA tier. */
export const GPA_BOOST_HIGH = 12   // GPA ≥ 3.75
export const GPA_BOOST_MID = 8     // GPA ≥ 3.50
export const GPA_BOOST_LOW = 5     // GPA ≥ 3.00
/** Extra boost when a GPA≥3.0 student profile matches a TN HOPE scholarship. */
export const HOPE_SCHOLARSHIP_BOOST = 15

/** Major / STEM / interest boosts for student × scholarship opportunities. */
export const MAJOR_MATCH_BOOST = 12
export const STEM_SCHOLARSHIP_BOOST = 10
export const STEM_PLATFORM_BOOST = 6
export const INTEREST_BOOST_PER_HIT = 4
export const INTEREST_BOOST_MAX = 8
export const SCHOLARSHIP_PLATFORM_BOOST = 5
/** Total cap for the combined major+STEM+interest+platform stack. */
export const MAJOR_INTEREST_STACK_MAX = 20

/** Faith-affiliation alignment boosts. */
export const FAITH_MATCH_BOOST = 10
export const FAITH_CATEGORY_BOOST = 8

/** Talent / music / leadership signal boosts. */
export const MUSIC_TALENT_BOOST = 12
export const TALENT_CATEGORY_BOOST = 8
export const LEADERSHIP_BOOST = 5

/** Tennessee geographic-signal boost for TN-specific opportunities. */
export const TN_GEO_BOOST = 8

/** Housing-usable funding matched to a student's housing need. */
export const HOUSING_USABLE_BOOST = 10

/** Population-served / mission-focus alignment (per hit, and cap). */
export const POPULATION_MISSION_BOOST_PER_HIT = 2
export const POPULATION_MISSION_BOOST_MAX = 8

/** Direct need + geographic fit boost (base, per-hit, cap, and geo gate). */
export const NEED_GEO_FIT_BASE = 12
export const NEED_GEO_FIT_PER_HIT = 5
export const NEED_GEO_FIT_MAX = 24
export const NEED_GEO_FIT_MIN_GEO_SUBSCALE = 75

// ── Admin / Seeding ─────────────────────────────────────────────────────

/** Minimum score for admin seed-to-pipeline operations */
export const ADMIN_SEED_MIN_SCORE = 45

// ── Frontend Display (sync with src/lib/matchDisplayThresholds.js) ──────

/**
 * Score at or above which results are auto-added to a profile's pipeline.
 * Aligned to the 75 bar (owner directive 2026-06-23) so a "bad match" (< 75)
 * never auto-lands in the working pipeline; it lives in the master catalog
 * instead.
 */
export const AUTO_ADD_SCORE = 75

/** Strong match bucket threshold */
export const STRONG_MATCH_SCORE = 85

/** Good match bucket threshold (aligned to the 75 bar, owner directive). */
export const GOOD_MATCH_SCORE = 75

/** Moderate match bucket threshold */
export const MODERATE_MATCH_SCORE = 40
