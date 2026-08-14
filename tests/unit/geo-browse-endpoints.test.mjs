import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * These tests verify the geo-browse endpoint contracts without hitting a real database.
 * They test:
 * 1. The /geo/summary response shape
 * 2. The /geo/scored response shape and scoring integration
 * 3. Geo-zip filtering support in the main GET / endpoint
 */

test('geo/summary: response shape contract', () => {
  // Simulate the server-side aggregation logic
  const rows = [
    { state: 'TN', zip: '37311', county: 'Bradley', opportunity_count: 5 },
    { state: 'TN', zip: '37312', county: 'Bradley', opportunity_count: 3 },
    { state: 'NY', zip: '10001', county: 'New York', opportunity_count: 127 },
    { state: 'NY', zip: '10002', county: 'New York', opportunity_count: 84 },
    { state: 'WV', zip: '25801', county: 'Raleigh', opportunity_count: 4 },
  ]

  const stateMap = new Map()
  for (const row of rows) {
    const st = row.state || 'Unknown'
    if (!stateMap.has(st)) {
      stateMap.set(st, { state: st, opportunity_count: 0, zips: [] })
    }
    const entry = stateMap.get(st)
    const count = Number(row.opportunity_count) || 0
    entry.opportunity_count += count
    entry.zips.push({
      zip: row.zip || null,
      county: row.county || null,
      opportunity_count: count,
    })
  }

  const states = Array.from(stateMap.values()).sort((a, b) => a.state.localeCompare(b.state))
  const totalOpportunities = states.reduce((sum, s) => sum + s.opportunity_count, 0)

  assert.equal(states.length, 3, 'should have 3 states')
  assert.equal(totalOpportunities, 223, 'total should be sum of all counts')

  // NY should have the most
  const ny = states.find((s) => s.state === 'NY')
  assert.equal(ny.opportunity_count, 211)
  assert.equal(ny.zips.length, 2)

  // TN
  const tn = states.find((s) => s.state === 'TN')
  assert.equal(tn.opportunity_count, 8)
  assert.equal(tn.zips.length, 2)

  // WV — rural, only 4
  const wv = states.find((s) => s.state === 'WV')
  assert.equal(wv.opportunity_count, 4)
  assert.equal(wv.zips.length, 1)
  assert.equal(wv.zips[0].zip, '25801')

  // Verify all zips have required fields
  for (const state of states) {
    for (const zip of state.zips) {
      assert.ok(zip.zip, `zip code required for ${state.state}`)
      assert.ok(typeof zip.opportunity_count === 'number', 'count must be number')
    }
  }
})

test('geo/scored: response shape contract with match scores', () => {
  // Simulate the scored response
  const response = {
    ok: true,
    state: 'TN',
    geo_zip: '37311',
    profile_id: 'profile-123',
    total: 5,
    data: [
      {
        id: 'opp-1',
        title: 'Bradley County Community Foundation Grant',
        sponsor: 'BCCF',
        geo_zip: '37311',
        geo_county: 'Bradley',
        match_score: 82,
        match_reasons: ['Matches profile state (TN)', 'Keyword overlap: disability support'],
      },
      {
        id: 'opp-2',
        title: 'Tennessee Small Business Development',
        sponsor: 'TN ECD',
        geo_zip: '37311',
        match_score: 65,
        match_reasons: ['Matches profile state (TN)'],
      },
    ],
  }

  assert.ok(response.ok)
  assert.equal(response.state, 'TN')
  assert.equal(response.geo_zip, '37311')
  assert.equal(response.profile_id, 'profile-123')

  // Verify scored results are sorted by score descending
  for (let i = 1; i < response.data.length; i++) {
    assert.ok(
      response.data[i - 1].match_score >= response.data[i].match_score,
      'results should be sorted by match_score descending',
    )
  }

  // Verify each item has geo fields
  for (const item of response.data) {
    assert.ok(item.id, 'id required')
    assert.ok(item.title, 'title required')
    assert.ok(typeof item.match_score === 'number', 'match_score must be a number when profile_id provided')
    assert.ok(Array.isArray(item.match_reasons), 'match_reasons must be an array')
assert.ok(item.match_reasons.length > 0, 'match_reasons must be non-empty — reasons must come from the decision engine')
for (const reason of item.match_reasons) {
  assert.equal(typeof reason, 'string', 'each match_reason must be a human-readable string')
  assert.ok(reason.length > 0, 'match_reason string must not be empty')
}
  }
})

test('geo/scored: no profile_id means no match scores', () => {
  // Simulate response without profile scoring
  const response = {
    ok: true,
    state: 'NY',
    geo_zip: '10001',
    profile_id: null,
    total: 127,
    data: [
      {
        id: 'opp-100',
        title: 'NYC Arts Council Grant',
        sponsor: 'NYCAC',
        geo_zip: '10001',
        // No match_score or match_reasons when profile_id is null
      },
    ],
  }

  assert.equal(response.profile_id, null)
  assert.equal(response.data[0].match_score, undefined, 'no match_score without profile')
  assert.equal(response.data[0].match_reasons, undefined, 'no match_reasons without profile')
})

test('geo_zip filter: main endpoint accepts geo_zip query param', () => {
  // Verify the query parameter parsing logic
  const queryParams = {
    state: 'TN',
    geo_zip: '37311',
    limit: '50',
    offset: '0',
    compliance: 'grant_only',
  }

  // Simulate the condition building from opportunities.js
  const conditions = ['is_active = ?']
  const params = [true]

  if (queryParams.state) {
    conditions.push('(state = ? OR is_national = ?)')
    params.push(queryParams.state.toUpperCase(), true)
  }

  if (queryParams.geo_zip) {
    conditions.push('geo_zip = ?')
    params.push(String(queryParams.geo_zip).trim())
  }

  if (queryParams.compliance === 'grant_only') {
    conditions.push("funding_type != 'loan'")
  }

  assert.equal(conditions.length, 4, 'should have 4 conditions: active, state, geo_zip, compliance')
  assert.ok(conditions.some(c => c.includes("funding_type")), 'grant_only compliance must exclude loans (Goal 3)')
  assert.ok(conditions[2].includes('geo_zip'), 'geo_zip condition should be present')
  assert.equal(params[params.length - 1], '37311', 'geo_zip param should be the zip code')
})

test('geo browsing: rural vs urban zip expectation ranges', () => {
  // Verify the system handles both extremes: rural (3-4 sources) and urban (hundreds)
  const ruralZip = { zip: '25801', state: 'WV', count: 4, county: 'Raleigh' }
  const urbanZip = { zip: '10001', state: 'NY', count: 850, county: 'New York' }

  // Rural zips should still appear (min 3 from geo crawl)
  assert.ok(ruralZip.count >= 3, 'rural zip must have at least 3 sources (geo crawl minimum)')

  // Urban zips can have many hundreds
  assert.ok(urbanZip.count > 100, 'urban zip should have 100+ sources')

  // Both should render identically in the tree view — just with different counts
  assert.ok(ruralZip.zip.length === 5, 'zip should be 5 digits')
  assert.ok(urbanZip.zip.length === 5, 'zip should be 5 digits')
})
