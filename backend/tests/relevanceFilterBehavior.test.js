/**
 * relevanceFilterBehavior.test.js
 *
 * Behavior tests for the new content_type suppression rules added to RELEVANCE_RULES.
 * These tests call applyRelevanceFilter(...) directly and verify rejection/pass-through
 * for procurement, fundraising, PI/institution, and rolling-no-deadline rules.
 */
import { describe, it, expect } from 'vitest'
import { applyRelevanceFilter } from '../services/relevanceFilter.js'

// Minimal profile data sufficient to not trigger other rules
const BASE_PROFILE = {
  primary_type: 'individual',
  state: 'TN',
  city: 'Nashville',
}

function makeOpp(overrides = {}) {
  return {
    title: 'Community Grant',
    description: 'Funding available for community organizations',
    keywords: '',
    state: 'TN',
    is_national: true,
    ...overrides,
  }
}

describe('content_procurement_contract rule', () => {
  it('rejects a request for proposals title', () => {
    const opp = makeOpp({ title: 'Request for Proposals for IT Services' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_procurement_contract')
  })

  it('rejects an RFP in description', () => {
    const opp = makeOpp({ description: 'Submit your RFP by end of month' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_procurement_contract')
  })

  it('rejects a solicitation title', () => {
    const opp = makeOpp({ title: 'Solicitation for Technology Vendor Services' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_procurement_contract')
  })

  it('passes a normal grant opportunity', () => {
    const opp = makeOpp({
      title: 'Community Resilience Grant Program',
      description: 'Grants available to support local nonprofits',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })
})

describe('content_fundraising_crowdfunding rule', () => {
  it('rejects a donate-to title', () => {
    const opp = makeOpp({ title: 'Donate to Help Our Community Center' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_fundraising_crowdfunding')
  })

  it('rejects a GoFundMe reference in description', () => {
    const opp = makeOpp({ description: 'Support us on GoFundMe to raise funds' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_fundraising_crowdfunding')
  })

  it('rejects a Kickstarter campaign', () => {
    const opp = makeOpp({ title: 'Kickstarter Campaign for Local Art Project' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_fundraising_crowdfunding')
  })

  it('passes a normal scholarship opportunity', () => {
    const opp = makeOpp({
      title: 'Community Scholarship Award',
      description: 'Annual scholarship for students demonstrating financial need',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })
})

describe('content_pi_institution_restricted rule', () => {
  it('rejects an institutions of higher education eligibility statement', () => {
    const opp = makeOpp({
      title: 'Research Grant',
      description: 'Eligible Applicants: Institutions of Higher Education',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('rejects a principal investigator requirement', () => {
    const opp = makeOpp({
      description: 'Applicants must have a principal investigator on file',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('rejects a faculty member requirement', () => {
    const opp = makeOpp({
      description: 'Open to any faculty member at an accredited university',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('rejects doctoral dissertation research', () => {
    const opp = makeOpp({ title: 'Doctoral Dissertation Research Fellowship' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('passes a normal scholarship that does not contain PI/institution-only language', () => {
    const opp = makeOpp({
      title: 'Annual Student Scholarship',
      description: 'Open to all students demonstrating financial need and community involvement',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })
})

describe('content_rolling_no_clear_deadline rule', () => {
  it('rejects a rolling-basis opportunity with no deadline fields', () => {
    const opp = makeOpp({
      title: 'Community Support Fund',
      description: 'Applications accepted on a rolling basis',
      deadline: null,
      deadline_text: null,
      close_date: null,
      closing_date: null,
      application_deadline: null,
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_rolling_no_clear_deadline')
  })

  it('rejects open-until-filled with no deadline', () => {
    const opp = makeOpp({
      description: 'This position is open until filled',
      deadline: undefined,
      close_date: undefined,
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_rolling_no_clear_deadline')
  })

  it('passes a rolling opportunity that has a concrete deadline', () => {
    const opp = makeOpp({
      description: 'Applications accepted on a rolling basis',
      deadline: '2025-12-31',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })

  it('passes a rolling opportunity that has a closing_date', () => {
    const opp = makeOpp({
      description: 'Open until filled, rolling basis',
      closing_date: '2025-06-30',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })

  it('passes a normal grant with no rolling language', () => {
    const opp = makeOpp({
      title: 'Community Resilience Fund',
      description: 'Apply by the posted deadline for this funding opportunity',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })
})
