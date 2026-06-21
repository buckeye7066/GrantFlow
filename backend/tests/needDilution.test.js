/**
 * Need-alignment must not be diluted by how MANY needs a profile lists.
 *
 * Regression guard for the 80%-slider fix: before this, scoreNeedComponent
 * divided matched needs by the profile's TOTAL need count, so a complete
 * profile (e.g. Robert White's 13 needs) scored every grant low and the 80%
 * slider returned nothing. A grant that addresses a profile's core needs must
 * score the same whether the profile lists those 4 needs or those 4 + many more.
 */
import { describe, it, expect } from 'vitest'
import { scoreOpportunity } from '../services/matchEngine.js'

const CORE = ['education', 'housing', 'healthcare', 'employment']
const EXTRA = ['transportation', 'childcare', 'food_assistance', 'legal_aid', 'mental_health', 'dental', 'utilities', 'clothing', 'internet']

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

describe('need-alignment is not diluted by profile need count', () => {
  it('a 4-core-need profile and a 13-need profile (same 4 matched) score within a small margin', () => {
    const focused = scoreOpportunity(ctx(CORE), opp).score
    const broad = scoreOpportunity(ctx([...CORE, ...EXTRA]), opp).score
    // The broad profile matches the same 4 core needs; it must NOT be punished
    // for listing more needs. (Pre-fix, broad scored far lower.)
    expect(broad).toBeGreaterThanOrEqual(focused - 3)
  })

  it('matching the core needs earns real, surfaceable score (not a diluted floor)', () => {
    const broad = scoreOpportunity(ctx([...CORE, ...EXTRA]), opp).score
    // 4 matched needs = full need-alignment credit; combined with geo/category
    // this clears the moderate bar instead of being dragged to the 20s.
    expect(broad).toBeGreaterThanOrEqual(40)
  })
})
