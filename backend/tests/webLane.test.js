/**
 * Unit tests for backend/crawler-os/webLane.js
 *
 * Drives the open-web lane fully offline with injected search + LLM + fetcher,
 * against a real OS memory store, and asserts that good finds are stored +
 * matched while bad ones are rejected by the SAME reality gate.
 */
import { describe, it, expect, vi } from 'vitest'
import { runWebDiscoveryLane } from '../crawler-os/webLane.js'
import { createMemoryStore, storage } from '../crawler-os/index.js'
import { buildLinkInventory } from '../crawler-os/blindLinkInventory.js'
import { extractPageFactsBlind } from '../crawler-os/blindPageFactExtractor.js'
import { mapBlindFactsToCandidate } from '../crawler-os/blindFactsMapper.js'
import { htmlToText } from '../services/webGrantExtractor.js'
import { capShadowHtml, MAX_SHADOW_HTML_CHARS, decideTargetVerified } from '../services/crawlerOsService.js'
import { classifyBlindOpportunityKind } from '../crawler-os/blindOpportunityKind.js'

const thesis = {
  profile_id: 'p1',
  applicant_types: ['nonprofit'],
  needs: ['youth', 'after school'],
  location: { state: 'TN', city: 'Nashville' },
  loan_allowed: false,
  cost_share_allowed: true,
}

function fakeFetcher(bodyByUrl) {
  return {
    fetch: async (url) => {
      if (bodyByUrl[url] === undefined || bodyByUrl[url] === null) return { ok: false }
      return { ok: true, body: bodyByUrl[url], finalUrl: url, contentHash: 'hash-' + url.length, fetchedAt: '2026-06-29T00:00:00Z' }
    },
  }
}

