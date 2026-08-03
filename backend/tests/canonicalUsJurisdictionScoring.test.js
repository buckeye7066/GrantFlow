import { describe, expect, it } from 'vitest'

import { scoreOpportunity } from '../services/matchEngine.js'

function profileContext(state) {
  return {
    profile: {
      id: `student-${state.toLowerCase()}`,
      display_name: `${state} Student`,
      primary_type: 'student',
      state,
      needs: ['education'],
    },
    sections: {
      education: { student_status: true, current_college: 'Example College' },
    },
    signals: {
      location: { state },
      locations: [{ state }],
      states: [state],
      needs: new Set(['education']),
      applicantTypes: ['student'],
    },
  }
}

function scoreBreakdown(result) {
  return result.match_explain?.scoreBreakdown ?? result.match_explain?.score_breakdown ?? {}
}

describe('canonical U.S. geography numeric scoring', () => {
  it('scores canonical CPCC scope as NC instead of the stale TN column', () => {
    const result = scoreOpportunity(profileContext('NC'), {
      id: 'cpcc-score',
      title: 'Central Piedmont Community College Foundation Scholarship',
      sponsor: 'Central Piedmont Community College',
      description: 'Scholarship assistance for enrolled students.',
      application_url: 'https://www.cpcc.edu/financial-aid/scholarships',
      state: 'TN',
      is_national: 1,
      opportunity_type: 'scholarship',
      categories: ['education', 'scholarship'],
      eligibility_bullets: ['Eligible enrolled students'],
    })

    expect(scoreBreakdown(result).geo_factor).toBe(1)
    expect(result.match_explain?.geography_cascade?.tier ?? result.match_explain?.geo?.tier)
      .not.toBe('mismatch')
  })

  it('scores canonical Ohio RDA scope as OH instead of the stale TN column', () => {
    const result = scoreOpportunity(profileContext('OH'), {
      id: 'ohio-rda-score',
      title: 'Ohio RDA Home Repair Assistance',
      sponsor: 'Ohio Rural Development Agency',
      description: 'Home repair assistance for eligible Ohio residents.',
      application_url: 'https://example.gov/ohio-rda/apply',
      state: 'TN',
      is_national: 1,
      opportunity_type: 'program',
      categories: ['housing'],
      eligibility_bullets: ['Eligible Ohio residents'],
    })

    expect(scoreBreakdown(result).geo_factor).toBe(1)
  })

  it('does not reinterpret an unregistered stored state', () => {
    const result = scoreOpportunity(profileContext('NC'), {
      id: 'ordinary-stored-state',
      title: 'Ordinary Tennessee Scholarship',
      sponsor: 'Example Foundation',
      description: 'Scholarship assistance for students.',
      application_url: 'https://example.org/apply',
      state: 'TN',
      is_national: 0,
      opportunity_type: 'scholarship',
      categories: ['education', 'scholarship'],
      eligibility_bullets: ['Eligible students'],
    })

    expect(scoreBreakdown(result).geo_factor).toBeLessThan(1)
  })
})
