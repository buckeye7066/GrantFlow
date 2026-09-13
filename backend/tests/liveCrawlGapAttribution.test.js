/**
 * liveCrawlGapAttribution.test.js — the 7-day live-crawl gap metric must say
 * WHY each gap happened (primary attribution), WHO was measured (trigger
 * population + distinct profiles), WHEN (window bounds), and it must never
 * collapse an LLM outage, a transport failure, a gate rejection and a healthy
 * empty search into one "low_results" number.
 *
 *   webq-10 / livegap-3  result_floor_shortfall and low_results are counted
 *                        separately (no alias double count).
 *   livegap-1            an empty 7-day window says "no live crawls", never
 *                        falls back to lifetime totals.
 *   livegap-2            every recent record carries primary_attribution and
 *                        the day bucket tallies by_attribution.
 *   livegap-4            per-trigger + distinct-profile accounting, window
 *                        bounds, metric envelope on the Sam finding.
 *   samcheck-1           the Sam check honors an injected `now`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  classifyGaps,
  attributePrimaryGap,
  buildGapLearningUpdate,
  summarizeGapWindow,
  learnFromCrawlGaps,
  getCrawlerGapLearning,
  PRIMARY_ATTRIBUTIONS,
} from '../services/coverageAudit/liveCrawlGapLearning.js'
import { getCheckById } from '../services/sam/samRegistry.js'

const ledger = (over = {}) => ({
  ok: true,
  queries: ['a', 'b', 'c'],
  queries_planned: ['a', 'b', 'c', 'd', 'e'],
  pages: 20, fetched: 18, extracted: 6, stored: 2, deduped: 1, rejected: 2,
  query_ledger: { planned: [], executed: [], skipped_budget: [{ query: 'd' }, { query: 'e' }], skipped_duplicate: [] },
  stage_ledger: {
    query_generated: 5, query_skipped_duplicate: 0, query_skipped_budget: 2,
    provider_attempted: 3, provider_degraded: 0, provider_unavailable: 0,
    response_received: 18, candidates_extracted: 6, extraction_failed: 0, extraction_failed_by_class: {},
    canonical_duplicates: 1, reality_rejected: 2, eligibility_rejected: 0, need_match_rejected: 0, apply_target_rejected: 0,
    catalog_refused: 0, review_held: 1, qualified_admitted: 2,
  },
  provider_health: { search: 'healthy', llm: 'healthy', detail: {} },
  ...over,
})

describe('webq-10 / livegap-3 — the store counts the audit\'s OWN classes', () => {
  it('a floor-only shortfall is result_floor_shortfall alone; low_results only when the audit says so', () => {
    expect(classifyGaps({ below_result_target: true, low_results: false })).toEqual(['result_floor_shortfall'])
    expect(classifyGaps({ below_result_target: true, low_results: true })).toEqual(['result_floor_shortfall', 'low_results'])
    expect(classifyGaps({ below_result_target: false, low_results: true })).toEqual(['low_results'])
    const store = buildGapLearningUpdate(null, { below_result_target: true, low_results: false, gaps: ['result_floor_shortfall:5_of_20'] }, { profileId: 'p', at: '2026-09-12T00:00:00Z' })
    expect(store.totals.by_class.result_floor_shortfall).toBe(1)
    expect(store.totals.by_class.low_results).toBeUndefined()
  })
})

describe('attributePrimaryGap — one honest cause per crawl', () => {
  it('exports the exact vocabulary', () => {
    expect(PRIMARY_ATTRIBUTIONS).toEqual(expect.arrayContaining([
      'healthy_no_results', 'query_budget_truncation', 'provider_unavailable', 'provider_degraded',
      'extraction_failed', 'canonical_duplicate', 'gate_rejected', 'under_result_target', 'no_crawl', 'unknown',
    ]))
  })
  it('no ledger at all is unknown; a skipped lane is no_crawl', () => {
    expect(attributePrimaryGap({ ledger: null, audit: { has_gap: true } })).toBe('unknown')
    expect(attributePrimaryGap({ ledger: { skipped: true, reason: 'time_budget_exhausted' }, audit: { has_gap: true } })).toBe('no_crawl')
    expect(attributePrimaryGap({ ledger: { ok: false, reason: 'web_lane_deps_missing' }, audit: { has_gap: true } })).toBe('no_crawl')
  })
  it('every search query unavailable is provider_unavailable; a partial outage with nothing admitted is provider_degraded', () => {
    expect(attributePrimaryGap({ ledger: ledger({ pages: 0, fetched: 0, extracted: 0, stage_ledger: { ...ledger().stage_ledger, provider_attempted: 3, provider_unavailable: 3, response_received: 0, candidates_extracted: 0, qualified_admitted: 0 } }), audit: { has_gap: true } })).toBe('provider_unavailable')
    expect(attributePrimaryGap({ ledger: ledger({ pages: 2, fetched: 2, extracted: 0, stage_ledger: { ...ledger().stage_ledger, provider_degraded: 2, response_received: 2, candidates_extracted: 0, canonical_duplicates: 0, reality_rejected: 0, review_held: 0, qualified_admitted: 0 } }), audit: { has_gap: true } })).toBe('provider_degraded')
  })
  it('fetched pages with zero candidates and classified failures is extraction_failed:<dominant class>', () => {
    expect(attributePrimaryGap({ ledger: ledger({ extracted: 0, stored: 0, stage_ledger: { ...ledger().stage_ledger, candidates_extracted: 0, extraction_failed: 18, extraction_failed_by_class: { llm_quota: 17, llm_timeout: 1 }, canonical_duplicates: 0, reality_rejected: 0, review_held: 0, qualified_admitted: 0 } }), audit: { has_gap: true } }))
      .toBe('extraction_failed:llm_quota')
  })
  it('the dominant rejection gate names itself; most-deduped is canonical_duplicate', () => {
    const base = { ...ledger().stage_ledger, qualified_admitted: 0, review_held: 0, canonical_duplicates: 0, reality_rejected: 0 }
    expect(attributePrimaryGap({ ledger: ledger({ stage_ledger: { ...base, candidates_extracted: 6, eligibility_rejected: 4, need_match_rejected: 2 } }), audit: { has_gap: true } })).toBe('gate_rejected:eligibility')
    expect(attributePrimaryGap({ ledger: ledger({ stage_ledger: { ...base, candidates_extracted: 6, reality_rejected: 5, apply_target_rejected: 1 } }), audit: { has_gap: true } })).toBe('gate_rejected:reality')
    expect(attributePrimaryGap({ ledger: ledger({ stage_ledger: { ...base, candidates_extracted: 6, canonical_duplicates: 5, reality_rejected: 1 } }), audit: { has_gap: true } })).toBe('canonical_duplicate')
  })
  it('a healthy pipeline that admitted nothing is query_budget_truncation when planned queries were skipped, else healthy_no_results', () => {
    const base = { ...ledger().stage_ledger, candidates_extracted: 0, canonical_duplicates: 0, reality_rejected: 0, review_held: 0, qualified_admitted: 0 }
    expect(attributePrimaryGap({ ledger: ledger({ extracted: 0, stage_ledger: { ...base, query_skipped_budget: 2 } }), audit: { has_gap: true } })).toBe('query_budget_truncation')
    expect(attributePrimaryGap({ ledger: ledger({ extracted: 0, stage_ledger: { ...base, query_skipped_budget: 0 } }), audit: { has_gap: true } })).toBe('healthy_no_results')
  })
  it('a healthy pipeline that admitted rows but left the profile below target is under_result_target; at target there is nothing to attribute', () => {
    const healthy = ledger({ stage_ledger: { ...ledger().stage_ledger, query_skipped_budget: 0 } })
    expect(attributePrimaryGap({ ledger: healthy, audit: { has_gap: true, below_result_target: true } })).toBe('under_result_target')
    expect(attributePrimaryGap({ ledger: healthy, audit: { has_gap: true, hyperlocal_gap: true } })).toBe('under_result_target')
    expect(attributePrimaryGap({ ledger: healthy, audit: { has_gap: false } })).toBeNull()
    // Without an audit the lane cannot judge coverage: admitted rows → null (no lane-level gap).
    expect(attributePrimaryGap({ ledger: healthy, audit: null })).toBeNull()
  })
  it('an extraction outage outranks a budget skip and a gate outranks a degraded provider', () => {
    const dead = ledger({ extracted: 0, stage_ledger: { ...ledger().stage_ledger, candidates_extracted: 0, extraction_failed: 18, extraction_failed_by_class: { llm_unavailable: 18 }, query_skipped_budget: 22, canonical_duplicates: 0, reality_rejected: 0, review_held: 0, qualified_admitted: 0 } })
    expect(attributePrimaryGap({ ledger: dead, audit: { has_gap: true } })).toBe('extraction_failed:llm_unavailable')
    const gated = ledger({ stage_ledger: { ...ledger().stage_ledger, provider_degraded: 1, candidates_extracted: 3, need_match_rejected: 3, canonical_duplicates: 0, reality_rejected: 0, review_held: 0, qualified_admitted: 0 } })
    expect(attributePrimaryGap({ ledger: gated, audit: { has_gap: true } })).toBe('gate_rejected:need')
  })
})

describe('livegap-2 / livegap-4 — the store carries attribution, trigger and distinct profiles per day', () => {
  it('tallies by_attribution + by_trigger per day and counts distinct profiles', () => {
    let store = null
    const at = '2026-09-12T10:00:00Z'
    store = buildGapLearningUpdate(store, { below_result_target: true }, { profileId: 'A', at, attribution: 'extraction_failed:llm_quota', trigger: 'heal' })
    store = buildGapLearningUpdate(store, { below_result_target: true }, { profileId: 'A', at, attribution: 'extraction_failed:llm_quota', trigger: 'heal' })
    store = buildGapLearningUpdate(store, { has_gap: false }, { profileId: 'B', at, attribution: null, trigger: 'auth' })
    store = buildGapLearningUpdate(store, { hyperlocal_gap: true }, { profileId: 'C', at, attribution: 'gate_rejected:need', trigger: 'fleet' })
    const day = store.days['2026-09-12']
    expect(day.calls).toBe(4)
    expect(day.with_gap).toBe(3)
    expect(day.by_attribution).toEqual({ 'extraction_failed:llm_quota': 2, 'gate_rejected:need': 1 })
    expect(day.by_trigger).toEqual({ heal: 2, auth: 1, fleet: 1 })
    expect(day.with_gap_by_trigger).toEqual({ heal: 2, fleet: 1 })
    expect(day.distinct_profiles).toBe(3)
    expect(store.recent[0]).toMatchObject({ profile_id: 'C', primary_attribution: 'gate_rejected:need', trigger: 'fleet' })
    const win = summarizeGapWindow(store, { days: 7, nowMs: Date.parse(at) })
    expect(win.by_attribution).toEqual({ 'extraction_failed:llm_quota': 2, 'gate_rejected:need': 1 })
    expect(win.by_trigger).toEqual({ heal: 2, auth: 1, fleet: 1 })
    expect(win.distinct_profiles).toBe(3)
    expect(win.window_start).toBe('2026-09-06')
    expect(win.window_end).toBe('2026-09-12')
    expect(win.days_with_calls).toBe(1)
  })
})

describe('livegap-1 / samcheck-1 — Sam crawler.gapLearning window honesty', () => {
  let raw
  beforeEach(() => { raw = new Database(':memory:'); raw.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)') })
  afterEach(() => { raw.close() })
  const put = (store, updatedAt) => raw.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run('crawler_gap_learning', JSON.stringify(store), updatedAt)

  it('buckets present but all older than the window → "no live discovery in the last 7 days", never a lifetime verdict', async () => {
    const check = getCheckById('crawler.gapLearning')
    const oldDay = new Date(Date.now() - 20 * 86400000).toISOString()
    put({ totals: { calls: 100, with_gap: 60, by_class: { hyperlocal_gap: 60 } }, days: { [oldDay.slice(0, 10)]: { calls: 100, with_gap: 60, by_class: { hyperlocal_gap: 60 } } }, recent: [], updated_at: oldDay }, oldDay)
    const res = await check.run({ db: raw })
    expect(res.ok).toBe(false)
    expect(res.summary).not.toContain('pre-window')
    expect(res.summary).toMatch(/no live (crawls|discovery)/i)
    expect(res.summary).toContain('7 days')
    expect(res.evidence.windowed).toBe(true)
    expect(res.evidence.metric_envelope.measurement_window).toMatchObject({ kind: 'rolling_days', days: 7 })
    expect(res.evidence.metric_envelope.evaluated_count).toBe(0)
    expect(res.evidence.metric_envelope.freshness_at).toBe(oldDay)
  })

  it('honors an injected now: a July bucket is IN window for a July clock', async () => {
    const check = getCheckById('crawler.gapLearning')
    put({ totals: { calls: 10, with_gap: 1, by_class: {} }, days: { '2026-07-05': { calls: 10, with_gap: 1, by_class: { hyperlocal_gap: 1 } } }, recent: [], updated_at: '2026-07-05T12:00:00Z' }, '2026-07-05T12:00:00Z')
    const res = await check.run({ db: raw, now: new Date('2026-07-05T12:00:00Z') })
    expect(res.ok).toBe(true)
    expect(res.evidence?.windowed ?? true).toBe(true)
    expect(res.summary).toContain('1/10')
  })

  it('the finding states window, population, provider health and the attribution breakdown (metric envelope)', async () => {
    const check = getCheckById('crawler.gapLearning')
    const today = new Date().toISOString()
    put({
      totals: { calls: 40, with_gap: 30, by_class: { result_floor_shortfall: 30 } },
      days: { [today.slice(0, 10)]: {
        calls: 40, with_gap: 30, by_class: { result_floor_shortfall: 30 },
        by_attribution: { 'extraction_failed:llm_quota': 28, healthy_no_results: 2 },
        by_trigger: { heal: 25, auth: 15 }, with_gap_by_trigger: { heal: 25, auth: 5 },
        profile_ids: ['a', 'b', 'c'], distinct_profiles: 3,
      } },
      recent: [], updated_at: today,
    }, today)
    // Provider health comes from the lane store when present.
    const lane = { totals: { runs: 8 }, recent: Array.from({ length: 8 }, () => ({ at: today, ok: true, skipped: false, queries: 6, pages: 40, fetched: 38, extracted: 0, stored: 0, extraction_failed: 38, extraction_failed_by_class: { llm_quota: 38 }, provider_health: { search: 'healthy', llm: 'unavailable' } })) }
    raw.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run('web_lane_health', JSON.stringify(lane), today)
    const res = await check.run({ db: raw })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('30/40')
    expect(res.summary).toMatch(/extraction_failed:llm_quota ×28/)
    expect(res.summary).toMatch(/3 distinct profile/)
    expect(res.summary).toMatch(/heal ×25/)
    expect(res.evidence.by_attribution).toEqual({ 'extraction_failed:llm_quota': 28, healthy_no_results: 2 })
    expect(res.evidence.by_trigger).toEqual({ heal: 25, auth: 15 })
    expect(res.evidence.distinct_profiles).toBe(3)
    expect(res.evidence.metric_envelope).toMatchObject({
      measurement_window: { kind: 'rolling_days', days: 7 },
      evaluated_population: { kind: 'live_crawls' },
      evaluated_count: 40,
      sample_size: 40,
      provider_health: expect.objectContaining({ llm: 'unavailable' }),
    })
    expect(res.summary).toMatch(/llm[:= ]+unavailable/i)
  })
})

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, status TEXT DEFAULT 'active', created_by TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT, categories TEXT, opportunity_kind TEXT, is_active INTEGER DEFAULT 1, deadline TEXT, deadline_at TEXT, deadline_type TEXT);
    CREATE TABLE profile_opportunity_matches (profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT, matcher_version TEXT, match_explain_json TEXT);
    CREATE TABLE anya_brain_memory (
      id TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      scope TEXT NOT NULL DEFAULT 'global', scope_id TEXT, memory_type TEXT NOT NULL, memory_key TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '{}', confidence REAL DEFAULT 1.0, expires_at DATETIME, source TEXT DEFAULT 'system',
      access_count INTEGER DEFAULT 0, last_accessed_at DATETIME
    );
    CREATE UNIQUE INDEX idx_anya_brain_unique ON anya_brain_memory(scope, scope_id, memory_key);
    CREATE TABLE matching_low_coverage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, search_terms TEXT, free_text TEXT, qualified_count INTEGER, min_score INTEGER, intent_label TEXT, branded_program TEXT, recorded_at TEXT);
  `)
  return db
}

describe('learnFromCrawlGaps — the lane ledger travels into the record', () => {
  let db
  beforeEach(() => { db = createDb(); process.env.CRAWLER_GAP_LEARNING_ENABLED = 'true' })
  afterEach(() => { db.close() })

  it('a dead-LLM crawl on an empty profile is attributed extraction_failed:llm_quota, tagged with its trigger, and returned', async () => {
    db.prepare("INSERT INTO profiles (id, display_name, created_by) VALUES ('k', 'Kathy', 'system')").run()
    const dead = ledger({ extracted: 0, stored: 0, stage_ledger: { ...ledger().stage_ledger, candidates_extracted: 0, extraction_failed: 18, extraction_failed_by_class: { llm_quota: 18 }, canonical_duplicates: 0, reality_rejected: 0, review_held: 0, qualified_admitted: 0 }, provider_health: { search: 'healthy', llm: 'unavailable' } })
    const res = await learnFromCrawlGaps(db, { profileId: 'k', thesis: { is_student: false, schools: [], location: {}, needs: [] }, displayName: 'Kathy', laneLedger: dead, trigger: 'heal' })
    expect(res.has_gap).toBe(true)
    expect(res.primary_attribution).toBe('extraction_failed:llm_quota')
    const store = await getCrawlerGapLearning(db)
    expect(store.recent[0]).toMatchObject({ profile_id: 'k', primary_attribution: 'extraction_failed:llm_quota', trigger: 'heal' })
    expect(store.recent[0].lane).toMatchObject({ fetched: 18, extracted: 0, provider_health: { llm: 'unavailable' } })
    const day = Object.values(store.days)[0]
    expect(day.by_attribution).toEqual({ 'extraction_failed:llm_quota': 1 })
    expect(day.by_trigger).toEqual({ heal: 1 })
    // The brain memory carries the same attribution so Anya's next query plan can read it.
    const mem = db.prepare("SELECT content FROM anya_brain_memory WHERE scope_id='k' AND memory_key='crawler_gap'").get()
    expect(JSON.parse(mem.content).primary_attribution).toBe('extraction_failed:llm_quota')
    // …and the audit-own class list has NO low_results alias riding on the floor class.
    expect(JSON.parse(mem.content).classes).toContain('result_floor_shortfall')
  })
})
