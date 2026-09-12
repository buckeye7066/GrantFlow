/**
 * webLaneLedger.test.js — REQUIREMENT E: the open-web lane emits a STRUCTURED,
 * BOUNDED ledger from its one execution path.
 *
 *   webq-1   result.queries = the queries that EXECUTED; the plan is reported
 *            separately with what the page budget skipped.
 *   webq-7   extraQueries are deduped against the plan by normalizeQueryKey
 *            (case/whitespace/punctuation variants), never by exact string.
 *   attrib-4 pages dedupe on the canonical FETCH identity (tracking params +
 *            fragment stripped) so an alias is never fetched or extracted twice.
 *   attrib-3 every stage has a counter: reality / eligibility / need /
 *            apply-target rejections, canonical duplicates, admissions.
 *   extractor death is CLASSIFIED (llm_quota / llm_timeout / …) and reported
 *            as provider_health.llm = unavailable + a reason, never ok+silence.
 */
import { describe, it, expect, vi } from 'vitest'
import { runWebDiscoveryLane } from '../crawler-os/webLane.js'
import { createMemoryStore } from '../crawler-os/index.js'
import { normalizeQueryKey } from '../crawler-os/webQueries.js'

const thesis = {
  profile_id: 'p1',
  applicant_types: ['nonprofit'],
  needs: ['youth', 'after school'],
  needs_defaulted: false,
  location: { state: 'TN', city: 'Nashville' },
  loan_allowed: false,
  cost_share_allowed: true,
}

const richThesis = {
  applicant_types: ['student', 'individual'],
  is_student: true,
  needs: ['scholarship', 'education', 'housing', 'fafsa', 'first_gen'],
  needs_defaulted: false,
  location: { state: 'TN', city: 'Murfreesboro' },
  interest_terms: ['nursing', 'biology'],
  schools: ['Example University'],
}

function fakeFetcher(bodyByUrl) {
  return {
    fetch: vi.fn(async (url) => {
      if (bodyByUrl[url] === undefined || bodyByUrl[url] === null) return { ok: false, status: 404 }
      return { ok: true, status: 200, body: bodyByUrl[url], finalUrl: url, contentHash: 'hash-' + url.length, fetchedAt: '2026-09-12T00:00:00Z' }
    }),
  }
}

function withMeta(rows, meta) {
  const results = [...rows]
  Object.defineProperty(results, 'searchMeta', { value: Object.freeze(meta), enumerable: false })
  return results
}

function withFailure(arr, failure) {
  Object.defineProperty(arr, 'extraction_failure', { value: failure, enumerable: false })
  return arr
}

const realOpp = (over = {}) => ({
  title: 'Nashville Youth Services Grant',
  funder: 'Nashville Community Foundation',
  summary: 'Grants to nonprofits serving youth and after school programs in Tennessee',
  deadline: '2027-12-01',
  apply_url: 'https://nyf.org/grant/apply',
  state: 'TN',
  need_categories: ['youth'],
  relevant: true,
  ...over,
})

describe('webq-1 — result.queries is what EXECUTED; the plan and the budget skips are reported apart', () => {
  it('reports 6 executed of 28 planned under the 44-page cap, with tiers and skipped_budget', async () => {
    const executed = []
    const searchWeb = async (query, { count }) => {
      executed.push(query)
      return Array.from({ length: count }, (_, hit) => ({ url: `https://fixture.invalid/${executed.length}/${hit}`, title: `R${hit}`, snippet: '' }))
    }
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({}), searchWeb, extractOpportunities: vi.fn() },
      { thesis: richThesis, runId: 'ledger-1', maxQueries: 28, resultsPerQuery: 8, maxPages: 44, seed: 0 },
    )
    expect(executed).toHaveLength(6)
    expect(res.queries).toEqual(executed)
    expect(res.queries_executed).toBe(6)
    expect(res.queries_planned).toHaveLength(28)
    expect(res.query_ledger.planned).toHaveLength(28)
    expect(res.query_ledger.planned[0]).toMatchObject({ query: expect.any(String), tier: expect.any(String), family: expect.any(String) })
    expect(res.query_ledger.executed).toHaveLength(6)
    expect(res.query_ledger.executed[0]).toMatchObject({ query: executed[0], tier: expect.any(String), provider: expect.any(String), status: expect.any(String), result_count: 8, new_pages: 8 })
    expect(res.query_ledger.skipped_budget).toHaveLength(22)
    expect(res.query_ledger.skipped_budget[0]).toMatchObject({ query: expect.any(String), tier: expect.any(String) })
    expect(res.stage_ledger.query_generated).toBe(28)
    expect(res.stage_ledger.query_skipped_budget).toBe(22)
    expect(res.stage_ledger.provider_attempted).toBe(6)
    // Budget: pages never exceed the cap, provider calls never exceed the plan.
    expect(res.pages).toBeLessThanOrEqual(44)
    expect(res.stage_ledger.provider_attempted).toBeLessThanOrEqual(28)
  })
})

