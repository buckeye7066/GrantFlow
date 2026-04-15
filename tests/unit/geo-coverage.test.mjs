import test from 'node:test'
import assert from 'node:assert/strict'

import {
  findNearbyZips,
  resolveGeoCoverage,
  buildGeoCoverageClause,
} from '../../backend/services/geo/geoCoverageService.js'

// ── findNearbyZips ──────────────────────────────────────────────────────────

test('findNearbyZips: returns nearby ZIPs within 25mi of Columbus OH (43215)', () => {
  const nearby = findNearbyZips('43215', 25)
  assert.ok(nearby.length > 0, 'Should find at least some nearby ZIPs')
  assert.ok(nearby.length < 500, `Should not return entire state (got ${nearby.length})`)

  for (const entry of nearby) {
    assert.ok(entry.distance <= 25, `Distance ${entry.distance} exceeds 25mi for ${entry.zip}`)
    assert.ok(/^\d{5}$/.test(entry.zip), `Invalid ZIP format: ${entry.zip}`)
    assert.ok(entry.state, `Missing state for ${entry.zip}`)
  }

  // Columbus OH ZIP should have mostly OH entries
  const ohCount = nearby.filter((z) => z.state === 'OH').length
  assert.ok(ohCount > nearby.length * 0.5, `Expected majority OH but got ${ohCount}/${nearby.length}`)
})

test('findNearbyZips: 50mi radius returns more ZIPs than 25mi', () => {
  const nearby25 = findNearbyZips('43215', 25)
  const nearby50 = findNearbyZips('43215', 50)
  assert.ok(nearby50.length > nearby25.length, `50mi (${nearby50.length}) should exceed 25mi (${nearby25.length})`)
})

test('findNearbyZips: border ZIP finds multiple states', () => {
  // 45202 = Cincinnati OH, right on the KY border
  const nearby = findNearbyZips('45202', 30)
  const states = new Set(nearby.map((z) => z.state))
  assert.ok(states.has('OH'), 'Should include OH')
  assert.ok(states.has('KY'), 'Should include KY (across the river)')
})

test('findNearbyZips: invalid ZIP returns empty array', () => {
  const result = findNearbyZips('00000', 25)
  assert.deepStrictEqual(result, [])
})

test('findNearbyZips: rural ZIP still returns results', () => {
  // 82930 = Kemmerer, WY (very rural)
  const nearby = findNearbyZips('82930', 50)
  assert.ok(nearby.length > 0, `Rural ZIP 82930 should find at least some neighbors within 50mi`)
})

test('findNearbyZips: results are sorted by distance', () => {
  const nearby = findNearbyZips('10001', 25)
  for (let i = 1; i < nearby.length; i++) {
    assert.ok(nearby[i].distance >= nearby[i - 1].distance, 'Results should be sorted ascending by distance')
  }
})

test('findNearbyZips: caches results (second call is instant)', () => {
  const t0 = Date.now()
  findNearbyZips('90210', 25) // first call
  const t1 = Date.now()
  findNearbyZips('90210', 25) // cached
  const t2 = Date.now()
  assert.ok(t2 - t1 <= t1 - t0 + 5, 'Cached call should be at least as fast')
})

// ── resolveGeoCoverage ──────────────────────────────────────────────────────

test('resolveGeoCoverage: no ZIP falls back to state/national', async () => {
  const mockDb = mockDatabase([])
  const result = await resolveGeoCoverage(mockDb, { state: 'OH' })
  assert.ok(result.tier === 'state' || result.tier === 'national', `Expected state or national, got ${result.tier}`)
  assert.ok(result.nearbyStates.has('OH'))
  assert.deepStrictEqual(result.localZips, [])
})

test('resolveGeoCoverage: with ZIP populates localZips', async () => {
  const mockDb = mockDatabase([], 0)
  const result = await resolveGeoCoverage(mockDb, { zip: '43215', state: 'OH' })
  assert.ok(result.localZips.length > 0, 'Should have local ZIPs')
  assert.ok(result.localZips.includes('43215'), 'Should include the center ZIP')
  assert.ok(result.nearbyStates.has('OH'))
})

test('resolveGeoCoverage: tier escalates when results are low', async () => {
  const mockDb = mockDatabase([], 0)
  const result = await resolveGeoCoverage(mockDb, { zip: '43215', state: 'OH' })
  // With mock returning 0 hits everywhere, should escalate to national
  assert.equal(result.tier, 'national')
  assert.ok(result.expandedZips.length > result.localZips.length || result.expandedZips.length > 0)
})

test('resolveGeoCoverage: tier=local when enough local results', async () => {
  const mockDb = mockDatabase([], 10)
  const result = await resolveGeoCoverage(mockDb, { zip: '43215', state: 'OH' })
  assert.equal(result.tier, 'local')
  assert.ok(result.stats.local >= 5)
})

test('resolveGeoCoverage: no data at all still returns valid result', async () => {
  const mockDb = mockDatabase([], 0)
  const result = await resolveGeoCoverage(mockDb, {})
  assert.equal(result.tier, 'national')
  assert.ok(result.nearbyStates instanceof Set)
})

