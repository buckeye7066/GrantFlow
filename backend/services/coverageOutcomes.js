/**
 * coverageOutcomes.js
 *
 * Mission rule (Phase 4 / Goal 9 — explainable, reliable, testable):
 * the SearchCoveragePanel must distinguish PLANNED, QUERIED, FAILED,
 * and FOUND for every source. Before this module the realCrawlers
 * route handed buildCoverageReport an empty outcomes[] which made
 * every required source look like a coverage gap (or, with the UI's
 * inference fallback, every required source look like it was queried
 * even when no candidates were loaded).
 *
 * crawlerManager.runCrawler returns a coarse `candidateCounts` map
 * keyed by strategy candidate-source group ("federal", "state",
 * "scholarships", etc.). Each group maps conceptually to one or more
 * SourceRegistry SOURCE_IDS. `result.results` carry a `source` field
 * (registry source id when available) which we use for the per-source
 * "found" tally.
 *
 * deriveCoverageOutcomes is pure / sync and easy to unit-test. It
 * never throws; if anything is missing it returns a best-effort
 * outcomes array, falling back to "queried: false" for sources we
 * can't account for so the gap remains honestly visible.
 */

import { SOURCE_IDS, SOURCES } from './sourceRegistry.js'

/**
 * Map crawlerManager strategy candidate-source group names →
 * SourceRegistry SOURCE_IDS that the group should be considered to
 * have queried. A group can map to multiple ids (e.g. "federal" runs
 * federal benefits AND grants.gov-style federal grant catalogues).
 *
 * Anything not in this map is still recorded with a synthetic
 * curated_<group> source_id so the UI can show "we ran the curated
 * <group> dataset"; it just won't roll up under a SourceRegistry id.
 */
const STRATEGY_GROUP_TO_SOURCE_IDS = Object.freeze({
  federal: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS, SOURCE_IDS.SNAP, SOURCE_IDS.MEDICAID, SOURCE_IDS.LIHEAP],
  faith_based: [SOURCE_IDS.FAITH_BASED_GRANTS],
  state: [SOURCE_IDS.STATE_PORTAL, SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS],
  national: [SOURCE_IDS.UNITED_WAY_211, SOURCE_IDS.COMMUNITY_ACTION, SOURCE_IDS.HRSA_HEALTH_CENTERS, SOURCE_IDS.FEEDING_AMERICA],
  business: [SOURCE_IDS.SBA_GRANTS, SOURCE_IDS.MINORITY_BUSINESS_DEV, SOURCE_IDS.WOMEN_OWNED_BUSINESS, SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT],
  scholarships: [SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS, SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.PELL_GRANT, SOURCE_IDS.ED_GOV_FAFSA],
  prescription: [SOURCE_IDS.HRSA_HEALTH_CENTERS],
  senior: [SOURCE_IDS.UNITED_WAY_211, SOURCE_IDS.COMMUNITY_ACTION],
  property_tax: [SOURCE_IDS.STATE_PORTAL],
  utility_assistance: [SOURCE_IDS.LIHEAP],
  family: [SOURCE_IDS.UNITED_WAY_211, SOURCE_IDS.COMMUNITY_ACTION, SOURCE_IDS.SNAP, SOURCE_IDS.FEEDING_AMERICA],
  school: [SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION, SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS, SOURCE_IDS.PTO_PTA_GRANTS],
  volunteer_fire: [SOURCE_IDS.FEMA_AFG, SOURCE_IDS.NATIONAL_VOLUNTEER_FIRE_COUNCIL, SOURCE_IDS.RURAL_FIRE_GRANTS],
})

/**
 * Pure function. Builds a list of per-source outcomes suitable for
 * passing to buildCoverageReport(plan, outcomes).
 *
 * Inputs:
 *   coveragePlan  — output from sourceRegistry.planCoverage()
 *   runResult     — output from crawlerManager.runCrawler()
 *   opportunities — final filtered/displayed opportunities[] for the
 *                   profile (used for the per-source "found" tally;
 *                   may be the merged curated+nearby list)
 *   errors        — optional array of { source_id?, group?, error }
 *                   reported by the crawler. Each error becomes a
 *                   `failed: true` outcome.
 *
 * Output:
 *   Array<{
 *     source_id,        // SourceRegistry id (or curated_<group>)
 *     queried: boolean,
 *     failed: boolean,
 *     found: number,
 *     duration_ms: number | null,
 *     error: string | null,
 *     planned: boolean,
 *     directory: boolean,
 *   }>
 */
