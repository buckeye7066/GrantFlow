/**
 * Tests for backend/services/urlEnrichment.js — the application-URL rescue
 * lane's search/verify helper.
 *
 * Honesty contract under test: the finder only ever returns a URL that came
 * back from a real search for the candidate's own title+sponsor, passed the
 * token-overlap plausibility check, and answered a liveness probe — and it
 * never throws (provider failures surface as searched:false).
 */

import { describe, it, expect } from 'vitest'
import {
  significantTitleTokens,
  isPlausibleOfficialHit,
  findOfficialUrlForOpportunity,
  MAX_LIVENESS_PROBES,
} from '../services/urlEnrichment.js'

describe('significantTitleTokens', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and short tokens, dedupes', () => {
    expect(
      significantTitleTokens('The Rural Fire-Department Equipment Grant Program for Fire Departments'),
    ).toEqual(['rural', 'fire', 'department', 'equipment', 'departments'])
  })

  it('drops tokens shorter than 3 chars and all defined stopwords', () => {
    expect(significantTitleTokens('A Fund to Aid an OK Grant of Grants in ON with Funding')).toEqual(['aid'])
  })

  it('returns [] for empty / non-string input', () => {
    expect(significantTitleTokens('')).toEqual([])
    expect(significantTitleTokens('   ')).toEqual([])
    expect(significantTitleTokens(null)).toEqual([])
    expect(significantTitleTokens(undefined)).toEqual([])
  })
})

describe('isPlausibleOfficialHit', () => {
  const candidate = {
    title: 'Rural Fire Department Equipment Grant',
    sponsor: 'FEMA',
  }
  // significant tokens: rural, fire, department, equipment (4)

  it('accepts a hit whose title/snippet/url cover >=60% of the significant tokens', () => {
    const hit = {
      url: 'https://www.fema.gov/grants/rural-fire-department-equipment',
      title: 'Rural Fire Department Equipment funding | FEMA',
      snippet: 'Apply for equipment funding for rural volunteer fire departments.',
    }
    expect(isPlausibleOfficialHit(candidate, hit)).toBe(true)
  })

  it('accepts even without any sponsor mention (sponsor is confidence, not a requirement)', () => {
    const hit = {
      url: 'https://examplefoundation.org/programs',
      title: 'Rural Fire Department Equipment support',
      snippet: 'Protective equipment for rural departments.',
    }
    expect(isPlausibleOfficialHit(candidate, hit)).toBe(true)
  })

  it('rejects a hit below the token-overlap threshold', () => {
    const hit = {
      url: 'https://example.org/unrelated',
      title: 'Fire safety tips for the home',
      snippet: 'Smoke alarms and evacuation plans.',
    }
    // only "fire" of 4 tokens (25%) — below 60%
    expect(isPlausibleOfficialHit(candidate, hit)).toBe(false)
  })

  it('rejects a search-engine results URL even with perfect token overlap', () => {
    const hit = {
      url: 'https://www.google.com/search?q=rural+fire+department+equipment+grant',
      title: 'Rural Fire Department Equipment Grant',
      snippet: 'rural fire department equipment',
    }
    expect(isPlausibleOfficialHit(candidate, hit)).toBe(false)
  })

  it('rejects non-http(s) URLs', () => {
    const hit = {
      url: 'ftp://fema.gov/rural-fire-department-equipment',
      title: 'Rural Fire Department Equipment Grant',
      snippet: 'rural fire department equipment',
    }
    expect(isPlausibleOfficialHit(candidate, hit)).toBe(false)
  })

  it('rejects when the candidate title has fewer than 2 significant tokens', () => {
    const vague = { title: 'The Grant Program', sponsor: 'FEMA' } // 0 significant tokens
    const hit = {
      url: 'https://fema.gov/the-grant-program',
      title: 'The Grant Program',
      snippet: 'the grant program',
    }
    expect(isPlausibleOfficialHit(vague, hit)).toBe(false)
  })

  it('handles missing/nullish inputs without throwing', () => {
    expect(isPlausibleOfficialHit(null, { url: 'https://x.org' })).toBe(false)
    expect(isPlausibleOfficialHit({ title: 'Rural Fire Department Equipment Grant' }, null)).toBe(false)
    expect(isPlausibleOfficialHit({}, {})).toBe(false)
  })
})

