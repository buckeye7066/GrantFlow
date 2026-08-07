/**
 * Guard for the admin Crawl Coverage dashboard's Accepted / Rejected /
 * Avg-match columns, which rendered "—" for EVERY run while Found was
 * populated (owner report, 2026-08-06).
 *
 * The cause was write-side: crawler_source_runs stored only
 * planned/queried/failed/found, and the route's two readers could never
 * produce a number —
 *   - crawler_jobs.result_meta was keyed on meta.crawler_run_id, and 0 of the
 *     15,740 prod rows with result_meta contain that key (nothing writes it);
 *   - rejection_log has no crawler_run_id column in prod at all, so the join
 *     threw into a silent catch on every request.
 *
 * Now the engine's own per-source counters are persisted (migration 166 /
 * pg 0171) and read back. These tests prove the FULL chain: engine tally →
 * crawlerOsCoveragePersistence → GET /api/admin/crawl-coverage, and that a run
 * with no recorded metrics reports 'not_recorded' rather than a fake 0.
 */

import request from 'supertest'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import crypto from 'crypto'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'
import { persistSourceCoverage } from '../services/crawlerOsCoveragePersistence.js'

const METRIC_COLUMNS = `
  parsed_candidates INTEGER, rejected INTEGER, accepted INTEGER,
  match_score_sum REAL, match_score_n INTEGER,`

