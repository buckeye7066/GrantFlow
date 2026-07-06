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
//
// NEED-ANCHORED SCALE (owner directive 2026-07-06, supersedes the additive
// weighted model): the match score IS the share of the profile's main needs
// the opportunity addresses, gated by eligibility and geography:
//
//   score = round( needCoverage% × eligibilityFactor × geoFactor )
//
// So a 50 literally means "this source addresses about half of what the
// profile needs, and the profile can actually apply, where it lives/serves."
// A source that matches ZERO declared needs scores near the floor no matter
// how national/generic/nonprofit-eligible it is. The old model's ~45 points
// of administrative baseline (right entity type + right country) are gone.

/** Minimum score any validated opportunity can receive (floor guarantee) */
export const SCORE_FLOOR = 5

/**
 * Number of "main needs" the coverage denominator counts, so a profile that
 * lists 10 needs is not punished: coverage is measured against
 * min(totalNeeds, NEED_DENOMINATOR_CAP). One fully-matched main need on a
 * 4+-need profile = 25.
 */
export const NEED_DENOMINATOR_CAP = 4

/**
 * Ceiling for profiles with NO declared needs: topical evidence alone
 * (keywords/categories/facets) may score at most this, so an empty profile
 * can never look like "half my needs are met".
 */
export const NO_NEEDS_TOPICAL_CAP = 40

/**
 * Specialized fit evidence (GPA×merit, faith×faith-based, housing-usable ×
 * housing need, major/STEM×scholarship, talent, workforce, benefit-program
 * alignment, population/mission) counts as at most HALF of one main-need
 * credit — it refines coverage, it can no longer stack 40 bonus points.
 */
export const FIT_EVIDENCE_HALF_CREDIT = 0.5

/** Eligibility gate factors (multiplicative). */
export const ELIG_MATCH_FACTOR = 1.0     // opportunity confirms the profile's applicant type
export const ELIG_UNKNOWN_FACTOR = 0.8   // opportunity silent / profile untyped — can't verify
export const ELIG_MISMATCH_FACTOR = 0.15 // opportunity explicitly targets someone else

/** Geography gate factors (multiplicative). */
export const GEO_MATCH_FACTOR = 1.0      // serves the profile's area (zip→national tiers)
export const GEO_UNKNOWN_FACTOR = 0.7    // location signals missing on either side
export const GEO_MISMATCH_FACTOR = 0.3   // explicitly serves somewhere else

/**
 * LEGACY weighted component weights. The need-anchored formula above replaced
 * the additive blend, but the component scorers still run as EVIDENCE
 * extractors (and the no-needs topical fallback uses the need component), so
 * the weights remain exported for compatibility (Amy tuning, tests).
 */
export const W_NEED = 0.35
export const W_ELIGIBILITY = 0.25
export const W_GEO = 0.20
export const W_CATEGORY = 0.20

/**
 * "Strong" bar on the LEGACY weighted-evidence subscale
 * (match_explain.scoreBreakdown.topical_evidence). The need-anchored FINAL
 * score is need-coverage × eligibility/geo gates and does NOT move when the
 * W_* weights change — weights act only inside the topical-evidence blend.
 * Amy's empirical weight-tuning KEEP/REVERT validation therefore measures
 * cohort quality on this subscale at this bar. 75 is the retired additive
 * scale's strong bar; the evidence blend still lives on that scale.
 */
export const TOPICAL_EVIDENCE_STRONG_BAR = 75

// ── Discovery / Comprehensive Match ─────────────────────────────────────

/**
 * Hard floor for the discovery bar, ON THE NEED-ANCHORED SCALE.
 * 25 = one fully-matched main need with clean eligibility + geography
 * (1 of NEED_DENOMINATOR_CAP=4). That is the new definition of
 * "pipeline-worthy" (owner directive 2026-07-06). The previous 75 bar
 * belonged to the retired additive scale where ~45 points were baseline.
 */
export const DISCOVERY_MIN_SCORE_FLOOR = 25

/**
 * Default minimum score for discovery results — the "slider" default.
 * Owner directive (2026-07-06, need-anchored scale): the bar for what surfaces
 * in a profile's pipeline/discovery view is 25 — at least one fully-matched
 * main need with clean gates. Anything below is NOT junk — it stays in the
 * master funding_opportunities catalog (deduped) so it can match another
 * profile later — it just doesn't clutter THIS profile's pipeline.
 *
 * Configurable via GRANTFLOW_DISCOVERY_MIN_SCORE, but CLAMPED to
 * [DISCOVERY_MIN_SCORE_FLOOR, 100] — an owner may TIGHTEN the bar (e.g. 50)
 * but can never drop it below the documented floor. Prefer gaining breadth
 * from the discovery lanes/queries over loosening this.
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
 * LEGACY (retired additive scale): number of matched profile needs that earned
 * full need-alignment credit in the old need SUBSCALE. The need-anchored
 * formula uses NEED_DENOMINATOR_CAP instead; this stays exported because the
 * component scorer (now an evidence extractor) and older tests reference it.
 */
export const NEED_FULL_CREDIT_HITS = 4

/** Progressive relaxation steps when results are too few.
 *  Tried in order; first to yield results wins. (Need-anchored scale:
 *  15 ≈ a partially-covered need or a discounted full need.) */
export const RELAX_THRESHOLDS = [15, 8, 0]

/** When all thresholds exhausted, return top N by score */
export const FALLBACK_TOP_N = 20

// ── Decision Engine (need-anchored scale) ───────────────────────────────

/** ACCEPT: addresses at least half of the profile's main needs. */
export const ACCEPT_SCORE = 50

/** REVIEW: some real need coverage worth a human look (below = weak). */
export const REVIEW_SCORE = 15

/** Minimum score for ACCEPT in the structured decision pipeline */
export const DECISION_ACCEPT_MIN = 25

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

/** Minimum score for admin seed-to-pipeline operations (need-anchored). */
export const ADMIN_SEED_MIN_SCORE = 20

// ── Frontend Display (sync with src/lib/matchDisplayThresholds.js) ──────

/**
 * Score at or above which results are auto-added to a profile's pipeline.
 * Need-anchored scale (owner directive 2026-07-06): 25 = at least one
 * fully-matched main need with clean eligibility + geography. Below that,
 * the source lives in the master catalog only.
 */
export const AUTO_ADD_SCORE = 25

/** Strong match bucket threshold: ~¾ of the profile's main needs. */
export const STRONG_MATCH_SCORE = 75

/** Good match bucket threshold: at least half of the main needs. */
export const GOOD_MATCH_SCORE = 50

/** Moderate match bucket threshold (some coverage, review-worthy). */
export const MODERATE_MATCH_SCORE = 15
