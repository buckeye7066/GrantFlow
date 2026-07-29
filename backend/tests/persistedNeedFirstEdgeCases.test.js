import { describe, expect, it } from 'vitest'

import { restorePersistedMatchTruth } from '../services/matching/persistedMatchTruth.js'

const profileContext = {
  profile: { id: 'student-1', primary_type: 'student' },
  sections: {
    education: { intended_major: 'Forensic Science' },
    occupation: {},
    family_life: {},
    demographics: {},
  },
  profileNorm: {
    entityType: 'student',
    isStudent: true,
    education: { intendedMajor: 'Forensic Science' },
  },
}

describe('persisted need-first evidence boundaries', () => {
  it('does not reinterpret general match reasons as matched needs', () => {
    const canonical = [{
      id: 'generic-1',
      title: 'Generic National Opportunity',
      sponsor: 'Generic Funder',
      opportunity_kind: 'DIRECT_GRANT',
      application_url: 'https://example.test/apply',
      match_score: 90,
      match_decision: 'ACCEPT',
    }]
    const persisted = [{
      ...canonical[0],
      match_score: 12,
      match_decision: 'review',
      match_reasons: JSON.stringify(['student profile', 'Tennessee geography']),
      match_explain_json: JSON.stringify({
        dataPointEvidence: {
          total: 20,
          credit: 0.5,
          matched: [{ kind: 'applicant_type', value: 'student', credit: 0.5 }],
        },
        scoreBreakdown: {
          data_point_total: 20,
          data_point_credit: 0.5,
        },
      }),
    }]

    expect(
      restorePersistedMatchTruth(canonical, persisted, { profileContext }),
    ).toEqual([])
  })
})
