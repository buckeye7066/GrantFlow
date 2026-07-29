import { describe, expect, it } from 'vitest'

import {
  collectProfileSchools,
  evaluateNeedFirstMatchPolicy,
} from '../services/matching/needFirstMatchPolicy.js'
import { applyNeedFirstScoring } from '../services/matching/needFirstScoringAdapter.js'

function canonical({
  score = 12,
  decision = 'ACCEPT',
  points = [],
  matchedNeeds = [],
  bonus = 0,
} = {}) {
  const credit = points.reduce((sum, point) => sum + Number(point.credit || 0), 0)
  return {
    score,
    decision,
    explanation: 'legacy canonical decision',
    reasons: [],
    matchedNeeds,
    match_explain: {
      matchedNeeds,
      dataPointEvidence: { total: 20, credit, matched: points, bonus_credit: bonus },
      scoreBreakdown: {
        data_point_total: 20,
        data_point_credit: credit,
        data_point_bonus_credit: bonus,
        eligibility_factor: 1,
        geo_factor: 1,
      },
    },
  }
}

function studentProfile(overrides = {}) {
  return {
    profile: { id: 'student-1', primary_type: 'student' },
    sections: {
      education: {
        current_institution: 'Bradley Central High School',
        intended_major: 'Paramedicine',
        target_colleges: ['Middle Tennessee State University'],
      },
      university_applications: {
        applications: [
          { id: 'mtsu', name: 'Middle Tennessee State University', status: 'accepted' },
        ],
      },
      occupation: {},
      family_life: {},
      demographics: {},
      ...overrides.sections,
    },
    profileNorm: {
      entityType: 'student',
      isStudent: true,
      education: { intendedMajor: 'Paramedicine' },
      needCategories: ['education'],
      ...overrides.profileNorm,
    },
    ...overrides,
  }
}

