/**
 * grantsGovAmountAdapter.test.js
 *
 * The defect this adapter closes: grants.gov renders detail pages client-side,
 * so the page-fetch strategy returns `thin_page` for every grants.gov row
 * forever — 45 of the 149 backlog rows in the 2026-07-15 prod audit, permanently
 * unreadable by fetching, with pipeline-$ coverage pinned at ~13%.
 *
 * The sharpest test here is `"none"` handling: grants.gov sends the literal
 * STRING "none" for an absent award figure (7 of 16 live rows on 2026-07-16), so
 * any truthiness check would treat it as a real value and fabricate an amount
 * through a source the plausibility guard deliberately trusts.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  parseApiAmount,
  isGrantsGovRow,
  extractOpportunityIdFromUrl,
  resolveOpportunityId,
  fetchGrantsGovAward,
  enrichAmountViaGrantsGovApi,
} from '../services/sources/grantsGovAmountAdapter.js'
import { findAmountAdapter, AMOUNT_ADAPTERS } from '../services/sources/amountAdapters.js'

/** Build a fake fetch returning one JSON body (optionally per-URL). */
function fakeFetch(handler) {
  return vi.fn(async (url, init) => {
    const body = JSON.parse(init.body)
    const out = handler(String(url), body)
    if (out?.__networkError) throw new Error('socket hang up')
    return {
      ok: out.ok ?? true,
      status: out.status ?? 200,
      json: async () => out.json ?? { errorcode: 0 },
    }
  })
}

const synopsisBody = (ceiling, floor) => ({
  ok: true,
  json: { errorcode: 0, data: { id: 361754, synopsis: { awardCeiling: ceiling, awardFloor: floor } } },
})

describe('parseApiAmount — the "none" trap', () => {
  it('rejects the literal strings grants.gov sends for an absent figure', () => {
    // These are REAL values observed live on 2026-07-16. A truthiness check
    // (`if (awardCeiling)`) reads every one of them as present.
    for (const v of ['none', 'None', 'NONE', 'null', 'n/a', '', '   ']) {
      expect(parseApiAmount(v), `${JSON.stringify(v)} must not become a number`).toBeNull()
    }
  })

  it('rejects zero and negatives (grants.gov uses "0" as a placeholder, not a fact)', () => {
    expect(parseApiAmount('0')).toBeNull()
    expect(parseApiAmount(0)).toBeNull()
    expect(parseApiAmount('-500')).toBeNull()
  })

  it('rejects null/undefined and unparseable junk rather than guessing', () => {
    expect(parseApiAmount(null)).toBeNull()
    expect(parseApiAmount(undefined)).toBeNull()
    expect(parseApiAmount('up to five thousand')).toBeNull()
    expect(parseApiAmount('12abc')).toBeNull()
  })

  it('parses real figures, including formatted ones', () => {
    expect(parseApiAmount('22000000')).toBe(22_000_000)
    expect(parseApiAmount('200000')).toBe(200_000)
    expect(parseApiAmount('$150,000')).toBe(150_000)
    expect(parseApiAmount(5000)).toBe(5000)
    expect(parseApiAmount('2500.50')).toBe(2500.5)
  })
})

describe('row identification', () => {
  it('recognizes both live source spellings and grants.gov URLs', () => {
    expect(isGrantsGovRow({ source: 'grants.gov' })).toBe(true)
    expect(isGrantsGovRow({ source: 'grants_gov' })).toBe(true)
    expect(isGrantsGovRow({ record_origin: 'grants_gov' })).toBe(true)
    expect(isGrantsGovRow({ source_url: 'https://www.grants.gov/search-results-detail/361754' })).toBe(true)
    expect(isGrantsGovRow({ application_url: 'https://grants.gov/view-opportunity/12345' })).toBe(true)
  })

  it('does not claim rows belonging to other sources', () => {
    expect(isGrantsGovRow({ source: 'web_search', source_url: 'https://example.org/grant' })).toBe(false)
    expect(isGrantsGovRow({ source: 'sam.gov', source_url: 'https://sam.gov/opp/abc' })).toBe(false)
    expect(isGrantsGovRow(null)).toBe(false)
    // A lookalike hostname must not be mistaken for grants.gov.
    expect(isGrantsGovRow({ source_url: 'https://fakegrants.gov.evil.com/x' })).toBe(false)
  })

  it('extracts the opportunity id from detail and view URLs', () => {
    expect(extractOpportunityIdFromUrl({ source_url: 'https://www.grants.gov/search-results-detail/361754' })).toBe('361754')
    expect(extractOpportunityIdFromUrl({ application_url: 'https://www.grants.gov/view-opportunity/998877' })).toBe('998877')
    expect(extractOpportunityIdFromUrl({ source_url: 'https://www.grants.gov/search-results-detail/' })).toBeNull()
  })
})

