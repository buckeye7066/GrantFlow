import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeMemoryDb } from './robert-test-helpers.mjs'
import { analyzeProfileCoverage } from '../../backend/services/robert/robertCoverageAnalyzer.js'
import { getCoverage } from '../../backend/services/robert/robertRunStore.js'

let db
beforeEach(() => { db = makeMemoryDb() })

const STUB_CTX = {
  profile: { id: 'p1', display_name: 'Cleveland VFD', primary_type: 'volunteer_fire_department', state: 'TN', county: 'Bradley', city: 'Cleveland', tags: ['equipment', 'capital_improvement'] },
  sections: { location_focus: { state: 'TN', county: 'Bradley', city: 'Cleveland', is_rural: true } },
  signals: { entityType: 'volunteer_fire_department', state: 'TN' },
}

describe('robertCoverageAnalyzer — flags zero-result risk + recommends searches', () => {
  it('marks a zero-result profile as high risk and persists coverage', async () => {
    const result = await analyzeProfileCoverage({
      db,
      profileId: 'p1',
      loadProfileContext: async () => STUB_CTX,
      queryGrantsCounts: async () => ({ total: 0, accepted: 0, review: 0 }),
      queryProfileMatchableCount: async () => 0,
    })
    assert.ok(result?.coverage)
    assert.ok(result.coverage.zero_result_risk >= 80, `risk should be high, got ${result.coverage.zero_result_risk}`)
    assert.ok(result.coverage.recommended_search_queries.length > 0)
    const persisted = await getCoverage(db, 'p1')
    assert.ok(persisted)
    assert.equal(persisted.profile_id, 'p1')
  })

  it('lowers risk when the profile has accepted matches', async () => {
    const result = await analyzeProfileCoverage({
      db,
      profileId: 'p1',
      loadProfileContext: async () => STUB_CTX,
      queryGrantsCounts: async () => ({ total: 5, accepted: 5, review: 0 }),
      queryProfileMatchableCount: async () => 100,
    })
    assert.ok(result.coverage.zero_result_risk <= 35, `risk should be low, got ${result.coverage.zero_result_risk}`)
  })

  it('returns null for a profile that cannot be loaded', async () => {
    const r = await analyzeProfileCoverage({
      db,
      profileId: 'missing',
      loadProfileContext: async () => null,
    })
    assert.equal(r, null)
  })

  it('recommends broader geography when zero results', async () => {
    const r = await analyzeProfileCoverage({
      db,
      profileId: 'p1',
      loadProfileContext: async () => STUB_CTX,
      queryGrantsCounts: async () => ({ total: 0, accepted: 0, review: 0 }),
      queryProfileMatchableCount: async () => 5,
    })
    const scopes = (r.coverage.missing_geographies || []).map((g) => g.scope)
    assert.ok(scopes.includes('national'))
    assert.ok(scopes.includes('state') || scopes.includes('county'))
  })
})
