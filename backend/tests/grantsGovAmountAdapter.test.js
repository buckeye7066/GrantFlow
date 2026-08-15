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
import { AMOUNT_CONFIDENCE_STRUCTURED } from '../services/awardAmountExtractor.js'

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

  it('marks the API\'s own "no record found" answer as record_retired (verified live 2026-08-15)', async () => {
    // The exact live shape for retired/archived listings (ids 338441/355786/
    // 360509): HTTP 200, "Webservice Succeeds", a data node with NO synopsis or
    // forecast, and errorMessages carrying the API's own statement.
    const f = fakeFetch(() => ({
      ok: true,
      json: { errorcode: 0, msg: 'Webservice Succeeds', data: { revision: 0, errorMessages: ['There is no record found for your search.'] } },
    }))
    const res = await fetchGrantsGovAward('338441', { fetchImpl: f })
    expect(res).toMatchObject({ ok: false, transient: false, record_retired: true, reason: 'record_not_found' })
  })

  it('a node-less response WITHOUT the no-record message stays the old no_synopsis_or_forecast failure', async () => {
    const f = fakeFetch(() => ({ ok: true, json: { errorcode: 0, data: { revision: 0 } } }))
    const res = await fetchGrantsGovAward('999999', { fetchImpl: f })
    expect(res).toMatchObject({ ok: false, reason: 'no_synopsis_or_forecast' })
    expect(res.record_retired).toBeUndefined()
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

  it('reports amount_confidence as the NUMERIC structured scale, not a label', async () => {
    // REGRESSION (prod 2026-07-16). This shipped as the string 'high'.
    // `amount_confidence` is a REAL column: Postgres threw `invalid input
    // syntax for type real: "high"`, and because the sweep marked the row
    // attempted BEFORE the write, 10 rows whose amounts the API had already
    // returned were burned holding nothing. Every unit test passed, because the
    // test DB is SQLite and SQLite is typeless — so asserting the TYPE here is
    // the only thing that can catch it.
    const f = fakeFetch(() => synopsisBody('22000000', '200000'))
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(typeof res.amounts.amount_confidence).toBe('number')
    expect(res.amounts.amount_confidence).toBe(AMOUNT_CONFIDENCE_STRUCTURED)
    // Same scale the page-extraction lane persists for structured figures.
    expect(res.amounts.amount_confidence).toBeGreaterThan(0)
    expect(res.amounts.amount_confidence).toBeLessThanOrEqual(1)
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

  it('a RETIRED record is a READ with an honest label, never "needs an adapter" (2026-08-15)', async () => {
    // 6 active-pipeline rows sat in the census's unanswered_unreadable bucket
    // as `grants_gov_api_failed:no_synopsis_or_forecast` while the API had
    // definitively answered "There is no record found for your search." —
    // the listing is retired/archived. page_read:true burns the row (the
    // answer cannot change) and the label rides amount_text so the row reads
    // as ANSWERED. (Simpler Grants fallback key unset here — the archive door
    // gets its chance in the next test.)
    delete process.env.SIMPLER_GRANTS_API_KEY
    const f = fakeFetch(() => ({
      ok: true,
      json: { errorcode: 0, msg: 'Webservice Succeeds', data: { revision: 0, errorMessages: ['There is no record found for your search.'] } },
    }))
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(res).toMatchObject({ attempted: true, page_read: true, transient: false, found: false, reason: 'grants_gov_record_retired' })
    expect(res.amount_text).toMatch(/no longer lists/i)
    expect(res.amounts).toBeUndefined()
  })

  it('the Simpler Grants archive door still WINS over a retired primary record', async () => {
    // grants.gov retiring a listing does not erase the historical figures —
    // Simpler Grants serves archived records. A real archived answer must beat
    // the retirement label.
    process.env.SIMPLER_GRANTS_API_KEY = 'test-key'
    try {
      const f = vi.fn(async (url, init) => {
        if (String(url).includes('simpler')) {
          return { ok: true, status: 200, json: async () => ({ data: { summary: { award_floor: '1000', award_ceiling: '5000' } } }) }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ errorcode: 0, msg: 'Webservice Succeeds', data: { revision: 0, errorMessages: ['There is no record found for your search.'] } }),
        }
      })
      const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
      expect(res).toMatchObject({ attempted: true, page_read: true, found: true })
      expect(res.amounts).toMatchObject({ amount_min: 1000, amount_max: 5000 })
    } finally {
      delete process.env.SIMPLER_GRANTS_API_KEY
    }
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
    expect(res.environment).toBe(false) // a dead id is about the ROW, not our egress
  })

  it('reports a WAF 403 as ENVIRONMENT-transient with its status — never a stable fact about the row', async () => {
    // REGRESSION (prod 2026-07-21). The adapter has effectively NEVER succeeded
    // from Railway: a WAF 403 on every datacenter-egress call (the identical
    // keyless request works from a residential machine). The old rule read ANY
    // 4xx as "grants.gov told us something stable about this id" → transient:
    // false → the sweep's burn rule permanently burned every knowable row
    // answerless. A 403 is a fact about OUR EGRESS, not the opportunity.
    for (const status of [403, 401, 429]) {
      const f = fakeFetch(() => ({ ok: false, status }))
      const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
      expect(res, `http ${status}`).toMatchObject({
        attempted: true,
        page_read: false, // never a fake success
        transient: true, // stays retryable
        environment: true, // and the sweep exempts it from the out-of-retries burn
        found: false,
        status, // telemetry: WHICH status blocked us
        reason: `grants_gov_api_failed:http_${status}`,
      })
      expect(res.amounts).toBeUndefined() // silence is not an answer
    }
  })

  it('a WAF 403 during the ID LOOKUP is equally environment-transient (not "no id")', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 403 }))
    const res = await enrichAmountViaGrantsGovApi(
      { source: 'grants.gov', source_id: 'PA-FPH-27-001', source_url: 'https://www.grants.gov/' },
      { fetchImpl: f },
    )
    expect(res).toMatchObject({
      attempted: true,
      page_read: false,
      transient: true,
      environment: true,
      status: 403,
      found: false,
      reason: 'grants_gov_id_lookup_failed:http_403',
    })
  })

  it('a 503 outage is transient but NOT environment (normal retry budget applies)', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 503 }))
    const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
    expect(res).toMatchObject({ transient: true, environment: false, status: 503 })
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

