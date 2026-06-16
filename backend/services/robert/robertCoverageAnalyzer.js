/**
 * robertCoverageAnalyzer.js
 *
 * Computes per-profile coverage / gap snapshots so Robert knows where
 * to focus discovery. Pure-ish: takes injected DB + an injected
 * `loadProfileContext` so unit tests don't need real profile loading.
 *
 * NEVER mutates funding_opportunities or grants. Reads only.
 */

import { upsertCoverage } from './robertRunStore.js'
import { buildProfileDemand } from './robertProfileDemandPlanner.js'
import { buildSearchPlans } from './robertSearchPlanner.js'

const ZERO_RESULT_THRESHOLD = 1
const STALE_AGE_DAYS = 30

/**
 * Analyse a single profile's coverage.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.profileId
 * @param {Function} args.loadProfileContext  async (db, profileId) => ctx
 * @param {Function} [args.queryGrantsCounts] async (db, profileId) => { total, accepted, review }
 * @param {Function} [args.queryProfileMatchableCount] async (db, profileId) => number
 * @returns {Promise<object>} coverage row + analysis details
 */
export async function analyzeProfileCoverage({
  db,
  profileId,
  loadProfileContext,
  queryGrantsCounts = defaultQueryGrantsCounts,
  queryProfileMatchableCount = defaultQueryProfileMatchableCount,
} = {}) {
  if (!db) throw new Error('analyzeProfileCoverage: db required')
  if (!profileId) throw new Error('analyzeProfileCoverage: profileId required')
  if (typeof loadProfileContext !== 'function') {
    throw new Error('analyzeProfileCoverage: loadProfileContext required')
  }

  const ctx = await loadProfileContext(db, profileId)
  if (!ctx?.profile?.id) {
    return null
  }

  const demand = buildProfileDemand(ctx)
  const counts = await safeCall(queryGrantsCounts, db, profileId, { total: 0, accepted: 0, review: 0 })
  const matchable = await safeCall(queryProfileMatchableCount, db, profileId, 0)

  const knownMatches = Number(counts.total) || 0
  const acceptedMatches = Number(counts.accepted) || 0
  const reviewMatches = Number(counts.review) || 0

  // zero_result_risk: 100 if no matchable opps in pool *or* zero accepted matches
  // and no profile-level grants. Decreases with accepted/strong matches.
  let zeroResultRisk = 0
  if (matchable < ZERO_RESULT_THRESHOLD) zeroResultRisk = 100
  else if (acceptedMatches === 0 && knownMatches < ZERO_RESULT_THRESHOLD) zeroResultRisk = 80
  else if (acceptedMatches === 0) zeroResultRisk = 60
  else if (acceptedMatches < 3) zeroResultRisk = 35
  else zeroResultRisk = 10

  // Coverage score: 0..100 based on how many of profile's needs have matches.
  const needCount = (demand?.needs?.length || 0) || 1
  const coverageScore = Math.max(0, Math.min(100,
    Math.round((acceptedMatches / Math.max(1, needCount)) * 50 + (matchable > 0 ? 30 : 0) + (acceptedMatches > 0 ? 20 : 0)),
  ))

  // Recommended search queries (top N from the planner).
  const plans = buildSearchPlans(demand, { maxPlans: 6 })
  const recommendedSearches = plans.map((p) => ({
    query: p.search_query,
    need_category: p.need_category,
    location_scope: p.location_scope,
    priority: p.priority,
    reason: p.reason,
  }))

  // Missing categories: needs the profile reports but with no accepted match.
  const missingNeeds = (demand?.needs && demand.needs.length > 0 && acceptedMatches === 0)
    ? demand.needs.slice(0, 8) : []

  const missingGeographies = computeMissingGeographies(demand, knownMatches)

  const recommendedSourceTypes = uniq(plans.flatMap((p) => p.source_types || []))

  const coverage = {
    profile_id: profileId,
    coverage_score: coverageScore,
    known_matches_count: knownMatches,
    accepted_matches_count: acceptedMatches,
    review_matches_count: reviewMatches,
    zero_result_risk: zeroResultRisk,
    missing_need_categories: missingNeeds,
    missing_geographies: missingGeographies,
    recommended_search_queries: recommendedSearches,
    recommended_source_types: recommendedSourceTypes,
  }

  await upsertCoverage(db, coverage)

  return {
    coverage,
    demand,
    plans,
    counts,
    matchable,
  }
}

function computeMissingGeographies(demand, knownMatches) {
  const out = []
  if (!demand?.location) return out
  // If we have a state but no matches, recommend broader scopes.
  if (knownMatches === 0) {
    if (demand.location.state) out.push({ scope: 'state', state: demand.location.state })
    out.push({ scope: 'national' })
    if (demand.location.county) out.push({ scope: 'county', county: demand.location.county, state: demand.location.state })
  }
  return out
}

async function safeCall(fn, ...args) {
  try { return await fn(...args) } catch { return undefined }
}

function uniq(arr) {
  const seen = new Set()
  const out = []
  for (const x of arr) {
    if (!seen.has(x)) { seen.add(x); out.push(x) }
  }
  return out
}

// ---------------------------------------------------------------------------
// Default DB queries (best-effort; if a column doesn't exist, return zeros)
// ---------------------------------------------------------------------------
async function defaultQueryGrantsCounts(db, profileId) {
  if (!db?.prepare) return { total: 0, accepted: 0, review: 0 }
  try {
    const total = await db.prepare('SELECT COUNT(*) AS c FROM grants WHERE profile_id = ?').get(profileId)
    let accepted = { c: 0 }, review = { c: 0 }
    try {
      accepted = await db.prepare(
        `SELECT COUNT(*) AS c FROM grants WHERE profile_id = ?
           AND COALESCE(status, '') NOT IN ('declined', 'archived', 'rejected')`,
      ).get(profileId)
    } catch { /* schema variation */ }
    return {
      total: Number(total?.c || 0),
      accepted: Number(accepted?.c || 0),
      review: Number(review?.c || 0),
    }
  } catch {
    return { total: 0, accepted: 0, review: 0 }
  }
}

async function defaultQueryProfileMatchableCount(db, _profileId) {
  if (!db?.prepare) return 0
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS c FROM funding_opportunities
         WHERE COALESCE(is_active, 1) = 1
           AND COALESCE(is_hidden, 0) = 0`,
    ).get()
    return Number(row?.c || 0)
  } catch {
    return 0
  }
}

export const __testing__ = { computeMissingGeographies, defaultQueryGrantsCounts, defaultQueryProfileMatchableCount }
