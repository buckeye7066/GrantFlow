/**
 * "0% conf" on every card was not a measurement — it was `Number(null)`.
 *
 * The 2026-08-01 production audit found `match_confidence` NULL on every stored
 * row because the crawler-os persist path did not write the column. Historical
 * rows and non-canonical producers can still be NULL, so resultEnricher must
 * never publish unknown as a hard 0,
 * because `Number(null)` is 0 and `Number.isFinite(0)` is true — so
 * FundingResultCard rendered "· 0% conf" on 100% of cards. A null renders NO
 * confidence chip at all, which is the honest presentation of "not measured".
 *
 * Both assertions FAIL on the pre-fix guard.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isFiniteNumberLike, canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'
import { restorePersistedMatchTruth } from '../services/matching/persistedMatchTruth.js'
import { stampMatchConfidenceProvenance } from '../services/matching/matchConfidenceProvenance.js'

describe('route projections — confidence always travels with provenance', () => {
  it.each([
    ['discovery', new URL('../routes/discovery.js', import.meta.url), 2],
    ['matching', new URL('../routes/matching.js', import.meta.url), 1],
  ])('%s projects provenance for every stored-confidence query', (_name, sourceUrl, expected) => {
    const source = readFileSync(sourceUrl, 'utf8')
    expect(source.match(/m\.match_explain_json AS os_match_explain_json/g) || []).toHaveLength(expected)
    expect(source.match(/match_explain_json: o\.os_match_explain_json/g) || []).toHaveLength(expected)
  })
})

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

  function measuredRow(confidence, overrides = {}) {
    const row = { ...baseRow, match_confidence: confidence, ...overrides }
    const explain = stampMatchConfidenceProvenance(
      { scoring_policy_version: 'need_first_v2' },
      row,
    )
    return { ...row, match_explain_json: JSON.stringify(explain) }
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

  it('does not publish a numeric confidence without persistence provenance', () => {
    const out = canonicalizeOpportunityList(profileContext, [{ ...baseRow, match_confidence: 55 }], {
      preserveDirectories: true,
      rejectHardIneligible: true,
      useStoredDecision: true,
    })
    expect(out.kept[0].match_confidence).toBeNull()
  })

  it('an exactly bound confidence round-trips, including a genuine 0', () => {
    for (const stored of [0, 55, 95]) {
      const out = canonicalizeOpportunityList(profileContext, [measuredRow(stored)], {
        preserveDirectories: true,
        rejectHardIneligible: true,
        useStoredDecision: true,
      })
      expect(out.kept[0].match_confidence, String(stored)).toBe(stored)
    }
  })

  it('suppresses confidence after score, decision, or policy provenance drifts', () => {
    const measured = measuredRow(55)
    const explain = JSON.parse(measured.match_explain_json)
    const cases = [
      { ...measured, match_score: 14 },
      { ...measured, match_decision: 'accept' },
      { ...measured, match_explain_json: JSON.stringify({ ...explain, scoring_policy_version: 'need_first_v3' }) },
    ]
    for (const row of cases) {
      const out = canonicalizeOpportunityList(profileContext, [row], {
        preserveDirectories: true,
        rejectHardIneligible: true,
        useStoredDecision: true,
      })
      expect(out.kept[0].match_confidence).toBeNull()
    }
  })

  it('revalidates provenance after persisted-truth read-time adjustments', () => {
    const measured = measuredRow(55)
    const valid = restorePersistedMatchTruth([measured], [measured])
    expect(valid[0].match_confidence).toBe(55)

    const mutated = { ...measured, match_score: 14 }
    const invalid = restorePersistedMatchTruth([mutated], [mutated])
    expect(invalid[0].match_confidence).toBeNull()
  })
})