describe('webq-7 — extraQueries dedupe against the plan on the normalized key', () => {
  it('a directive that differs only by case/whitespace from a planned query runs once and is recorded as a duplicate', async () => {
    const planned = []
    const first = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({}), searchWeb: vi.fn().mockResolvedValue([]), extractOpportunities: vi.fn() },
      { thesis: richThesis, runId: 'dup-0', maxQueries: 10, seed: 0 },
    )
    planned.push(...first.queries_planned)
    const target = planned[3]
    const variant = `  ${target.toUpperCase().replace(/\s+/g, '   ')}  `
    expect(variant).not.toBe(target)
    expect(normalizeQueryKey(variant)).toBe(normalizeQueryKey(target))

    const executed = []
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({}), searchWeb: async (q) => { executed.push(q); return [] }, extractOpportunities: vi.fn() },
      { thesis: richThesis, runId: 'dup-1', maxQueries: 10, seed: 0, extraQueries: [variant, 'Unique Directive Query'] },
    )
    const keys = executed.map(normalizeQueryKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter((k) => k === normalizeQueryKey(target))).toHaveLength(1)
    expect(res.query_ledger.skipped_duplicate).toEqual(expect.arrayContaining([
      expect.objectContaining({ duplicate_of: expect.any(String) }),
    ]))
    expect(res.stage_ledger.query_skipped_duplicate).toBeGreaterThanOrEqual(1)
    expect(res.query_ledger.planned.some((e) => e.query === 'Unique Directive Query' && e.tier === 'directive')).toBe(true)
  })
})

describe('attrib-4 — page dedupe keys on the canonical fetch identity', () => {
  it('a utm/fragment alias of an already-queued page is never fetched twice', async () => {
    const calls = []
    const searchWeb = async (q) => {
      calls.push(q)
      if (calls.length === 1) return [{ url: 'https://a.org/grant', title: 'A', snippet: '' }]
      if (calls.length === 2) return [{ url: 'https://a.org/grant?utm_source=x#top', title: 'A again', snippet: '' }]
      return []
    }
    const fetcher = fakeFetcher({ 'https://a.org/grant': '<body>grant</body>', 'https://a.org/grant?utm_source=x#top': '<body>grant</body>' })
    const extractOpportunities = vi.fn().mockResolvedValue([])
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher, searchWeb, extractOpportunities },
      { thesis, runId: 'alias', maxQueries: 3, seed: 0 },
    )
    expect(fetcher.fetch).toHaveBeenCalledTimes(1)
    expect(res.pages).toBe(1)
    expect(res.pages_deduped).toBe(1)
    expect(res.page_ledger[0]).toMatchObject({ url: 'https://a.org/grant', canonical_key: expect.any(String), fetched: true })
  })
})

