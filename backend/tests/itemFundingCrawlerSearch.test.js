/**
 * itemFundingCrawler.searchWebForItem — the search-backend rewire (2026-07-27).
 *
 * The crawler used to scrape DuckDuckGo HTML directly: dead from datacenter
 * IPs (202 anti-bot challenge), and blind to SearXNG and Brave entirely — so
 * in prod every item search silently returned nothing, and when Brave's budget
 * breaker was open the lane had no other rung to fall to. It must now route
 * through the SHARED searchWeb ladder so it degrades exactly like profile
 * discovery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const searchWebMock = vi.fn()
vi.mock('../services/shared/webSearchEngine.js', () => ({
  searchWeb: (...a) => searchWebMock(...a),
}))

const { searchWebForItem } = await import('../services/crawlers/itemFundingCrawler.js')

beforeEach(() => {
  searchWebMock.mockReset()
})

describe('searchWebForItem', () => {
  it('routes every query through the SHARED searchWeb ladder (never its own scraper)', async () => {
    searchWebMock.mockResolvedValue([
      { url: 'https://vandonations.org/apply', title: 'Van Donation Program', snippet: 'free vans for nonprofits' },
    ])

    const results = await searchWebForItem('15-passenger van', {
      signals: { location: { state: 'TN' } },
    })

    expect(searchWebMock).toHaveBeenCalled()
    // Every call is the shared-engine shape: (query, { count, timeoutMs }).
    for (const call of searchWebMock.mock.calls) {
      expect(typeof call[0]).toBe('string')
      expect(call[1]).toMatchObject({ count: 8 })
    }
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toMatchObject({
      url: 'https://vandonations.org/apply',
      title: 'Van Donation Program',
      description: 'free vans for nonprofits',
    })
    // Provenance survives: the query that surfaced the hit rides along.
    expect(typeof results[0]._search_query).toBe('string')
  })

  it('dedupes the same URL across queries', async () => {
    searchWebMock.mockResolvedValue([
      { url: 'https://example.org/one', title: 'One', snippet: '' },
      { url: 'https://example.org/one/', title: 'One again', snippet: '' },
    ])
    const results = await searchWebForItem('wheelchair ramp', { signals: {} })
    expect(results.filter((r) => r.url.toLowerCase().startsWith('https://example.org/one')).length).toBe(1)
  })

  it('a failing search backend yields [] for that query, never a throw', async () => {
    searchWebMock.mockRejectedValue(new Error('every backend down'))
    const results = await searchWebForItem('CPR training', { signals: {} })
    expect(Array.isArray(results)).toBe(true)
    expect(results).toEqual([])
  })
})