describe('runWebDiscoveryLane', () => {
  it('stores a real extracted opportunity and matches it; rejects a sponsorless one', async () => {
    const store = createMemoryStore()
    const searchWeb = vi.fn().mockResolvedValue([
      { url: 'https://nyf.org/grant', title: 'Youth Fund', snippet: '' },
      { url: 'https://bad.org/x', title: 'Bad', snippet: '' },
    ])
    const extractOpportunities = vi.fn(async ({ pageUrl }) => {
      if (pageUrl.includes('nyf.org')) {
        return [{ title: 'Nashville Youth Services Grant', funder: 'Nashville Community Foundation', summary: 'Grants to nonprofits serving youth and after school programs in Tennessee', deadline: '2026-12-01', apply_url: 'https://nyf.org/grant/apply', state: 'TN', relevant: true }]
      }
      // sponsorless → must be rejected by the reality gate (NO_SPONSOR)
      return [{ title: 'Mystery Money', funder: '', summary: 'no funder', apply_url: 'https://bad.org/x', relevant: true }]
    })

    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher({ 'https://nyf.org/grant': '<body>youth grant</body>', 'https://bad.org/x': '<body>x</body>' }), searchWeb, extractOpportunities },
      { thesis, runId: 'run1' },
    )

    expect(res.ok).toBe(true)
    expect(res.fetched).toBe(2)
    expect(res.stored).toBe(1) // only the real one
    expect(res.extracted).toBe(1) // sponsorless is dropped pre-gate by toCandidate (malformed)

    const catalog = storage.listCatalog(store)
    expect(catalog.length).toBe(1)
    expect(catalog[0].title).toMatch(/Nashville Youth Services Grant/)
    expect(catalog[0].source_id).toBe('web_search')

    // A match row was computed for the discovering profile.
    const matches = store.all('profile_opportunity_matches').filter((m) => m.profile_id === 'p1')
    expect(matches.length).toBe(1)
    expect(Number(matches[0].match_score)).toBeGreaterThan(0)

    // Crawler-doctor provenance: the match records WHICH query surfaced the
    // page it was extracted from, and the lane that found it.
    expect(typeof matches[0].source_query).toBe('string')
    expect(matches[0].source_query.length).toBeGreaterThan(0)
    expect(res.queries).toContain(matches[0].source_query)
    expect(matches[0].discovered_via).toBe('web_search')
  })

  it('rejects an expired opportunity via the reality gate', async () => {
    const store = createMemoryStore()
    const searchWeb = vi.fn().mockResolvedValue([{ url: 'https://old.org/g', title: 'Old', snippet: '' }])
    const extractOpportunities = vi.fn().mockResolvedValue([
      { title: 'Expired Youth Grant', funder: 'Old Foundation', summary: 'youth', deadline: '2020-01-01', apply_url: 'https://old.org/g', state: 'TN', relevant: true },
    ])
    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher({ 'https://old.org/g': '<body>old</body>' }), searchWeb, extractOpportunities },
      { thesis, runId: 'run2' },
    )
    expect(res.extracted).toBe(1)
    expect(res.stored).toBe(0)
    expect(res.rejected).toBe(1)
    expect(storage.listCatalog(store).length).toBe(0)
  })

  it('returns a no-op result when deps are missing', async () => {
    const res = await runWebDiscoveryLane({ store: null }, { thesis })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('web_lane_deps_missing')
  })

  it('breadth budgets default to 20 queries and honour the env overrides (2026-08-03 recall audit)', async () => {
    // Measured 2026-08-03: at the old cap of 14, all 34 real prod profiles
    // truncated their query pool (2,531 built vs 476 run — 81% suppressed).
    // The default is now 20 and env-tunable; caller opts still win.
    const richThesis = {
      ...thesis,
      is_student: true,
      applicant_types: ['student'],
      schools: ['Middle Tennessee State University', 'Cleveland State Community College'],
      field_of_study: 'Forensic Science',
      needs: ['education', 'housing', 'medical', 'food', 'transportation'],
      interest_terms: ['forensic science', 'criminal justice'],
      location: { state: 'TN', city: 'Cleveland', county: 'Bradley' },
    }
    const run = async () => {
      const store = createMemoryStore()
      const res = await runWebDiscoveryLane(
        { store, fetcher: fakeFetcher({}), searchWeb: vi.fn().mockResolvedValue([]), extractOpportunities: vi.fn() },
        { thesis: richThesis, runId: 'budget', seed: 0 },
      )
      return res.queries.length
    }
    try {
      delete process.env.WEB_LANE_MAX_QUERIES
      expect(await run()).toBe(20)
      process.env.WEB_LANE_MAX_QUERIES = '5'
      expect(await run()).toBe(5)
      // Garbage never disables the budget (the Number(null)-is-finite class).
      process.env.WEB_LANE_MAX_QUERIES = 'banana'
      expect(await run()).toBe(20)
    } finally {
      delete process.env.WEB_LANE_MAX_QUERIES
    }
  })

  describe('seed pages (owner rule: a source found for a profile gets added)', () => {
    const realOpp = {
      title: 'Tennessee Disability Small Grants',
      funder: 'Tennessee Disability Coalition',
      summary: 'Small grants to Tennessee nonprofits serving youth and after school programs',
      deadline: '2026-12-01',
      apply_url: 'https://tndisability.org/grants/apply',
      state: 'TN',
      relevant: true,
    }

    it('adds a real source the lane search never surfaced', async () => {
      // The exact 2026-07-15 case: the Google-bar benchmark found
      // tndisability.org for a TN profile, filed it as a candidate, and nothing
      // ever added it because the lane's own search does not surface it.
      const store = createMemoryStore()
      const searchWeb = vi.fn().mockResolvedValue([])
      const extractOpportunities = vi.fn(async () => [realOpp])

      const res = await runWebDiscoveryLane(
        {
          store,
          fetcher: fakeFetcher({ 'https://tndisability.org/grants': '<body>small grants</body>' }),
          searchWeb,
          extractOpportunities,
        },
        { thesis, runId: 'seed-run', seedPages: [{ url: 'https://tndisability.org/grants', title: 'Small Grants' }] },
      )

      expect(res.seeded).toBe(1)
      expect(res.stored).toBe(1)
      expect(res.seeded_adopted_urls).toEqual(['https://tndisability.org/grants'])
      expect(storage.listCatalog(store).map((o) => o.title)).toContain('Tennessee Disability Small Grants')
    })

    it('a seed does NOT bypass the reality gate', async () => {
      // The whole safety argument for automating this rule: a seed buys a page a
      // LOOK, never a row. If being seeded could skip a gate, "auto-add" would
      // mean "auto-trust" and the benchmark would become an ingestion backdoor.
      const store = createMemoryStore()
      const searchWeb = vi.fn().mockResolvedValue([])
      const extractOpportunities = vi.fn(async () => [
        { title: 'Mystery Money', funder: '', summary: 'no funder at all', apply_url: 'https://junk.org/x', relevant: true },
      ])

      const res = await runWebDiscoveryLane(
        { store, fetcher: fakeFetcher({ 'https://junk.org/x': '<body>x</body>' }), searchWeb, extractOpportunities },
        { thesis, runId: 'seed-gate', seedPages: [{ url: 'https://junk.org/x' }] },
      )

      expect(res.seeded).toBe(1)
      expect(res.stored).toBe(0)
      expect(res.seeded_adopted_urls).toEqual([])
      expect(storage.listCatalog(store)).toHaveLength(0)
    })

    it('reports a seed whose page cannot be fetched as NOT adopted', async () => {
      // Honesty: offering a seed is not adopting it. A dead page must never be
      // reported as an added source.
      const store = createMemoryStore()
      const res = await runWebDiscoveryLane(
        { store, fetcher: fakeFetcher({}), searchWeb: vi.fn().mockResolvedValue([]), extractOpportunities: vi.fn(async () => [realOpp]) },
        { thesis, runId: 'seed-dead', seedPages: [{ url: 'https://dead.org/x' }] },
      )
      expect(res.seeded).toBe(1)
      expect(res.seeded_adopted).toBe(0)
      expect(res.seeded_adopted_urls).toEqual([])
    })

    it('seeds run ALONGSIDE search hits and are not crowded out by maxPages', async () => {
      // maxPages bounds how much of an unbounded SERP we chase — a question
      // already settled for a known URL. If seeds shared that budget, a busy
      // search would silently starve the rule.
      const store = createMemoryStore()
      const searchWeb = vi.fn().mockResolvedValue([{ url: 'https://serp.org/a', title: 'A', snippet: '' }])
      const extractOpportunities = vi.fn(async ({ pageUrl }) =>
        pageUrl.includes('tndisability') ? [realOpp] : [{ ...realOpp, title: 'Serp Grant', apply_url: 'https://serp.org/a/apply' }],
      )

      const res = await runWebDiscoveryLane(
        {
          store,
          fetcher: fakeFetcher({ 'https://tndisability.org/grants': '<body>a</body>', 'https://serp.org/a': '<body>b</body>' }),
          searchWeb,
          extractOpportunities,
        },
        { thesis, runId: 'seed-cap', maxPages: 1, seedPages: [{ url: 'https://tndisability.org/grants' }] },
      )

      expect(res.seeded).toBe(1)
      expect(res.fetched).toBe(2) // seed + the one allowed search page
      expect(res.seeded_adopted_urls).toEqual(['https://tndisability.org/grants'])
    })

    it('ignores malformed/duplicate seeds without touching the run', async () => {
      const store = createMemoryStore()
      const res = await runWebDiscoveryLane(
        { store, fetcher: fakeFetcher({ 'https://tndisability.org/grants': '<body>a</body>' }), searchWeb: vi.fn().mockResolvedValue([]), extractOpportunities: vi.fn(async () => [realOpp]) },
        {
          thesis,
          runId: 'seed-junk',
          seedPages: [
            { url: 'not-a-url' },
            { url: '' },
            null,
            { url: 'https://tndisability.org/grants' },
            { url: 'https://tndisability.org/grants' }, // duplicate
          ],
        },
      )
      expect(res.seeded).toBe(1)
      expect(res.stored).toBe(1)
    })

    it('runs unchanged when no seeds are supplied (default path)', async () => {
      const store = createMemoryStore()
      const res = await runWebDiscoveryLane(
        { store, fetcher: fakeFetcher({ 'https://serp.org/a': '<body>b</body>' }), searchWeb: vi.fn().mockResolvedValue([{ url: 'https://serp.org/a', title: 'A', snippet: '' }]), extractOpportunities: vi.fn(async () => [realOpp]) },
        { thesis, runId: 'no-seed' },
      )
      expect(res.seeded).toBe(0)
      expect(res.seeded_adopted_urls).toEqual([])
      expect(res.stored).toBe(1)
    })
  })
})

