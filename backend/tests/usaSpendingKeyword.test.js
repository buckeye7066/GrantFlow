/**
 * USASpending awards are now profile-keyword-driven in the connector ingest
 * (funder-lead intelligence for org/government profiles). These tests pin that
 * a profile term reaches the API as a `filters.keywords` constraint — and that
 * the legacy keyless call (used by crawlerFramework) is unchanged.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const calls = []
vi.mock('../services/sources/httpClient.js', () => ({
  fetchWithRetry: vi.fn(async (url, opts) => {
    calls.push({ url, opts })
    return { results: [] }
  }),
}))

const { fetchUSASpending } = await import('../services/sources/usaSpending.js')

describe('fetchUSASpending keyword filtering', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('passes a single profile term into filters.keywords', async () => {
    await fetchUSASpending({ keyword: 'dialysis', limit: 5 })
    expect(calls).toHaveLength(1)
    expect(calls[0].opts.data.filters.keywords).toEqual(['dialysis'])
  })

  it('merges keyword + keywords[] and drops out-of-range terms', async () => {
    await fetchUSASpending({ keyword: 'veteran housing', keywords: ['ab', 'food security'] })
    expect(calls[0].opts.data.filters.keywords).toEqual(['veteran housing', 'food security'])
  })

  it('omits filters.keywords entirely for the legacy keyless call', async () => {
    await fetchUSASpending({ limit: 5, page: 1 })
    expect(calls[0].opts.data.filters.keywords).toBeUndefined()
    // Award-type/time-period filters are still present (back-compat).
    expect(calls[0].opts.data.filters.award_type_codes).toEqual(['02', '03', '04', '05'])
  })
})
