/**
 * webLaneSourceSummary.test.js — discovery-attrib-6: the open-web lane lands in
 * crawler_source_runs as a synthetic `web_search` source row with the SAME
 * column semantics the registry sources use, so the admin Crawl Coverage
 * dashboard carries the lane that finds county / community / foundation funding.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { webLaneSourceSummary, persistSourceCoverage, WEB_LANE_SOURCE_ID } from '../services/crawlerOsCoveragePersistence.js'

const lane = (over = {}) => ({
  ok: true,
  queries: ['a', 'b'],
  pages: 12, fetched: 10, extracted: 5, stored: 2, deduped: 1, rejected: 2,
  stage_ledger: {
    provider_attempted: 2, provider_unavailable: 0, candidates_extracted: 5, reality_rejected: 1, catalog_refused: 1,
    canonical_duplicates: 1, qualified_admitted: 1, extraction_failed: 0, extraction_failed_by_class: {},
  },
  provider_health: { search: 'healthy', llm: 'healthy' },
  primary_attribution: null,
  reason: null,
  ...over,
})

describe('webLaneSourceSummary', () => {
  it('maps a productive lane run onto the registry per-source shape (OK)', () => {
    const s = webLaneSourceSummary(lane())
    expect(s).toMatchObject({ source_id: WEB_LANE_SOURCE_ID, outcome: 'ok', fetched: 10, parsed: 5, rejected: 2, stored: 2, existing: 1, accepted: 1 })
  })
  it('a lane that ran and stored nothing is EMPTY; a dead extractor keeps EMPTY but names the reason', () => {
    expect(webLaneSourceSummary(lane({ stored: 0 })).outcome).toBe('empty')
    const dead = webLaneSourceSummary(lane({ stored: 0, extracted: 0, reason: 'extraction_failed:llm_quota', provider_health: { search: 'healthy', llm: 'unavailable' }, primary_attribution: 'extraction_failed:llm_quota' }))
    expect(dead).toMatchObject({ outcome: 'empty', reason: 'extraction_failed:llm_quota', primary_attribution: 'extraction_failed:llm_quota' })
  })
  it('a skipped lane is SKIPPED, a lane whose every search failed is ERROR, no lane is null', () => {
    expect(webLaneSourceSummary({ skipped: true, reason: 'time_budget_exhausted' })).toMatchObject({ outcome: 'skipped', reason: 'time_budget_exhausted' })
    expect(webLaneSourceSummary(lane({ provider_health: { search: 'unavailable', llm: 'unknown' }, stored: 0 })).outcome).toBe('error')
    expect(webLaneSourceSummary(null)).toBeNull()
  })
  it('the row is written to crawler_source_runs beside the registry rows', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE crawler_source_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, crawler_run_id TEXT, profile_id TEXT, crawler_type TEXT, source_id TEXT, source_label TEXT,
        planned INTEGER, queried INTEGER, failed INTEGER, found INTEGER, directory INTEGER, error TEXT,
        parsed_candidates INTEGER, rejected INTEGER, accepted INTEGER, match_score_sum REAL, match_score_n INTEGER)`)
      const res = await persistSourceCoverage(db, {
        crawlerRunId: 'run-1', profileId: 'p1', crawlerType: 'crawler-os',
        sources: [{ source_id: 'grants_gov', outcome: 'ok', stored: 3 }, webLaneSourceSummary(lane())],
      })
      expect(res.written).toBe(2)
      const row = db.prepare("SELECT * FROM crawler_source_runs WHERE source_id = 'web_search'").get()
      expect(row).toMatchObject({ crawler_run_id: 'run-1', profile_id: 'p1', queried: 1, failed: 0, found: 3, parsed_candidates: 5, rejected: 2, accepted: 1 })
    } finally { db.close() }
  })
})