function ensureTable(db, { withMetrics = true } = {}) {
  db.prepare('DROP TABLE IF EXISTS crawler_source_runs').run()
  db.prepare(
    `CREATE TABLE crawler_source_runs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       crawler_run_id TEXT NOT NULL,
       profile_id TEXT,
       crawler_type TEXT,
       source_id TEXT NOT NULL,
       source_label TEXT,
       planned INTEGER NOT NULL DEFAULT 0,
       queried INTEGER NOT NULL DEFAULT 0,
       failed INTEGER NOT NULL DEFAULT 0,
       found INTEGER NOT NULL DEFAULT 0,
       directory INTEGER NOT NULL DEFAULT 0,
       ${withMetrics ? METRIC_COLUMNS : ''}
       duration_ms INTEGER,
       error TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
  ).run()
}

// The exact shape crawler-os pipeline.js finishSource() emits per source.
const SOURCE_SUMMARIES = [
  {
    source_id: 'grants_gov',
    outcome: 'ok',
    reason: null,
    parsed: 7,
    rejected: 2,
    stored: 3,
    existing: 1,
    accepted: 2,
    match_score_sum: 130,
    match_score_n: 4,
  },
  {
    source_id: 'sba_grants',
    outcome: 'ok',
    reason: null,
    parsed: 2,
    rejected: 1,
    stored: 1,
    existing: 0,
    accepted: 1,
    match_score_sum: 50,
    match_score_n: 1,
  },
]

describe('crawl coverage match metrics (accepted / rejected / avg_match)', () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 180_000)

  beforeEach(() => {
    resetDb(db)
    ensureTable(db)
  })

  it('persists the engine\'s per-source accepted / rejected / match tallies', async () => {
    const runId = crypto.randomUUID()
    const res = await persistSourceCoverage(db, {
      crawlerRunId: runId,
      profileId: 'p-metrics',
      crawlerType: 'crawler-os',
      sources: SOURCE_SUMMARIES,
    })
    expect(res.written).toBe(2)

    const rows = db
      .prepare('SELECT * FROM crawler_source_runs WHERE crawler_run_id = ? ORDER BY source_id')
      .all(runId)
    const grantsGov = rows.find((r) => r.source_id === 'grants_gov')
    expect(grantsGov.accepted).toBe(2)
    expect(grantsGov.rejected).toBe(2)
    expect(grantsGov.parsed_candidates).toBe(7)
    expect(grantsGov.match_score_sum).toBe(130)
    expect(grantsGov.match_score_n).toBe(4)
  })

  it('reports real accepted / rejected / avg_match on GET /api/admin/crawl-coverage', async () => {
    const runId = crypto.randomUUID()
    await persistSourceCoverage(db, {
      crawlerRunId: runId,
      profileId: 'p-metrics',
      crawlerType: 'crawler-os',
      sources: SOURCE_SUMMARIES,
    })

    const res = await request(app).get('/api/admin/crawl-coverage').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    const run = res.body.runs.find((r) => r.crawler_run_id === runId)
    expect(run).toBeTruthy()
    // found = stored + existing across sources
    expect(run.results_found).toBe(5)
    // These three are the columns that used to be "—" on every single run.
    expect(run.results_accepted).toBe(3)
    expect(run.results_rejected).toBe(3)
    expect(run.avg_match).toBe(36) // (130 + 50) / (4 + 1)
    expect(run.metrics_status).toBe('recorded')
  })

  it('a run with no recorded metrics is labelled not_recorded, never a fake zero', async () => {
    const runId = crypto.randomUUID()
    // A legacy row: written before migration 166 added the metric columns.
    db.prepare(
      `INSERT INTO crawler_source_runs
         (crawler_run_id, profile_id, crawler_type, source_id, source_label,
          planned, queried, failed, found, directory)
       VALUES (?, ?, ?, ?, ?, 1, 1, 0, 9, 0)`,
    ).run(runId, 'p-legacy', 'comprehensive', 'grants_gov', 'Grants.gov')

    const res = await request(app).get('/api/admin/crawl-coverage').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    const run = res.body.runs.find((r) => r.crawler_run_id === runId)
    expect(run).toBeTruthy()
    expect(run.results_found).toBe(9)
    expect(run.metrics_status).toBe('not_recorded')
    expect(run.results_accepted).toBeNull()
    expect(run.results_rejected).toBeNull()
    expect(run.avg_match).toBeNull()
  })

  it('degrades to the legacy row shape (never loses coverage) when the columns are absent', async () => {
    ensureTable(db, { withMetrics: false })
    const runId = crypto.randomUUID()
    const res = await persistSourceCoverage(db, {
      crawlerRunId: runId,
      profileId: 'p-old-schema',
      crawlerType: 'crawler-os',
      sources: SOURCE_SUMMARIES,
    })
    expect(res.written).toBe(2)

    const api = await request(app).get('/api/admin/crawl-coverage').set(TEST_ADMIN_AUTH_HEADER)
    expect(api.status).toBe(200)
    const run = api.body.runs.find((r) => r.crawler_run_id === runId)
    expect(run.results_found).toBe(5)
    expect(run.metrics_status).toBe('not_recorded')
  })

  // ---- stale-source runnability (registry drift) ----

  it('a display source with no crawler-os lane is not_crawlable, not "never run"', async () => {
    const res = await request(app).get('/api/admin/crawl-coverage').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    // overpass_local exists only in the DISPLAY catalog — no crawler can run it,
    // and "Run now" on it can only 404 source_not_crawlable.
    const row = res.body.stale_sources.find((s) => s.source_id === 'overpass_local')
    expect(row).toBeTruthy()
    expect(row.failure_status).toBe('not_crawlable')
    expect(row.runnable).toBe(false)
    expect(typeof row.reason).toBe('string')
    expect(res.body.totals.not_crawlable_sources).toBeGreaterThan(0)
  })

  it('an aliased display source reads the crawler-os id\'s freshness, so a live lane is not "never run"', async () => {
    // sam_gov_assistance_listings (display) is sam_gov (engine). A recent
    // sam_gov row must clear the display row from the stale list entirely.
    db.prepare(
      `INSERT INTO crawler_source_runs
         (crawler_run_id, profile_id, crawler_type, source_id, source_label,
          planned, queried, failed, found, directory, created_at)
       VALUES (?, NULL, 'crawler-os', 'sam_gov', 'SAM.gov', 1, 1, 0, 2, 0, ?)`,
    ).run(crypto.randomUUID(), new Date().toISOString())

    const res = await request(app).get('/api/admin/crawl-coverage').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    const row = res.body.stale_sources.find((s) => s.source_id === 'sam_gov_assistance_listings')
    expect(row).toBeUndefined()
  })

  it('a runnable source that truly never ran still reports never_run (recall is not hidden)', async () => {
    const res = await request(app).get('/api/admin/crawl-coverage').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    const neverRun = res.body.stale_sources.filter((s) => s.failure_status === 'never_run')
    expect(neverRun.length).toBeGreaterThan(0)
    for (const row of neverRun) expect(row.runnable).toBe(true)
  })
})
