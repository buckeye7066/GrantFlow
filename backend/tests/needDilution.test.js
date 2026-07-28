/**
 * Data-point denominator semantics (owner directive 2026-07-06 evening).
 *
 * HISTORY: this file used to guard the OPPOSITE contract. On the retired
 * scales, dividing by the profile's total need count was a BUG (the
 * "80%-slider returns nothing" class), so the denominator was capped at 4
 * and a 13-need profile scored the same as a 4-need profile. The data-point
 * model deliberately reverses that: the denominator IS the whole inventory —
 * "a richer profile raises the bar" — and the failure mode the old guard
 * protected against is prevented by EMPIRICALLY CALIBRATED thresholds
 * (AUTO_ADD_SCORE=8 etc.) instead of by capping the denominator.
 *
 * The contracts that still must hold:
 *  1. Dilution is bounded and honest: matching the same core needs on a
 *     richer profile lowers the score (bigger denominator) but NEVER below
 *     the pipeline bar when the core needs are really addressed.
 *  2. Monotonicity: matching MORE of a profile's data points never lowers
 *     the score.
 */
import { describe, it, expect } from 'vitest'
import { scoreOpportunity } from '../services/matchEngine.js'
import { AUTO_ADD_SCORE } from '../config/matchThresholds.js'

const CORE = ['education', 'housing', 'healthcare', 'employment']
const EXTRA = ['transportation', 'childcare', 'food_assistance', 'legal_aid', 'mental_health', 'dental', 'utilities', 'clothing', 'internet']
// Ballast needs the opportunity text never mentions: dilution semantics apply
// to CALIBRATABLE inventories (>= MIN_CALIBRATED_INVENTORY, 2026-07-27) —
// below the floor a fixed denominator deliberately mutes dilution, so both
// fixtures must clear it for the comparison to be meaningful.
const BALLAST = ['agriculture', 'maritime', 'aviation', 'forestry', 'archaeology', 'astronomy', 'robotics', 'ceramics', 'geology', 'meteorology', 'linguistics', 'philately']

function ctx(needs) {
  return {
    profile: { id: 'p', primary_type: 'individual', state: 'TN' },
    signals: { location: { state: 'TN' }, needs: new Set(needs) },
  }
}

// A grant whose keywords address exactly the 4 core needs.
const opp = {
  title: 'Community Support Grant',
  description: 'Education, housing, healthcare and employment assistance.',
  keywords: JSON.stringify([...CORE]),
  categories: JSON.stringify([...CORE]),
  is_national: 1,
  state: 'nationwide',
}

// The same grant, but also covering many of the broad profile's extra needs.
const broadOpp = {
  ...opp,
  title: 'Comprehensive Family Support Grant',
  description:
    'Education, housing, healthcare, employment, transportation, childcare, food assistance, legal aid, mental health, dental, utilities, clothing and internet assistance.',
  keywords: JSON.stringify([...CORE, ...EXTRA]),
  categories: JSON.stringify([...CORE, ...EXTRA]),
}

describe('data-point denominator semantics', () => {
  it('a richer profile scores the same partial match lower — but core-need coverage stays pipeline-worthy', () => {
    const focused = scoreOpportunity(ctx([...CORE, ...BALLAST]), opp).score
    const broad = scoreOpportunity(ctx([...CORE, ...BALLAST, ...EXTRA]), opp).score
    // Deliberate dilution: same 4 matched needs over a larger inventory.
    expect(broad).toBeLessThan(focused)
    // But real core-need coverage must remain surfaceable, not floor-crushed.
    expect(broad).toBeGreaterThanOrEqual(AUTO_ADD_SCORE)
  })

  it('matching more of the profile monotonically raises the score', () => {
    const partial = scoreOpportunity(ctx([...CORE, ...BALLAST, ...EXTRA]), opp).score
    const fuller = scoreOpportunity(ctx([...CORE, ...BALLAST, ...EXTRA]), broadOpp).score
    expect(fuller).toBeGreaterThan(partial)
  })
})
