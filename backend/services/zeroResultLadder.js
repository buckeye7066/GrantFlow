/**
 * zeroResultLadder.js
 *
 * Phase 6 mission rule: zero results is a failure state. No blank page
 * without explanation; no irrelevant filler pretending to be a match.
 *
 * This module formalizes the fallback ladder used by every funding-result
 * route (matching.js, discovery.js, Anya summaries, pipeline savers). The
 * ladder is intentionally pure / synchronous / no I/O so it can be unit
 * tested with fixture profile/result lists.
 *
 * Tiers (top is best, descend on miss):
 *   1. STRONG_DIRECT     — direct opportunities at or above the requested
 *                          minimum score; user got what they asked for.
 *   2. RELAXED_DIRECT    — direct opportunities at a lower score; clearly
 *                          marked threshold_relaxed=true.
 *   3. DIRECTORY         — directory/referral resources (mission rule:
 *                          directories ALWAYS survive filtering); marked
 *                          kind=directory and shown with the disclaimer.
 *   4. GEO_EXPAND        — same scoring rules but with the state filter
 *                          relaxed (national-only / out-of-state allowed);
 *                          marked geo_expanded=true.
 *   5. PROFILE_GAPS      — no match at all; surface profile gaps so the
 *                          user knows what to fill in.
 *   6. EXPLAIN_ZERO      — last resort: an honest "we couldn't find
 *                          anything" payload describing what was tried.
 *
 * Routes call assembleFundingResults() with the scored candidate list
 * and minimum score; the ladder returns a single envelope describing
 * which tier produced the visible results, plus structured diagnostics.
 */

export const TIERS = Object.freeze({
  STRONG_DIRECT: 'STRONG_DIRECT',
  RELAXED_DIRECT: 'RELAXED_DIRECT',
  DIRECTORY: 'DIRECTORY',
  GEO_EXPAND: 'GEO_EXPAND',
  PROFILE_GAPS: 'PROFILE_GAPS',
  EXPLAIN_ZERO: 'EXPLAIN_ZERO',
})

const DIRECT_KINDS = new Set(['direct', 'benefit'])
const DIRECTORY_KINDS = new Set(['directory', 'referral', 'school_portal'])

function isDirect(opp) {
  const k = String(opp?.kind || opp?.opportunity_kind || 'direct').toLowerCase()
  return DIRECT_KINDS.has(k)
}

function isDirectory(opp) {
  const k = String(opp?.kind || opp?.opportunity_kind || '').toLowerCase()
  return DIRECTORY_KINDS.has(k)
}

function score(opp) {
  const s = Number(opp?.match_score ?? opp?.score ?? 0)
  return Number.isFinite(s) ? s : 0
}

function rejected(opp) {
  return String(opp?.match_decision || '').toUpperCase() === 'REJECT'
}

/**
 * Walk the fallback ladder.
 *
 * @param {Array<object>} scored - all scored candidates (already ranked)
 * @param {object} opts
 * @param {number} [opts.minScore=50]   - requested minimum score
 * @param {number} [opts.maxResults=50] - maximum to return at any tier
 * @param {Array<object>} [opts.geoExpansionPool] - candidates that were
 *        excluded by the geographic filter; ladder may pull from these
 *        when GEO_EXPAND tier is reached.
 * @param {Array<string>} [opts.profileGaps] - high-value profile fields
 *        the user has not filled in (used by PROFILE_GAPS tier).
 * @returns {{
 *   tier: string,                    // which tier produced the results
 *   opportunities: Array<object>,    // what to show
 *   threshold_relaxed: boolean,      // mission rule: surface honestly
 *   threshold_relaxed_reason: string|undefined,
 *   geo_expanded: boolean,
 *   directory_only: boolean,
 *   profile_gaps: string[],
 *   explanation: string,
 *   tier_attempts: Array<{tier: string, count: number, reason?: string}>
 * }}
 */
