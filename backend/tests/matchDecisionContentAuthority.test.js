import { describe, expect, it } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'
import { applyRelevanceFilter, extractProfileData } from '../services/relevanceFilter.js'
import { isProcurementContractOpportunity } from '../services/matching/contentEligibilityPolicy.js'

const individual = {
  primary_type: 'individual',
  state: 'TN',
  needs: ['training', 'employment'],
}

function procurement(overrides = {}) {
  return {
    title: 'Workforce Training Contract Opportunity',
    description: 'Seeking a vendor to deliver workforce training services.',
    application_url: 'https://example.org/respond',
    state: 'TN',
    ...overrides,
  }
}

describe('canonical content applicability authority', () => {
  it('shares procurement source classification with the legacy lead filter', () => {
    const opportunity = procurement({
      title: 'Workforce Training Services',
      description: 'Funding-related notice.',
      eligibility_bullets: JSON.stringify(['Eligible bidder must submit a response.']),
    })
    expect(isProcurementContractOpportunity(opportunity)).toBe(true)
    expect(applyRelevanceFilter(opportunity, extractProfileData(individual)).ruleId)
      .toBe('content_procurement_contract')
  })

  it('rejects an individual procurement solicitation at canonical write time', () => {
    const decision = computeMatchDecision(individual, procurement())
    expect(decision.decision).toBe('REJECT')
    expect(decision.score).toBe(0)
    expect(decision.explanation).toMatch(/procurement\/contract solicitation/i)
  })

  it('does not apply the individual procurement rejection to an organization', () => {
    const decision = computeMatchDecision(
      {
        primary_type: 'business',
        state: 'TN',
        needs: ['workforce development'],
      },
      procurement(),
    )
    expect(decision.explanation).not.toMatch(/not a grant opportunity for individuals/i)
  })

  it.each([
    [
      'religion',
      { ...individual, religion: 'Jewish' },
      {
        title: 'Catholics Only Housing Assistance',
        description: 'Restricted to Catholic applicants.',
        application_url: 'https://example.org/apply',
      },
      /faith-restricted/i,
    ],
    [
      'rural locale',
      { ...individual, locale: 'urban' },
      {
        title: 'Rural Residents Only Housing Assistance',
        description: 'Restricted to rural residents only.',
        application_url: 'https://example.org/apply',
      },
      /rural-only/i,
    ],
    [
      'orientation',
      { ...individual, sexual_orientation: 'straight' },
      {
        title: 'LGBTQ Applicants Only Housing Assistance',
        description: 'Open only to LGBTQ applicants.',
        application_url: 'https://example.org/apply',
      },
      /LGBTQ\+-only/i,
    ],
    [
      'marital status',
      { ...individual, marital_status: 'single' },
      {
        title: 'Married Couples Only Housing Assistance',
        description: 'Restricted to married couples only.',
        application_url: 'https://example.org/apply',
      },
      /marital-status-restricted/i,
    ],
  ])('rejects a known, explicit %s conflict only at canonical write time', (_label, profile, opportunity, reason) => {
    const decision = computeMatchDecision(profile, opportunity)
    expect(decision.decision).toBe('REJECT')
    expect(decision.score).toBe(0)
    expect(decision.explanation).toMatch(reason)
  })

  it.each([
    ['fundraising ask', { title: 'Donate to Our GoFundMe Housing Campaign', application_url: 'https://example.org/donate' }],
    ['missing action URL', { title: 'Housing Support Grant', description: 'Direct housing funding.' }],
    ['templated locator', { title: 'United Way near Nashville, TN', application_url: 'https://example.org/apply' }],
    ['foreign embassy call', { title: 'U.S. Mission Italy Annual Program Statement', application_url: 'https://it.usembassy.gov/apply' }],
    ['tribal-government call', { title: 'Tribal Response Cooperative Agreement', application_url: 'https://example.org/apply' }],
  ])('rejects source-invalid %s rows in the canonical decision', (_label, opportunity) => {
    const decision = computeMatchDecision(individual, opportunity)
    expect(decision.decision).toBe('REJECT')
    expect(decision.score).toBe(0)
  })
})
