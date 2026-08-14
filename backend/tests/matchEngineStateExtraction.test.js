/**
 * matchEngineStateExtraction.test.js
 *
 * Regression coverage for the private _extractStateNameFromTitle() helper in
 * matchEngine.js, exercised indirectly through the exported evaluateEligibility()
 * -> geoLooksNationalOrInState() -> titleNamesLocalDistrict() path.
 *
 * This helper is a fork of the same original bare-substring implementation
 * duplicated across relevanceFilterRules.js, relevanceFilter.js,
 * pipelineGoalCleanupService.js, and two one-time scripts. A bare substring
 * match resolved a county NAME sharing a state name ("Delaware County, Ohio")
 * as a claim about that state (DE) -- so an Ohio county's own local
 * scholarship, viewed by an Ohio profile, was wrongly flagged
 * 'local_award_out_of_state' and its score capped below ACCEPT.
 */
import { describe, it, expect } from 'vitest'
import { evaluateEligibility } from '../services/matchEngine.js'
import { normalizeProfile } from '../services/profileNormalizer.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'

const OH_PROFILE = {
  id: 'p-oh',
  primary_type: 'individual',
  state: 'OH',
  city: 'Columbus',
}

describe('evaluateEligibility — county-as-state guard (matchEngine.js fork)', () => {
  it('does NOT flag a same-state county-named local award as out-of-state', () => {
    // "Delaware County" is a real Ohio county. A bare-substring state
    // extractor reads "delaware" as the state of Delaware and wrongly
    // excludes this Ohio profile's own local county scholarship.
    const oppNorm = normalizeOpportunity({
      title: 'Delaware County Scholarship Fund',
      description: 'Scholarship for graduating seniors in Delaware County, Ohio.',
      is_national: false,
      state: null,
    })
    const profileNorm = normalizeProfile(OH_PROFILE)
    const result = evaluateEligibility(profileNorm, oppNorm)
    expect(result.missingFields).not.toContain('local_award_out_of_state')
  })

  it('still flags a genuinely out-of-state county-named local award', () => {
    // Sanity check: the guard must not blanket-suppress the rule it exists
    // alongside -- a real Indiana county award for an Ohio profile is still
    // correctly flagged.
    const oppNorm = normalizeOpportunity({
      title: 'La Grange County Scholarship Fund',
      description: 'Scholarship for graduating seniors in La Grange County, Indiana.',
      is_national: false,
      state: 'IN',
    })
    const profileNorm = normalizeProfile(OH_PROFILE)
    const result = evaluateEligibility(profileNorm, oppNorm)
    expect(result.missingFields).toContain('local_award_out_of_state')
  })
})
