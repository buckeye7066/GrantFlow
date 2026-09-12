// Live incident 2026-09-11/12: GET /api/foundations/federal/search never returned
// a program. The api.sam.gov Assistance Listings data API rejected pageSize 1000
// with HTTP 400, has no keyword search, and allows 10 requests a day, while the
// active catalog is 2,872 listings. Federal search now reads SAM.gov's keyless
// site search (index=cfda). These fixtures use the result shape measured live.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetAxiosForTests, __setAxiosForTests } from '../src/integrations/httpClient.js'
import { fetchAssistanceListings, getAssistanceListing } from '../src/integrations/samAssistanceListings.js'

const result = (programNumber, title, {
  objective = '',
  type = ['F001', 'Grant'],
  applicant = ['Individual/Family'],
  beneficiary = [],
  org = [['HOUSING AND URBAN DEVELOPMENT, DEPARTMENT OF', 1], ['OFFICE OF PUBLIC AND INDIAN HOUSING', 2]],
  isActive = true,
} = {}) => ({
  _id: `fal${programNumber.replace('.', '')}`,
  programNumber,
  title,
  isActive,
  objective,
  website: `https://example.gov/programs/${programNumber}`,
  organizationHierarchy: org.map(([name, level]) => ({ name, level })),
  assistanceTypes: [{ hierarchy: [{ code: 'FF', level: 1, value: 'Financial' }, { code: type[0], level: 2, value: type[1] }] }],
  eligibility: {
    applicant: { types: applicant.map((value, i) => ({ code: `ET${i}`, value })), additionalInfo: 'Low-income families.' },
    beneficiary: { types: beneficiary.map((value, i) => ({ code: `EB${i}`, value })) },
  },
  financial: { additionalInfo: 'FY 2025 average award is $8,029.', obligations: [{ assistanceType: { code: type[0], value: type[1] }, values: [{ year: 2026, estimate: 1000 }] }] },
  contacts: [{ name: 'Program Office', title: 'Program Analyst', phone: '555-0100', address: { city: 'Washington', state: 'DC' } }],
})

let calls
let respond
beforeEach(() => {
  delete process.env.SAM_GOV_PUBLIC_API_KEY
  calls = []
  respond = (results, totalElements = results.length) => ({
    status: 200,
    headers: {},
    data: { _embedded: { results }, page: { size: results.length, totalElements, totalPages: 1, number: 0 } },
  })
  __setAxiosForTests(async (config) => {
    calls.push(config)
    return respond([
      result('14.871', 'Section 8 Housing Choice Vouchers', { objective: 'Rental assistance for very low-income families.' }),
    ], 242)
  })
})
afterEach(() => { __resetAxiosForTests() })

describe('SAM.gov assistance listings search contract', () => {
  it('asks the keyless SAM.gov search service with the live request contract', async () => {
    await fetchAssistanceListings({ keyword: 'housing' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://sam.gov/api/prod/sgs/v1/search')
    expect(calls[0].headers.Accept).toBe('application/hal+json')
    expect(calls[0].params).toEqual({ index: 'cfda', q: 'housing', page: 0, size: 25, is_active: 'true' })
    expect(calls[0].params.api_key).toBeUndefined()
  })

  it('maps the search result fields callers read', async () => {
    const { total, opportunities } = await fetchAssistanceListings({ keyword: 'housing' })
    expect(total).toBe(242)
    const [voucher] = opportunities
    expect(voucher.title).toBe('14.871 — Section 8 Housing Choice Vouchers')
    expect(voucher.source).toBe('sam.assistance')
    expect(voucher.source_id).toBe('14.871')
    expect(voucher.sponsor).toBe('OFFICE OF PUBLIC AND INDIAN HOUSING')
    expect(voucher.description).toContain('Rental assistance')
    expect(voucher.source_url).toBe('https://sam.gov/fal/fal14871/view')
    expect(voucher.application_url).toBe('https://example.gov/programs/14.871')
    expect(voucher.eligibility_bullets.join(' ')).toContain('Individual/Family')
    expect(voucher.categories).toContain('grant')
    expect(voucher.opportunity_type).toBe('grant')
    expect(voucher.contact_info).toEqual({ name: 'Program Office', email: null, phone: '555-0100' })
    // The search index states no per-award range; its financial note is text, never a number.
    expect(voucher.amount_min).toBeNull()
    expect(voucher.amount_max).toBeNull()
    expect(voucher.amount_description).toBe('FY 2025 average award is $8,029.')
  })

  it('sends a 0-based page upstream and caps the page size at 100', async () => {
    await fetchAssistanceListings({ keyword: 'veterans', page: 3, limit: 500 })
    expect(calls[0].params.page).toBe(2)
    expect(calls[0].params.size).toBe(100)
  })

  it('drops inactive listings', async () => {
    __setAxiosForTests(async (config) => {
      calls.push(config)
      return respond([
        result('10.411', 'Rural Housing Site Loans', { type: ['F003', 'Direct Loan'] }),
        result('10.999', 'Retired Program', { isActive: false }),
      ])
    })
    const { opportunities } = await fetchAssistanceListings({ keyword: 'housing' })
    expect(opportunities.map((o) => o.source_id)).toEqual(['10.411'])
    expect(opportunities[0].opportunity_type).toBe('loan')
  })

  it('assistanceType words filter by the coded type and report the rows kept', async () => {
    __setAxiosForTests(async (config) => {
      calls.push(config)
      return respond([
        result('14.871', 'Section 8 Housing Choice Vouchers'),
        result('59.012', 'Small Business Loans', { type: ['F004', 'Guaranteed/Insured Loans'] }),
      ], 571)
    })
    const grants = await fetchAssistanceListings({ keyword: 'housing', assistanceType: 'grant' })
    expect(grants.opportunities.map((o) => o.source_id)).toEqual(['14.871'])
    expect(grants.total).toBe(1)
  })

  it('looks a single program up by its number, including inactive listings', async () => {
    __setAxiosForTests(async (config) => {
      calls.push(config)
      return respond([result('10.400', 'Similar Program'), result('10.410', 'Very Low to Moderate Income Housing Loans')])
    })
    const listing = await getAssistanceListing('10.410')
    expect(calls[0].params).toEqual({ index: 'cfda', q: '10.410', page: 0, size: 25 })
    expect(listing.source_id).toBe('10.410')
  })
})
