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

/** Minimum score any validated opportunity can receive (floor guarantee).
 *  DATA-POINT scale: prod median is 8 and p25 is 5, so the old floor of 5
 *  would lift junk to the pipeline bar's doorstep — 2 keeps the guarantee
 *  ("validated ≠ zero") without manufacturing relevance. */
export const SCORE_FLOOR = 2

// ── DATA-POINT scoring model (owner directive 2026-07-06 evening) ────────
//
// Supersedes the need-anchored denominator: the score is the share of the
// profile's ENTIRE data-point inventory the source matches, gated by
// eligibility and geography:
//
//   score = round( matchedDataPointCredit / totalDataPoints × 100
//                  × eligibilityFactor × geoFactor )
//
// "88 data points in the profile, source matches 44 → 50." The inventory
// (backend/services/profileDataPoints.js) is the single source of truth for
// what counts as a data point; the per-match evidence list stored in
// match_explain_json.dataPointEvidence IS the score's explanation. A richer
// profile raises the bar (denominator grows), so absolute scores run much
// lower than the need-anchored scale — the bars below this block are
// EMPIRICALLY recalibrated against the real prod distribution, not reused.
//
// CALIBRATION (prod, 2026-07-06, 10,859 stored matches across 86 profiles,
// backend/scripts/score-distribution.mjs; inventories ran 51–146 points):
//   p50=8  p75=11  p90=15  p95=17  p99=23  max=47
// Population-preserving mapping from the need-anchored bars:
//   purge 12→5 · review 15→7 · pipeline bar 25→8 · good 50→11 · strong 75→14
// Every band below uses this mapping. If the distribution shifts (richer
// profiles, better amount/eligibility acquisition), re-run the script and
// re-map — do not hand-tune individual bars.
//
// Escape hatch: GRANTFLOW_SCORING_MODEL=need_anchored restores the previous
// scale (kept for A/B verification during the migration window).
export const SCORING_MODEL =
  process.env.GRANTFLOW_SCORING_MODEL === 'need_anchored' ? 'need_anchored' : 'data_point'

/**
 * Scale identity stamp for persisted score-adjacent state (live tuning,
 * scoreboards). Persisted numbers from a DIFFERENT scale must be ignored on
 * hydrate, not reinterpreted — a stale need-anchored minScore of 25 is p99 on
 * this scale and would empty discovery.
 */
export const SCORE_SCALE_ID = 'data_point_v1'

/** Minimum term length for a value to count as a data point. */
export const DATA_POINT_MIN_TERM_LENGTH = 3

/**
 * Minimum inventory size for a CALIBRATED coverage claim (2026-07-27, the
 * "9 of the profile's 6 data points — 83%" class). The bands above are
 * empirically calibrated against REAL profiles carrying 50–150 data points;
 * the crawler-os lane scored against thesis STUB profiles carrying ~6 (needs
 * list only), so any topically broad directory trivially "covered" 50–100%
 * of every profile — Anita (KY, individual) and Demo Student (TN, student) got
 * the SAME registry-directory-dominated list, labeled "Excellent Match".
 * An inventory below this floor cannot support a percentage claim on the
 * calibrated scale: the engine falls back to the bounded topical path
 * (NO_NEEDS_TOPICAL_CAP), exactly like a bare profile. Real profiles clear
 * this floor by an order of magnitude; only stub/thin-context callers hit it.
 */
export const MIN_CALIBRATED_INVENTORY = 15

/**
 * Number of "main needs" the coverage denominator counts, so a profile that
 * lists 10 needs is not punished: coverage is measured against
 * min(totalNeeds, NEED_DENOMINATOR_CAP). One fully-matched main need on a
 * 4+-need profile = 25.
 */
export const NEED_DENOMINATOR_CAP = 4

/**
 * Ceiling for profiles with NO usable data points (and, on the legacy
 * need-anchored path, no declared needs): topical evidence alone may score at
 * most this, so an empty profile can never outrank evidenced coverage. 13 on
 * the data-point scale preserves the old cap's position relative to the
 * pipeline bar (40/25 ≈ 13/8).
 */
export const NO_NEEDS_TOPICAL_CAP = 13

/**
 * Specialized fit evidence (GPA×merit, faith×faith-based, housing-usable ×
 * housing need, major/STEM×scholarship, talent, workforce, benefit-program
 * alignment, population/mission) counts as at most HALF of one main-need
 * credit — it refines coverage, it can no longer stack 40 bonus points.
 */