describe('stage ledger — extraction failures are classified and provider_health names the dead layer', () => {
  it('a dead LLM (llm_quota on every fetched page) is extraction_failed:llm_quota, llm unavailable, reason set', async () => {
    const searchWeb = vi.fn().mockResolvedValue(withMeta([
      { url: 'https://one.org/a', title: 'one', snippet: '' },
      { url: 'https://two.org/b', title: 'two', snippet: '' },
    ], { provider: 'searxng', provenance: 'live', status: 'ok' }))
    const extractOpportunities = vi.fn(async () => withFailure([], { class: 'llm_quota', detail: '429 insufficient_quota' }))
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({ 'https://one.org/a': '<body>x</body>', 'https://two.org/b': '<body>y</body>' }), searchWeb, extractOpportunities },
      { thesis, runId: 'dead-llm', maxQueries: 1, seed: 0 },
    )
    expect(res.ok).toBe(true)
    expect(res.fetched).toBe(2)
    expect(res.extracted).toBe(0)
    expect(res.stage_ledger.response_received).toBe(2)
    expect(res.stage_ledger.extraction_failed).toBe(2)
    expect(res.stage_ledger.extraction_failed_by_class).toEqual({ llm_quota: 2 })
    expect(res.provider_health.search).toBe('healthy')
    expect(res.provider_health.llm).toBe('unavailable')
    expect(res.extraction_available).toBe(false)
    expect(res.reason).toBe('extraction_failed:llm_quota')
    expect(res.page_ledger.every((p) => p.extraction_failure === 'llm_quota')).toBe(true)
  })

  it('an extractor that THROWS is classified unknown (never silently [])', async () => {
    const searchWeb = vi.fn().mockResolvedValue([{ url: 'https://one.org/a', title: 'one', snippet: '' }])
    const extractOpportunities = vi.fn(async () => { throw new Error('boom') })
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({ 'https://one.org/a': '<body>x</body>' }), searchWeb, extractOpportunities },
      { thesis, runId: 'throw', maxQueries: 1, seed: 0 },
    )
    expect(res.stage_ledger.extraction_failed_by_class).toEqual({ unknown: 1 })
    expect(res.page_ledger[0].extraction_failure).toBe('unknown')
  })

  it('a healthy extractor that finds nothing is candidates_extracted 0 with NO failure (llm healthy)', async () => {
    const searchWeb = vi.fn().mockResolvedValue([{ url: 'https://one.org/a', title: 'one', snippet: '' }])
    const extractOpportunities = vi.fn(async () => [])
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({ 'https://one.org/a': '<body>x</body>' }), searchWeb, extractOpportunities },
      { thesis, runId: 'healthy-empty', maxQueries: 1, seed: 0 },
    )
    expect(res.stage_ledger.extraction_failed).toBe(0)
    expect(res.provider_health.llm).toBe('healthy')
    expect(res.reason ?? null).toBeNull()
  })

  it('search provider verdicts: every query unavailable → unavailable; a mix → degraded', async () => {
    const mk = (status) => vi.fn().mockResolvedValue(withMeta([], { provider: 'duckduckgo', provenance: 'live', status }))
    const down = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({}), searchWeb: mk('unavailable'), extractOpportunities: vi.fn() },
      { thesis, runId: 'down', maxQueries: 3, seed: 0 },
    )
    expect(down.provider_health.search).toBe('unavailable')
    expect(down.stage_ledger.provider_unavailable).toBe(3)

    let n = 0
    const mixed = vi.fn(async () => { n += 1; return withMeta([], { provider: 'searxng', provenance: 'live', status: n === 1 ? 'degraded_results' : 'ok' }) })
    const deg = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({}), searchWeb: mixed, extractOpportunities: vi.fn() },
      { thesis, runId: 'deg', maxQueries: 3, seed: 0 },
    )
    expect(deg.provider_health.search).toBe('degraded')
    expect(deg.stage_ledger.provider_degraded).toBe(1)
  })
})

