import { describe, it } from 'node:test'
import assert from 'node:assert'
import { classifyProfileChange, decideRevalAction } from '../../backend/services/profileRevalEngine.js'

describe('Profile Reval Engine', () => {

  it('naics minor → re-score', () => {
    const trigger = classifyProfileChange([{ field: 'naics_secondary', old: '511', new: '512' }])
    const res = decideRevalAction({ trigger, fanout_pct: 0.0004, affected_items: 8000, cost_units: 100, daily_budget: 1000 })
    assert.equal(res.action, 're-score')
  })

  it('primary naics → targeted', () => {
    const trigger = classifyProfileChange([{ field: 'naics_primary', old: '511', new: '512' }])
    const res = decideRevalAction({ trigger, fanout_pct: 0.01, affected_items: 20000, cost_units: 100, daily_budget: 1000 })
    assert.equal(res.action, 'targeted_reval')
  })

  it('high fanout → full recrawl', () => {
    const res = decideRevalAction({ trigger: 'naics_minor', fanout_pct: 0.05, affected_items: 50000, cost_units: 100, daily_budget: 1000 })
    assert.equal(res.action, 'full_recrawl')
  })

  it('cost guardrail blocks', () => {
    const res = decideRevalAction({ trigger: 'geo_shift', fanout_pct: 0.05, affected_items: 50000, cost_units: 20000, daily_budget: 1000 })
    assert.equal(res.block, true)
  })

})
