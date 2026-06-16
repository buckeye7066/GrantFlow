import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildProfileDemand } from '../../backend/services/robert/robertProfileDemandPlanner.js'
import { buildSearchPlans } from '../../backend/services/robert/robertSearchPlanner.js'

describe('robertSearchPlanner — generates plans from a profile demand', () => {
  it('produces multi-scope plans for a TN volunteer fire dept', () => {
    const ctx = {
      profile: { id: 'p1', display_name: 'Cleveland VFD', primary_type: 'volunteer_fire_department', state: 'TN', county: 'Bradley', city: 'Cleveland', tags: ['equipment', 'capital_improvement'] },
      sections: { location_focus: { state: 'TN', county: 'Bradley', city: 'Cleveland', is_rural: true } },
      signals: { entityType: 'volunteer_fire_department', state: 'TN' },
    }
    const demand = buildProfileDemand(ctx)
    assert.equal(demand.primary_type, 'volunteer_fire_department')
    assert.equal(demand.location.state, 'TN')

    const plans = buildSearchPlans(demand, { maxPlans: 50 })
    assert.ok(plans.length >= 2, 'expected multiple plans')

    const scopes = new Set(plans.map((p) => p.location_scope))
    assert.ok(scopes.has('city') || scopes.has('county') || scopes.has('state'), 'must include local scopes')
    assert.ok(scopes.has('national'), 'must include national fallback')

    const queries = plans.map((p) => p.search_query.toLowerCase())
    assert.ok(queries.some((q) => q.includes('fire') || q.includes('equipment') || q.includes('capital')))
  })

  it('expands geography city → county → state → national for zero-result avoidance', () => {
    const ctx = {
      profile: { id: 'p2', display_name: 'Family', primary_type: 'family', state: 'OH', county: 'Cuyahoga', city: 'Cleveland', tags: ['housing'] },
      sections: {},
    }
    const demand = buildProfileDemand(ctx)
    const plans = buildSearchPlans(demand, { maxPlans: 20 })
    const scopes = plans.map((p) => p.location_scope)
    for (const expected of ['city', 'county', 'state', 'national']) {
      assert.ok(scopes.includes(expected), `missing scope ${expected}`)
    }
  })

  it('queries never include placeholder or search-engine URL fragments', () => {
    const demand = buildProfileDemand({ profile: { id: 'p', primary_type: 'church', state: 'TN' }, sections: {} })
    const plans = buildSearchPlans(demand, { maxPlans: 10 })
    for (const p of plans) {
      assert.doesNotMatch(p.search_query, /example\.com|localhost|google\.com\/search/i)
    }
  })

  it('tags exclude_terms with loans and matching funds', () => {
    const demand = buildProfileDemand({ profile: { id: 'p', primary_type: 'small_business', state: 'TN', tags: ['business'] }, sections: {} })
    const plans = buildSearchPlans(demand, { maxPlans: 5 })
    for (const p of plans) {
      assert.ok(p.exclude_terms.includes('loan') || p.exclude_terms.includes('loans'))
      assert.ok(p.exclude_terms.includes('matching funds'))
    }
  })
})