describe('findOfficialUrlForOpportunity', () => {
  const candidate = { title: 'Rural Fire Department Equipment Grant', sponsor: 'FEMA' }
  const goodHit = {
    url: 'https://www.fema.gov/grants/rural-fire-department-equipment',
    title: 'Rural Fire Department Equipment Grant | FEMA',
    snippet: 'Equipment funding for rural fire departments.',
  }

  it('returns the probed final URL on a plausible, live hit (and reports search telemetry)', async () => {
    const calls = { search: [], probe: [] }
    const res = await findOfficialUrlForOpportunity(candidate, {
      searchWebImpl: async (query, opts) => {
        calls.search.push({ query, opts })
        return [goodHit, { url: 'https://unrelated.org', title: 'zzz', snippet: 'zzz' }]
      },
      checkUrlImpl: async (url) => {
        calls.probe.push(url)
        return { status: 'ok', code: 200, finalUrl: 'https://www.fema.gov/grants/rural-fire-department-equipment/' }
      },
    })
    expect(res.searched).toBe(true)
    expect(res.hits).toBe(2)
    expect(res.url).toBe('https://www.fema.gov/grants/rural-fire-department-equipment/')
    expect(res.hit).toEqual(goodHit)
    expect(res.probe.status).toBe('ok')
    // Query is built from the candidate's own title + sponsor — nothing else.
    expect(calls.search[0].query).toBe('"Rural Fire Department Equipment Grant" FEMA')
    // Only the plausible hit is probed.
    expect(calls.probe).toEqual([goodHit.url])
  })

  it('falls back to hit.url when the probe reports no finalUrl (redirect counts as live)', async () => {
    const res = await findOfficialUrlForOpportunity(candidate, {
      searchWebImpl: async () => [goodHit],
      checkUrlImpl: async () => ({ status: 'redirect', code: 301, finalUrl: null }),
    })
    expect(res.url).toBe(goodHit.url)
  })

  it('returns {url:null, searched:true, hits:0} when the search returns zero hits', async () => {
    const res = await findOfficialUrlForOpportunity(candidate, {
      searchWebImpl: async () => [],
      checkUrlImpl: async () => { throw new Error('must not be called') },
    })
    expect(res).toEqual({ url: null, searched: true, hits: 0 })
  })

  it('returns {url:null, searched:true} with hit count when nothing plausible came back', async () => {
    const probes = []
    const res = await findOfficialUrlForOpportunity(candidate, {
      searchWebImpl: async () => [
        { url: 'https://unrelated-a.org', title: 'aaa', snippet: 'bbb' },
        { url: 'https://unrelated-b.org', title: 'ccc', snippet: 'ddd' },
      ],
      checkUrlImpl: async (url) => { probes.push(url); return { status: 'ok', code: 200 } },
    })
    expect(res.url).toBe(null)
    expect(res.searched).toBe(true)
    expect(res.hits).toBe(2)
    expect(probes).toEqual([]) // implausible hits are never probed
  })

  it('tries the next plausible hit when a probe comes back broken', async () => {
    const secondHit = {
      url: 'https://examplefoundation.org/rural-fire-department-equipment',
      title: 'Rural Fire Department Equipment Grant',
      snippet: 'equipment for rural fire departments',
    }
    const res = await findOfficialUrlForOpportunity(candidate, {
      // First hit mentions the sponsor so it is probed first (confidence order).
      searchWebImpl: async () => [goodHit, secondHit],
      checkUrlImpl: async (url) =>
        url === goodHit.url
          ? { status: 'broken', code: 404, finalUrl: null }
          : { status: 'ok', code: 200, finalUrl: null },
    })
    expect(res.url).toBe(secondHit.url)
    expect(res.hit).toEqual(secondHit)
  })

  it('never probes more than MAX_LIVENESS_PROBES hits', async () => {
    const manyHits = Array.from({ length: 6 }, (_, i) => ({
      url: `https://site-${i}.org/rural-fire-department-equipment`,
      title: 'Rural Fire Department Equipment Grant',
      snippet: 'rural fire department equipment',
    }))
    let probes = 0
    const res = await findOfficialUrlForOpportunity(candidate, {
      searchWebImpl: async () => manyHits,
      checkUrlImpl: async () => { probes += 1; return { status: 'broken', code: 500, finalUrl: null } },
    })
    expect(probes).toBe(MAX_LIVENESS_PROBES)
    expect(res.url).toBe(null)
    expect(res.searched).toBe(true)
    expect(res.hits).toBe(6)
  })

  it('never throws — a throwing search impl yields {url:null, searched:false, error}', async () => {
    const res = await findOfficialUrlForOpportunity(candidate, {
      searchWebImpl: async () => { throw new Error('provider exploded') },
      checkUrlImpl: async () => ({ status: 'ok', code: 200 }),
    })
    expect(res.url).toBe(null)
    expect(res.searched).toBe(false)
    expect(res.error).toContain('provider exploded')
  })

  it('never throws — a throwing probe impl yields searched:false', async () => {
    const res = await findOfficialUrlForOpportunity(candidate, {
      searchWebImpl: async () => [goodHit],
      checkUrlImpl: async () => { throw new Error('socket melted') },
    })
    expect(res.url).toBe(null)
    expect(res.searched).toBe(false)
    expect(res.error).toContain('socket melted')
  })
})
