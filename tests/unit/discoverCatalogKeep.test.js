import { describe, it, expect } from 'vitest'
import { keepDiscoverCatalogRow } from '../../src/lib/discoverCatalogKeep.js'

describe('keepDiscoverCatalogRow', () => {
  it('keeps ACCEPT rows below the slider floor', () => {
    expect(
      keepDiscoverCatalogRow(
        { match_decision: 'ACCEPT', match_score: 3 },
        11,
        false,
      ),
    ).toBe(true)
  })

  it('keeps directory rows below the slider floor without recovery', () => {
    expect(
      keepDiscoverCatalogRow(
        { opportunity_kind: 'DIRECTORY', match_score: 1, match_decision: 'REVIEW' },
        11,
        false,
      ),
    ).toBe(true)
  })

  it('drops low-score REVIEW rows when recovery did not apply', () => {
    expect(
      keepDiscoverCatalogRow(
        { match_decision: 'REVIEW', match_score: 2 },
        11,
        false,
      ),
    ).toBe(false)
  })

  it('keeps recovered below-floor rows when backend flagged relaxation', () => {
    expect(
      keepDiscoverCatalogRow(
        { match_decision: 'REVIEW', match_score: 2, threshold_relaxed: true },
        11,
        true,
      ),
    ).toBe(true)
  })
})
