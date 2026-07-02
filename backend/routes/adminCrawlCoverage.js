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
 *           avg_trust, avg_match,
 *         } ],
 *         stale_sources: [{ source_id, label, freshness_days, last_crawl,
 *                           days_since, failure_status }],
 *         weak_data_profiles: [{ profile_id, display_name, score, missing[] }],
 *         totals: { runs, sources_failed_recent, stale_sources,
 *                   weak_data_profiles, source_failure_rate },
 *         optional_tables: { rejection_log: bool },
 *       }
 */

import express from 'express'
import { SOURCES, getSource } from '../services/sourceRegistry.js'
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

  let runRows = []
  try {
    runRows = await db
      .prepare(
        `SELECT crawler_run_id,
                MAX(profile_id)   AS profile_id,
                MAX(crawler_type) AS crawler_type,
                MAX(created_at)   AS started_at,
                SUM(CASE WHEN planned THEN 1 ELSE 0 END)  AS sources_planned,
                SUM(CASE WHEN queried THEN 1 ELSE 0 END)  AS sources_queried,
                SUM(CASE WHEN failed  THEN 1 ELSE 0 END)  AS sources_failed,
                SUM(found) AS results_found
         FROM crawler_source_runs
         ${where}
         GROUP BY crawler_run_id
         ORDER BY started_at DESC
         LIMIT ${limitPlaceholder}`,
      )
      .all(...params)
  } catch (err) {
    // crawler_source_runs may not exist on a brand-new DB — that's fine.
    routeLogger.warn(`[CrawlCoverage] crawler_source_runs unavailable: ${err?.message ?? err}`)
    return []
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

  // crawler_jobs: accepted count + avg match score. crawler_jobs has no
  // crawler_run_id FK, so we join on profile + time proximity is unreliable;
  // instead we read result_meta JSON which often carries { accepted, avg_match }.
  // We key by crawler_run_id when result_meta embeds it; otherwise this stays
  // null and the dashboard shows results_found only (honest degradation).
  const acceptedByRun = new Map()
  try {
    const jobRows = await db
      .prepare(
        `SELECT result_count, result_meta
         FROM crawler_jobs
         WHERE result_meta IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 500`,
      )
      .all()
    for (const job of jobRows ?? []) {
      let meta
      try {
        meta = typeof job.result_meta === 'string' ? JSON.parse(job.result_meta) : job.result_meta
      } catch {
        continue
      }
      const rid = meta?.crawler_run_id || meta?.run_id
      if (!rid) continue
      acceptedByRun.set(rid, {
        accepted: Number(
          meta.accepted ?? meta.results_accepted ?? meta.inserted ?? job.result_count ?? 0,
        ),
        rejected: Number(meta.rejected ?? meta.results_rejected ?? 0),
        avg_match: Number.isFinite(Number(meta.avg_match ?? meta.avg_match_score))
          ? Number(meta.avg_match ?? meta.avg_match_score)
          : null,
      })
    }
  } catch {
    // crawler_jobs / result_meta missing — accepted/avg_match stay null.
  }

  // OPTIONAL rejection_log: count rejected per run if the table exists.
  const rejectionByRun = new Map()
  if (await tableExists(db, 'rejection_log')) {
    try {
      const ph = placeholders(isPg, 1, runIds.length)
      const rejRows = await db
        .prepare(
          `SELECT crawler_run_id, COUNT(*) AS rejected
           FROM rejection_log
           WHERE crawler_run_id IN (${ph})
           GROUP BY crawler_run_id`,
        )
        .all(...runIds)
      for (const row of rejRows ?? []) {
        rejectionByRun.set(row.crawler_run_id, Number(row.rejected ?? 0))
      }
    } catch {
      // shape mismatch — ignore, degrade gracefully
    }
  }

  return runRows.map((r) => {
    const rid = r.crawler_run_id
    const accepted = acceptedByRun.get(rid) ?? null
    const trustAgg = trustBySrc.get(rid)
    const rejectionLogCount = rejectionByRun.has(rid) ? rejectionByRun.get(rid) : null
    const resultsFound = Number(r.results_found ?? 0)
    const resultsAccepted = accepted?.accepted ?? null
    const resultsRejected =
      rejectionLogCount !== null
        ? rejectionLogCount
        : accepted?.rejected !== null && accepted?.rejected !== undefined
          ? accepted.rejected
          : resultsAccepted !== null
            ? Math.max(0, resultsFound - resultsAccepted)
            : null
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
      results_accepted: resultsAccepted,
      results_rejected: resultsRejected,
      avg_trust: trustAgg && trustAgg.n > 0 ? Number((trustAgg.sum / trustAgg.n).toFixed(2)) : null,
      avg_match: accepted?.avg_match ?? null,
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
    const lastCrawl = lastBySrc.get(src.id) ?? null
    if (!lastCrawl) {
      stale.push({
        source_id: src.id,
        label: src.label ?? src.id,
        freshness_days: freshnessDays,
        last_crawl: null,
        days_since: null,
        failure_status: 'never_run',
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
      })
    }
  }
  // Worst offenders first: never-run, then most-overdue.
  stale.sort((a, b) => {
    if (a.days_since === null && b.days_since !== null) return -1
    if (b.days_since === null && a.days_since !== null) return 1
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
        stale_sources: staleSources.length,
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