describe('resolveOpportunityId — exact-match floor', () => {
  it('uses the id in the row URL without spending a request', async () => {
    const f = fakeFetch(() => ({ ok: true, json: { errorcode: 0 } }))
    const res = await resolveOpportunityId(
      { source_url: 'https://www.grants.gov/search-results-detail/361754' },
      { fetchImpl: f },
    )
    expect(res.id).toBe('361754')
    expect(f).not.toHaveBeenCalled()
  })

  it('resolves by opportunity number via search2 when the URL carries no id', async () => {
    const f = fakeFetch(() => ({
      ok: true,
      json: { errorcode: 0, data: { oppHits: [{ id: '361754', number: 'PA-FPH-27-001' }] } },
    }))
    const res = await resolveOpportunityId(
      { source: 'grants.gov', source_id: 'PA-FPH-27-001', source_url: 'https://www.grants.gov/' },
      { fetchImpl: f },
    )
    expect(res.id).toBe('361754')
  })

  it('REFUSES a near-miss hit (search2 is a search: hits[0] is not identity)', async () => {
    // The sort-without-a-floor class: taking hits[0] unconditionally is exactly
    // how a stranger's email got attached to a Yana lead.
    const f = fakeFetch(() => ({
      ok: true,
      json: { errorcode: 0, data: { oppHits: [{ id: '999999', number: 'PA-FPH-27-002' }] } },
    }))
    const res = await resolveOpportunityId(
      { source: 'grants.gov', source_id: 'PA-FPH-27-001' },
      { fetchImpl: f },
    )
    expect(res.id).toBeNull()
  })

  it('reports a failed lookup as transient rather than "no id"', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 503 }))
    const res = await resolveOpportunityId({ source: 'grants.gov', source_id: 'PA-FPH-27-001' }, { fetchImpl: f })
    expect(res.id).toBeNull()
    expect(res.transient).toBe(true)
  })
})

describe('fetchGrantsGovAward — synopsis vs forecast', () => {
  it('reads award figures from synopsis (posted opportunities)', async () => {
    const f = fakeFetch(() => synopsisBody('22000000', '200000'))
    const res = await fetchGrantsGovAward('361754', { fetchImpl: f })
    expect(res).toMatchObject({ ok: true, amount_min: 200_000, amount_max: 22_000_000 })
  })

  it('reads award figures from forecast when there is NO synopsis node', async () => {
    // Verified live 2026-07-16 (id 334092): a forecasted opportunity has a
    // `forecast` node and no `synopsis` at all. Reading only `synopsis` would
    // silently report "no amount" for every forecasted row.
    const f = fakeFetch(() => ({
      ok: true,
      json: { errorcode: 0, data: { id: 334092, forecast: { awardCeiling: '500000', awardFloor: '50000' } } },
    }))
    const res = await fetchGrantsGovAward('334092', { fetchImpl: f })
    expect(res).toMatchObject({ ok: true, amount_min: 50_000, amount_max: 500_000 })
  })

  it('returns ok with null amounts when the API says "none" (a real answer)', async () => {
    const f = fakeFetch(() => synopsisBody('none', 'none'))
    const res = await fetchGrantsGovAward('350230', { fetchImpl: f })
    expect(res).toMatchObject({ ok: true, amount_min: null, amount_max: null })
  })

  it('treats an application-level errorcode as stable, not transient', async () => {
    const f = fakeFetch(() => ({ ok: true, json: { errorcode: 1, msg: 'Invalid opportunity id' } }))
    const res = await fetchGrantsGovAward('1', { fetchImpl: f })
    expect(res.ok).toBe(false)
    expect(res.transient).toBe(false)
  })
})

