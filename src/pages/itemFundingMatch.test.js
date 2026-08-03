import { describe, expect, it } from 'vitest'

import {
  itemFundingResultPassesLocation,
  mapBackendItemFundingResult,
} from './itemFundingMatch.js'

describe('Item Funding backend score mapping', () => {
  it('uses the backend item-fit score without manufacturing a 50 or 75', () => {
    const mapped = mapBackendItemFundingResult({
      id: 'ramp-1',
      title: 'Wheelchair Ramp Assistance',
      combined_score: 63,
      match_score: 11,
      need_match: { score: 84, matchedTerms: ['wheelchair ramp'] },
      result_source: 'item_catalog',
    })

    expect(mapped.match.score).toBe(63)
    expect(mapped.match.raw_score).toBe(11)
    expect(mapped.match.item_score).toBe(84)
    expect(mapped.match.reasons).toContain('wheelchair ramp')
  })

  it('preserves a measured zero and defaults missing measurement to zero', () => {
    expect(mapBackendItemFundingResult({ combined_score: 0, match_score: 91 }).match.score).toBe(0)
    expect(mapBackendItemFundingResult({ title: 'Unscored lead' }).match.score).toBe(0)
  })

  it('does not allow later fallback fields to override the first measured score', () => {
    expect(mapBackendItemFundingResult({
      combined_score: null,
      item_fit_score: 72,
      need_score: 88,
      match_score: 12,
    }).match.score).toBe(72)
  })

  it('flags rejection, loans, cost share, and unconfirmed eligibility honestly', () => {
    const mapped = mapBackendItemFundingResult({
      title: 'Equipment Loan Program',
      match_score: 75,
      match_decision: 'reject',
      requires_match: true,
      eligibility_confirmed: false,
      funding_type: 'loan',
    })

    expect(mapped.match.disqualified).toBe(true)
    expect(mapped.match.eligibility_unconfirmed).toBe(true)
    expect(mapped.opportunity.eligibility_confirmed).toBe(false)
    expect(mapped.match.reasons).toContain('Eligibility is not yet confirmed')
    expect(mapped.match.reasons).toContain('Requires matching funds, cost share, or repayment')
  })

  it('deduplicates explanation text and labels web provenance', () => {
    const mapped = mapBackendItemFundingResult({
      title: 'Free Computer Program',
      need_match: { matchedTerms: ['computer', 'computer'] },
      match_reasons: ['computer'],
      result_source: 'web_search',
      url: 'https://example.org/computers',
    })

    expect(mapped.match.reasons.filter((reason) => reason === 'computer')).toHaveLength(1)
    expect(mapped.match.reasons).toContain('Found via live web search')
    expect(mapped.opportunity.source).toBe('Live web search')
    expect(mapped.opportunity.application_url).toBe('https://example.org/computers')
  })
})

describe('Item Funding location controls', () => {
  it('honors the national toggle', () => {
    const national = { is_national: true }
    expect(itemFundingResultPassesLocation(national, { includeNational: true })).toBe(true)
    expect(itemFundingResultPassesLocation(national, { includeNational: false })).toBe(false)
  })

  it('uses an exact normalized state match for non-national results', () => {
    const tennessee = { is_national: false, state: 'TN' }
    expect(itemFundingResultPassesLocation(tennessee, { state: 'tn' })).toBe(true)
    expect(itemFundingResultPassesLocation(tennessee, { state: 'OH' })).toBe(false)
    expect(itemFundingResultPassesLocation(tennessee, { state: 'all' })).toBe(true)
  })
})
