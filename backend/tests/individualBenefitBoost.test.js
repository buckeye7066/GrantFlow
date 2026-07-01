/**
 * Individual + benefit-program score alignment.
 *
 * The grant-tuned base model under-scores assistance/benefit programs for
 * low-income individuals (disability/senior/housing/food/energy needs) — the
 * reason people like Kathy see thin results. A modest post-weight boost makes
 * the SCORE reflect the genuine alignment (it does NOT relax the surfacing bar).
 */
import { describe, it, expect } from 'vitest'
import { scoreOpportunity } from '../services/matchEngine.js'

const BENEFIT_OPP = {
  id: 'liheap-tn',
  title: 'LIHEAP Energy Assistance Program',
  description: 'Help with home energy and utility bills for low-income households.',
  opportunity_type: 'benefit',
  state: 'TN',
  is_national: 0,
}

// Disabled individual with an energy/housing benefit need (data-derived facets).
const DISABLED_INDIVIDUAL = {
  profile: { id: 'kathy', primary_type: 'individual', state: 'TN', city: 'Cleveland' },
  sections: {
    demographics: { disability_status: 'Has disability' },
    housing: { answers: { risk_of_eviction: true } },
    financial: { answers: { low_income: true } },
  },
}

// A church org with no benefit need — must NOT get the individual-benefit boost.
const CHURCH_ORG = {
  profile: { id: 'church', primary_type: 'church', state: 'TN', organization_name: 'Grace Church' },
  sections: {},
}

describe('individual + benefit-program boost', () => {
  it('boosts a benefit program for a disabled individual with a benefit need', () => {
    const r = scoreOpportunity(DISABLED_INDIVIDUAL, BENEFIT_OPP)
    expect(r.reasons.some((x) => /Individual \+ benefit-program alignment/i.test(x))).toBe(true)
  })

  it('does NOT apply the boost to an organization profile', () => {
    const r = scoreOpportunity(CHURCH_ORG, BENEFIT_OPP)
    expect(r.reasons.some((x) => /Individual \+ benefit-program alignment/i.test(x))).toBe(false)
  })

  it('scores the benefit program higher for the individual-in-need than for the org', () => {
    const indiv = scoreOpportunity(DISABLED_INDIVIDUAL, BENEFIT_OPP).score
    const org = scoreOpportunity(CHURCH_ORG, BENEFIT_OPP).score
    expect(indiv).toBeGreaterThan(org)
  })
})
