// Live incident 2026-09-11: GET /api/foundations/federal/search answered 500 for
// EVERY query. SAM.gov's Assistance Listings API rejects `Accept: application/json`
// with 406 ("Acceptable representations: [application/hal+json]"), answers with
// `assistanceListingsData`/`totalRecords` (not the `_embedded`/`page` shape the
// parser read), and has NO free-text search parameter (`keyword` is ignored —
// 2,872 records with or without it). The public key is also capped per day, so
// keyword search runs over one cached catalog instead of a request per search.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetAxiosForTests, __setAxiosForTests } from '../src/integrations/httpClient.js'
import {
  __resetAssistanceCatalogCacheForTests,
  fetchAssistanceListings,
} from '../src/integrations/samAssistanceListings.js'

const listing = (id, title, { objective = '', typeCode = 'F001', typeName = 'Grant', max = null, applicants = ['Individual/Family'], department = 'HOUSING AND URBAN DEVELOPMENT, DEPARTMENT OF', agency = 'OFFICE OF PUBLIC AND INDIAN HOUSING' } = {}) => ({
  version: '2.0',
  status: 'Active',
  assistanceListingId: id,
  title,
  federalOrganization: { department, agency },
  programWebPage: `https://example.gov/programs/${id}`,
  overview: { objective },
  financialInformation: {
    obligations: [{ assistanceType: { code: typeCode, name: typeName }, values: [{ year: 2026, actual: null, estimate: 1000 }] }],
    rangeAndAverageAssistance: max === null ? [] : [{ fiscalYear: 2026, minimumAwardAmount: 100, maximumAwardAmount: max, averageAwardAmount: 500 }],
  },
  criteriaForApplying: { applicant: { types: applicants.map((name, i) => ({ code: `ET${i}`, name })), description: 'Low-income families.' } },
})

const catalog = [
  listing('14.871', 'Section 8 Housing Choice Vouchers', { objective: 'Rental assistance for very low-income families.', max: 12000 }),
  listing('10.500', 'Cooperative Extension Service', { objective: 'Agricultural education.', department: 'AGRICULTURE, DEPARTMENT OF', agency: 'NATIONAL INSTITUTE OF FOOD AND AGRICULTURE' }),
  listing('59.012', 'Small Business Loans', { objective: 'Loans for housing contractors.', typeCode: 'F004', typeName: 'Loan Guarantee', department: 'SMALL BUSINESS ADMINISTRATION', agency: 'SMALL BUSINESS ADMINISTRATION' }),
]

let calls
beforeEach(() => {
  process.env.SAM_GOV_PUBLIC_API_KEY = 'test-key'
  __resetAssistanceCatalogCacheForTests()
  calls = []
  __setAxiosForTests(async (config) => {
    calls.push(config)
    return { status: 200, headers: {}, data: { totalRecords: catalog.length, pageSize: 1000, pageNumber: 0, totalPages: 1, assistanceListingsData: catalog } }
  })
})
afterEach(() => { __resetAxiosForTests(); __resetAssistanceCatalogCacheForTests() })

describe('SAM.gov Assistance Listings contract', () => {
  it('asks for application/hal+json and never sends an ignored keyword upstream', async () => {
    await fetchAssistanceListings({ keyword: 'housing' })
    expect(calls.length).toBe(1)
    expect(calls[0].headers.Accept).toBe('application/hal+json')
    expect(calls[0].params.keyword).toBeUndefined()
    expect(calls[0].params.pageSize).toBe(1000)
  })

  it('keyword search filters the real assistanceListingsData records', async () => {
    const result = await fetchAssistanceListings({ keyword: 'housing' })
    expect(result.opportunities.map((o) => o.source_id)).toEqual(['14.871', '59.012'])
    expect(result.total).toBe(2)
    const [voucher] = result.opportunities
    expect(voucher.title).toBe('14.871 — Section 8 Housing Choice Vouchers')
    expect(voucher.sponsor).toBe('OFFICE OF PUBLIC AND INDIAN HOUSING')
    expect(voucher.description).toContain('Rental assistance')
    expect(voucher.application_url).toBe('https://example.gov/programs/14.871')
    expect(voucher.amount_max).toBe(12000)
    expect(voucher.eligibility_bullets.join(' ')).toContain('Individual/Family')
  })

  it('assistanceType words filter by the coded obligation type', async () => {
    const grants = await fetchAssistanceListings({ keyword: 'housing', assistanceType: 'grant' })
    expect(grants.opportunities.map((o) => o.source_id)).toEqual(['14.871'])
  })

  it('serves later searches from the cached catalog (daily-capped public key)', async () => {
    await fetchAssistanceListings({ keyword: 'housing' })
    const second = await fetchAssistanceListings({ keyword: 'extension' })
    expect(second.opportunities.map((o) => o.source_id)).toEqual(['10.500'])
    expect(calls.length).toBe(1)
  })
})
