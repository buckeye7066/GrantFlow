/**
 * makeDecision.geography.test.js
 *
 * Verifies the "geography must expand outward" rule:
 *   - Cross-state opps are NO LONGER hard-rejected by default.
 *   - They are downgraded to REVIEW so the UI still surfaces them.
 *   - HARD REJECT is preserved only when the opp explicitly declares state
 *     exclusivity (e.g. "Ohio residents only").
 */
import { describe, it, expect } from 'vitest'
import { makeDecision, scoreOpportunity } from '../services/matchEngine.js'
import { ACCEPT_SCORE } from '../config/matchThresholds.js'

const TN_PROFILE = { state: 'TN', primary_type: 'individual' }

describe('makeDecision: geographic state handling (expand-outward rule)', () => {
  it('cross-state opp without exclusive language → REVIEW, not REJECT', () => {
    const opp = {
      title: 'Ohio Community Health Program',
      description: 'Supports Ohio-area community health workers.',
      state: 'OH',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, TN_PROFILE, opp)
    expect(result.decision).toBe('REVIEW')
    expect(result.explanation).toMatch(/may be accessible/i)
  })

  it('cross-state opp with "residents only" language → REJECT', () => {
    const opp = {
      title: 'Ohio Emergency Aid',
      description: 'Ohio residents only.',
      state: 'OH',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, TN_PROFILE, opp)
    expect(result.decision).toBe('REJECT')
  })

  it('national opp matches any state → not rejected for geography', () => {
    const opp = {
      title: 'National Housing Assistance',
      description: 'Available nationwide.',
      state: 'nationwide',
      is_national: true,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, TN_PROFILE, opp)
    expect(result.decision).toBe('ACCEPT')
  })

  it('same-state opp is not flagged by geography rule', () => {
    const opp = {
      title: 'Tennessee Community Grant',
      description: 'For TN residents.',
      state: 'TN',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, TN_PROFILE, opp)
    expect(result.decision).toBe('ACCEPT')
  })

  it('profile with no state: cross-state opp passes geography check', () => {
    const profNoState = { primary_type: 'individual' }
    const opp = {
      title: 'Ohio Emergency Aid',
      state: 'OH',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, profNoState, opp)
    expect(result.decision).toBe('ACCEPT')
  })
})

// ---------------------------------------------------------------------------
// Multi-address profiles (home + school). STRICTLY ADDITIVE + NEUTRAL:
//  (a) single-address profile is unchanged (covered by the suite above),
//  (b) a two-state profile gets in-state credit for a SECONDARY-state program,
//  (c) state-exclusive REJECT still fires for a state in NEITHER profile state,
//  (d) having no second address never lowers a score.
// ---------------------------------------------------------------------------

// signals shape that buildProfileSignals/profileSignals emits: primary `location`
// plus the deduped primary-first `states` array across all addresses.
const OH_HOME_TN_SCHOOL_SIGNALS = {
  location: { state: 'OH', zip: '43004' },
  states: ['OH', 'TN'],
  locations: [
    { state: 'OH', zip: '43004' },
    { state: 'TN', zip: '37212' },
  ],
}

