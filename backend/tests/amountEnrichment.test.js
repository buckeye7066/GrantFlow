import { describe, it, expect } from 'vitest'
import { enrichOpportunityAmountFromSource, isTransientFetchFailure } from '../services/amountEnrichment.js'

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
    // ...and BECAUSE it never throws, the caller cannot use try/catch to tell an
    // outage from a real answer. That is what page_read/transient are for: the
    // sweep's retry guard used to live in a catch block this contract makes
    // unreachable, so every 503 permanently burned a row's one chance.
    expect(res.page_read).toBe(false)
    expect(res.transient).toBe(true)
  })

  describe('page_read / transient — the burn-guard contract', () => {
    it('marks a page the extractor actually scanned as read, so the caller stops asking', async () => {
      const res = await enrichOpportunityAmountFromSource(
        { title: 'x', source_url: 'https://funder.org/grants' },
        { fetcher: fakeFetcher(PAGE(`${FILLER} No award figures are published here. ${FILLER}`)) },
      )
      expect(res.page_read).toBe(true)
      expect(res.transient).toBe(false)
    })

    it('treats 5xx/429/timeouts as transient and a 404/410 as a stable fact about the URL', async () => {
      for (const status of [500, 502, 503, 429, 408]) {
        const res = await enrichOpportunityAmountFromSource(
          { title: 'x', source_url: 'https://funder.org' },
          { fetcher: fakeFetcher(null, false, status) },
        )
        expect(res.page_read, `status ${status}`).toBe(false)
        expect(res.transient, `status ${status}`).toBe(true)
      }
      for (const status of [404, 410]) {
        const res = await enrichOpportunityAmountFromSource(
          { title: 'x', source_url: 'https://funder.org' },
          { fetcher: fakeFetcher(null, false, status) },
        )
        expect(res.transient, `status ${status}`).toBe(false)
        expect(res.environment ?? false, `status ${status}`).toBe(false)
      }
    })

    it('reports a 401/403/429 page fetch as an ENVIRONMENT failure, never a row fact', async () => {
      // A WAF/bot-block (tn.gov Incapsula, Akamai fronts) refuses OUR CALLER,
      // not the URL — the same rule the API adapters already state. Burning on
      // it converted egress trouble into permanently answerless rows; the sweep
      // now parks these on the env-blocked lane (no burn, no retry-budget spend).
      for (const status of [401, 403, 429]) {
        const res = await enrichOpportunityAmountFromSource(
          { title: 'x', source_url: 'https://funder.org' },
          { fetcher: fakeFetcher(null, false, status) },
        )
        expect(res.page_read, `status ${status}`).toBe(false)
        expect(res.environment, `status ${status}`).toBe(true)
        expect(res.transient, `status ${status}`).toBe(true)
        expect(res.status, `status ${status}`).toBe(status)
      }
    })

    it('treats a JS-shell thin page as stable, not transient — refetching cannot fix it', async () => {
      const thin = await enrichOpportunityAmountFromSource(
        { title: 'x', source_url: 'https://sam.gov/opp/123' },
        { fetcher: fakeFetcher(PAGE('tiny')) },
      )
      // Not page_read: the extractor never saw award copy, so we have NOT
      // learned this opportunity lacks an amount. Not transient either: the
      // shell renders empty every night. Reaching these hosts needs an adapter.
      expect(thin.page_read).toBe(false)
      expect(thin.transient).toBe(false)
    })

    it('classifies a statusless transport failure as transient', () => {
      expect(isTransientFetchFailure({ status: null })).toBe(true)
      expect(isTransientFetchFailure({})).toBe(true)
      expect(isTransientFetchFailure({ status: 503 })).toBe(true)
      expect(isTransientFetchFailure({ status: 404 })).toBe(false)
    })
  })

  describe('the API adapter lane', () => {
    // A stub adapter standing in for grants.gov: asserts the WIRING (adapter
    // consulted before any fetch, its answer returned verbatim, a decline
    // falling through to the page) without touching the network.
    const adapterFor = (result, spy) => () => ({
      id: 'stub',
      enrich: async (row) => { spy?.(row); return result },
    })

    it('reads a JS-shell source via its API instead of returning thin_page', async () => {
      // THE REGRESSION. On the old code this row could only ever be a
      // `thin_page`: grants.gov renders client-side, so the fetcher gets a shell
      // with no award copy and the sweep learns nothing, every night, forever —
      // 45 of 149 backlog rows in the 2026-07-15 prod audit.
      const res = await enrichOpportunityAmountFromSource(
        { title: 'Title X Family Planning', source: 'grants.gov', source_url: 'https://www.grants.gov/search-results-detail/361754' },
        {
          fetcher: fakeFetcher(PAGE('tiny')),
          findAdapter: adapterFor({
            attempted: true, page_read: true, transient: false, found: true,
            amounts: { amount_min: 200_000, amount_max: 22_000_000, amount_status: 'range', amount_confidence: 'high' },
          }),
        },
      )
      expect(res.found).toBe(true)
      expect(res.amounts.amount_max).toBe(22_000_000)
    })

    it('does not fetch the page at all when an adapter answers', async () => {
      let fetched = false
      const watchingFetcher = { fetch: async () => { fetched = true; return { ok: true, status: 200, body: PAGE('x') } } }
      await enrichOpportunityAmountFromSource(
        { title: 'x', source: 'grants.gov', source_url: 'https://www.grants.gov/search-results-detail/1' },
        {
          fetcher: watchingFetcher,
          findAdapter: adapterFor({ attempted: true, page_read: true, transient: false, found: false, reason: 'no_award_amount_published' }),
        },
      )
      expect(fetched, 'an authoritative API answer must not be second-guessed by scraping').toBe(false)
    })

    it('falls back to the page fetcher when the adapter declines (attempted:false)', async () => {
      // An adapter that cannot identify the row must never cost that row its
      // chance at the generic strategy.
      const res = await enrichOpportunityAmountFromSource(
        { title: 'Community Grant', source_url: 'https://funder.org/grants' },
        {
          fetcher: fakeFetcher(PAGE(`${FILLER} Grants of up to $5,000 are awarded. ${FILLER}`)),
          findAdapter: adapterFor({ attempted: false, page_read: false, transient: false, found: false, reason: 'not_mine' }),
        },
      )
      expect(res.found).toBe(true)
      expect(res.amounts.amount_max).toBe(5000)
    })

    it('passes the row to the adapter and returns a transient API failure verbatim', async () => {
      let seen = null
      const res = await enrichOpportunityAmountFromSource(
        { title: 'x', source: 'grants.gov', source_url: 'https://www.grants.gov/search-results-detail/9' },
        {
          fetcher: fakeFetcher(PAGE('tiny')),
          findAdapter: adapterFor(
            { attempted: true, page_read: false, transient: true, found: false, reason: 'grants_gov_api_failed:503' },
            (row) => { seen = row },
          ),
        },
      )
      expect(seen?.source).toBe('grants.gov')
      // transient must survive to the sweep — it is what stops an outage from
      // permanently burning the row.
      expect(res).toMatchObject({ attempted: true, transient: true, page_read: false })
    })
  })
})
