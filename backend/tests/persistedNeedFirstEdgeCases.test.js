import { afterEach, describe, expect, it } from 'vitest'

import { restorePersistedMatchTruth } from '../services/matching/persistedMatchTruth.js'
import { REVIEW_SCORE } from '../config/matchThresholds.js'

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

afterEach(() => {
  delete process.env.NEED_FIRST_RETAIN_UNANCHORED
})

describe('persisted need-first evidence boundaries', () => {
  it('retains an unanchored generic source BELOW the display floor and never reinterprets general reasons as matched needs', () => {
    // The retain-unanchored rule (NEED_FIRST_RETAIN_UNANCHORED, default ON —
    // fix/need-first-retain-unanchored-sources): a missing purpose PHRASE is a
    // missing signal, not an exclusion, so the row is KEPT — but only as a
    // low-scored REVIEW capped under REVIEW_SCORE (below the display floor),
    // never resurrected to the canonical ACCEPT 90, and its explanation states
    // the honest data-point arithmetic instead of dressing the generic reasons
    // ("student profile") up as matched needs.
    const restored = restorePersistedMatchTruth(canonical, persisted, { profileContext })
    expect(restored).toHaveLength(1)
    const row = restored[0]

    // Sub-display-floor REVIEW — never the canonical ACCEPT.
    expect(String(row.match_decision).toUpperCase()).toBe('REVIEW')
    expect(Number(row.match_score)).toBeLessThan(REVIEW_SCORE)

    // The evidence boundary this file exists for: general match reasons are
    // NOT reinterpreted as matched needs. The explanation quotes the stored
    // data-point arithmetic; no need claims are minted.
    expect(row.why).toMatch(/0\.5 of 20 substantive profile data points/)
    const matchedNeeds = row.match_explain_json?.matchedNeeds ?? row.match_explain_json?.matched_needs ?? []
    expect(matchedNeeds).toEqual([])
  })

  it('NEED_FIRST_RETAIN_UNANCHORED=0 restores the prior hard-reject (the row is dropped)', () => {
    process.env.NEED_FIRST_RETAIN_UNANCHORED = '0'
    expect(
      restorePersistedMatchTruth(canonical, persisted, { profileContext }),
    ).toEqual([])
  })
})
