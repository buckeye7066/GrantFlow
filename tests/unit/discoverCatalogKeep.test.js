import { describe, it, expect } from 'vitest'
import {
  keepDiscoverCatalogRow,
  normalizeDiscoverResultPayload,
} from '../../src/lib/discoverCatalogKeep.js'

describe('normalizeDiscoverResultPayload', () => {
  it('returns direct response metadata and opportunities unchanged', () => {
    const payload = {
      opportunities: [{ id: 'direct' }],
      relaxation: { applied: true },
      score_hint: { floor: 7 },
    }
    expect(normalizeDiscoverResultPayload(payload)).toBe(payload)
  })

  it('unwraps the supported data envelope including recovery metadata', () => {
    const inner = {
      opportunities: [{ id: 'wrapped', threshold_relaxed: true }],
      relaxation: { applied: true },
      score_hint: { floor: 4 },
    }
    expect(normalizeDiscoverResultPayload({ data: inner })).toBe(inner)
  })
})

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
