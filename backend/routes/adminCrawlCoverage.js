/**
 * adminCrawlCoverage.js — Admin-only, READ-ONLY crawl coverage & health
 * dashboard (architecture point #13 / P1+P2).
 *
 * Surfaces "did the crawler know where to look, did it query, what failed,
 * what was found vs accepted vs rejected" by joining the data that already
 * exists:
 *
 *   - crawler_source_runs   (per-source planned/queried/failed/found per run;
 *                            migration 072 / pg 0066)
 *   - crawler_jobs          (status / result_count / result_meta — surfaced
 *                            as accepted-vs-found where result_meta carries it)
 *   - sourceRegistry        (freshness_days per source → stale detection,
 *                            trust + labels)
 *   - profileReadinessService (weak-data profiles missing state/zip/type/etc.)
 *   - rejection_log         (OPTIONAL — degrades gracefully if absent)
 *
 * This route NEVER mutates anything. Every query is wrapped so that a missing
 * optional table (rejection_log, crawler_source_runs on a brand-new DB) yields
 * an empty/defaulted section rather than a 500. The single hard requirement is
 * `req.ctx.isAdmin === true`.
 *
 * Contract:
 *   GET /api/admin/crawl-coverage?profileId=&limit=
 *     → {
 *         generated_at,
 *         filters: { profile_id, limit },
 *         runs: [ {
 *           crawler_run_id, profile_id, crawler_type, started_at,
 *           sources_planned, sources_queried, sources_failed (count),
 *           failed_sources: [{ source_id, label, error }],
 *           results_found, results_accepted, results_rejected,
 *           avg_trust, avg_match, metrics_status ('recorded' | 'not_recorded'),
 *         } ],
 *         stale_sources: [{ source_id, label, freshness_days, last_crawl,
 *                           days_since, failure_status ('never_run' | 'stale' |
 *                           'not_crawlable'), runnable, crawler_os_source_id,
 *                           reason }],
 *         weak_data_profiles: [{ profile_id, display_name, score, missing[] }],
 *         totals: { runs, sources_failed_recent, stale_sources,
 *                   not_crawlable_sources, weak_data_profiles,
 *                   source_failure_rate },
 *         optional_tables: { rejection_log: bool },
 *       }
 */

import express from 'express'
import { SOURCES, getSource } from '../services/sourceRegistry.js'
import { classifyDisplaySource } from '../services/sourceRegistryParity.js'
import { checkProfileReadiness } from '../services/profileReadinessService.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:adminCrawlCoverage')
const router = express.Router()

function requireAdmin(req, res) {
  if (req.ctx && req.ctx.isAdmin === true) return true
  res.status(403).json({ error: 'Admin access required' })
  return false
}

// Trust tier → numeric rank so we can compute an avg_trust per run for the
// dashboard. Higher = more trustworthy. Unknown tiers contribute nothing.
const TRUST_RANK = Object.freeze({
  official_api: 5,
  official_portal: 4,
  verified_directory: 3,
  community_directory: 2,
  open_web: 1,
  manual_curated: 1,
})

function placeholders(isPg, startIndex, count) {
  return Array.from({ length: count }, (_, i) =>
    isPg ? `$${startIndex + i}` : '?',
  ).join(', ')
}

/**
 * Detect whether an optional table exists. Best-effort, never throws.
 */
async function tableExists(db, tableName) {
  if (!db?.prepare) return false
  const isPg = db?.dialect === 'postgres'
  try {
    if (isPg) {
      const row = await db
        .prepare('SELECT to_regclass($1) AS reg')
        .get(`public.${tableName}`)
      return Boolean(row?.reg)
    }
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(tableName)
    return Boolean(row?.name)
  } catch {
    return false
  }
}

/**
 * Build the per-run coverage rows from crawler_source_runs, enriched with
 * accepted/rejected counts (crawler_jobs.result_meta / rejection_log) and
 * avg_trust / avg_match where derivable.
 */