describe('runWebDiscoveryLane — profile-BLIND shadow (WEB_LANE_PROFILE_BLIND, Phase 1b)', () => {
  // Fixture: one real page (nyf.org) + one sponsorless page (bad.org). The live
  // path stores exactly the real one; the shadow runs on BOTH fetched pages
  // without changing anything the live path returns/persists.
  const bodyByUrl = {
    'https://nyf.org/grant': '<html><body><main><h1>Youth Grant</h1><p>Grants for youth in TN.</p></main></body></html>',
    'https://bad.org/x': '<body>x</body>',
  }
  const makeSearch = () =>
    vi.fn().mockResolvedValue([
      { url: 'https://nyf.org/grant', title: 'Youth Fund', snippet: '' },
      { url: 'https://bad.org/x', title: 'Bad', snippet: '' },
    ])
  const makeExtract = () =>
    vi.fn(async ({ pageUrl }) => {
      if (pageUrl.includes('nyf.org')) {
        return [{ title: 'Nashville Youth Services Grant', funder: 'Nashville Community Foundation', summary: 'Grants to nonprofits serving youth and after school programs in Tennessee', deadline: '2026-12-01', apply_url: 'https://nyf.org/grant/apply', state: 'TN', relevant: true }]
      }
      return [{ title: 'Mystery Money', funder: '', summary: 'no funder', apply_url: 'https://bad.org/x', relevant: true }]
    })

  // Snapshot the live-visible outputs so a shadow run can be proven identical.
  function liveSnapshot(store, res) {
    return {
      catalog: storage.listCatalog(store).map((c) => ({ title: c.title, source_id: c.source_id })),
      matches: store.all('profile_opportunity_matches').filter((m) => m.profile_id === 'p1').map((m) => ({ id: m.opportunity_id, score: Number(m.match_score) })),
      recommendations: res.recommendations.map((r) => ({ title: r.title, score: r.match_score })),
      counters: { pages: res.pages, fetched: res.fetched, extracted: res.extracted, stored: res.stored, deduped: res.deduped, rejected: res.rejected },
    }
  }

  it('flag OFF (no blindShadow dep): blind extractor never runs, no shadow counter, writes byte-identical', async () => {
    // A spy that WOULD be the blind extractor — never wired, so never called.
    const blindSpy = vi.fn(async () => [{ title: 'X', sponsor: 'Y', field_provenance: { eligibility: {} } }])
    const store = createMemoryStore()
    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher(bodyByUrl), searchWeb: makeSearch(), extractOpportunities: makeExtract() /* no blindShadow */ },
      { thesis, runId: 'off1' },
    )
    expect(blindSpy).not.toHaveBeenCalled()
    expect('web_lane_blind_shadow' in res).toBe(false) // key never added when flag off
    expect(res.stored).toBe(1)
    expect(storage.listCatalog(store).length).toBe(1)
  })

  it('flag ON: shadow runs on each fetched page, emits a delta counter, and does NOT leak into live results', async () => {
    // Baseline (flag OFF) live outputs.
    const baseStore = createMemoryStore()
    const baseRes = await runWebDiscoveryLane(
      { store: baseStore, fetcher: fakeFetcher(bodyByUrl), searchWeb: makeSearch(), extractOpportunities: makeExtract() },
      { thesis, runId: 'base' },
    )
    const baseline = liveSnapshot(baseStore, baseRes)

    // Flag ON: inject a blind shadow that returns EXTRA candidates (with page
    // evidence) — if any leaked, the live snapshot would diverge.
    const extractPage = vi.fn(async ({ pageUrl }) => {
      if (pageUrl.includes('nyf.org')) {
        return [{ title: 'Blind Grant A', sponsor: 'Blind Funder', field_provenance: { eligibility: { value: 'x', evidence_snippet: 'youth', source: pageUrl } } }]
      }
      return [] // bad.org page: blind path found nothing
    })
    const onStore = createMemoryStore()
    const onRes = await runWebDiscoveryLane(
      { store: onStore, fetcher: fakeFetcher(bodyByUrl), searchWeb: makeSearch(), extractOpportunities: makeExtract(), blindShadow: { extractPage } },
      { thesis, runId: 'on1' },
    )
    // Target verification is telemetry-only and runs off the live path; settle it
    // so promotion_evidence is attached before we assert the counter shape.
    await onRes.targetVerification

    // Shadow ran on both fetched pages; blind produced 1 evidenced candidate.
    expect(extractPage).toHaveBeenCalledTimes(2)
    const { elapsed_ms, ...counter } = onRes.web_lane_blind_shadow
    expect(counter).toEqual({
      ran: true,
      pages_shadowed: 2,
      errors: 0,
      timeouts: 0,
      capped: false,
      current_candidates: 1, // only nyf.org yields a current-path candidate
      blind_candidates: 1,
      blind_evidenced: 1,
      delta: 0, // 1 blind − 1 current
      // The one blind candidate carries no classifier label in this mock, so it
      // tallies conservatively as UNKNOWN. (Per-kind classification is exercised
      // by the dedicated test below and the classifier's own node:test suite.)
      by_kind: { direct: 0, aggregator_index: 0, unknown: 1, protected_directory: 0, unverified_index: 0 },
      // Phase 1d promotion evidence: the one blind candidate exposes NO independent
      // apply/info target (no apply_url/info_url), so it is source_only — no fetch.
      promotion_evidence: {
        target_checked: 1,
        target_verified: 0,
        source_only: 1,
        real_and_matched: 0,
        target_check_errors: 0,
        target_fetches: 0,
        target_capped: false,
        target_elapsed_ms: 0,
      },
    })
    expect(typeof elapsed_ms).toBe('number')
    expect(elapsed_ms).toBeGreaterThanOrEqual(0)

    // Live outputs are byte-identical to the flag-off baseline: nothing leaked.
    expect(liveSnapshot(onStore, onRes)).toEqual(baseline)
    // And no blind candidate was persisted into the catalog.
    expect(storage.listCatalog(onStore).some((c) => /Blind/.test(c.title))).toBe(false)
  })

  it('flag ON: the shadow counter tallies the classifier per-kind breakdown (trust axis splits only the aggregator bucket)', async () => {
    // The shadow builder labels each blind candidate with blind_kind + blind_trust
    // (Phase 1c). Here we inject candidates carrying those labels and assert the
    // read-only counter tallies them — a DIRECT program, a PROTECTED durable
    // directory, and an UNVERIFIED open-web list, split across the two fetched
    // pages. The classifier's OWN correctness is pinned by its node:test suite.
    const extractPage = vi.fn(async ({ pageUrl }) => {
      if (pageUrl.includes('nyf.org')) {
        return [
          { title: 'Direct A', sponsor: 'Funder A', blind_kind: 'DIRECT_PROGRAM', blind_trust: 'UNVERIFIED' },
          { title: 'Dir P', sponsor: 'State 211', blind_kind: 'AGGREGATOR_INDEX', blind_trust: 'PROTECTED' },
        ]
      }
      return [
        { title: 'Dir U', sponsor: 'Blog', blind_kind: 'AGGREGATOR_INDEX', blind_trust: 'UNVERIFIED' },
        { title: 'Mystery', sponsor: 'X' }, // no label => conservatively UNKNOWN
      ]
    })
    const store = createMemoryStore()
    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher(bodyByUrl), searchWeb: makeSearch(), extractOpportunities: makeExtract(), blindShadow: { extractPage } },
      { thesis, runId: 'kind1' },
    )
    await res.targetVerification // settle the off-live-path telemetry step
    const bk = res.web_lane_blind_shadow.by_kind
    expect(bk).toEqual({ direct: 1, aggregator_index: 2, unknown: 1, protected_directory: 1, unverified_index: 1 })
    // INVARIANT: the trust split covers exactly the aggregator bucket.
    expect(bk.protected_directory + bk.unverified_index).toBe(bk.aggregator_index)
    // Live path untouched: still exactly the one real opportunity.
    expect(res.stored).toBe(1)
    expect(storage.listCatalog(store).length).toBe(1)
  })

  it('flag ON with the blind path throwing: live lane still returns normally (best-effort isolation)', async () => {
    const extractPage = vi.fn(async () => { throw new Error('blind boom / timeout') })
    const store = createMemoryStore()
    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher(bodyByUrl), searchWeb: makeSearch(), extractOpportunities: makeExtract(), blindShadow: { extractPage } },
      { thesis, runId: 'err1' },
    )
    await res.targetVerification // settle the off-live-path telemetry step
    // Live path unaffected: still stored the one real opportunity.
    expect(res.ok).toBe(true)
    expect(res.stored).toBe(1)
    expect(storage.listCatalog(store).length).toBe(1)
    // The shadow caught every failure and reported it; no candidates counted.
    expect(res.web_lane_blind_shadow.errors).toBe(2)
    expect(res.web_lane_blind_shadow.pages_shadowed).toBe(0)
    expect(res.web_lane_blind_shadow.blind_candidates).toBe(0)
  })

  it('flag ON: shadow work is capped per run (maxPages)', async () => {
    const extractPage = vi.fn(async () => [])
    const store = createMemoryStore()
    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher(bodyByUrl), searchWeb: makeSearch(), extractOpportunities: makeExtract(), blindShadow: { extractPage, maxPages: 1 } },
      { thesis, runId: 'cap1' },
    )
    await res.targetVerification // settle the off-live-path telemetry step
    // Two pages fetched, but the shadow only ran on the first.
    expect(extractPage).toHaveBeenCalledTimes(1)
    expect(res.web_lane_blind_shadow.pages_shadowed).toBe(1)
    expect(res.web_lane_blind_shadow.capped).toBe(true)
  })

  it('flag ON with the blind path hanging on EVERY page: live returns within the single wall-clock budget; timeouts counted (not silent success)', async () => {
    const extractPage = vi.fn(() => new Promise(() => {})) // never resolves — simulates a hung provider
    const store = createMemoryStore()
    const t0 = Date.now()
    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher(bodyByUrl), searchWeb: makeSearch(), extractOpportunities: makeExtract(), blindShadow: { extractPage, totalBudgetMs: 600, perPageTimeoutMs: 150 } },
      { thesis, runId: 'to1' },
    )
    const dt = Date.now() - t0
    await res.targetVerification // settle the off-live-path telemetry step
    // Live path unaffected and returned normally.
    expect(res.ok).toBe(true)
    expect(res.stored).toBe(1)
    expect(storage.listCatalog(store).length).toBe(1)
    // A hung page is counted as a TIMEOUT, never as a 0-candidate success.
    expect(res.web_lane_blind_shadow.timeouts).toBeGreaterThanOrEqual(1)
    expect(res.web_lane_blind_shadow.pages_shadowed).toBe(0)
    expect(res.web_lane_blind_shadow.blind_candidates).toBe(0)
    // TOTAL shadow time is bounded by the SINGLE budget (not per-page × pages)...
    expect(res.web_lane_blind_shadow.elapsed_ms).toBeLessThanOrEqual(600)
    // ...so the whole live run never waited anywhere near per-page(150) × pages,
    // let alone the ~160s the un-bounded default (8×20s) would have added.
    expect(dt).toBeLessThan(1500)
  })

  it('caps oversized page HTML before any DOM parse (bounded synchronous work)', () => {
    const huge = 'a'.repeat(MAX_SHADOW_HTML_CHARS * 4)
    expect(huge.length).toBeGreaterThan(MAX_SHADOW_HTML_CHARS)
    expect(capShadowHtml(huge).length).toBe(MAX_SHADOW_HTML_CHARS) // truncated BEFORE cheerio.load
    const small = '<html><body>hi</body></html>'
    expect(capShadowHtml(small)).toBe(small) // a normal body is untouched
  })

  it('flag ON with the REAL Phase-1a blind pipeline (mock LLM): extracts an evidenced candidate from the fetched page', async () => {
    const html =
      '<html><body><main><h1>Nashville Youth Services Grant</h1>' +
      '<p>The Nashville Community Foundation offers the Nashville Youth Services Grant ' +
      'to nonprofit organizations serving youth and after school programs in Tennessee.</p>' +
      '<p>Eligibility: nonprofit organizations in Tennessee serving youth.</p>' +
      '<a href="https://nyf.org/grant/apply">Apply here</a></main></body></html>'
    const store = createMemoryStore()
    const searchWeb = vi.fn().mockResolvedValue([{ url: 'https://nyf.org/grant', title: 'Youth Fund', snippet: '' }])
    const extractOpportunities = vi.fn(async () => [])

    // A deterministic mock LLM grounded in the page: title/sponsor/evidence all
    // appear in the page text, and the apply link is chosen by inventory id.
    const llm = vi.fn(async () => ({
      opportunities: [{
        title: 'Nashville Youth Services Grant',
        funder: 'Nashville Community Foundation',
        summary: 'Grants to nonprofits serving youth',
        eligibility_text: 'nonprofit organizations in Tennessee serving youth',
        eligibility_bullets: [],
        need_categories: ['youth'],
        amount_min: null, amount_max: null,
        national: false, states: ['TN'],
        is_loan: false, requires_cost_share: false,
        apply_link_id: 'L1', info_link_id: null,
        evidence: { eligibility: 'nonprofit organizations in Tennessee serving youth', geography: 'Tennessee' },
      }],
    }))

    // The SAME extractPage shape crawlerOsService.makeBlindShadow builds.
    const extractPage = async ({ pageUrl, html: pageHtml }) => {
      const pageText = htmlToText(pageHtml, 12000)
      const linkInventory = buildLinkInventory(pageHtml, { baseUrl: pageUrl })
      const facts = await extractPageFactsBlind({ pageUrl, pageText, linkInventory }, { llm })
      return facts.map(mapBlindFactsToCandidate).filter(Boolean)
    }

    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher({ 'https://nyf.org/grant': html }), searchWeb, extractOpportunities, blindShadow: { extractPage } },
      { thesis, runId: 'real1' },
    )
    await res.targetVerification // settle the off-live-path telemetry step

    expect(llm).toHaveBeenCalledTimes(1) // the blind extractor really invoked the injected LLM
    const s = res.web_lane_blind_shadow
    expect(s.pages_shadowed).toBe(1)
    expect(s.blind_candidates).toBe(1)
    expect(s.blind_evidenced).toBe(1) // page-supported field_provenance survived validation
    // Live path stored nothing (current extractor returned []), proving the blind
    // pipeline is pure observation.
    expect(res.stored).toBe(0)
    expect(storage.listCatalog(store).length).toBe(0)
  })
})