describe('stage ledger — gate rejections, duplicates and admissions are counted per stage and per page', () => {
  it('reality rejection, canonical duplicate, apply-target hold and admission each land in their own counter', async () => {
    const searchWeb = vi.fn().mockResolvedValue([
      { url: 'https://real.org/grant', title: 'real', snippet: '' },
      { url: 'https://dup.org/grant', title: 'dup', snippet: '' },
      { url: 'https://expired.org/grant', title: 'expired', snippet: '' },
      { url: 'https://nourl.org/grant', title: 'nourl', snippet: '' },
    ])
    const extractOpportunities = vi.fn(async ({ pageUrl }) => {
      if (pageUrl.includes('real.org')) return [realOpp()]
      if (pageUrl.includes('dup.org')) return [realOpp({ apply_url: 'https://nyf.org/grant/apply' })] // same canonical identity
      if (pageUrl.includes('expired.org')) return [realOpp({ title: 'Old Youth Grant', deadline: '2020-01-01', apply_url: 'https://expired.org/apply' })]
      return [realOpp({ title: 'Info Only Youth Program', apply_url: null, info_url: 'https://nourl.org/grant', deadline: 'rolling' })]
    })
    const fetcher = fakeFetcher({
      'https://real.org/grant': '<body>a</body>', 'https://dup.org/grant': '<body>b</body>',
      'https://expired.org/grant': '<body>c</body>', 'https://nourl.org/grant': '<body>d</body>',
    })
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher, searchWeb, extractOpportunities },
      { thesis, runId: 'gates', maxQueries: 1, seed: 0 },
    )
    const s = res.stage_ledger
    expect(s.candidates_extracted).toBe(4)
    expect(s.reality_rejected).toBe(1)
    expect(s.canonical_duplicates).toBe(1)
    expect(s.apply_target_rejected).toBe(1)
    // Accounting identity: every extracted candidate lands in exactly one bucket.
    expect(s.reality_rejected + s.canonical_duplicates + s.catalog_refused + s.eligibility_rejected + s.need_match_rejected + s.apply_target_rejected + s.qualified_admitted + s.review_held).toBe(s.candidates_extracted)
    const byUrl = Object.fromEntries(res.page_ledger.map((p) => [p.url, p]))
    expect(byUrl['https://expired.org/grant'].reality_rejected).toBe(1)
    expect(byUrl['https://dup.org/grant'].canonical_duplicate).toBe(1)
    expect(byUrl['https://nourl.org/grant'].gate_rejected.apply_target).toBe(1)
    expect(byUrl['https://real.org/grant'].extracted).toBe(1)
  })

  it('the page ledger is bounded to maxPages entries and reports the truncation', async () => {
    const searchWeb = async () => Array.from({ length: 8 }, (_, i) => ({ url: `https://x.org/${Math.random()}/${i}`, title: 'x', snippet: '' }))
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({}), searchWeb, extractOpportunities: vi.fn() },
      { thesis: richThesis, runId: 'bound', maxQueries: 4, resultsPerQuery: 8, maxPages: 5, seed: 0 },
    )
    expect(res.page_ledger.length).toBeLessThanOrEqual(5)
    expect(res.pages).toBe(5)
  })

  it('seed pages carry a per-seed outcome ledger (adopted / gate / fetch_failed / extraction_failed)', async () => {
    const searchWeb = vi.fn().mockResolvedValue([])
    const extractOpportunities = vi.fn(async ({ pageUrl }) => {
      if (pageUrl.includes('good')) return [realOpp()]
      if (pageUrl.includes('expired')) return [realOpp({ title: 'Old', deadline: '2020-01-01', apply_url: 'https://expired.org/apply' })]
      return withFailure([], { class: 'llm_timeout' })
    })
    const res = await runWebDiscoveryLane(
      { store: createMemoryStore(), fetcher: fakeFetcher({ 'https://good.org/g': '<body>g</body>', 'https://expired.org/e': '<body>e</body>', 'https://dead.org/d': '<body>d</body>' }), searchWeb, extractOpportunities },
      { thesis, runId: 'seeds', maxQueries: 1, seed: 0, seedPages: [
        { url: 'https://good.org/g' }, { url: 'https://expired.org/e' }, { url: 'https://dead.org/d' }, { url: 'https://unfetchable.org/u' },
      ] },
    )
    const byUrl = Object.fromEntries(res.seed_outcomes.map((s) => [s.url, s]))
    expect(byUrl['https://good.org/g']).toMatchObject({ outcome: 'adopted', fetched: true })
    expect(byUrl['https://expired.org/e']).toMatchObject({ outcome: 'reality_rejected', gate: 'reality' })
    expect(byUrl['https://dead.org/d']).toMatchObject({ outcome: 'extraction_failed', reason: 'llm_timeout' })
    expect(byUrl['https://unfetchable.org/u']).toMatchObject({ outcome: 'fetch_failed', fetched: false })
  })

  it('a deps-missing lane reports no_crawl-shaped telemetry (no ledgers invented)', async () => {
    const res = await runWebDiscoveryLane({ store: null }, { thesis })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('web_lane_deps_missing')
    expect(res.stage_ledger.provider_attempted).toBe(0)
    expect(res.provider_health).toEqual(expect.objectContaining({ search: 'unknown', llm: 'unknown' }))
  })
})
