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
})
