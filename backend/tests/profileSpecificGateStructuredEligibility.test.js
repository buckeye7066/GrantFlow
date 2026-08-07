import { describe, expect, it } from 'vitest'
import { applyRelevanceFilter } from '../services/relevanceFilter.js'
import { evaluateProfileSpecificGate } from '../services/matching/profileSpecificGate.js'

const MALE_PROFILE = {
  primary_type: 'individual',
  state: 'TN',
  city: 'Nashville',
  gender: 'male',
  needs: ['business', 'working capital'],
}

function opportunity(overrides = {}) {
  return {
    id: 'structured-eligibility-opportunity',
    title: 'Tennessee Small Business Growth Award',
    description: 'Working-capital support for small businesses planning sustainable growth.',
    application_url: 'https://example.org/apply',
    source_url: 'https://example.org/program',
    state: 'TN',
    ...overrides,
  }
}

describe('structured eligibility relevance contract', () => {
  it('score-penalizes JSON-only women-prioritized language without display rejection', () => {
    const row = opportunity({
      eligibility_json: {
        review_priority: 'Preference for women entrepreneurs and women-owned businesses.',
      },
    })

    const relevance = applyRelevanceFilter(row, MALE_PROFILE, { mode: 'soft' })
    expect(relevance.pass).toBe(true)
    expect(relevance.softFail).toBe(true)
    expect(relevance.ruleId).toBe('demographic_women_prioritized')

    const display = evaluateProfileSpecificGate(MALE_PROFILE, row, {
      mode: 'display',
      useStoredDecision: false,
    })
    expect(display.pass).toBe(true)
  })

  it('still hard-rejects explicit JSON-only women exclusivity', () => {
    const row = opportunity({
      eligibility_json: JSON.stringify({
        eligible_applicants: 'Women only. Applicant must be female.',
      }),
    })

    const relevance = applyRelevanceFilter(row, MALE_PROFILE, { mode: 'soft' })
    expect(relevance.pass).toBe(false)
    expect(relevance.ruleId).toBe('demographic_women_only')

    const display = evaluateProfileSpecificGate(MALE_PROFILE, row, {
      mode: 'display',
      useStoredDecision: false,
    })
    expect(display.pass).toBe(false)
    expect(display.ruleId).toBe('demographic_women_only')
  })
})