describe('runWebDiscoveryLane — Phase 1d independent target verification (promotion evidence)', () => {
  const thesisTv = {
    profile_id: 'p1',
    applicant_types: ['nonprofit'],
    needs: ['youth', 'after school'],
    location: { state: 'TN', city: 'Nashville' },
    loan_allowed: false,
    cost_share_allowed: true,
  }
  const SOURCE = 'https://nyf.org/grant'
  // The live lane always fetches + extracts + stores the one real opportunity from
  // the source page — every 1d test asserts that live output is untouched.
  const realOpp = {
    title: 'Nashville Youth Services Grant',
    funder: 'Nashville Community Foundation',
    summary: 'Grants to nonprofits serving youth and after school programs in Tennessee',
    deadline: '2026-12-01',
    apply_url: 'https://nyf.org/grant/apply',
    state: 'TN',
    relevant: true,
  }
  const makeLiveExtract = () => vi.fn(async ({ pageUrl }) => (pageUrl === SOURCE ? [realOpp] : []))
  const makeSearch = () => vi.fn().mockResolvedValue([{ url: SOURCE, title: 'Youth Fund', snippet: '' }])

  // A tracking fetcher: records every URL it is asked to fetch (so we can assert
  // the SSRF-safe fetcher is the ONLY fetch path + dedup), serves configured 2xx
  // bodies, 404s the rest, and can hang / throw for specific target URLs.
  function makeTrackingFetcher({ bodies = {}, hang = new Set(), throwOn = new Set() } = {}) {
    const calls = []
    return {
      calls,
      fetch: async (url) => {
        calls.push(url)
        if (throwOn.has(url)) throw new Error('fetch boom ' + url)
        if (hang.has(url)) return new Promise(() => {}) // never resolves — simulates a hung host
        const body = bodies[url]
        if (body === undefined || body === null) return { ok: false, status: 404, finalUrl: url, body: null }
        return { ok: true, status: 200, body, finalUrl: url, contentHash: 'h' + url.length, fetchedAt: '2026-06-29T00:00:00Z' }
      },
    }
  }

  const evidenced = { eligibility: { value: 'x', evidence_snippet: 'youth', source: SOURCE } }

  it('records target_verified vs source_only correctly; real_and_matched only when verified AND evidenced', async () => {
    const store = createMemoryStore()
    const fetcher = makeTrackingFetcher({
      bodies: {
        [SOURCE]: '<html><body><main>youth grant</main></body></html>',
        'https://prog.org/apply': '<html><body>real program apply page</body></html>',
        'https://dir.org/list': '<html><body>a directory</body></html>',
        // dead.org/404 intentionally absent => fetcher returns ok:false (unreachable)
      },
    })
    // Blind shadow: one page yields three candidates with distinct targets.
    const extractPage = vi.fn(async () => [
      { title: 'Verified A', sponsor: 'Funder A', apply_url: 'https://prog.org/apply', field_provenance: evidenced },
      { title: 'Aggregator B', sponsor: 'Funder B', apply_url: 'https://dir.org/list' },
      { title: 'Dead C', sponsor: 'Funder C', apply_url: 'https://dead.org/404' },
    ])
    // classifyTarget mock: prog.org is a real program, dir.org an aggregator.
    const classifyTarget = vi.fn(async ({ finalUrl }) => ({ verified: /prog\.org/.test(finalUrl) }))

    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract(), blindShadow: { extractPage, classifyTarget } },
      { thesis: thesisTv, runId: 'tv-1' },
    )

    // Live path untouched — and available WITHOUT awaiting target verification.
    expect(res.stored).toBe(1)
    expect(storage.listCatalog(store).length).toBe(1)

    // Settle the off-live-path verification to read its telemetry counter.
    await res.targetVerification
    const pe = res.web_lane_blind_shadow.promotion_evidence
    expect(pe.target_checked).toBe(3)
    expect(pe.target_verified).toBe(1)
    expect(pe.source_only).toBe(2) // aggregator + unreachable
    expect(pe.real_and_matched).toBe(1) // only the verified AND evidenced candidate
    expect(pe.target_check_errors).toBe(0)
    expect(pe.target_fetches).toBe(3)
    expect(pe.target_capped).toBe(false)
    // classifyTarget is NOT consulted for an unreachable target (fetch decides first).
    expect(classifyTarget).toHaveBeenCalledTimes(2)
  })

  it('is BOUNDED: N hanging targets stay within the single wall-clock budget and the max-fetch cap; live returns normally', async () => {
    const store = createMemoryStore()
    const hang = new Set()
    const candidates = []
    for (let i = 0; i < 8; i += 1) {
      const url = `https://slow${i}.org/apply`
      hang.add(url)
      candidates.push({ title: `Slow ${i}`, sponsor: `F ${i}`, apply_url: url })
    }
    const fetcher = makeTrackingFetcher({ bodies: { [SOURCE]: '<html><body>youth grant</body></html>' }, hang })
    const extractPage = vi.fn(async () => candidates)

    const t0 = Date.now()
    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract(),
        blindShadow: { extractPage, targetVerifyBudgetMs: 600, targetVerifyMax: 5, targetVerifyTimeoutMs: 150 } },
      { thesis: thesisTv, runId: 'tv-bound' },
    )
    const dt = Date.now() - t0
    await res.targetVerification // settle the off-live-path telemetry step

    // Live path unaffected.
    expect(res.ok).toBe(true)
    expect(res.stored).toBe(1)
    const pe = res.web_lane_blind_shadow.promotion_evidence
    // Never more than the max-fetch cap, and the pass stopped early (capped).
    expect(pe.target_fetches).toBeLessThanOrEqual(5)
    expect(pe.target_fetches).toBeGreaterThanOrEqual(1)
    expect(pe.target_capped).toBe(true)
    // A hung target is a caught error, never a silent verified.
    expect(pe.target_verified).toBe(0)
    expect(pe.target_check_errors).toBeGreaterThanOrEqual(1)
    // TOTAL target-verify time is bounded by the SINGLE budget, not per-fetch × N.
    expect(pe.target_elapsed_ms).toBeLessThanOrEqual(600 + 200) // budget + one in-flight slice
    // ...so the whole live run never waited anywhere near 8×150ms of hung fetches.
    expect(dt).toBeLessThan(1500)
  })

  it('best-effort isolation: a throwing fetcher counts errors and never affects the live lane', async () => {
    const store = createMemoryStore()
    const throwOn = new Set(['https://boom1.org/apply', 'https://boom2.org/apply'])
    const fetcher = makeTrackingFetcher({ bodies: { [SOURCE]: '<html><body>youth grant</body></html>' }, throwOn })
    const extractPage = vi.fn(async () => [
      { title: 'Boom 1', sponsor: 'F1', apply_url: 'https://boom1.org/apply' },
      { title: 'Boom 2', sponsor: 'F2', apply_url: 'https://boom2.org/apply' },
    ])
    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract(), blindShadow: { extractPage } },
      { thesis: thesisTv, runId: 'tv-throw' },
    )
    await res.targetVerification // settle the off-live-path telemetry step
    expect(res.ok).toBe(true)
    expect(res.stored).toBe(1) // live unaffected
    const pe = res.web_lane_blind_shadow.promotion_evidence
    expect(pe.target_check_errors).toBe(2)
    expect(pe.target_verified).toBe(0)
    expect(pe.target_checked).toBe(2)
  })

  it('uses ONLY the injected SSRF-safe fetcher, DEDUPES shared targets, and NEVER re-fetches the source page', async () => {
    const store = createMemoryStore()
    const fetcher = makeTrackingFetcher({
      bodies: { [SOURCE]: '<html><body>youth grant</body></html>', 'https://shared.org/apply': '<html><body>shared apply</body></html>' },
    })
    const extractPage = vi.fn(async () => [
      { title: 'Shared 1', sponsor: 'F1', apply_url: 'https://shared.org/apply', field_provenance: evidenced },
      { title: 'Shared 2', sponsor: 'F2', apply_url: 'https://shared.org/apply' }, // same target => dedup
      { title: 'Source-only', sponsor: 'F3', info_url: SOURCE }, // target IS the source page => no independent fetch
    ])
    const classifyTarget = vi.fn(async () => ({ verified: true }))
    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract(), blindShadow: { extractPage, classifyTarget } },
      { thesis: thesisTv, runId: 'tv-dedup' },
    )
    await res.targetVerification // settle the off-live-path telemetry step
    // The shared target was fetched exactly once (dedup); the source page was
    // fetched exactly once — by the LIVE lane — and NEVER re-fetched for verification.
    expect(fetcher.calls.filter((u) => u === 'https://shared.org/apply').length).toBe(1)
    expect(fetcher.calls.filter((u) => u === SOURCE).length).toBe(1)
    const pe = res.web_lane_blind_shadow.promotion_evidence
    expect(pe.target_checked).toBe(3)
    expect(pe.target_verified).toBe(2) // both shared candidates verified (2nd via cache)
    expect(pe.source_only).toBe(1) // the source-page-only candidate
    expect(pe.real_and_matched).toBe(1) // only the evidenced shared candidate
    expect(pe.target_fetches).toBe(1) // one real network fetch for the two shared candidates
  })

  it('flag OFF (no blindShadow): no target verification runs and no promotion_evidence key exists', async () => {
    const store = createMemoryStore()
    const fetcher = makeTrackingFetcher({ bodies: { [SOURCE]: '<html><body>youth grant</body></html>', 'https://x.org/apply': '<html><body>x</body></html>' } })
    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract() /* no blindShadow */ },
      { thesis: thesisTv, runId: 'tv-off' },
    )
    expect('web_lane_blind_shadow' in res).toBe(false)
    // The only fetch was the LIVE source-page fetch — no target verification at all.
    expect(fetcher.calls).toEqual([SOURCE])
    expect(res.stored).toBe(1)
  })

  it('end-to-end with the REAL classifier verdict: a real program page verifies; an aggregator/directory page is source_only', async () => {
    // Build the SAME classifyTarget crawlerOsService.makeBlindShadow builds: fetch
    // bytes → htmlToText + buildLinkInventory → 1c classifier → decideTargetVerified.
    const classifyTarget = async ({ finalUrl, html, status }) => {
      const pageText = htmlToText(html, 12000)
      const linkInventory = buildLinkInventory(html, { baseUrl: finalUrl })
      const { kind } = classifyBlindOpportunityKind({ candidate: { page_url: finalUrl, info_url: finalUrl }, linkInventory, pageText })
      return decideTargetVerified({ kind, pageText, status })
    }
    const programHtml =
      '<html><body><main><h1>Nashville Youth Services Grant</h1>' +
      '<p>The Nashville Community Foundation offers this grant to nonprofits serving youth in Tennessee. ' +
      'Applications are reviewed annually.</p>' +
      '<a href="https://prog.org/apply/form">Apply here</a></main></body></html>'
    // A directory page: many outbound program links + directory language.
    const dirLinks = Array.from({ length: 20 }, (_, i) => `<a href="https://dir.org/p/${i}">Program ${i}</a>`).join('')
    const dirHtml =
      `<html><body><main><h1>Grants Directory</h1><p>Browse our list of grants and search our database of funding.</p>${dirLinks}</main></body></html>`

    const store = createMemoryStore()
    const fetcher = makeTrackingFetcher({
      bodies: {
        [SOURCE]: '<html><body>youth grant</body></html>',
        'https://prog.org/apply': programHtml,
        'https://dir.org/directory': dirHtml,
      },
    })
    const extractPage = vi.fn(async () => [
      { title: 'Prog', sponsor: 'Nashville Community Foundation', apply_url: 'https://prog.org/apply', field_provenance: evidenced },
      { title: 'Dir', sponsor: 'Some Portal', apply_url: 'https://dir.org/directory' },
    ])
    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract(), blindShadow: { extractPage, classifyTarget } },
      { thesis: thesisTv, runId: 'tv-real' },
    )
    await res.targetVerification // settle the off-live-path telemetry step
    const pe = res.web_lane_blind_shadow.promotion_evidence
    expect(pe.target_verified).toBe(1) // the real program page
    expect(pe.source_only).toBe(1) // the aggregator/directory page
    expect(pe.real_and_matched).toBe(1)
    expect(res.stored).toBe(1) // live untouched
  })

  it('FINDING 2: a target that hangs the whole budget does NOT delay the live return (verification runs off the live path)', async () => {
    // The blocker: target verification used to be AWAITED before result.ok and the
    // return, so a hung target could delay the live result + persistRun by up to
    // the whole budget. Now the live result is finalized and returned immediately;
    // verification is a telemetry-only handle the caller settles AFTER persistRun.
    const store = createMemoryStore()
    const hang = new Set(['https://slow.org/apply'])
    const fetcher = makeTrackingFetcher({ bodies: { [SOURCE]: '<html><body>youth grant</body></html>' }, hang })
    const extractPage = vi.fn(async () => [{ title: 'Slow', sponsor: 'F', apply_url: 'https://slow.org/apply' }])

    const t0 = Date.now()
    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract(),
        blindShadow: { extractPage, targetVerifyBudgetMs: 1000, targetVerifyMax: 5, targetVerifyTimeoutMs: 1000 } },
      { thesis: thesisTv, runId: 'tv-nonblock' },
    )
    const liveReturnMs = Date.now() - t0

    // The LIVE result is fully available at return — result.ok, the stored
    // opportunity, and the catalog are ALL present before verification completes.
    expect(res.ok).toBe(true)
    expect(res.stored).toBe(1)
    expect(storage.listCatalog(store).length).toBe(1)
    // promotion_evidence is NOT attached yet: it is telemetry-only, off the live path.
    expect(res.web_lane_blind_shadow.promotion_evidence).toBeUndefined()
    // The live return time is INDEPENDENT of the ~1s hung-target budget — it did
    // not wait on target verification at all.
    expect(liveReturnMs).toBeLessThan(500)

    // Settling the handle is where the slow work is observed — decoupled from and
    // strictly AFTER the fast live return above.
    const t1 = Date.now()
    const pe = await res.targetVerification
    const verifyMs = Date.now() - t1
    expect(verifyMs).toBeGreaterThan(liveReturnMs)
    expect(pe.target_check_errors).toBeGreaterThanOrEqual(1) // the hung target aborted + counted
    expect(pe.target_verified).toBe(0)
    // Live result never regressed while verification ran.
    expect(storage.listCatalog(store).length).toBe(1)
  })

  it('FINDING 3: a repeatedly-FAILING target is cached — two candidates sharing a throwing url produce exactly ONE fetch', async () => {
    const store = createMemoryStore()
    const throwOn = new Set(['https://boom.org/apply'])
    const fetcher = makeTrackingFetcher({ bodies: { [SOURCE]: '<html><body>youth grant</body></html>' }, throwOn })
    const extractPage = vi.fn(async () => [
      { title: 'Boom 1', sponsor: 'F1', apply_url: 'https://boom.org/apply' },
      { title: 'Boom 2', sponsor: 'F2', apply_url: 'https://boom.org/apply' }, // same failing target
    ])
    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract(), blindShadow: { extractPage } },
      { thesis: thesisTv, runId: 'tv-failcache' },
    )
    await res.targetVerification
    // The failing target was fetched exactly ONCE — the second candidate reused the
    // cached failure verdict instead of spending another fetch (the dedup now
    // covers failures/timeouts, not only successes).
    expect(fetcher.calls.filter((u) => u === 'https://boom.org/apply').length).toBe(1)
    const pe = res.web_lane_blind_shadow.promotion_evidence
    expect(pe.target_fetches).toBe(1)
    expect(pe.target_checked).toBe(2)
    expect(pe.target_check_errors).toBe(1) // the one real attempt
    expect(pe.source_only).toBe(1) // the deduped repeat (cached not-verified)
    expect(pe.target_verified).toBe(0)
  })

  it('FINDING 3: alias (tracking param) and fragment variants of the same target dedup to ONE fetch', async () => {
    const store = createMemoryStore()
    const canonical = 'https://prog.org/apply'
    const fetcher = makeTrackingFetcher({
      bodies: { [SOURCE]: '<html><body>youth grant</body></html>', [canonical]: '<html><body>real program apply page</body></html>' },
    })
    const classifyTarget = vi.fn(async () => ({ verified: true }))
    const extractPage = vi.fn(async () => [
      { title: 'Base', sponsor: 'F1', apply_url: 'https://prog.org/apply', field_provenance: evidenced },
      { title: 'Tracking alias', sponsor: 'F2', apply_url: 'https://prog.org/apply?utm_source=news' }, // tracking param stripped
      { title: 'Fragment alias', sponsor: 'F3', apply_url: 'https://prog.org/apply#section' }, // fragment never sent on the wire
    ])
    const res = await runWebDiscoveryLane(
      { store, fetcher, searchWeb: makeSearch(), extractOpportunities: makeLiveExtract(), blindShadow: { extractPage, classifyTarget } },
      { thesis: thesisTv, runId: 'tv-aliasdedup' },
    )
    await res.targetVerification
    // All three collapse to the same normalized fetch identity → ONE network fetch.
    expect(fetcher.calls.filter((u) => u.startsWith('https://prog.org/apply')).length).toBe(1)
    const pe = res.web_lane_blind_shadow.promotion_evidence
    expect(pe.target_fetches).toBe(1)
    expect(pe.target_checked).toBe(3)
    expect(pe.target_verified).toBe(3) // base verified; the two aliases reuse the cached verdict
    expect(pe.real_and_matched).toBe(1) // only the evidenced base candidate
    // classifyTarget was consulted ONCE — only the single real fetch is classified.
    expect(classifyTarget).toHaveBeenCalledTimes(1)
  })
})