describe('makeDecision: multi-address (home + school) geography', () => {
  it('(b) secondary-state exclusive opp is IN-STATE → not rejected', () => {
    // Profile lives OH (primary) but attends school in TN. A TN-residents-only
    // program must be treated as in-state (TN ∈ profile states), NOT rejected.
    const opp = {
      title: 'Tennessee Student Emergency Aid',
      description: 'Tennessee residents only.',
      state: 'TN',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, { state: 'OH', primary_type: 'individual' }, opp, null, OH_HOME_TN_SCHOOL_SIGNALS)
    expect(result.decision).toBe('ACCEPT')
  })

  it('(b) primary-state exclusive opp is still IN-STATE → not rejected', () => {
    const opp = {
      title: 'Ohio Emergency Aid',
      description: 'Ohio residents only.',
      state: 'OH',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, { state: 'OH', primary_type: 'individual' }, opp, null, OH_HOME_TN_SCHOOL_SIGNALS)
    expect(result.decision).toBe('ACCEPT')
  })

  it('(c) state-exclusive REJECT still fires for a THIRD state in neither profile state', () => {
    const opp = {
      title: 'California Emergency Aid',
      description: 'California residents only.',
      state: 'CA',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, { state: 'OH', primary_type: 'individual' }, opp, null, OH_HOME_TN_SCHOOL_SIGNALS)
    expect(result.decision).toBe('REJECT')
  })

  it('(c) non-exclusive third-state opp → REVIEW (soft), naming both profile states', () => {
    const opp = {
      title: 'California Community Health Program',
      description: 'Supports California-area community health workers.',
      state: 'CA',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const result = makeDecision(ACCEPT_SCORE + 5, { state: 'OH', primary_type: 'individual' }, opp, null, OH_HOME_TN_SCHOOL_SIGNALS)
    expect(result.decision).toBe('REVIEW')
    expect(result.explanation).toMatch(/OH\/TN/)
  })

  it('(d) adding a second address never lowers the score for a single-state opp', () => {
    // Same TN-exclusive opp: a single-TN profile and a (OH+TN) profile must both ACCEPT.
    const opp = {
      title: 'Tennessee Student Emergency Aid',
      description: 'Tennessee residents only.',
      state: 'TN',
      is_national: false,
      application_url: 'https://example.org/apply',
    }
    const singleTN = makeDecision(ACCEPT_SCORE + 5, { state: 'TN', primary_type: 'individual' }, opp, null, {
      location: { state: 'TN', zip: '37212' }, states: ['TN'], locations: [{ state: 'TN', zip: '37212' }],
    })
    const twoState = makeDecision(ACCEPT_SCORE + 5, { state: 'OH', primary_type: 'individual' }, opp, null, OH_HOME_TN_SCHOOL_SIGNALS)
    expect(singleTN.decision).toBe('ACCEPT')
    expect(twoState.decision).toBe('ACCEPT')
  })
})

describe('scoreGeoComponent (via scoreOpportunity): multi-address in-state credit', () => {
  const baseOpp = (state) => ({
    title: `${state} Local Assistance Program`,
    description: 'Local assistance grant.',
    state,
    is_national: false,
    application_url: 'https://example.org/apply',
    keywords: ['assistance'],
    categories: ['financial_assistance'],
  })

  function geoScore(signals, opp) {
    const ctx = { profile: { state: signals.location.state, primary_type: 'individual' }, sections: {}, signals }
    return scoreOpportunity(ctx, opp).score
  }

  it('(a) single-address profile scores a same-state opp identically with or without `states`', () => {
    const withStates = { location: { state: 'TN' }, states: ['TN'], locations: [{ state: 'TN' }] }
    const withoutStates = { location: { state: 'TN' } } // older snapshot, no `states`
    const opp = baseOpp('TN')
    expect(geoScore(withStates, opp)).toBe(geoScore(withoutStates, opp))
  })

  it('(b) secondary-state program gets in-state (state-tier) geo credit', () => {
    const opp = baseOpp('TN')
    // Score the SAME TN opp for: a profile only in OH (mismatch) vs a profile in OH+TN (in-state).
    const ohOnly = geoScore({ location: { state: 'OH' }, states: ['OH'], locations: [{ state: 'OH' }] }, opp)
    const ohPlusTn = geoScore(OH_HOME_TN_SCHOOL_SIGNALS, opp)
    // In-state credit must NOT be lower than the cross-state score — it should be strictly higher.
    expect(ohPlusTn).toBeGreaterThan(ohOnly)
  })

  it('(d) adding a second address never lowers the score for a primary-state opp', () => {
    const opp = baseOpp('OH')
    const ohOnly = geoScore({ location: { state: 'OH' }, states: ['OH'], locations: [{ state: 'OH' }] }, opp)
    const ohPlusTn = geoScore(OH_HOME_TN_SCHOOL_SIGNALS, opp)
    expect(ohPlusTn).toBeGreaterThanOrEqual(ohOnly)
  })
})
