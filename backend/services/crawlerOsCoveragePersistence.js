// backend/services/crawlerOsCoveragePersistence.js
//
// Persists the Crawler OS's per-source outcome telemetry into the durable
// `crawler_source_runs` table (migration 072 / pg 0066) that the admin Crawl
// Coverage & Health dashboard (GET /api/admin/crawl-coverage,
// backend/routes/adminCrawlCoverage.js) reads.
//
// ROOT CAUSE THIS FIXES (2026-07-20 investigation): the 2026-06-22 Crawler OS
// cutover (commit 9a59f0d1, "Cut real-crawlers /run to the Crawler OS") deleted
// the legacy /real-crawlers/run pipeline body wholesale — including its only
// call to persistCoverageOutcomes(), the SOLE writer of crawler_source_runs —
// but never wired an equivalent write for the new engine. The dead
// persistCoverageOutcomes()/deriveCoverageOutcomes()/planCoverage()/
// buildCoverageReport() functions/imports were left behind in realCrawlers.js,
// unreachable. Since 2026-06-22 nothing has written a new row: the dashboard
// was frozen on the legacy engine's final ~36 hours of runs (2026-06-20/21),
// which all show Found=0 across every source and profile — a coincidence of
// timing (the last gasps of a since-retired pipeline), not a sign the crawler
// is currently broken. The ACTUAL discovery engine (Crawler OS) kept working
// the whole time — confirmed independently via a real pipeline-automation job
// (4c5cde4b, 2026-07-03) that advanced 11 real Tennessee grants for a profile
// whose "comprehensive" runs show 0-found in this same stale dashboard window.
//
// crawler-os/pipeline.js's runDiscovery already computes an honest per-source
// outcome for every source it queries (source_id, outcome, fetched, parsed,
// rejected, stored, existing, deduped) as `run.sources`; this module just maps
// that shape onto crawler_source_runs' columns so the dashboard becomes live
// again for the CURRENT engine. Best-effort and additive: a telemetry write
// must never fail (or slow down) a real crawl.

import { getSource } from '../crawler-os/sourceRegistry.js'
import { CRAWLER_OUTCOME } from '../crawler-os/contract.js'

// Outcomes that represent a genuine failure to query the source (as opposed to
// an honest SKIPPED — missing adapter/env, never a failure — or an EMPTY
// clean-but-zero-results run).
const FAILURE_OUTCOMES = new Set([
  CRAWLER_OUTCOME.FETCH_ERROR,
  CRAWLER_OUTCOME.PARSE_ERROR,
  CRAWLER_OUTCOME.ERROR,
  CRAWLER_OUTCOME.BLOCKED,
  CRAWLER_OUTCOME.RATE_LIMITED,
])

/**
 * Persist one crawl run's per-source coverage outcomes.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.crawlerRunId - crawler-os run_id (groups rows for one dashboard row)
 * @param {?string} opts.profileId
 * @param {?string} opts.crawlerType - caller-facing label (e.g. 'comprehensive', 'crawler-os')
 * @param {Array<{source_id:string, outcome:string, reason?:string, stored?:number, existing?:number}>} opts.sources
 * @returns {Promise<{written:number}>}
 */
