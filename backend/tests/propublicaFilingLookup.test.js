// Live incident 2026-09-11: GET /api/foundations/:ein/filing/:taxPeriod answered
// 500 even for a filing ProPublica itself lists (EIN 620646012, 202306). The
// client requested `/organizations/{ein}/{taxPeriod}.json`, a path the ProPublica
// Nonprofit Explorer API v2 does not serve (404). Filings live on the
// organization record: `filings_with_data` (parsed 990 fields) and
// `filings_without_data` (PDF only).
import { afterEach, describe, expect, it } from 'vitest'
import { __resetAxiosForTests, __setAxiosForTests } from '../src/integrations/httpClient.js'
import { getFiling } from '../src/integrations/propublica990.js'

const orgPayload = {
  organization: { ein: 620646012, name: 'Example Research Hospital' },
  filings_with_data: [
    { tax_prd: 202306, tax_prd_yr: 2023, formtype: 0, pdf_url: 'https://example.org/202306.pdf', totrevenue: 1707244071, totfuncexpns: 1519049173 },
  ],
  filings_without_data: [
    { tax_prd: 202406, tax_prd_yr: 2024, formtype: 0, formtype_str: '990', pdf_url: 'https://example.org/202406.pdf' },
  ],
}

afterEach(() => __resetAxiosForTests())

describe('ProPublica filing lookup', () => {
  it('reads a filing with parsed data from the organization record', async () => {
    const urls = []
    __setAxiosForTests(async (config) => { urls.push(config.url); return { status: 200, headers: {}, data: orgPayload } })
    const filing = await getFiling('62-0646012', '202306')
    expect(urls).toEqual(['https://projects.propublica.org/nonprofits/api/v2/organizations/620646012.json'])
    expect(filing.ein).toBe('620646012')
    expect(filing.tax_period).toBe('202306')
    expect(filing.has_data).toBe(true)
    expect(filing.filing.totrevenue).toBe(1707244071)
    expect(filing.pdf_url).toBe('https://example.org/202306.pdf')
  })

  it('reads a PDF-only filing', async () => {
    __setAxiosForTests(async () => ({ status: 200, headers: {}, data: orgPayload }))
    const filing = await getFiling('620646012', '202406')
    expect(filing.has_data).toBe(false)
    expect(filing.pdf_url).toBe('https://example.org/202406.pdf')
  })

  it('reports an unknown tax period as a 404, not a server error', async () => {
    __setAxiosForTests(async () => ({ status: 200, headers: {}, data: orgPayload }))
    const error = await getFiling('620646012', '199912').catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.response?.status).toBe(404)
  })
})