export const FIT_EVIDENCE_HALF_CREDIT = 0.5

/**
 * FULL-SATISFACTION COVERAGE FLOOR (owner directive 2026-08-23, "scoring later").
 *
 * The data-point score is matched-credit ÷ the profile's ENTIRE inventory, so a
 * broadly-eligible fund that states FEW criteria scores LOW even for someone who
 * FULLY satisfies it: a national patient-assistance fund (PAN, HealthWell,
 * Modest Needs) that gates on "a qualifying condition + financial need" touches
 * 1-2 of a ~70-point inventory → 6-10% coverage → REVIEW, never ACCEPT — burying
 * the funds a disabled/senior/low-income person genuinely qualifies for.
 *
 * The cure is a SATISFACTION ratio (Instrumentl's good-fit idea): when a match
 * satisfies EVERY need the funder STATES (full satisfaction of the criteria that
 * apply), passes the eligibility + geography gates cleanly, and the profile is
 * rich enough to calibrate (≥ MIN_CALIBRATED_INVENTORY), its coverage is floored
 * here so it reaches ACCEPT. This is a floor via Math.max — it NEVER lowers a
 * higher measured coverage, and it is gated so it can never flood:
 *   - the funder must STATE ≥1 need (MISSING = NEUTRAL — a stated-nothing fund
 *     is NOT "fully satisfied by everyone" and is never lifted);
 *   - the profile must satisfy ALL of them at FULL credit (a partial / fragment
 *     match does not rise);
 *   - eligibility/geo must not be a mismatch and no population mismatch may hold;
 *   - directory/benefit pointers are excluded (the locator rule — a pointer
 *     never claims ACCEPT).
 *
 * 15 lands a lifted match in the GOOD-match band (≥ GOOD_MATCH_SCORE 11, below
 * STRONG 17) after the 0.8 unknown-eligibility haircut (15×0.8=12) — genuinely
 * qualifying broad-fund matches surface at ACCEPT, ranked BELOW high-coverage
 * strong matches, never above them. Reversible via GRANTFLOW_SATISFACTION_FLOOR.
 */