export function deriveCoverageOutcomes({
  coveragePlan = null,
  runResult = null,
  opportunities = [],
  errors = [],
} = {}) {
  const planned = new Set(coveragePlan?.sources_planned ?? [])
  const candidateCounts = runResult?.debug?.candidateCounts ?? {}
  const totalDurationMs = runResult?.debug?.timing?.total_ms ?? null

  // Tally per-source `found` from the actual displayed opportunities.
  // Each opportunity's `source` field is normally a SourceRegistry id
  // for catalogue-backed results, otherwise a string like
  // "curated_federal" / "scraper_X". We aggregate both shapes.
  const foundBySourceId = new Map()
  for (const opp of opportunities ?? []) {
    const raw = String(opp?.source || opp?.source_id || '').trim()
    if (!raw) continue
    foundBySourceId.set(raw, (foundBySourceId.get(raw) ?? 0) + 1)
  }

  // 1) For every strategy candidate group with a non-zero loaded
  //    count, mark each conceptually-queried SOURCE_ID as queried.
  const outcomeBySourceId = new Map()
  const ensure = (sourceId) => {
    if (!outcomeBySourceId.has(sourceId)) {
      outcomeBySourceId.set(sourceId, {
        source_id: sourceId,
        queried: false,
        failed: false,
        found: 0,
        duration_ms: null,
        error: null,
        planned: planned.has(sourceId),
        directory: !!SOURCES[sourceId]?.directory,
      })
    }
    return outcomeBySourceId.get(sourceId)
  }

  for (const [group, count] of Object.entries(candidateCounts)) {
    if (!Number.isFinite(count) || count <= 0) continue
    const sourceIds = STRATEGY_GROUP_TO_SOURCE_IDS[group] ?? []
    if (sourceIds.length === 0) {
      // Unmapped group — record it with a synthetic id so the UI can
      // still tell admins "we ran the curated <group> dataset and got
      // N candidates". This keeps mission goal #9 (explainable) honest
      // even when a strategy ships a new group before its registry
      // mapping does.
      const syntheticId = `curated_${group}`
      const o = ensure(syntheticId)
      o.queried = true
      o.duration_ms = totalDurationMs
      o.directory = false
      continue
    }
    for (const sourceId of sourceIds) {
      const o = ensure(sourceId)
      o.queried = true
      o.duration_ms = totalDurationMs
    }
  }

  // 2) Merge in per-source "found" counts from the displayed
  //    opportunities (only for sources that actually appeared in the
  //    output — keeps the report honest).
  for (const [sourceId, count] of foundBySourceId) {
    const o = ensure(sourceId)
    o.queried = true
    o.found = count
  }

  // 3) Apply explicit error reports (e.g. an HTTP source that timed
  //    out). These override `failed` to true and capture the message.
  for (const err of errors ?? []) {
    if (!err) continue
    const targetIds = err.source_id
      ? [err.source_id]
      : err.group
        ? STRATEGY_GROUP_TO_SOURCE_IDS[err.group] ?? []
        : []
    for (const sourceId of targetIds) {
      const o = ensure(sourceId)
      o.failed = true
      o.error = String(err.error || err.message || 'unknown')
    }
  }

  return Array.from(outcomeBySourceId.values())
}

/**
 * Convenience: return a flat summary suitable for logging or the
 * smoke-test JSON report.
 */
export function summariseOutcomes(outcomes = []) {
  let queried = 0
  let failed = 0
  let totalFound = 0
  let directoryFound = 0
  let directFound = 0
  for (const o of outcomes) {
    if (o.queried) queried++
    if (o.failed) failed++
    totalFound += Number(o.found || 0)
    if (o.directory) directoryFound += Number(o.found || 0)
    else directFound += Number(o.found || 0)
  }
  return {
    sources_total: outcomes.length,
    sources_queried: queried,
    sources_failed: failed,
    direct_found: directFound,
    directory_found: directoryFound,
    total_found: totalFound,
  }
}

export default { deriveCoverageOutcomes, summariseOutcomes }