export function assembleFundingResults(scored = [], opts = {}) {
  // Fallback default aligned to the need-anchored discovery bar (25).
  const minScore = Number.isFinite(opts.minScore) ? Math.max(0, Math.min(100, opts.minScore)) : 25
  const maxResults = Math.max(1, Math.min(200, Number(opts.maxResults) || 50))
  const geoExpansionPool = Array.isArray(opts.geoExpansionPool) ? opts.geoExpansionPool : []
  const profileGaps = Array.isArray(opts.profileGaps) ? opts.profileGaps : []
  // Strict mode: caller (e.g. Discover slider with strict=1) wants the minimum
  // score to be a HARD floor. Relaxed direct, directories, and geo-expanded
  // tiers are all suppressed unless the user deliberately lowers their slider.
  const strictMinScore = opts.strictMinScore === true

  const all = (Array.isArray(scored) ? scored : []).filter((o) => o && !rejected(o))
  const tierAttempts = []

  // Tier 1: STRONG_DIRECT
  const strong = all.filter((o) => isDirect(o) && score(o) >= minScore)
  tierAttempts.push({ tier: TIERS.STRONG_DIRECT, count: strong.length })
  if (strong.length > 0) {
    return finalize({
      tier: TIERS.STRONG_DIRECT,
      opportunities: strong.slice(0, maxResults),
      explanation: `Found ${strong.length} direct opportunit${strong.length === 1 ? 'y' : 'ies'} at or above your threshold (${minScore}%).`,
      tierAttempts,
    })
  }

  // Strict mode: the caller asked for the minimum score to be a hard floor.
  // Do not return relaxed/directories/geo-expanded results below that floor.
  if (strictMinScore) {
    if (profileGaps.length > 0) {
      tierAttempts.push({
        tier: TIERS.PROFILE_GAPS,
        count: 0,
        reason: 'strict_threshold_no_relax',
      })
      return finalize({
        tier: TIERS.PROFILE_GAPS,
        opportunities: [],
        profile_gaps: profileGaps,
        explanation: `No direct opportunities met your strict ${minScore}% threshold. Key profile fields are missing: ${profileGaps.join(', ')}. Fill these in or deliberately lower the slider to broaden results.`,
        tierAttempts,
      })
    }

    tierAttempts.push({
      tier: TIERS.EXPLAIN_ZERO,
      count: 0,
      reason: 'strict_threshold_no_relax',
    })
    return finalize({
      tier: TIERS.EXPLAIN_ZERO,
      opportunities: [],
      explanation: `No opportunities met your strict ${minScore}% match threshold. Lower the slider deliberately to see weaker matches, or add more profile detail so GrantFlow can find better-fit sources.`,
      tierAttempts,
    })
  }

  // Tier 2: RELAXED_DIRECT
  const RELAX_TIERS = [40, 30, 20, 10, 0]
  let relaxed = []
  let relaxedTo = null
  for (const t of RELAX_TIERS) {
    if (t >= minScore) continue
    const subset = all.filter((o) => isDirect(o) && score(o) >= t)
    if (subset.length > 0) {
      relaxed = subset
      relaxedTo = t
      break
    }
  }
  tierAttempts.push({ tier: TIERS.RELAXED_DIRECT, count: relaxed.length })
  if (relaxed.length > 0) {
    return finalize({
      tier: TIERS.RELAXED_DIRECT,
      opportunities: relaxed.slice(0, maxResults).map((o) => ({
        ...o,
        threshold_relaxed: true,
        relaxed_reason: `No matches at ${minScore}%; relaxed to ${relaxedTo}%.`,
      })),
      threshold_relaxed: true,
      threshold_relaxed_reason: `No strong matches at your threshold (${minScore}%); showing direct opportunities at ≥${relaxedTo}%. Complete your profile to improve match quality.`,
      explanation: `Showing ${relaxed.length} lower-confidence direct opportunit${relaxed.length === 1 ? 'y' : 'ies'} so you still see options.`,
      tierAttempts,
    })
  }

  // Tier 3: DIRECTORY (mission rule: directories ALWAYS survive filtering)
  const directories = all.filter((o) => isDirectory(o))
  tierAttempts.push({ tier: TIERS.DIRECTORY, count: directories.length })
  if (directories.length > 0) {
    return finalize({
      tier: TIERS.DIRECTORY,
      opportunities: directories.slice(0, maxResults),
      directory_only: true,
      explanation: `No direct grants matched. Showing ${directories.length} director${directories.length === 1 ? 'y' : 'ies'} or referral resource${directories.length === 1 ? '' : 's'} where you can search for help locally. These are NOT direct grants.`,
      tierAttempts,
    })
  }

  // Tier 4: GEO_EXPAND (pull from out-of-state pool)
  const geoExpanded = geoExpansionPool
    .filter((o) => o && !rejected(o))
    .filter((o) => isDirect(o) || isDirectory(o))
  tierAttempts.push({ tier: TIERS.GEO_EXPAND, count: geoExpanded.length })
  if (geoExpanded.length > 0) {
    return finalize({
      tier: TIERS.GEO_EXPAND,
      opportunities: geoExpanded.slice(0, maxResults).map((o) => ({
        ...o,
        geo_expanded: true,
      })),
      geo_expanded: true,
      threshold_relaxed: true,
      threshold_relaxed_reason:
        'No matches in your state; expanding the search to national and adjacent regions. Complete your profile location for closer matches.',
      explanation: `No in-state matches. Showing ${geoExpanded.length} result${geoExpanded.length === 1 ? '' : 's'} from a wider region.`,
      tierAttempts,
    })
  }

  // Tier 5: PROFILE_GAPS — explain what to fill in
  if (profileGaps.length > 0) {
    tierAttempts.push({ tier: TIERS.PROFILE_GAPS, count: 0 })
    return finalize({
      tier: TIERS.PROFILE_GAPS,
      opportunities: [],
      profile_gaps: profileGaps,
      explanation: `We couldn't find any matches because key profile fields are missing: ${profileGaps.join(', ')}. Filling these in will let GrantFlow find sources that fit you.`,
      tierAttempts,
    })
  }

  // Tier 6: EXPLAIN_ZERO — honest "we tried, found nothing" payload
  tierAttempts.push({ tier: TIERS.EXPLAIN_ZERO, count: 0 })
  return finalize({
    tier: TIERS.EXPLAIN_ZERO,
    opportunities: [],
    explanation:
      "We searched our sources and couldn't find a real match for this profile right now. Try widening your needs, adjusting your location, or check back later — new opportunities are crawled regularly.",
    tierAttempts,
  })
}

function finalize(input) {
  return {
    tier: input.tier,
    opportunities: input.opportunities,
    threshold_relaxed: Boolean(input.threshold_relaxed),
    threshold_relaxed_reason: input.threshold_relaxed_reason,
    geo_expanded: Boolean(input.geo_expanded),
    directory_only: Boolean(input.directory_only),
    profile_gaps: input.profile_gaps ?? [],
    explanation: input.explanation,
    tier_attempts: input.tierAttempts,
  }
}

export default { TIERS, assembleFundingResults }