// ── buildGeoCoverageClause ──────────────────────────────────────────────────

test('buildGeoCoverageClause: local tier includes ZIP conditions', () => {
  const geoCoverage = {
    tier: 'local',
    localZips: ['43215', '43201', '43202'],
    expandedZips: [],
    nearbyStates: new Set(['OH']),
  }
  const { clause, params } = buildGeoCoverageClause({ dialect: 'sqlite' }, geoCoverage)
  assert.ok(clause.includes('geo_zip IN'), 'Should have ZIP filter')
  assert.ok(clause.includes("state IN"), 'Should have state filter')
  assert.ok(clause.includes('is_national'), 'Should always include national fallback')
  assert.ok(params.length > 0, 'Should have params')
})

test('buildGeoCoverageClause: national tier has no ZIP conditions', () => {
  const geoCoverage = {
    tier: 'national',
    localZips: [],
    expandedZips: [],
    nearbyStates: new Set(['OH']),
  }
  const { clause, params } = buildGeoCoverageClause({ dialect: 'sqlite' }, geoCoverage)
  assert.ok(!clause.includes('geo_zip IN'), 'National tier should not have ZIP filter')
  assert.ok(clause.includes("state IN"), 'Should still include state')
})

test('buildGeoCoverageClause: postgres syntax', () => {
  const geoCoverage = {
    tier: 'local',
    localZips: ['10001'],
    expandedZips: [],
    nearbyStates: new Set(['NY']),
  }
  const { clause } = buildGeoCoverageClause({ dialect: 'postgres' }, geoCoverage)
  assert.ok(clause.includes('is_national = TRUE'), 'Should use Postgres TRUE')
})

// ── Distance-aware scoring (matchEngine integration) ────────────────────────

test('scoreGeoComponent: nearby ZIP within 25mi scores higher than state match', async () => {
  const { scoreOpportunity } = await import('../../backend/services/matchEngine.js')

  const profile = { postal_code: '45202', state: 'OH', needs: ['housing'] }
  // Exact same state
  const oppSameState = { state: 'OH', title: 'Ohio Housing Help', description: 'Housing assistance in Ohio' }
  // Nearby ZIP (Cincinnati area, ~5mi away)
  const oppNearbyZip = { geo_zip: '45219', state: 'OH', title: 'Local Housing Help', description: 'Housing assistance near you' }

  const scoreSameState = scoreOpportunity(profile, oppSameState)
  const scoreNearbyZip = scoreOpportunity(profile, oppNearbyZip)

  assert.ok(
    scoreNearbyZip.score >= scoreSameState.score,
    `Nearby ZIP (${scoreNearbyZip.score}) should score >= same state (${scoreSameState.score})`,
  )
})

test('scoreGeoComponent: 50mi proximity scores higher than national', async () => {
  const { scoreOpportunity } = await import('../../backend/services/matchEngine.js')

  const profile = { postal_code: '43215', state: 'OH', needs: ['education'] }
  const oppNational = { is_national: true, title: 'National Education Grant', description: 'Education funding' }
  const opp40mi = { geo_zip: '43050', state: 'OH', title: 'Local Education Grant', description: 'Education funding' }

  const scoreNat = scoreOpportunity(profile, oppNational)
  const score40mi = scoreOpportunity(profile, opp40mi)

  assert.ok(
    score40mi.score >= scoreNat.score,
    `40mi proximity (${score40mi.score}) should score >= national (${scoreNat.score})`,
  )
})

test('scoreGeoComponent: exact ZIP match still scores highest', async () => {
  const { scoreOpportunity } = await import('../../backend/services/matchEngine.js')

  const profile = { postal_code: '43215', state: 'OH', needs: ['housing'] }
  const oppExact = { geo_zip: '43215', state: 'OH', title: 'Housing Help', description: 'Housing assistance' }
  const oppNearby = { geo_zip: '43201', state: 'OH', title: 'Housing Help', description: 'Housing assistance' }

  const scoreExact = scoreOpportunity(profile, oppExact)
  const scoreNearby = scoreOpportunity(profile, oppNearby)

  assert.ok(
    scoreExact.score >= scoreNearby.score,
    `Exact ZIP (${scoreExact.score}) should score >= nearby ZIP (${scoreNearby.score})`,
  )
})

test('rural ZIP does not return zero score', async () => {
  const { scoreOpportunity } = await import('../../backend/services/matchEngine.js')

  // Very rural WY ZIP with a national opportunity
  const profile = { postal_code: '82930', state: 'WY', needs: ['utilities'] }
  const opp = { is_national: true, title: 'LIHEAP Energy Assistance', description: 'Help with utility bills' }

  const result = scoreOpportunity(profile, opp)
  assert.ok(result.score > 0, `Rural profile should not get zero score (got ${result.score})`)
  assert.ok(result.score >= 5, `Score should be at least the floor of 5 (got ${result.score})`)
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockDatabase(rows = [], countValue = 0) {
  return {
    dialect: 'sqlite',
    prepare: () => ({
      get: async (..._args) => ({ cnt: countValue }),
      all: async (..._args) => rows,
      run: async (..._args) => ({ changes: 0 }),
    }),
  }
}
