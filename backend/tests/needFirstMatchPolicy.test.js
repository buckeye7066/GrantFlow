import { describe, expect, it } from 'vitest'
import {
  collectProfileSchools,
  enforceNeedFirstDecision,
  evaluateNeedFirstMatchPolicy,
} from '../services/matching/needFirstMatchPolicy.js'
import { applyNeedFirstScoring } from '../services/matching/needFirstScoringAdapter.js'

function studentContext(overrides = {}) {
  return {
    profile: { id: 'student-1', primary_type: 'student' },
    sections: {
      education: {
        current_institution: 'Bradley Central High School',
        intended_major: 'Forensic Science',
        gpa: 3.84,
        target_colleges: ['Middle Tennessee State University'],
      },
      university_applications: {
        applications: [
          { name: 'Middle Tennessee State University', status: 'committed' },
          { name: 'University of Tennessee', status: 'accepted' },
        ],
      },
      family_life: {},
      occupation: {},
      demographics: {},
      ...overrides.sections,
    },
    ...overrides,
  }
}

const studentNorm = {
  isStudent: true,
  entityType: 'student',
  education: { intendedMajor: 'Forensic Science' },
  academics: { gpa: 3.84 },
  needCategories: ['education'],
  effectiveFacets: ['individual', 'student'],
}

function matched(...points) {
  return { matched: points, credit: points.reduce((sum, point) => sum + Number(point.credit || 0), 0) }
}

function canonicalMatch({ points = [], needs = [] } = {}) {
  return {
    score: 12,
    decision: 'ACCEPT',
    explanation: 'Strong match',
    reasons: [],
    matchedNeeds: needs,
    match_explain: {
      matchedNeeds: needs,
      dataPointEvidence: {
        total: 20,
        credit: points.reduce((sum, point) => sum + Number(point.credit || 0), 0),
        matched: points,
      },
      scoreBreakdown: {
        data_point_total: 20,
        data_point_credit: points.reduce((sum, point) => sum + Number(point.credit || 0), 0),
        eligibility_factor: 1,
        geo_factor: 1,
      },
    },
  }
}