async function loadRuns(db, { profileId, limit }) {
  if (!db?.prepare) return []
  const isPg = db?.dialect === 'postgres'

  // Most-recent distinct run ids (optionally scoped to one profile).
  const params = []
  let where = ''
  if (profileId) {
    where = `WHERE profile_id = ${isPg ? '$1' : '?'}`
    params.push(String(profileId))
  }
  const limitPlaceholder = isPg ? `$${params.length + 1}` : '?'
  params.push(limit)

  const rollupSelect = (withMetrics) => `SELECT crawler_run_id,
                MAX(profile_id)   AS profile_id,
                MAX(crawler_type) AS crawler_type,
                MAX(created_at)   AS started_at,
                SUM(CASE WHEN planned THEN 1 ELSE 0 END)  AS sources_planned,
                SUM(CASE WHEN queried THEN 1 ELSE 0 END)  AS sources_queried,
                SUM(CASE WHEN failed  THEN 1 ELSE 0 END)  AS sources_failed,
                SUM(found) AS results_found${
                  withMetrics
                    ? `,
                SUM(accepted)        AS results_accepted,
                SUM(rejected)        AS results_rejected,
                SUM(match_score_sum) AS match_score_sum,
                SUM(match_score_n)   AS match_score_n`
                    : ''
                }
         FROM crawler_source_runs
         ${where}
         GROUP BY crawler_run_id
         ORDER BY started_at DESC
         LIMIT ${limitPlaceholder}`

  // Match telemetry lives in columns added by migration 166 / pg 0171. On a DB
  // that has not replayed them the rollup degrades to the legacy shape and every
  // run reports metrics_status:'not_recorded' — an honest "unknown", never a 0.
  let runRows = []
  let metricsAvailable = true
  try {
    runRows = await db.prepare(rollupSelect(true)).all(...params)
  } catch (metricErr) {
    metricsAvailable = false
    try {
      runRows = await db.prepare(rollupSelect(false)).all(...params)
    } catch (err) {
      // crawler_source_runs may not exist on a brand-new DB — that's fine.
      routeLogger.warn(
        `[CrawlCoverage] crawler_source_runs unavailable: ${err?.message ?? err} (metrics probe: ${metricErr?.message ?? metricErr})`,
      )
      return []
    }
  }

  if (runRows.length === 0) return []

  const runIds = runRows.map((r) => r.crawler_run_id).filter(Boolean)

  // Per-run failed-source detail (only the rows that actually failed).
  const failedBySrc = new Map()
  try {
    const ph = placeholders(isPg, 1, runIds.length)
    const failRows = await db
      .prepare(
        `SELECT crawler_run_id, source_id, source_label, error
         FROM crawler_source_runs
         WHERE failed AND crawler_run_id IN (${ph})`,
      )
      .all(...runIds)
    for (const row of failRows ?? []) {
      const list = failedBySrc.get(row.crawler_run_id) ?? []
      list.push({
        source_id: row.source_id,
        label: row.source_label || getSource(row.source_id)?.label || row.source_id,
        error: row.error || 'unknown',
      })
      failedBySrc.set(row.crawler_run_id, list)
    }
  } catch {
    // best-effort — leave failedBySrc empty
  }

  // Per-run avg_trust from the queried sources' registry trust tiers.
  const trustBySrc = new Map()
  try {
    const ph = placeholders(isPg, 1, runIds.length)
    const queriedRows = await db
      .prepare(
        `SELECT crawler_run_id, source_id
         FROM crawler_source_runs
         WHERE queried AND crawler_run_id IN (${ph})`,
      )
      .all(...runIds)
    for (const row of queriedRows ?? []) {
      const rank = TRUST_RANK[getSource(row.source_id)?.trust] ?? null
      if (rank === null || rank === undefined) continue
      const agg = trustBySrc.get(row.crawler_run_id) ?? { sum: 0, n: 0 }
      agg.sum += rank
      agg.n += 1
      trustBySrc.set(row.crawler_run_id, agg)
    }
  } catch {
    // best-effort
  }

  // Accepted / rejected / avg_match come from the ENGINE's own per-source
  // counters, recorded by crawlerOsCoveragePersistence into the columns added by
  // migration 166 / pg 0171.
  //
  // They used to be read from crawler_jobs.result_meta keyed on
  // meta.crawler_run_id, with rejection_log as a second fallback. NEITHER could
  // ever produce a number: measured in prod 2026-08-07, 0 of 15,740
  // result_meta rows contain `crawler_run_id` or `run_id` (that key is written
  // by nothing), and prod's rejection_log has no crawler_run_id column at all,
  // so its query threw into a silent catch on every request. That is why the
  // panel showed "—" in Accepted/Rejected/Avg-match for every run while Found
  // was populated. Both dead readers are removed rather than left to look like
  // coverage that exists.
  return runRows.map((r) => {
    const rid = r.crawler_run_id
    const trustAgg = trustBySrc.get(rid)
    const resultsFound = Number(r.results_found ?? 0)
    // A run predating migration 166 aggregates to NULL. NULL means UNKNOWN and
    // must not be shown as 0 — the dashboard renders it as "not recorded".
    const hasMetrics = metricsAvailable && r.results_accepted !== null && r.results_accepted !== undefined
    const matchN = Number(r.match_score_n ?? 0)
    return {
      crawler_run_id: rid,
      profile_id: r.profile_id ?? null,
      crawler_type: r.crawler_type ?? null,
      started_at: r.started_at ?? null,
      sources_planned: Number(r.sources_planned ?? 0),
      sources_queried: Number(r.sources_queried ?? 0),
      sources_failed: Number(r.sources_failed ?? 0),
      failed_sources: failedBySrc.get(rid) ?? [],
      results_found: resultsFound,
      results_accepted: hasMetrics ? Number(r.results_accepted ?? 0) : null,
      results_rejected: hasMetrics ? Number(r.results_rejected ?? 0) : null,
      avg_trust: trustAgg && trustAgg.n > 0 ? Number((trustAgg.sum / trustAgg.n).toFixed(2)) : null,
      avg_match:
        hasMetrics && matchN > 0
          ? Number((Number(r.match_score_sum ?? 0) / matchN).toFixed(2))
          : null,
      // Explicit so "—" can never mean both "zero" and "we never recorded it".
      metrics_status: hasMetrics ? 'recorded' : 'not_recorded',
    }
  })
}

