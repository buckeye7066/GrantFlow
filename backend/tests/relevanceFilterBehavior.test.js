/**
 * relevanceFilterBehavior.test.js
 *
 * Behavior tests for the new content-type suppression rules added in the
 * hard exclusion rules update. Verifies that applyRelevanceFilter correctly
 * rejects procurement, fundraising, PI-restricted, and no-deadline-rolling
 * opportunities — and passes through legitimate grant opportunities.
 */
import { describe, it, expect } from 'vitest'
import { applyRelevanceFilter } from '../services/relevanceFilter.js'

// Default profile that passes all demographic/entity filters
const baseProfile = {
  primary_type: 'individual',
  state: 'TN',
  city: 'Nashville',
}

function opp(overrides = {}) {
  return {
    title: overrides.title ?? 'Community Grant Opportunity',
    description: overrides.description ?? '',
    state: 'TN',
    is_national: true,
    ...overrides,
  }
}

describe('Hard content-type suppression rules — reject cases', () => {
  it('rejects a procurement/contract solicitation (RFP)', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'Request for Proposals for IT Services' }),
      baseProfile,
    )
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_procurement_contract')
  })

  it('rejects a solicitation in the description', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'Vendor Opportunity', description: 'This is a contract opportunity for qualified vendors.' }),
      baseProfile,
    )
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_procurement_contract')
  })

  it('rejects a fundraising/crowdfunding ask', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'Donate to Help Our Community Center' }),
      baseProfile,
    )
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_fundraising_crowdfunding')
  })

  it('rejects a GoFundMe-style crowdfunding listing', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'GoFundMe Campaign for Local Shelter', description: 'crowdfund our mission' }),
      baseProfile,
    )
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_fundraising_crowdfunding')
  })

  it('rejects a PI/institution-restricted academic call', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'Grant for Institutions of Higher Education', description: 'Eligible Applicants: Institutions of Higher Education' }),
      baseProfile,
    )
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('rejects a principal investigator only grant', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'Research Award', description: 'Applicant must be a principal investigator at an accredited university.' }),
      baseProfile,
    )
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('rejects a rolling listing with no deadline fields', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'Small Business Support Fund', description: 'Applications accepted on a rolling basis.' }),
      baseProfile,
    )
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_rolling_no_clear_deadline')
  })

  it('rejects open-until-filled with no deadline', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'Open Until Filled: Utility Assistance Program' }),
      baseProfile,
    )
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_rolling_no_clear_deadline')
  })
})

describe('Hard content-type suppression rules — pass cases', () => {
  it('passes a normal grant opportunity with standard language', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'Community Development Block Grant', description: 'Awards up to $50,000 to eligible nonprofits.' }),
      baseProfile,
    )
    expect(result.pass).toBe(true)
  })

  it('passes a rolling opportunity that has a real close_date', () => {
    const result = applyRelevanceFilter(
      opp({
        title: 'Small Business Rolling Grant',
        description: 'Applications accepted on a rolling basis.',
        close_date: '2025-12-31',
      }),
      baseProfile,
    )
    expect(result.pass).toBe(true)
  })

  it('passes a rolling opportunity with a deadline field', () => {
    const result = applyRelevanceFilter(
      opp({
        title: 'Open Until Filled Assistance Program',
        deadline: '2025-06-01',
      }),
      baseProfile,
    )
    expect(result.pass).toBe(true)
  })

  it('passes a normal scholarship that does not contain PI/institution-only language', () => {
    const result = applyRelevanceFilter(
      opp({ title: 'College Scholarship for First-Generation Students', description: 'Open to all eligible applicants.' }),
      baseProfile,
    )
    expect(result.pass).toBe(true)
  })
})
