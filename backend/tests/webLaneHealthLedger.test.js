/**
 * webLaneHealthLedger.test.js — the durable web-lane record tells the truth
 * about EFFORT and about WHICH LAYER died.
 *
 *   discovery-attrib-2  the ring stores executed queries, provider counts,
 *                       rejections, dedupes, provider_health, attribution.
 *   discovery-attrib-5  an extractor that fetches pages and extracts nothing
 *                       (with classified failures) is judged extraction_dead.
 *   weblane-1           skipped / no-crawl runs never count toward the DEAD
 *                       verdict; zero-page means "queries ran, nothing came back".
 *   getLastWebLaneRun   one bounded record per profile under
 *                       system_kv web_lane_last_run:<profileId> (lane E reads it).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildWebLaneHealthUpdate,
  summarizeRecentWebLane,
  recordWebLaneRun,
  getWebLaneHealth,
  getLastWebLaneRun,
  buildWebLaneRunRecord,
  MIN_RUNS_TO_JUDGE,
} from '../services/coverageAudit/webLaneHealth.js'
import { getCheckById } from '../services/sam/samRegistry.js'

const laneTelemetry = (over = {}) => ({
  ok: true,
  queries: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
  queries_planned: Array.from({ length: 28 }, (_, i) => `p${i}`),
  queries_executed: 6,
  pages: 44, pages_deduped: 3, seeded: 0, fetched: 40, extracted: 0, stored: 0, deduped: 0, rejected: 0,
  search_provenance: Array.from({ length: 6 }, (_, i) => ({ query_index: i, provider: 'searxng', status: 'ok', result_count: 8 })),
  search_provider_counts: { searxng: 6 },
  search_cache_hits: 0, search_unknown_provenance_count: 0, search_degraded_queries: 0, search_unavailable_queries: 0,
  query_ledger: { planned: [], executed: [], skipped_budget: Array.from({ length: 22 }, (_, i) => ({ query: `p${i + 6}`, tier: 'breadth' })), skipped_duplicate: [] },
  stage_ledger: {
    query_generated: 28, query_skipped_duplicate: 0, query_skipped_budget: 22,
    provider_attempted: 6, provider_degraded: 0, provider_unavailable: 0,
    response_received: 40, candidates_extracted: 0, extraction_failed: 40, extraction_failed_by_class: { llm_quota: 40 },
    canonical_duplicates: 0, reality_rejected: 0, eligibility_rejected: 0, need_match_rejected: 0, apply_target_rejected: 0,
    catalog_refused: 0, review_held: 0, qualified_admitted: 0,
  },
  page_ledger: Array.from({ length: 44 }, (_, i) => ({ url: `https://x.org/${i}`, canonical_key: `https://x.org/${i}`, query: 'q1', fetched: i < 40, fetch_status: i < 40 ? 200 : 404, extracted: 0, extraction_failure: i < 40 ? 'llm_quota' : null, reality_rejected: 0, gate_rejected: { eligibility: 0, need: 0, apply_target: 0 }, canonical_duplicate: 0, admitted: 0 })),
  provider_health: { search: 'healthy', llm: 'unavailable', detail: { search: { attempted: 6 }, llm: { failed_by_class: { llm_quota: 40 } } } },
  primary_attribution: 'extraction_failed:llm_quota',
  extraction_available: false,
  reason: 'extraction_failed:llm_quota',
  ...over,
})

describe('discovery-attrib-2 — the ring entry records effort and outcome truthfully', () => {
  it('stores executed vs planned, provider counts, stage counters, provider_health and attribution', async () => {
    const db = new Database(':memory:')
    try {
      const res = await recordWebLaneRun(db, { profileId: 'p1', telemetry: laneTelemetry(), trigger: 'heal' })
      expect(res.ok).toBe(true)
      const store = await getWebLaneHealth(db)
      const e = store.recent[0]
      expect(e).toMatchObject({
        profile_id: 'p1', trigger: 'heal', skipped: false,
        queries: 6, queries_planned: 28, queries_skipped_budget: 22, queries_skipped_duplicate: 0,
        pages: 44, pages_deduped: 3, fetched: 40, extracted: 0, stored: 0,
        extraction_failed: 40,
        search_provider_counts: { searxng: 6 },
        search_degraded_queries: 0, search_unavailable_queries: 0,
        provider_health: { search: 'healthy', llm: 'unavailable' },
        primary_attribution: 'extraction_failed:llm_quota',
        reason: 'extraction_failed:llm_quota',
      })
      expect(e.extraction_failed_by_class).toEqual({ llm_quota: 40 })
      expect(e.stage_ledger.qualified_admitted).toBe(0)
      // The ring stays BOUNDED: no per-page ledger in the 30-run ring.
      expect(e.page_ledger).toBeUndefined()
      expect(e.pages_ledger).toBeUndefined()
      expect(store.totals.zero_extract_runs).toBe(1)
      expect(store.totals.zero_page_runs).toBe(0)
    } finally { db.close() }
  })
})

describe('getLastWebLaneRun — one bounded full record per profile', () => {
  it('round-trips the full record (pages bounded) under web_lane_last_run:<profileId> and overwrites on the next run', async () => {
    const db = new Database(':memory:')
    try {
      await recordWebLaneRun(db, { profileId: 'p1', telemetry: laneTelemetry(), trigger: 'auth', at: '2026-09-12T10:00:00Z' })
      const first = await getLastWebLaneRun(db, 'p1')
      expect(first).toMatchObject({ profile_id: 'p1', at: '2026-09-12T10:00:00Z', trigger: 'auth', queries: laneTelemetry().queries, primary_attribution: 'extraction_failed:llm_quota' })
      expect(first.pages).toHaveLength(44)
      expect(first.pages[0]).toMatchObject({ url: 'https://x.org/0', fetched: true, extraction_failure: 'llm_quota' })
      expect(first.query_ledger.skipped_budget).toHaveLength(22)
      expect(first.stage_ledger.extraction_failed_by_class).toEqual({ llm_quota: 40 })
      expect(first.provider_health.llm).toBe('unavailable')
      expect(first.results_per_query).toBeDefined()
      expect(first.max_pages).toBeDefined()

      await recordWebLaneRun(db, { profileId: 'p1', telemetry: laneTelemetry({ extracted: 3, stage_ledger: { ...laneTelemetry().stage_ledger, candidates_extracted: 3, extraction_failed: 0, extraction_failed_by_class: {} }, provider_health: { search: 'healthy', llm: 'healthy' }, primary_attribution: null, reason: null, extraction_available: true }), at: '2026-09-12T11:00:00Z' })
      const second = await getLastWebLaneRun(db, 'p1')
      expect(second.at).toBe('2026-09-12T11:00:00Z')
      expect(second.extracted).toBe(3)
      expect(await getLastWebLaneRun(db, 'nobody')).toBeNull()
      const rows = db.prepare("SELECT key FROM system_kv WHERE key LIKE 'web_lane_last_run:%'").all()
      expect(rows).toHaveLength(1)
    } finally { db.close() }
  })

  it('buildWebLaneRunRecord bounds the page ledger to max_pages entries', () => {
    const rec = buildWebLaneRunRecord(laneTelemetry({ page_ledger: Array.from({ length: 200 }, (_, i) => ({ url: `https://y.org/${i}` })), max_pages: 44 }), { profileId: 'p', at: 't' })
    expect(rec.pages).toHaveLength(44)
    expect(rec.pages_truncated).toBe(156)
  })
})

describe('weblane-1 — skipped and no-crawl runs never count toward DEAD', () => {
  it('six time-budget skips are reported as skipped, not as a dead search backend', () => {
    let store = null
    for (let i = 0; i < 6; i++) store = buildWebLaneHealthUpdate(store, { at: 't', profile_id: `p${i}`, skipped: true, reason: 'time_budget_exhausted' })
    const s = summarizeRecentWebLane(store)
    expect(s.dead).toBe(false)
    expect(s.skipped).toBe(6)
    expect(s.judged).toBe(0)
    expect(store.totals.zero_page_runs).toBe(0)
    expect(store.totals.skipped_runs).toBe(6)
  })
  it('a deps-missing lane (zero queries executed, zero pages) is a no-crawl, not a zero-page run', () => {
    let store = null
    for (let i = 0; i < 6; i++) store = buildWebLaneHealthUpdate(store, { at: 't', profile_id: `p${i}`, ok: false, queries: 0, pages: 0, reason: 'web_lane_deps_missing' })
    const s = summarizeRecentWebLane(store)
    expect(s.dead).toBe(false)
    expect(s.no_crawl).toBe(6)
  })
  it('the legacy dead verdict (queries ran, zero pages) still fires, and is NOT diluted by interleaved skips', () => {
    let store = null
    for (let i = 0; i < MIN_RUNS_TO_JUDGE; i++) {
      store = buildWebLaneHealthUpdate(store, { at: 't', profile_id: 'p', ok: true, queries: 6, pages: 0, error: 'search backend down' })
      store = buildWebLaneHealthUpdate(store, { at: 't', profile_id: 'p', skipped: true, reason: 'time_budget_exhausted' })
    }
    const s = summarizeRecentWebLane(store, { lastN: 20 })
    expect(s.judged).toBe(MIN_RUNS_TO_JUDGE)
    expect(s.dead).toBe(true)
  })
})

describe('discovery-attrib-5 — a dead extractor is judged extraction_dead', () => {
  it('eight runs with pages fetched, zero extracted and classified LLM failures → extraction_dead with the dominant class', () => {
    let store = null
    for (let i = 0; i < 8; i++) store = buildWebLaneHealthUpdate(store, buildWebLaneRunRecord(laneTelemetry(), { profileId: `p${i}`, at: 't' }))
    const s = summarizeRecentWebLane(store)
    expect(s.dead).toBe(false)
    expect(s.extraction_dead).toBe(true)
    expect(s.zero_extract).toBe(8)
    expect(s.extraction_failed_by_class).toEqual({ llm_quota: 320 })
    expect(s.dominant_extraction_failure).toBe('llm_quota')
    expect(s.provider_health).toMatchObject({ search: 'healthy', llm: 'unavailable' })
  })
  it('thin pages alone (page_too_short) are not an extractor death, and one healthy extraction clears the verdict', () => {
    let store = null
    for (let i = 0; i < 8; i++) store = buildWebLaneHealthUpdate(store, buildWebLaneRunRecord(laneTelemetry({ stage_ledger: { ...laneTelemetry().stage_ledger, extraction_failed_by_class: { page_too_short: 40 } }, provider_health: { search: 'healthy', llm: 'unknown' } }), { profileId: 'p', at: 't' }))
    expect(summarizeRecentWebLane(store).extraction_dead).toBe(false)
    store = buildWebLaneHealthUpdate(null, buildWebLaneRunRecord(laneTelemetry(), { profileId: 'p', at: 't' }))
    for (let i = 0; i < 7; i++) store = buildWebLaneHealthUpdate(store, buildWebLaneRunRecord(laneTelemetry(), { profileId: 'p', at: 't' }))
    store = buildWebLaneHealthUpdate(store, buildWebLaneRunRecord(laneTelemetry({ extracted: 2, stage_ledger: { ...laneTelemetry().stage_ledger, candidates_extracted: 2, extraction_failed: 0, extraction_failed_by_class: {} }, provider_health: { search: 'healthy', llm: 'healthy' } }), { profileId: 'p', at: 't' }))
    expect(summarizeRecentWebLane(store).extraction_dead).toBe(false)
  })
  it('Sam crawler.webLaneHealth reds out on extraction_dead naming the LLM layer + class, with a metric envelope', async () => {
    const check = getCheckById('crawler.webLaneHealth')
    const db = new Database(':memory:')
    try {
      for (let i = 0; i < 8; i++) await recordWebLaneRun(db, { profileId: `p${i}`, telemetry: laneTelemetry() })
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/extract/i)
      expect(res.summary).toMatch(/llm_quota/)
      expect(res.summary).not.toMatch(/ZERO search pages/)
      expect(res.recommended_fix).toMatch(/LLM|Anthropic|OpenAI|credit/i)
      expect(res.evidence.metric_envelope).toMatchObject({ evaluated_population: { kind: 'web_lane_runs' }, evaluated_count: 8, provider_health: expect.objectContaining({ llm: 'unavailable' }) })
      expect(res.evidence.extraction_failed_by_class).toEqual({ llm_quota: 320 })
      // And it recovers: healthy extraction → green.
      for (let i = 0; i < 8; i++) await recordWebLaneRun(db, { profileId: `r${i}`, telemetry: laneTelemetry({ extracted: 2, stage_ledger: { ...laneTelemetry().stage_ledger, candidates_extracted: 2, extraction_failed: 0, extraction_failed_by_class: {} }, provider_health: { search: 'healthy', llm: 'healthy' }, primary_attribution: null, reason: null }) })
      const ok = await check.run({ db })
      expect(ok.ok).toBe(true)
      expect(ok.evidence.metric_envelope.evaluated_count).toBe(8)
    } finally { db.close() }
  })
})
