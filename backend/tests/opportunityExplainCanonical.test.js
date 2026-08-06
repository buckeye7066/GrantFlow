import { describe, expect, it } from 'vitest'

import { SCORE_SCALE_ID } from '../config/matchThresholds.js'
import { buildMatchExplanation } from '../routes/opportunities.js'

const individual = {
  id: 'profile-1',
  primary_type: 'individual',
  state: 'OH',
  needs: ['housing', 'utilities'],
}

describe('opportunity explain canonical authority', () => {
  it('does not reuse a catalog/client score when the canonical pair rejects', () => {
    const result = buildMatchExplanation(individual, {}, {
      id: 'loan-1',
      title: 'Home Improvement Loan',
      description: 'A repayable low-interest loan for home repairs.',
      application_url: 'https://ohio.gov/loan',
      is_loan: true,
      match_score: 99,
      score: 99,
    })

    expect(result).toMatchObject({
      matchDecision: 'REJECT',
      matchScore: 0,
      scoreContext: 'Not eligible',
      scoreScaleId: SCORE_SCALE_ID,
      eligible: false,
    })
    expect(result.misses.length).toBeGreaterThan(0)
  })

  it('labels a directory as needs-review even when the raw row claims 99', () => {
    const result = buildMatchExplanation(individual, {}, {
      id: 'directory-1',
      title: 'Ohio Housing Resource Directory',
      description: 'A directory of housing programs and local contacts.',
      source_url: 'https://ohio.gov/housing-directory',
      application_url: 'https://ohio.gov/housing-directory',
      opportunity_kind: 'DIRECTORY',
      type: 'DIRECTORY',
      state: 'OH',
      match_score: 99,
      score: 99,
    })

    expect(result.matchDecision).toBe('REVIEW')
    expect(result.scoreContext).toBe('Needs review')
    expect(result.matchScore).not.toBe(99)
    expect(result.scoreScaleId).toBe(SCORE_SCALE_ID)
  })
})
