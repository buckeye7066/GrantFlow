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
import { capShadowHtml, MAX_SHADOW_HTML_CHARS } from '../services/crawlerOsService.js'

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
    })
    expect(typeof elapsed_ms).toBe('number')
    expect(elapsed_ms).toBeGreaterThanOrEqual(0)

    // Live outputs are byte-identical to the flag-off baseline: nothing leaked.
    expect(liveSnapshot(onStore, onRes)).toEqual(baseline)
    // And no blind candidate was persisted into the catalog.
    expect(storage.listCatalog(onStore).some((c) => /Blind/.test(c.title))).toBe(false)
  })

  it('flag ON with the blind path throwing: live lane still returns normally (best-effort isolation)', async () => {
    const extractPage = vi.fn(async () => { throw new Error('blind boom / timeout') })
    const store = createMemoryStore()
    const res = await runWebDiscoveryLane(
      { store, fetcher: fakeFetcher(bodyByUrl), searchWeb: makeSearch(), extractOpportunities: makeExtract(), blindShadow: { extractPage } },
      { thesis, runId: 'err1' },
    )
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