/**
 * Sources whose most recent successful crawl is older than their registry
 * freshness window (or which have never run). Pure registry + per-source last
 * crawl from crawler_source_runs.
 */
async function loadStaleSources(db) {
  if (!db?.prepare) return []
  const lastBySrc = new Map()
  try {
    const rows = await db
      .prepare(
        `SELECT source_id, MAX(created_at) AS last_crawl
         FROM crawler_source_runs
         WHERE queried AND NOT failed
         GROUP BY source_id`,
      )
      .all()
    for (const row of rows ?? []) {
      if (row?.source_id) lastBySrc.set(row.source_id, row.last_crawl)
    }
  } catch {
    // table absent — every registry source is "never_run" below.
  }

  const now = Date.now()
  const stale = []
  for (const src of Object.values(SOURCES)) {
    const freshnessDays = Number(src?.freshness_days ?? 0)
    if (!freshnessDays) continue
    // Which crawler-os id (if any) actually runs this display source. 39 of the
    // 61 display sources have none — they can never write a crawler_source_runs
    // row, so calling them "never run" (with a Run-now button that can only 404
    // source_not_crawlable) blamed the scheduler for registry drift. They stay
    // LISTED — hiding them would hide the gap — but as `not_crawlable`.
    const parity = classifyDisplaySource(src.id)
    const lastCrawl = parity.runnable ? (lastBySrc.get(parity.crawler_os_source_id) ?? null) : null
    if (!parity.runnable) {
      stale.push({
        source_id: src.id,
        label: src.label ?? src.id,
        freshness_days: freshnessDays,
        last_crawl: lastBySrc.get(src.id) ?? null,
        days_since: null,
        failure_status: 'not_crawlable',
        runnable: false,
        crawler_os_source_id: null,
        reason: parity.reason,
      })
      continue
    }
    if (!lastCrawl) {
      stale.push({
        source_id: src.id,
        label: src.label ?? src.id,
        freshness_days: freshnessDays,
        last_crawl: null,
        days_since: null,
        failure_status: 'never_run',
        runnable: true,
        crawler_os_source_id: parity.crawler_os_source_id,
        reason: null,
      })
      continue
    }
    const ageMs = now - new Date(lastCrawl).getTime()
    const daysSince = Number.isFinite(ageMs) ? ageMs / 86_400_000 : null
    if (daysSince !== null && daysSince > freshnessDays) {
      stale.push({
        source_id: src.id,
        label: src.label ?? src.id,
        freshness_days: freshnessDays,
        last_crawl: lastCrawl,
        days_since: Number(daysSince.toFixed(1)),
        failure_status: 'stale',
        runnable: true,
        crawler_os_source_id: parity.crawler_os_source_id,
        reason: null,
      })
    }
  }
  // Actionable first: a runnable source that never ran or went stale is a real
  // crawler problem; a not_crawlable row is a registry-wiring backlog item and
  // sorts last so it can never crowd out the actionable ones.
  const rank = (s) => (s.failure_status === 'not_crawlable' ? 2 : s.days_since === null ? 0 : 1)
  stale.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return (b.days_since ?? 0) - (a.days_since ?? 0)
  })
  return stale
}

/**
 * Profiles whose readiness is missing high-value crawl-targeting fields
 * (applicant_type / location / intent). Delegates to the canonical
 * profileReadinessService so we don't re-implement field detection.
 */
