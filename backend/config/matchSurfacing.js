/**
 * matchSurfacing.js — SINGLE SOURCE OF TRUTH for "what surfaces to a profile".
 *
 * GrantFlow's recurring recall bug: the rule for WHICH persisted matches are
 * shown to a profile was re-encoded independently in every read path
 * (matching.js, discovery.js, realCrawlers.js, fundingSources.js,
 * crawlerPlanService.js, crawlerOsCompatibility.js, hamiltonFundingSourcePolicy.js).
 * Those copies drifted into THREE different `matcher_version` allowlists:
 *   - `= 'crawler-os'`                              (dropped xmatch AND web-llm)
 *   - `IN ('crawler-os','crawler-os-xmatch')`       (dropped web-llm)
 *   - (the intended) crawler-os + xmatch + web-llm
 * The net effect: a profile's real, high-scoring `web-llm` scholarship matches
 * (e.g. Robert White's 80+ EMS scholarships) were persisted but NEVER read
 * back, so the pipeline looked nearly empty.
 *
 * Per the repo invariant rule ("a machine-checkable product rule must be
 * re-asserted in ONE place"), every read/surface path MUST import from here
 * instead of inlining a matcher_version list or a score-floor predicate.
 *
 * IMPORTANT: this governs READ/SURFACE paths only. The crawler-os RECONCILE
 * delete scope (crawlerOsPersistence.js) and the xmatch cleanup (robertAgent.js)
 * deliberately EXCLUDE 'web-llm' and 'institution-link' so web-discovered and
 * attendance-linked matches are never wiped by a reconcile — do NOT wire this
 * constant into those delete paths.
 */

import { REVIEW_SCORE } from './matchThresholds.js'

/**
 * Matcher versions that represent legitimate, profile-scoped matches meant to
 * be shown to the user:
 *   - crawler-os        : the primary Crawler OS discovery/matching authority
 *   - crawler-os-xmatch : cross-profile matches (Robert's cross-matching)
 *   - web-llm           : Brave/SearXNG + LLM web scholarship discovery,
 *                         persisted specifically to survive the OS reconcile
 *   - institution-link  : the student's OWN school's aid, linked by the
 *                         ATTENDANCE gate and scored by the canonical engine
 *                         (enforceInstitutionAidLinkage). Persisted under its
 *                         own version for the SAME reason as web-llm: an
 *                         institution row is reachable only through the
 *                         name-keyed open-web lane, so any registry-only run
 *                         of that profile would otherwise erase it and nothing
 *                         would ever look at the catalog row again (prod
 *                         2026-08-01: 52 active MTSU rows, 0 match rows, for a
 *                         student whose current_institution IS MTSU).
 *   - profile-discovery-link : a catalog row that RECORDS the profile it was
 *                         discovered for (`funding_opportunities.profile_id`),
 *                         re-offered to that same profile and scored by the
 *                         canonical engine (enforceProfileDiscoveredCatalogLinkage).
 *                         Persisted under its own version for the SAME reason
 *                         as web-llm and institution-link: the crawler-os
 *                         reconcile is a rolling snapshot, so a row the next
 *                         run does not re-find loses its match forever (prod
 *                         2026-08-01: `web_search` rows created in August were
 *                         37% matched, June/July rows 3-4% — a decay curve, not
 *                         a quality story).
 */
