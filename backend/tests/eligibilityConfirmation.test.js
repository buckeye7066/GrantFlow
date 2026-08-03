import { describe, expect, it } from 'vitest'

import {
  applyEligibilityConfirmationPolicy,
  ELIGIBILITY_UNCONFIRMED_SCORE_CAP,
  eligibilityConfirmationOf,
} from '../services/matching/eligibilityConfirmation.js'

describe('eligibility confirmation policy', () => {
  it('caps a high direct match below ACCEPT and labels the missing eligibility', () => {
    const canonical = {
      score: 23,
      decision: 'ACCEPT',
      eligible: 'maybe',
      missingEligibilityFields: ['income_eligibility'],
      explanation: 'Strong healthcare fit.',
    }

    const result = applyEligibilityConfirmationPolicy({
      canonical,
      score: canonical.score,
      decision: canonical.decision,
      explanation: canonical.explanation,
      reasons: [],
    })

    expect(result.applied).toBe(true)
    expect(result.score).toBe(ELIGIBILITY_UNCONFIRMED_SCORE_CAP)
    expect(result.decision).toBe('REVIEW')
    expect(result.confirmation).toMatchObject({
      confirmed: false,
      unconfirmed: true,
      missingFields: ['income_eligibility'],
    })
    expect(result.reasons.join(' ')).toMatch(/Eligibility unconfirmed/i)
    expect(result.explanation).toMatch(/review the program criteria/i)
  })

  it('does not raise a lower measured score to the cap', () => {
    const result = applyEligibilityConfirmationPolicy({
      canonical: {
        score: 7,
        decision: 'REVIEW',
        missingEligibilityFields: ['student_status'],
      },
      score: 7,
      decision: 'REVIEW',
    })

    expect(result.applied).toBe(true)
    expect(result.score).toBe(7)
    expect(result.decision).toBe('REVIEW')
  })

  it.each([
    ['application_url'],
    ['profile_location'],
    ['local_award_out_of_state'],
    ['application_url', 'profile_location'],
  ])('does not mislabel non-eligibility metadata as applicant uncertainty: %j', (...fields) => {
    const confirmation = eligibilityConfirmationOf({
      eligible: 'maybe',
      missingEligibilityFields: fields,
    })
    const result = applyEligibilityConfirmationPolicy({
      canonical: { score: 15, decision: 'REVIEW', missingEligibilityFields: fields },
      score: 15,
      decision: 'REVIEW',
    })

    expect(confirmation.unconfirmed).toBe(false)
    expect(result.applied).toBe(false)
    expect(result.score).toBe(15)
  })

  it('caps when applicant uncertainty and actionability uncertainty coexist', () => {
    const confirmation = eligibilityConfirmationOf({
      missingEligibilityFields: ['application_url', 'income_eligibility'],
    })

    expect(confirmation).toMatchObject({
      unconfirmed: true,
      missingFields: ['income_eligibility'],
      allMissingFields: ['application_url', 'income_eligibility'],
    })
  })

  it('never resurrects a canonical rejection', () => {
    const result = applyEligibilityConfirmationPolicy({
      canonical: {
        score: 18,
        decision: 'REJECT',
        missingEligibilityFields: ['gender'],
        explanation: 'Explicitly ineligible.',
      },
      score: 18,
      decision: 'REJECT',
      explanation: 'Explicitly ineligible.',
    })

    expect(result.decision).toBe('REJECT')
    expect(result.explanation).toBe('Explicitly ineligible.')
  })

  it('leaves pointer/resource scoring to the resource policy', () => {
    const result = applyEligibilityConfirmationPolicy({
      canonical: {
        score: 22,
        decision: 'REVIEW',
        missingEligibilityFields: ['income_eligibility'],
      },
      score: 22,
      decision: 'REVIEW',
      resource: true,
    })

    expect(result.applied).toBe(false)
    expect(result.score).toBe(22)
    expect(result.decision).toBe('REVIEW')
  })

  it('normalizes and deduplicates missing fields from canonical and explain payloads', () => {
    const confirmation = eligibilityConfirmationOf({
      missingEligibilityFields: ['Income Eligibility', 'application_url'],
      match_explain: {
        missing_eligibility_fields: ['income_eligibility', 'Student Status'],
      },
    })

    expect(confirmation.missingFields).toEqual(['income_eligibility', 'student_status'])
    expect(confirmation.allMissingFields).toEqual([
      'income_eligibility',
      'application_url',
      'student_status',
    ])
  })
})