describe('enrichAmountViaGrantsGovApi — the sweep contract', () => {
  const row = { source: 'grants.gov', title: 'Title X', source_url: 'https://www.grants.gov/search-results-detail/361754' }

  it('returns a found result with official structured amounts', async () => {
    const f = fakeFetch(() => synopsisBody('22000000', '200000'))
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(res).toMatchObject({ attempted: true, page_read: true, transient: false, found: true })
    expect(res.amounts).toMatchObject({ amount_min: 200_000, amount_max: 22_000_000, amount_status: 'range' })
  })

  it('marks an equal floor/ceiling as a known amount, not a range', async () => {
    const f = fakeFetch(() => synopsisBody('5000', '5000'))
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(res.amounts).toMatchObject({ amount_min: 5000, amount_max: 5000, amount_status: 'known' })
  })

  it('NEVER fabricates an amount when the API says "none" — and burns the row', async () => {
    // The whole point: page_read:true tells the sweep this is a real answer, so
    // the row stops being re-read; found:false + no `amounts` means nothing is
    // written. This is the honest "grants.gov publishes no figure" outcome.
    const f = fakeFetch(() => synopsisBody('none', 'none'))
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(res).toMatchObject({ attempted: true, page_read: true, found: false, reason: 'no_award_amount_published' })
    expect(res.amounts).toBeUndefined()
  })

  it('reports a 503 as transient so an outage never burns the row', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 503 }))
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(res).toMatchObject({ attempted: true, page_read: false, transient: true, found: false })
  })

  it('reports a 404 as stable (retrying a dead id nightly teaches nothing)', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(res).toMatchObject({ attempted: true, page_read: false, transient: false })
  })

  it('reports a transport throw as transient rather than escaping', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNRESET') })
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(res).toMatchObject({ attempted: true, transient: true, found: false })
  })

  it('declines a non-grants.gov row with attempted:false so the page fetcher still runs', async () => {
    const f = fakeFetch(() => ({ ok: true, json: { errorcode: 0 } }))
    const res = await enrichAmountViaGrantsGovApi({ source: 'web_search', source_url: 'https://x.org/a' }, { fetchImpl: f })
    expect(res.attempted).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it('declines with attempted:false when the row is ours but unidentifiable', async () => {
    // No id in the URL and no source_id → the adapter cannot act, but the page
    // fetcher might still read something. Must NOT burn the row.
    const f = fakeFetch(() => ({ ok: true, json: { errorcode: 0 } }))
    const res = await enrichAmountViaGrantsGovApi({ source: 'grants.gov', source_url: 'https://www.grants.gov/' }, { fetchImpl: f })
    expect(res.attempted).toBe(false)
  })
})

describe('the adapter registry (totality)', () => {
  it('routes a grants.gov row to the grants_gov adapter', () => {
    expect(findAmountAdapter({ source: 'grants.gov' })?.id).toBe('grants_gov')
  })

  it('returns null for rows no adapter owns (caller falls back to page fetch)', () => {
    expect(findAmountAdapter({ source: 'web_search' })).toBeNull()
    expect(findAmountAdapter(null)).toBeNull()
  })

  it('every registered adapter satisfies the registry contract', () => {
    // Totality: a new adapter cannot silently fall out of the contract the
    // enrichment sweep depends on.
    expect(AMOUNT_ADAPTERS.length).toBeGreaterThan(0)
    for (const a of AMOUNT_ADAPTERS) {
      expect(typeof a.id, 'adapter needs a stable id').toBe('string')
      expect(typeof a.matches, `${a.id}.matches`).toBe('function')
      expect(typeof a.enrich, `${a.id}.enrich`).toBe('function')
    }
  })

  it('a throwing matcher cannot break routing for other sources', () => {
    expect(() => findAmountAdapter({ get source() { throw new Error('boom') } })).not.toThrow()
  })
})