export const SURFACED_MATCHER_VERSIONS = Object.freeze([
  'crawler-os',
  'crawler-os-xmatch',
  'web-llm',
  'institution-link',
  'profile-discovery-link',
  //   - field-of-study-link  : a catalog row whose TITLE or SPONSOR names the
  //                         profile's OWN declared field of study
  //                         (`education.intended_major` / `education.interests`),
  //                         scored by the canonical engine
  //                         (enforceDeclaredFieldOfStudyRecall). Persisted under
  //                         its own version for the SAME reason as the three
  //                         above: the reconcile is a rolling snapshot. Prod
  //                         2026-08-02: a forensic-science student carried 1 of
  //                         13 active forensic rows, and the pair nobody had
  //                         scored ("AFTE Forensic Science Scholarship")
  //                         replays as ACCEPT 83.
  'field-of-study-link',
  //   - student-aid-instate-link : a catalog row whose TITLE or SPONSOR NAMES
  //                         the student's own STATE and whose title/aid
  //                         taxonomy makes it student aid, scored by the
  //                         canonical engine (enforceStudentAidInStateRecall).
  //                         Prod 2026-08-02: a TN dual-enrolled senior carried
  //                         0 of 21 active TN HOPE rows, and the pair nobody
  //                         had scored replays as ACCEPT 100 ("Matches 70 of
  //                         the profile's 70 data points"). Same rolling-
  //                         snapshot reason for its own version as the above.
  'student-aid-instate-link',
  //   - county-crisis-need-link : a catalog row whose TITLE or SPONSOR NAMES
  //                         the household's own COUNTY and which serves a
  //                         CRISIS need the profile declares, scored by the
  //                         canonical engine (enforceCountyCrisisNeedRecall)
  //                         and written ONLY on ACCEPT. Prod 2026-08-02: 416
  //                         active eviction/rental rows carried 16 match rows
  //                         between them; a family in Lorain County OH had NO
  //                         row at all for "Love INC Lorain County — Emergency
  //                         Housing & Rent Assistance", which replays as
  //                         ACCEPT 100. Same rolling-snapshot reason for its
  //                         own version as the five above.
  'county-crisis-need-link',
  //   - catalog-rescore-link : the CONTINUOUS catalog-wide re-matching sweep
  //                         (services/matching/catalogRescoreSweep.js). The
  //                         rolling snapshot leaves 94% of active non-pointer
  //                         catalog rows never scored for anyone (measured
  //                         2026-08-03: 641 of 11,050 rows have EVER matched
  //                         any profile); this sweep eventually puts every
  //                         active pair in front of the canonical engine,
  //                         bounded per pass, ACCEPT-only. Same rolling-
  //                         snapshot reason for its own version as the six
  //                         above. Writes are env-gated OFF until the
  //                         fix/qa-36-profile-junk fundability chain lands.
  'catalog-rescore-link',
  //   - funder-behavior-link : a `propublica_990` funder row whose OWN filed
  //                         grant list (IRS 990-PF Part XV / 990 Schedule I,
  //                         ingested into `grant_transactions`) demonstrates
  //                         in-state giving for a need the profile DECLARES,
  //                         scored by the canonical engine (ACCEPT/REVIEW —
  //                         a funder row structurally lacks an apply_url, so
  //                         an ACCEPT is systematically downgraded to REVIEW;
  //                         enforceFunderBehaviorRecall). Persisted
  //                         under its own version for the SAME rolling-
  //                         snapshot reason as the seven above.
  'funder-behavior-link',
])

/**
 * SQL fragment for `matcher_version IN (...)`. Built from the constant above —
 * all values are compile-time literals (no user input), so inlining is safe.
 * Use as:  `WHERE m.profile_id = ? AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}`
 */
export const SURFACED_MATCHER_VERSIONS_SQL = `(${SURFACED_MATCHER_VERSIONS.map((v) => `'${v}'`).join(',')})`

/**
 * Whether a scored row should be SHOWN to the profile, given the requested
 * display floor.
 *
 * A row surfaces when ANY of:
 *   1. It is a directory/referral scoring at least DIRECTORY_MIN_SCORE (or
 *      never scored) — mission rule: directories survive the display floor,
 *      BUT an engine score below the REVIEW band means the engine affirmatively
 *      judged it irrelevant to this profile (e.g. a federal student-aid
 *      directory scored 0 for a senior citizen). Those stay hidden.
 *   2. The engine's own decision is ACCEPT — an ACCEPT is only produced at
 *      score >= ACCEPT_SCORE (70) AND after every hard-eligibility / geo /
 *      population gate, and is downgraded to REVIEW when it lacks a URL, has a
 *      blank profile, or has incomplete eligibility. So an ACCEPT is a strong
 *      certification of a real, eligible, actionable match. Hiding the engine's
 *      OWN accepts behind a stricter *display* floor (75) was pure incoherence:
 *      core in-state awards (e.g. Anastasia White's HOPE Scholarship, TN
 *      Student Assistance Award — all ACCEPT at 72) were silently buried.
 *   3. Its score clears the requested display floor.
 *
 * This raises recall WITHOUT lowering the quality bar: REVIEW / weak matches
 * below the floor still do not surface here — only the engine-certified ACCEPTs.
 *
 * @param {{is_directory?: boolean, match_decision?: string, match_score?: number|string}} row
 * @param {number} minScore requested display floor
 * @returns {boolean}
 */
/**
 * Directories bypass the requested display floor but not the engine's own
 * REVIEW band: a scored directory below this is an affirmative "irrelevant to
 * this profile" judgment (e.g. student-aid directory scored 0 for a senior),
 * not a borderline match.
 */
export const DIRECTORY_MIN_SCORE = REVIEW_SCORE

export function qualifiesForDisplay(row, minScore) {
  if (!row) return false
  if (row.is_directory) {
    // Never-scored (null/blank) ≠ scored-irrelevant: Number(null) is 0, so an
    // unscored directory must be detected BEFORE numeric coercion or it would
    // be hidden as if the engine had judged it a zero.
    const raw = row.match_score
    if (raw === null || raw === undefined || raw === '') return true
    const dirScore = Number(raw)
    return !Number.isFinite(dirScore) || dirScore >= DIRECTORY_MIN_SCORE
  }
  if (String(row.match_decision || '').toUpperCase() === 'ACCEPT') return true
  const score = Number(row.match_score)
  return Number.isFinite(score) && score >= Number(minScore)
}

export default {
  SURFACED_MATCHER_VERSIONS,
  SURFACED_MATCHER_VERSIONS_SQL,
  DIRECTORY_MIN_SCORE,
  qualifiesForDisplay,
}