describe('Simpler Grants fallback — the second door around the WAF', () => {
  // Prod 2026-07-21: api.grants.gov 403'd EVERY call from the Railway egress
  // (127 attempts, 0 answers) while the same data sat one GET away on
  // api.simpler.grants.gov (separate HHS infra, SIMPLER_GRANTS_API_KEY set in
  // prod). These tests pin the fallback ladder: primary env-blocked → simpler
  // answers → the row gets its figures instead of parking as blocked forever.

  /** GET/POST-aware fake fetch: routes by URL substring. */
  const routedFetch = (routes) =>
    vi.fn(async (url, init = {}) => {
      for (const [needle, out] of routes) {
        if (String(url).includes(needle)) {
          if (out?.__networkError) throw new Error('socket hang up')
          return {
            ok: out.ok ?? true,
            status: out.status ?? 200,
            json: async () => out.json ?? {},
          }
        }
      }
      throw new Error(`unrouted url in test: ${url}`)
    })

  const row = { source: 'grants.gov', source_url: 'https://www.grants.gov/search-results-detail/112354' }

  it('answers via Simpler when the primary API is WAF-403 environment-blocked', async () => {
    vi.stubEnv('SIMPLER_GRANTS_API_KEY', 'test-key')
    try {
      const f = routedFetch([
        ['api.grants.gov', { ok: false, status: 403 }],
        ['api.simpler.grants.gov/v1/opportunities/112354', {
          json: { data: { summary: { award_floor: 10_000, award_ceiling: 50_000 } } },
        }],
      ])
      const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
      expect(res.found).toBe(true)
      expect(res.page_read).toBe(true)
      expect(res.reason).toBe('simpler_grants_api')
      expect(res.amounts.amount_min).toBe(10_000)
      expect(res.amounts.amount_max).toBe(50_000)
      expect(res.amounts.amount_confidence).toBe(AMOUNT_CONFIDENCE_STRUCTURED)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('stays an ENVIRONMENT failure when both doors are blocked (row must not burn)', async () => {
    vi.stubEnv('SIMPLER_GRANTS_API_KEY', 'test-key')
    try {
      const f = routedFetch([
        ['api.grants.gov', { ok: false, status: 403 }],
        ['api.simpler.grants.gov', { ok: false, status: 401 }],
      ])
      const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
      expect(res.found).toBe(false)
      expect(res.page_read).toBe(false)
      expect(res.environment).toBe(true)
      expect(res.transient).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('without a Simpler key the primary environment failure reports unchanged', async () => {
    vi.stubEnv('SIMPLER_GRANTS_API_KEY', '')
    try {
      const f = routedFetch([['api.grants.gov', { ok: false, status: 403 }]])
      const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
      expect(res.environment).toBe(true)
      expect(res.transient).toBe(true)
      // Simpler must never have been called: the only routed host is grants.gov.
      for (const call of f.mock.calls) expect(String(call[0])).toContain('api.grants.gov')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('Simpler "no figure" is the honest denial, with the program envelope as TEXT only', async () => {
    vi.stubEnv('SIMPLER_GRANTS_API_KEY', 'test-key')
    try {
      const f = routedFetch([
        ['api.grants.gov', { ok: false, status: 403 }],
        ['api.simpler.grants.gov', {
          json: { data: { summary: { award_floor: null, award_ceiling: null, estimated_total_program_funding: 3_270_000, expected_number_of_awards: 20 } } },
        }],
      ])
      const res = await enrichAmountViaGrantsGovApi(row, { fetchImpl: f })
      expect(res.page_read).toBe(true)
      expect(res.found).toBe(false)
      expect(res.reason).toBe('no_award_amount_published')
      // The envelope is preserved as an honest label — never as a number (#958).
      expect(res.amount_text).toContain('$3,270,000')
      expect(res.amount_text).toContain('~20')
      expect(res.amounts).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
