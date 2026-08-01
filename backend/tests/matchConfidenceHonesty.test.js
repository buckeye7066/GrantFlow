/**
 * "0% conf" on every card was not a measurement — it was `Number(null)`.
 *
 * Prod 2026-08-01: `profile_opportunity_matches.match_confidence` is NULL on
 * 4,397 of 4,397 rows across all 39 profiles (the crawler-os persist path never
 * writes the column). resultEnricher then published that unknown as a hard 0,
 * because `Number(null)` is 0 and `Number.isFinite(0)` is true — so
 * FundingResultCard rendered "· 0% conf" on 100% of cards. A null renders NO
 * confidence chip at all, which is the honest presentation of "not measured".
 *
 * Both assertions FAIL on the pre-fix guard.
 */

import { describe, it, expect } from 'vitest'
import { isFiniteNumberLike, canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'

describe('isFiniteNumberLike — absent is not zero', () => {
  it('rejects every value that Number() silently coerces to 0', () => {
    for (const v of [null, undefined, '', '   ', [], false, true, {}, 'abc', NaN]) {
      expect(isFiniteNumberLike(v), JSON.stringify(v)).toBe(false)
    }
  })

  it('accepts real numbers, including a genuine zero', () => {
    for (const v of [0, '0', 55, '55', 100, -3, 12.5]) {
      expect(isFiniteNumberLike(v), String(v)).toBe(true)
    }
  })
})

describe('canonicalizeOpportunityList — an unmeasured confidence stays null', () => {
  const profileContext = {
    profile: { id: 'p1', primary_type: 'senior', state: 'IN', needs: ['housing'] },
    sections: {},
    signals: null,
  }
  const baseRow = {
    id: 'o1',
    title: '211 - Local help with rent, utilities, food & emergencies',
    sponsor: 'United Way / 211',
    description: 'Local help with rent, utilities and food.',
    source_url: 'https://www.211.org',
    application_url: 'https://www.211.org',
    opportunity_kind: 'DIRECTORY',
    is_national: 1,
    match_score: 13,
    match_decision: 'review',
    match_reasons: ['housing', 'health_medical'],
  }

  it('publishes NULL — not 0 — when the stored row has no confidence (the live prod shape)', () => {
    const out = canonicalizeOpportunityList(profileContext, [{ ...baseRow, match_confidence: null }], {
      preserveDirectories: true,
      rejectHardIneligible: true,
      useStoredDecision: true,
    })
    expect(out.kept).toHaveLength(1)
    expect(out.kept[0].match_confidence).toBeNull()
  })

  it('an ABSENT column (the /api/matching projection never selects it) is also NULL', () => {
    const { match_confidence: _omitted, ...noColumn } = { ...baseRow, match_confidence: null }
    const out = canonicalizeOpportunityList(profileContext, [noColumn], {
      preserveDirectories: true,
      rejectHardIneligible: true,
      useStoredDecision: true,
    })
    expect(out.kept[0].match_confidence).toBeNull()
  })

  it('a REAL stored confidence still round-trips, including a real 0', () => {
    for (const stored of [0, 55, 95]) {
      const out = canonicalizeOpportunityList(profileContext, [{ ...baseRow, match_confidence: stored }], {
        preserveDirectories: true,
        rejectHardIneligible: true,
        useStoredDecision: true,
      })
      expect(out.kept[0].match_confidence, String(stored)).toBe(stored)
    }
  })
})
