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
  it('rejects a contract opportunity for individual profiles', () => {
    const opp = makeOpp({ title: 'Contract Opportunity for IT Vendor Services' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_procurement_contract')
  })

  it('passes RFP/solicitation for individual profiles (narrowed pattern)', () => {
    const opp = makeOpp({ title: 'Request for Proposals for Community Services' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })

  it('passes a contract opportunity for organization profiles', () => {
    const orgProfile = { ...BASE_PROFILE, primary_type: 'organization' }
    const opp = makeOpp({ title: 'Contract Opportunity for IT Vendor Services' })
    const result = applyRelevanceFilter(opp, orgProfile)
    expect(result.pass).toBe(true)
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
  it('rejects a principal investigator requirement for individual profiles', () => {
    const opp = makeOpp({
      description: 'Applicants must have a principal investigator on file',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('rejects a faculty member requirement for individual profiles', () => {
    const opp = makeOpp({
      description: 'Open to any faculty member at an accredited university',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('rejects doctoral dissertation research for individual profiles', () => {
    const opp = makeOpp({ title: 'Doctoral Dissertation Research Fellowship' })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(false)
    expect(result.ruleId).toBe('content_pi_institution_restricted')
  })

  it('passes PI/institution opportunities for nonprofit profiles', () => {
    const nonprofitProfile = { ...BASE_PROFILE, primary_type: 'nonprofit' }
    const opp = makeOpp({
      description: 'Applicants must have a principal investigator on file',
    })
    const result = applyRelevanceFilter(opp, nonprofitProfile)
    expect(result.pass).toBe(true)
  })

  it('passes PI/institution opportunities for student profiles', () => {
    const studentProfile = { ...BASE_PROFILE, primary_type: 'student' }
    const opp = makeOpp({
      description: 'Applicants must have a principal investigator on file',
    })
    const result = applyRelevanceFilter(opp, studentProfile)
    expect(result.pass).toBe(true)
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

describe('rolling programs (rule 19 removed)', () => {
  it('passes a rolling-basis opportunity — rolling programs are legitimate funding', () => {
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
    expect(result.pass).toBe(true)
  })

  it('passes open-until-filled opportunities', () => {
    const opp = makeOpp({
      description: 'This position is open until filled',
      deadline: undefined,
      close_date: undefined,
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })

  it('passes a rolling opportunity with a concrete deadline', () => {
    const opp = makeOpp({
      description: 'Applications accepted on a rolling basis',
      deadline: '2025-12-31',
    })
    const result = applyRelevanceFilter(opp, BASE_PROFILE)
    expect(result.pass).toBe(true)
  })
})