describe('need-first match policy', () => {
  it('uses a committed institution as the authoritative school', () => {
    const schools = collectProfileSchools(studentContext(), studentNorm)
    expect(schools.committed).toContain('Middle Tennessee State University')
    expect(schools.authoritative).toEqual(['Middle Tennessee State University'])
  })

  it('rejects institution-specific aid for an unrelated school', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'University at Buffalo Merit Scholarship',
        sponsor: 'University at Buffalo',
        opportunity_kind: 'SCHOLARSHIP',
      },
      dataPointEval: matched({ kind: 'academic', value: 'GPA 3.84', credit: 1 }),
      matchedNeeds: ['education'],
    })

    expect(policy.hardMismatch).toBe(true)
    expect(policy.decision).toBe('REJECT')
    expect(policy.reasons.join(' ')).toMatch(/University at Buffalo/i)
  })

  it('accepts the committed institution as a direct purpose anchor', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'Middle Tennessee State University Forensic Science Scholarship',
        sponsor: 'Middle Tennessee State University',
        opportunity_kind: 'SCHOLARSHIP',
      },
      dataPointEval: matched(
        { kind: 'academic', value: 'GPA 3.84', credit: 1 },
        { kind: 'interest', value: 'forensic science', credit: 1 },
      ),
      matchedNeeds: ['education'],
    })

    expect(policy.hardMismatch).toBe(false)
    expect(policy.purposeAnchor).toBe(true)
    expect(policy.decision).toBeNull()
    expect(policy.purposeReasons.join(' ')).toMatch(/Institution match/i)
  })

  it('rejects a profession-specific scholarship without that profession', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'Future Nurses Scholarship',
        sponsor: 'Nursing Foundation',
        opportunity_kind: 'SCHOLARSHIP',
      },
      dataPointEval: matched({ kind: 'academic', value: 'GPA 3.84', credit: 1 }),
      matchedNeeds: ['education'],
    })

    expect(policy.hardMismatch).toBe(true)
    expect(policy.decision).toBe('REJECT')
    expect(policy.reasons.join(' ')).toMatch(/nursing/i)
  })

  it('keeps an EMS scholarship for an EMT profile', () => {
    const profileContext = {
      profile: { primary_type: 'individual' },
      sections: {
        occupation: { ems_worker: true, job_title: 'AEMT' },
        education: { intended_major: 'Paramedicine' },
      },
      profileNorm: {
        isStudent: true,
        entityType: 'individual',
        education: { intendedMajor: 'Paramedicine' },
        needCategories: ['education'],
      },
    }
    const result = applyNeedFirstScoring({
      canonical: canonicalMatch({
        points: [{ kind: 'occupation', value: 'AEMT', credit: 1 }],
        needs: ['education'],
      }),
      profileContext,
      opportunity: {
        title: 'NAEMT EMS Education Scholarship for Paramedics',
        sponsor: 'NAEMT',
        opportunity_kind: 'SCHOLARSHIP',
      },
    })

    expect(result.decision).toBe('ACCEPT')
    expect(result.match_explain.needFirstPolicy.hardMismatch).toBe(false)
    expect(result.match_explain.needFirstPolicy.purposeReasons.join(' ')).toMatch(/EMS\/EMT\/paramedic/i)
  })

  it('rejects an EMS scholarship for a non-EMS student', () => {
    const result = applyNeedFirstScoring({
      canonical: canonicalMatch({
        points: [{ kind: 'academic', value: 'GPA 3.84', credit: 1 }],
        needs: ['education'],
      }),
      profileContext: { ...studentContext(), profileNorm: studentNorm },
      opportunity: {
        title: 'NAEMT EMS Education Scholarship for Paramedics',
        sponsor: 'NAEMT',
        opportunity_kind: 'SCHOLARSHIP',
      },
    })

    expect(result.decision).toBe('REJECT')
    expect(result.match_explain.needFirstPolicy.hardMismatch).toBe(true)
    expect(result.reasons.join(' ')).toMatch(/EMS\/EMT\/paramedic/i)
  })

  it('does not treat student status as proof of a child or dependent', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'Child Care Assistance for Student Parents',
        sponsor: 'Family Services',
        opportunity_kind: 'PROGRAM',
      },
      dataPointEval: matched({ kind: 'applicant_type', value: 'student', credit: 0.5 }),
      matchedNeeds: [],
    })

    expect(policy.hardMismatch).toBe(true)
    expect(policy.decision).toBe('REJECT')
    expect(policy.reasons.join(' ')).toMatch(/child or caregiver/i)
  })

  it('RETAINS (does not discard) an unanchored, applicant-type-compatible direct source as a low-scored REVIEW', () => {
    // Mission rule: a missing purpose PHRASE is a missing signal, not an
    // exclusion — attributes reduce score, they do not eliminate results. A
    // generic national grant the student is plausibly eligible for must survive
    // as a low REVIEW (recall / zero-result recovery), not be hard-rejected.
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'National Opportunity Program',
        sponsor: 'Generic Funder',
        opportunity_kind: 'DIRECT_GRANT',
      },
      dataPointEval: matched(
        { kind: 'geo', value: 'TN', credit: 0 },
        { kind: 'applicant_type', value: 'student', credit: 0.5 },
      ),
      matchedNeeds: [],
    })

    expect(policy.purposeAnchor).toBe(false)
    expect(policy.decision).toBe('REVIEW')
    expect(policy.reviewOnly).toBe(true)
    expect(policy.scoreCap).toBeLessThan(7)
  })

  it('STILL hard-rejects an unanchored applicant-type category error (student scholarship for a non-student)', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: {
        profile: { id: 'org-1', primary_type: 'public_school' },
        sections: { organization_details: { organization_type: 'public_school' } },
      },
      profileNorm: { entityType: 'public_school', isStudent: false, needCategories: [] },
      opportunity: {
        title: 'National Student Merit Scholarship',
        sponsor: 'Generic Foundation',
        opportunity_kind: 'SCHOLARSHIP',
      },
      dataPointEval: matched({ kind: 'academic', value: 'school', credit: 1 }),
      matchedNeeds: [],
    })

    expect(policy.purposeAnchor).toBe(false)
    expect(policy.decision).toBe('REJECT')
  })

  it('NEED_FIRST_RETAIN_UNANCHORED=0 restores the prior hard-reject of unanchored sources', () => {
    const prev = process.env.NEED_FIRST_RETAIN_UNANCHORED
    process.env.NEED_FIRST_RETAIN_UNANCHORED = '0'
    try {
      const policy = evaluateNeedFirstMatchPolicy({
        profileContext: studentContext(),
        profileNorm: studentNorm,
        opportunity: {
          title: 'National Opportunity Program',
          sponsor: 'Generic Funder',
          opportunity_kind: 'DIRECT_GRANT',
        },
        dataPointEval: matched({ kind: 'applicant_type', value: 'student', credit: 0.5 }),
        matchedNeeds: [],
      })
      expect(policy.purposeAnchor).toBe(false)
      expect(policy.decision).toBe('REJECT')
    } finally {
      if (prev === undefined) delete process.env.NEED_FIRST_RETAIN_UNANCHORED
      else process.env.NEED_FIRST_RETAIN_UNANCHORED = prev
    }
  })

  it('allows a scholarship anchored by academic and financial facts', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'National Merit and Financial Need Scholarship',
        sponsor: 'Community Foundation',
        opportunity_kind: 'SCHOLARSHIP',
      },
      dataPointEval: matched(
        { kind: 'academic', value: 'GPA 3.84', credit: 1 },
        { kind: 'financial', value: 'financial need', credit: 1 },
      ),
      matchedNeeds: [],
    })

    expect(policy.purposeAnchor).toBe(true)
    expect(policy.decision).toBeNull()
  })

  it('allows a benefit only when it connects to need or assistance evidence', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: {
        profile: { primary_type: 'individual' },
        sections: { government_assistance: { ssdi_recipient: true } },
      },
      profileNorm: { entityType: 'individual', needCategories: ['disability'] },
      opportunity: {
        title: 'Social Security Disability Benefits',
        sponsor: 'Social Security Administration',
        opportunity_kind: 'BENEFIT',
      },
      dataPointEval: matched(
        { kind: 'need', value: 'disability', credit: 1 },
        { kind: 'assistance', value: 'ssdi', credit: 1 },
      ),
      matchedNeeds: ['disability'],
    })

    expect(policy.purposeAnchor).toBe(true)
    expect(policy.decision).toBeNull()
  })

  it('keeps directories and referrals REVIEW-only without calling them direct funding', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'Scholarship Search Directory',
        opportunity_kind: 'DIRECTORY',
      },
      dataPointEval: matched(),
    })

    expect(policy.resource).toBe(true)
    expect(policy.decision).toBe('REVIEW')
    expect(policy.reviewOnly).toBe(true)
  })

  it('rejects survivor benefits without survivor evidence', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'Social Security Survivor Benefits',
        opportunity_kind: 'BENEFIT',
      },
      dataPointEval: matched({ kind: 'applicant_type', value: 'student', credit: 0.5 }),
    })
    expect(policy.hardMismatch).toBe(true)
    expect(policy.reasons.join(' ')).toMatch(/survivor/i)
  })

  it('rejects international-student-only aid without an international signal', () => {
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: studentContext(),
      profileNorm: studentNorm,
      opportunity: {
        title: 'Scholarship for International Students Only',
        opportunity_kind: 'SCHOLARSHIP',
      },
      dataPointEval: matched({ kind: 'academic', value: 'GPA 3.84', credit: 1 }),
    })
    expect(policy.hardMismatch).toBe(true)
    expect(policy.reasons.join(' ')).toMatch(/international/i)
  })

  it('overrides an inflated ACCEPT when policy says the source is not a profile match', () => {
    const policy = {
      resource: false,
      decision: 'REJECT',
      hardMismatch: false,
      hardMismatches: [],
      reasons: ['No direct purpose anchor'],
    }
    const result = enforceNeedFirstDecision({
      decision: 'ACCEPT',
      explanation: 'Strong match',
      reasons: ['high score'],
    }, policy)

    expect(result.decision).toBe('REJECT')
    expect(result.explanation).toMatch(/does not address a declared need/i)
  })
})
