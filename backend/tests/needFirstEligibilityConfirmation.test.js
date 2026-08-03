import { describe, expect, it } from 'vitest'

import { ACCEPT_SCORE } from '../config/matchThresholds.js'
import { applyNeedFirstScoring } from '../services/matching/needFirstScoringAdapter.js'
import { ELIGIBILITY_UNCONFIRMED_SCORE_CAP } from '../services/matching/eligibilityConfirmation.js'

function directOpportunity() {
  return {
    id: 'benefit-1',
    title: 'Verified Health Assistance Program',
    sponsor: 'Example Health Foundation',
    description: 'Direct financial assistance for eligible patients.',
    application_url: 'https://example.org/apply',
    opportunity_kind: 'DIRECT_GRANT',
    opportunity_type: 'grant',
    categories: ['healthcare'],
  }
}

function profileContext() {
  return {
    profile: {
      id: 'person-1',
      primary_type: 'individual',
      needs: ['healthcare'],
      state: 'TN',
    },
    sections: {
      health_medical: { needs_medical_assistance: true },
    },
    signals: {
      location: { state: 'TN' },
      needs: new Set(['healthcare']),
    },
  }
}

describe('need-first eligibility confirmation integration', () => {
  it('caps and labels a direct canonical ACCEPT with unresolved income eligibility', () => {
    const result = applyNeedFirstScoring({
      canonical: {
        score: 23,
        decision: 'ACCEPT',
        eligible: 'maybe',
        explanation: 'Strong health need alignment.',
        reasons: [],
        missingEligibilityFields: ['income_eligibility'],
        matchedNeeds: ['healthcare'],
        match_explain: {
          missingEligibilityFields: ['income_eligibility'],
          dataPointEvidence: { credit: 4, matched: ['needs.healthcare'] },
          scoreBreakdown: {
            data_point_total: 15,
            data_point_credit: 4,
            eligibility_factor: 1,
            geo_factor: 1,
          },
        },
      },
      profileContext: profileContext(),
      opportunity: directOpportunity(),
    })

    expect(result.score).toBe(ELIGIBILITY_UNCONFIRMED_SCORE_CAP)
    expect(result.score).toBeLessThan(ACCEPT_SCORE)
    expect(result.decision).toBe('REVIEW')
    expect(result.eligibilityConfirmed).toBe(false)
    expect(result.eligibilityUnconfirmed).toBe(true)
    expect(result.match_explain).toMatchObject({
      eligibility_unconfirmed: true,
      eligibility_confirmation: {
        confirmed: false,
        unconfirmed: true,
        missing_fields: ['income_eligibility'],
        score_cap: ELIGIBILITY_UNCONFIRMED_SCORE_CAP,
        applied: true,
      },
    })
    expect(result.reasons.join(' ')).toMatch(/Eligibility unconfirmed/i)
  })

  it('does not cap a REVIEW that lacks only an application URL', () => {
    const result = applyNeedFirstScoring({
      canonical: {
        score: 15,
        decision: 'REVIEW',
        eligible: 'maybe',
        explanation: 'Application target is not yet known.',
        reasons: [],
        missingEligibilityFields: ['application_url'],
        matchedNeeds: ['healthcare'],
        match_explain: {
          missingEligibilityFields: ['application_url'],
          dataPointEvidence: { credit: 3, matched: ['needs.healthcare'] },
          scoreBreakdown: {
            data_point_total: 15,
            data_point_credit: 3,
            eligibility_factor: 1,
            geo_factor: 1,
          },
        },
      },
      profileContext: profileContext(),
      opportunity: { ...directOpportunity(), application_url: null },
    })

    expect(result.score).toBe(15)
    expect(result.decision).toBe('REVIEW')
    expect(result.eligibilityUnconfirmed).toBe(false)
    expect(result.match_explain.eligibility_unconfirmed).toBe(false)
  })

  it('keeps a canonical rejection rejected', () => {
    const result = applyNeedFirstScoring({
      canonical: {
        score: 18,
        decision: 'REJECT',
        eligible: false,
        explanation: 'Explicit applicant mismatch.',
        reasons: ['Applicant type mismatch'],
        missingEligibilityFields: ['income_eligibility'],
        matchedNeeds: ['healthcare'],
        match_explain: {},
      },
      profileContext: profileContext(),
      opportunity: directOpportunity(),
    })

    expect(result.decision).toBe('REJECT')
  })
})