export async function persistSourceCoverage(db, { crawlerRunId, profileId, crawlerType, sources } = {}) {
  if (!db || typeof db.prepare !== 'function') return { written: 0 }
  if (!crawlerRunId || !Array.isArray(sources) || sources.length === 0) return { written: 0 }

  const isPg = db?.dialect === 'postgres'
  const boolVal = (v) => (isPg ? Boolean(v) : (v ? 1 : 0))
  const LEGACY_COLUMNS = `(crawler_run_id, profile_id, crawler_type, source_id, source_label,
         planned, queried, failed, found, directory, error)`
  // Migration 166 / pg 0171 added the match-telemetry columns the admin Crawl
  // Coverage dashboard's Accepted / Rejected / Avg-match columns need. A DB that
  // has not replayed them yet must still get the legacy row rather than lose the
  // whole run's coverage, so the extended INSERT degrades to the legacy one once
  // (per call), never per row.
  const METRIC_COLUMNS = `(crawler_run_id, profile_id, crawler_type, source_id, source_label,
         planned, queried, failed, found, directory, error,
         parsed_candidates, rejected, accepted, match_score_sum, match_score_n)`
  const values = (n) =>
    isPg ? Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ') : Array.from({ length: n }, () => '?').join(', ')
  const legacySql = `INSERT INTO crawler_source_runs\n        ${LEGACY_COLUMNS}\n       VALUES (${values(11)})`
  const metricSql = `INSERT INTO crawler_source_runs\n        ${METRIC_COLUMNS}\n       VALUES (${values(16)})`
  let metricsSupported = true

  let written = 0
  let firstFailure = null
  for (const s of sources) {
    if (!s?.source_id) continue
    const outcome = s.outcome ?? null
    // Every entry in run.sources was SELECTED by the planner (thePlan.selected_source_ids)
    // — that is exactly what "planned" means here.
    const planned = true
    const queried = outcome !== CRAWLER_OUTCOME.SKIPPED
    const failed = FAILURE_OUTCOMES.has(outcome)
    const found = Number(s.stored ?? 0) + Number(s.existing ?? 0)
    const registrySource = getSource(s.source_id)
    const label = registrySource?.name ?? s.source_id
    const directory = Boolean(registrySource?.directory)

    const baseArgs = [
      crawlerRunId,
      profileId ?? null,
      crawlerType ?? null,
      s.source_id,
      label,
      boolVal(planned),
      boolVal(queried),
      boolVal(failed),
      Number.isFinite(found) ? found : 0,
      boolVal(directory),
      s.reason ?? null,
    ]
    // The engine's own per-source counters (pipeline.js finishSource). A source
    // that produced no decision honestly records 0, never NULL — NULL is
    // reserved for rows written before the metrics existed, which the dashboard
    // reports as "not recorded" rather than as a zero.
    const intOrZero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
    const metricArgs = [
      ...baseArgs,
      intOrZero(s.parsed),
      intOrZero(s.rejected),
      intOrZero(s.accepted),
      Number.isFinite(Number(s.match_score_sum)) ? Number(s.match_score_sum) : 0,
      intOrZero(s.match_score_n),
    ]

    let inserted = false
    if (metricsSupported) {
      try {
        await db.prepare(metricSql).run(...metricArgs)
        inserted = true
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase()
        // Only a MISSING-COLUMN error justifies dropping the metrics; anything
        // else (missing table, constraint) must surface through the legacy path.
        // sqlite says "table X has no column named Y"; postgres says
        // `column "y" of relation "x" does not exist`.
        const missingColumn =
          msg.includes('no such column') ||
          msg.includes('has no column named') ||
          (msg.includes('column') && msg.includes('does not exist'))
        if (missingColumn) {
          metricsSupported = false
        } else {
          if (!firstFailure) firstFailure = err
          if (msg.includes('no such table') || msg.includes('does not exist')) break
          continue
        }
      }
    }

    if (!inserted) {
      try {
        await db.prepare(legacySql).run(...baseArgs)
        inserted = true
      } catch (err) {
        if (!firstFailure) firstFailure = err
        // Table missing (migrations not yet applied) — stop the batch quietly,
        // matching the historical realCrawlers.js persistCoverageOutcomes behavior.
        const msg = String(err?.message || '').toLowerCase()
        if (msg.includes('no such table') || msg.includes('does not exist')) break
      }
    }
    if (inserted) written += 1
  }
  // Only surface a failure when NOTHING was written (a genuine schema/DB
  // problem worth logging upstream); a partial batch with a benign per-row
  // hiccup should not block the crawl or spam logs.
  if (written === 0 && firstFailure) throw firstFailure
  return { written }
}

export default { persistSourceCoverage }
