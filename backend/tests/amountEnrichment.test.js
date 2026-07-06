import { describe, it, expect } from 'vitest'
import { enrichOpportunityAmountFromSource } from '../services/amountEnrichment.js'

const PAGE = (body) => `<html><head><title>x</title></head><body><main>${body}</main></body></html>`
const FILLER = ' Community foundation serving the region since 1985. '.repeat(10)

function fakeFetcher(body, ok = true, status = 200) {
  return { fetch: async () => ({ ok, status, body, finalUrl: 'https://funder.org/grants' }) }
}

describe('enrichOpportunityAmountFromSource', () => {
  it('extracts a per-award amount from the source page', async () => {
    const res = await enrichOpportunityAmountFromSource(
      { title: 'Community Grant', source_url: 'https://funder.org/grants' },
      { fetcher: fakeFetcher(PAGE(`${FILLER} Grants of up to $5,000 are awarded to local nonprofits. ${FILLER}`)) },
    )
    expect(res.attempted).toBe(true)
    expect(res.found).toBe(true)
    expect(res.amounts.amount_max).toBe(5000)
  })

  it('does not fabricate numbers from a program-total page', async () => {
    const res = await enrichOpportunityAmountFromSource(
      { title: 'Big Program', source_url: 'https://funder.org/grants' },
      { fetcher: fakeFetcher(PAGE(`${FILLER} $42 million in funding awarded annually across the nation. ${FILLER}`)) },
    )
    expect(res.found).toBe(false)
  })

  it('reports honestly when there is no URL, a failed fetch, or a thin page', async () => {
    expect((await enrichOpportunityAmountFromSource({ title: 'x' }, { fetcher: fakeFetcher('') })).attempted).toBe(false)
    const failed = await enrichOpportunityAmountFromSource(
      { title: 'x', source_url: 'https://funder.org' },
      { fetcher: fakeFetcher(null, false, 404) },
    )
    expect(failed.found).toBe(false)
    const thin = await enrichOpportunityAmountFromSource(
      { title: 'x', source_url: 'https://funder.org' },
      { fetcher: fakeFetcher(PAGE('tiny')) },
    )
    expect(thin.found).toBe(false)
    expect(thin.reason).toBe('thin_page')
  })

  it('never throws when the fetcher explodes', async () => {
    const res = await enrichOpportunityAmountFromSource(
      { title: 'x', source_url: 'https://funder.org' },
      { fetcher: { fetch: async () => { throw new Error('boom') } } },
    )
    expect(res.found).toBe(false)
    expect(res.reason).toContain('boom')
  })
})