describe('decideTargetVerified (Phase 1d pure verdict)', () => {
  const bigProgram = 'A real funding program page. '.repeat(80) // > thin-page threshold, no bad cues
  it('verifies a reachable real single program (DIRECT_PROGRAM / UNKNOWN, no bad cues)', () => {
    expect(decideTargetVerified({ kind: 'DIRECT_PROGRAM', pageText: bigProgram, status: 200 }).verified).toBe(true)
    expect(decideTargetVerified({ kind: 'UNKNOWN', pageText: bigProgram, status: 200 }).verified).toBe(true)
  })
  it('rejects an aggregator/directory target', () => {
    const v = decideTargetVerified({ kind: 'AGGREGATOR_INDEX', pageText: bigProgram, status: 200 })
    expect(v.verified).toBe(false)
    expect(v.reason).toBe('aggregator')
  })
  it('rejects an error page (soft-200 or 4xx) and a thin login wall', () => {
    expect(decideTargetVerified({ kind: 'UNKNOWN', pageText: 'Page not found. Sorry.', status: 200 }).verified).toBe(false)
    expect(decideTargetVerified({ kind: 'DIRECT_PROGRAM', pageText: bigProgram, status: 404 }).verified).toBe(false)
    expect(decideTargetVerified({ kind: 'UNKNOWN', pageText: 'Please log in. Enter your password.', status: 200 }).verified).toBe(false)
  })
  it('does NOT reject a real program page that merely mentions a login link in long copy', () => {
    // "password" appears but the page is substantial content, not a thin login wall.
    const withNav = bigProgram + ' Members can log in with a password to view their account.'
    expect(decideTargetVerified({ kind: 'DIRECT_PROGRAM', pageText: withNav, status: 200 }).verified).toBe(true)
  })
})