async function loadWeakDataProfiles(db, { profileId, limit }) {
  if (!db?.prepare) return []
  let profiles = []
  try {
    if (profileId) {
      const row = await db
        .prepare('SELECT id, display_name FROM profiles WHERE id = ? LIMIT 1')
        .get(String(profileId))
      if (row) profiles = [row]
    } else {
      profiles = await db
        .prepare(
          `SELECT id, display_name FROM profiles
           WHERE status IS NULL OR status != 'deleted'
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(Math.min(limit * 5, 200))
    }
  } catch (err) {
    routeLogger.warn(`[CrawlCoverage] profiles query failed: ${err?.message ?? err}`)
    return []
  }

  const weak = []
  for (const p of profiles) {
    let readiness
    try {
      readiness = await checkProfileReadiness(db, p.id)
    } catch {
      continue
    }
    const missing = Array.isArray(readiness?.missing) ? readiness.missing : []
    const meaningful = missing.filter((m) => m !== 'profile_not_found' && m !== 'db_error')
    if (meaningful.length === 0) continue
    weak.push({
      profile_id: p.id,
      display_name: p.display_name ?? p.id,
      score: Number(readiness?.score ?? 0),
      missing: meaningful,
    })
  }
  weak.sort((a, b) => a.score - b.score)
  return weak.slice(0, limit)
}

/**
 * Amy's crawler-learning flywheel state, read-only and best-effort:
 *   - archetype_learning: the per-archetype gap classes currently steering the
 *     next crawl's web queries (with the Amy run + evidence that caused each);
 *   - archetype_metrics: the last few runs of per-archetype qualified /
 *     ineligible-accept counts, so evolution is verifiable on the dashboard.
 * Degrades to nulls when Amy has never run (or the store is unreadable).
 */
async function loadAmyLearning(db) {
  try {
    const { getArchetypeLearning, readArchetypeMetrics } = await import('../services/amy/archetypeLearning.js')
    const [learning, metrics] = await Promise.all([
      getArchetypeLearning(db).catch(() => null),
      readArchetypeMetrics(db).catch(() => null),
    ])
    return {
      archetype_learning: learning ?? null,
      archetype_metrics: Array.isArray(metrics?.runs) ? metrics.runs.slice(0, 5) : [],
      metrics_updated_at: metrics?.updated_at ?? null,
    }
  } catch {
    return { archetype_learning: null, archetype_metrics: [], metrics_updated_at: null }
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/crawl-coverage
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const db = req.db
  const profileId = req.query.profileId ? String(req.query.profileId) : null
  const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 25, 100))

  try {
    const [runs, staleSources, weakDataProfiles, hasRejectionLog, amyLearning] = await Promise.all([
      loadRuns(db, { profileId, limit }),
      loadStaleSources(db),
      loadWeakDataProfiles(db, { profileId, limit }),
      tableExists(db, 'rejection_log'),
      loadAmyLearning(db),
    ])

    const sourcesFailedRecent = runs.reduce((acc, r) => acc + Number(r.sources_failed || 0), 0)
    const sourcesQueriedRecent = runs.reduce((acc, r) => acc + Number(r.sources_queried || 0), 0)
    const sourceFailureRate =
      sourcesQueriedRecent > 0
        ? Number((sourcesFailedRecent / sourcesQueriedRecent).toFixed(3))
        : 0

    res.json({
      generated_at: new Date().toISOString(),
      filters: { profile_id: profileId, limit },
      runs,
      stale_sources: staleSources,
      weak_data_profiles: weakDataProfiles,
      amy_learning: amyLearning,
      totals: {
        runs: runs.length,
        sources_failed_recent: sourcesFailedRecent,
        sources_queried_recent: sourcesQueriedRecent,
        stale_sources: staleSources.filter((s) => s.failure_status !== 'not_crawlable').length,
        // Registry drift, counted separately so a wiring backlog can never be
        // read as a crawler that stopped running (see sourceRegistryParity.js).
        not_crawlable_sources: staleSources.filter((s) => s.failure_status === 'not_crawlable').length,
        weak_data_profiles: weakDataProfiles.length,
        source_failure_rate: sourceFailureRate,
      },
      optional_tables: { rejection_log: Boolean(hasRejectionLog) },
    })
  } catch (err) {
    routeLogger.error(`[CrawlCoverage] failed: ${err?.message ?? err}`)
    res.status(500).json({ error: 'Failed to build crawl coverage report' })
  }
})

export default router