export const SATISFACTION_ACCEPT_COVERAGE = (() => {
  const raw = Number(process.env.GRANTFLOW_SATISFACTION_FLOOR)
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 15
})()

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
 * Hard floor for the discovery bar, ON THE DATA-POINT SCALE.
 *
 * OWNER DIRECTIVE 2026-08-03 (recall over suppression — GrantFlow must beat a
 * free Google search by surfacing real, relatable sources): lowered from the
 * pipeline bar (8) to the engine REVIEW bar (REVIEW_SCORE = 7, "some real
 * coverage worth a human look"). Every source the engine judges review-worthy
 * or better now SURFACES in Discover, ranked below ACCEPTs, instead of being
 * hidden behind the stricter pipeline/auto-add bar (AUTO_ADD_SCORE = 8, which is
 * UNCHANGED — Discover shows more, but auto-add to the pipeline stays
 * conservative). Directories already surfaced at REVIEW_SCORE; this aligns
 * direct sources with them. Junk scored below the review bar (e.g. the
 * unanchored sources capped at REVIEW_SCORE-1 by needFirstMatchPolicy) still
 * does not surface here.
 *
 * Reversible without a code change: set GRANTFLOW_DISCOVERY_MIN_SCORE_FLOOR=8 to
 * restore the prior floor (or tighten just the display slider via
 * GRANTFLOW_DISCOVERY_MIN_SCORE=8). Kept as 7 to equal REVIEW_SCORE; the drift
 * tripwire in discoveryMinScorePreference.test.js asserts they stay in sync.
 */
export const DISCOVERY_MIN_SCORE_FLOOR = (() => {
  const raw = Number(process.env.GRANTFLOW_DISCOVERY_MIN_SCORE_FLOOR)
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 7
})()

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
 *  Tried in order; first to yield results wins. (Data-point scale mapping of
 *  the former [15, 8, 0].) */
export const RELAX_THRESHOLDS = [7, 4, 0]

/** When all thresholds exhausted, return top N by score */
export const FALLBACK_TOP_N = 20

// ── Decision Engine (data-point scale; population-preserving mapping) ───

/** ACCEPT: top ~quarter of real matches (old 50 ≡ new 11). */
export const ACCEPT_SCORE = 11

/** REVIEW: some real coverage worth a human look (old 15 ≡ new 7). */
export const REVIEW_SCORE = 7

/**
 * Soft relevance mismatch penalty (population/eligibility softFail path).
 * Old 0–100 scale used ~25. On data_point_v1 (ACCEPT≈11), scale proportionally
 * so soft mismatches reduce score without zeroing every near-match.
 * Override: GRANTFLOW_SOFT_RELEVANCE_PENALTY=<number>
 */
export const SOFT_RELEVANCE_PENALTY = (() => {
  const rawValue = process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY?.trim()
  const raw = rawValue ? Number(rawValue) : Number.NaN
  if (Number.isFinite(raw) && raw >= 0) return raw
  return SCORING_MODEL === 'data_point' ? 4 : 25
})()

/** Minimum score for ACCEPT in the structured decision pipeline (old 25). */
export const DECISION_ACCEPT_MIN = 8

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

/** Minimum score for admin seed-to-pipeline operations (data-point scale). */
export const ADMIN_SEED_MIN_SCORE = 7

/**
 * Score stamped on rows a corrective sweep DEMOTES (stale student-aid
 * ACCEPTs, surfaced-but-ineligible matches). MUST sit below REVIEW_SCORE and
 * AUTO_ADD_SCORE so a demoted row actually stops surfacing — on the retired
 * scale this was a hardcoded 10 under a 25 bar; when the bar moved to 8 the
 * un-translated 10 kept demoted rows visible and broke sweep idempotency.
 */
export const DEMOTED_MATCH_SCORE = 4

// ── Frontend Display (sync with src/lib/matchDisplayThresholds.js) ──────

/**
 * Score at or above which results are auto-added to a profile's pipeline.
 * Data-point scale: 8 keeps the same admitted population the need-anchored
 * 25 bar did (calibration block above). Below that, the source lives in the
 * master catalog only.
 */
export const AUTO_ADD_SCORE = 8

/**
 * Strong match bucket threshold (top ~10% of real matches; old 75).
 *
 * Re-calibrated 2026-07-31 from 14 against 5,706 non-synthetic scored prod
 * matches (p50=6, p75=13, p90=17, p95=23, max=85 — the previous fit was
 * p50=8, p90=15, max=47). At 14 this bar labelled 15.4% of matches "Excellent
 * Match", roughly one in six, against a documented intent of ~10%; 17 measures
 * 11.8%. DISPLAY ONLY — decisions run off ACCEPT_SCORE / DECISION_ACCEPT_MIN /
 * DISCOVERY_MIN_SCORE_FLOOR, which are unchanged. MUST equal
 * MATCH_DISPLAY_TIERS.excellent in src/lib/matchDisplayThresholds.js; the
 * drift tripwire in src/lib/__tests__/matchDisplayThresholds.test.js enforces
 * it.
 */
export const STRONG_MATCH_SCORE = 17

/** Good match bucket threshold (top ~quarter; old 50). */
export const GOOD_MATCH_SCORE = 11

/** Moderate match bucket threshold (some coverage, review-worthy; old 15). */
export const MODERATE_MATCH_SCORE = 7

// ── Legacy-scale preference migration ────────────────────────────────────

/**
 * Upper bound of the "Minimum match score" slider track (sync with
 * src/lib/matchDisplayThresholds.js MIN_SCORE_SLIDER_MAX). 30 sits above the
 * prod p99 (23); no data-point-scale minimum above it makes sense, so any
 * PERSISTED min-score preference beyond it must be a retired-scale value.
 */
export const MIN_SCORE_SLIDER_MAX = 30

/**
 * One-time translation for persisted OLD-SCALE minimum-score preferences
 * (need-anchored 0–100 values, e.g. a stored "85" that starved discovery
 * forever — max real score on this scale is ≈58 and >23 is the top 1%):
 *   ≥75 (old strong/best) → STRONG_MATCH_SCORE (14)
 *   31–74 (old good and everything between) → GOOD_MATCH_SCORE (11)
 * Values ≤ MIN_SCORE_SLIDER_MAX pass through untouched (already live-scale).
 * Non-numeric input is returned as-is (callers decide the null/NaN policy).
 * Mirrors translateLegacyMinScore in src/lib/matchDisplayThresholds.js.
 */
export function translateLegacyMinScore(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return value
  if (v <= MIN_SCORE_SLIDER_MAX) return v
  if (v >= 75) return STRONG_MATCH_SCORE
  return GOOD_MATCH_SCORE
}