describe('need-first policy edge cases', () => {
  it('keeps current high school plus accepted/target colleges before commitment', () => {
    const context = studentProfile()
    const schools = collectProfileSchools(context, context.profileNorm)
    expect(schools.committed).toEqual([])
    expect(schools.authoritative).toContain('Bradley Central High School')
    expect(schools.authoritative).toContain('Middle Tennessee State University')

    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Middle Tennessee State University Opportunity Scholarship',
        sponsor: 'Middle Tennessee State University',
      },
      dataPointEval: {
        matched: [{ kind: 'academic', value: 'student', credit: 1 }],
      },
    })
    expect(policy.hardMismatch).toBe(false)
    expect(policy.reviewOnly).toBe(false)
    expect(policy.purposeReasons.join(' ')).toMatch(/Institution match/i)
  })

  it('accepts a multi-profession award when the profile matches any listed profession', () => {
    const context = studentProfile({
      sections: {
        occupation: { job_title: 'AEMT', ems_worker: true },
      },
      profileNorm: {
        occupation: { job_title: 'AEMT', ems_worker: true },
      },
    })
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Healthcare Careers Scholarship for Nursing, EMS, and Dental Students',
        eligibility_text: 'Open to nursing, EMT/paramedic, or dental students.',
      },
      dataPointEval: {
        matched: [{ kind: 'occupation', value: 'AEMT', credit: 1 }],
      },
    })
    expect(policy.hardMismatch).toBe(false)
    expect(policy.diagnostics.profession_domains).toEqual(
      expect.arrayContaining(['nursing', 'ems', 'dental']),
    )
    expect(policy.diagnostics.profession_matches).toContain('ems')
  })

  it('does not classify a public-school organization as an individual student', () => {
    const result = applyNeedFirstScoring({
      canonical: canonical({
        points: [{ kind: 'academic', value: 'school', credit: 1 }],
      }),
      profileContext: {
        profile: { primary_type: 'public_school' },
        sections: { organization_details: { organization_type: 'public_school' } },
      },
      opportunity: {
        title: 'National Student Merit Scholarship',
        opportunity_kind: 'SCHOLARSHIP',
      },
    })
    expect(result.match_explain.needFirstPolicy.diagnostics.profile_is_student).toBe(false)
    expect(result.decision).toBe('REJECT')
  })

  it('does not treat adult caregiving as proof of a child for childcare aid', () => {
    const context = {
      profile: { primary_type: 'individual' },
      sections: {
        family_life: { caregiver: true, cares_for_family_member: true },
      },
      profileNorm: { entityType: 'individual', isCaregiver: true, hasChildren: false },
    }
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Child Care Assistance for Working Adults',
        eligibility_text: 'Applicants must have a dependent child.',
      },
      dataPointEval: { matched: [{ kind: 'family', value: 'caregiver', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(true)
    expect(policy.reasons.join(' ')).toMatch(/child, dependent, or pregnancy/i)
  })

  it('recognizes an explicit demographics caregiver flag for caregiver-only support', () => {
    const context = {
      profile: { primary_type: 'individual' },
      sections: { demographics: { is_caregiver: true } },
      profileNorm: { entityType: 'individual' },
    }
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Family Caregiver Support Grant',
        description: 'Financial assistance for family caregivers.',
      },
      dataPointEval: { matched: [{ kind: 'family', value: 'caregiver', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(false)
    expect(policy.purposeAnchor).toBe(true)
  })

  it('recognizes foster-care alumni evidence collected in demographics', () => {
    const context = studentProfile({
      sections: { demographics: { foster_care_alumni: true } },
      profileNorm: { hasFosterIndicator: false },
    })
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Chafee Education and Training Voucher Scholarship',
        eligibility_text: 'For former foster youth.',
      },
      dataPointEval: { matched: [{ kind: 'demographic', value: 'foster care alumni', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(false)
    expect(policy.purposeAnchor).toBe(true)
  })

  it('recognizes a refugee-or-immigrant boolean for international-only aid', () => {
    const context = studentProfile({
      sections: { demographics: { is_refugee_or_immigrant: true } },
      profileNorm: { isImmigrant: false, isInternationalStudent: false },
    })
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Scholarship Exclusively for International Students',
      },
      dataPointEval: { matched: [{ kind: 'immigration', value: 'refugee', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(false)
    expect(policy.purposeAnchor).toBe(true)
  })

  it('keeps a directory mentioning EMS as a REVIEW resource, not a profession rejection', () => {
    const context = studentProfile()
    const result = applyNeedFirstScoring({
      canonical: canonical({ score: 9 }),
      profileContext: context,
      opportunity: {
        title: 'EMS and Nursing Scholarship Directory',
        opportunity_kind: 'DIRECTORY',
        is_directory: true,
      },
    })
    expect(result.decision).toBe('REVIEW')
    expect(result.score).toBe(9)
    expect(result.match_explain.needFirstPolicy.resource).toBe(true)
    expect(result.match_explain.needFirstPolicy.hardMismatch).toBe(false)
  })

  it('holds a title-only institution inference at REVIEW instead of hard rejecting it', () => {
    const context = studentProfile()
    const result = applyNeedFirstScoring({
      canonical: canonical({
        points: [{ kind: 'academic', value: 'student', credit: 1 }],
      }),
      profileContext: context,
      opportunity: {
        title: 'University at Buffalo Merit Scholarship',
        sponsor: 'Community Foundation',
      },
    })
    expect(result.match_explain.needFirstPolicy.hardMismatch).toBe(false)
    expect(result.match_explain.needFirstPolicy.reviewOnly).toBe(true)
    expect(result.decision).toBe('REVIEW')
  })

  it('downgrades a university-administered broad scholarship when enrollment restriction is not stated', () => {
    const context = studentProfile()
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Regional First-Generation Student Scholarship',
        sponsor: 'University at Buffalo',
        description: 'A regional award for first-generation college students.',
      },
      dataPointEval: { matched: [{ kind: 'demographic', value: 'first generation', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(false)
    expect(policy.reviewOnly).toBe(true)
    expect(policy.decision).toBe('REVIEW')
    expect(policy.reasons.join(' ')).toMatch(/does not prove enrollment/i)
  })

  it('still rejects a sponsor-confirmed unrelated institution when the restriction is stated', () => {
    const context = studentProfile()
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'University at Buffalo Merit Scholarship',
        sponsor: 'University at Buffalo',
        eligibility_text: 'Applicants must be enrolled at the University at Buffalo.',
      },
      dataPointEval: { matched: [{ kind: 'academic', value: 'student', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(true)
    expect(policy.decision).toBe('REJECT')
  })

  it('does not reject employee aid merely because the employer is a small business', () => {
    const context = {
      profile: { primary_type: 'individual' },
      sections: { occupation: { employment_status: 'employed' } },
      profileNorm: { entityType: 'individual', occupation: { employment_status: 'employed' } },
    }
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Emergency Relief for Employees of Small Businesses',
        description: 'Direct assistance for workers whose small-business employer closed after a disaster.',
      },
      dataPointEval: { matched: [{ kind: 'occupation', value: 'employed', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(false)
    expect(policy.decision).toBeNull()
    expect(policy.reasons.join(' ')).toMatch(/employer context/i)
  })

  it('still rejects an explicitly business-only grant for an individual profile', () => {
    const context = {
      profile: { primary_type: 'individual' },
      sections: { occupation: { employment_status: 'employed' } },
      profileNorm: { entityType: 'individual' },
    }
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Small Business Recovery Grant',
        eligibility_text: 'Eligible applicants are small businesses.',
      },
      dataPointEval: { matched: [{ kind: 'occupation', value: 'employed', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(true)
    expect(policy.hardMismatches.join(' ')).toMatch(/Business-only funding/i)
  })

  it('does not interpret nursing-home assistance as a nurse-only profession program', () => {
    const context = {
      profile: { primary_type: 'individual' },
      sections: { health_medical: { support_needs: ['long term care'] } },
      profileNorm: { entityType: 'individual', needCategories: ['healthcare'] },
    }
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Nursing Home Resident Assistance Fund',
        description: 'Financial help with skilled nursing facility care costs.',
      },
      dataPointEval: { matched: [{ kind: 'health', value: 'long term care', credit: 1 }] },
    })
    expect(policy.hardMismatch).toBe(false)
    expect(policy.decision).toBeNull()
    expect(policy.reasons.join(' ')).toMatch(/care setting/i)
  })

  it('does not confuse domestic-violence survivor assistance with death-survivor benefits', () => {
    const context = {
      profile: { primary_type: 'individual' },
      sections: { demographics: { domestic_violence_survivor: true } },
      profileNorm: { entityType: 'individual' },
    }
    const policy = evaluateNeedFirstMatchPolicy({
      profileContext: context,
      profileNorm: context.profileNorm,
      opportunity: {
        title: 'Domestic Violence Survivor Assistance Grant',
        description: 'Emergency financial assistance for survivors of domestic violence.',
      },
      dataPointEval: { matched: [{ kind: 'demographic', value: 'survivor', credit: 1 }] },
    })
    expect(policy.hardMismatches.join(' ')).not.toMatch(/death-survivor/i)
    expect(policy.purposeAnchor).toBe(true)
  })
})
