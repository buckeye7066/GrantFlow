import { describe, expect, it } from 'vitest'
import { evaluateNeedFirstMatchPolicy } from '../services/matching/needFirstMatchPolicy.js'

const anastasiaContext = {
  profile: { id: 'anastasia', primary_type: 'student' },
  sections: {
    education: {
      intended_major: 'Forensic Science',
      gpa: 3.84,
      target_colleges: ['Middle Tennessee State University'],
    },
    university_applications: {
      applications: [{ name: 'Middle Tennessee State University', status: 'committed' }],
    },
    family_life: {},
    occupation: {},
    demographics: {},
  },
}

const anastasiaNorm = {
  isStudent: true,
  entityType: 'student',
  education: { intendedMajor: 'Forensic Science' },
  academics: { gpa: 3.84 },
  needCategories: ['education'],
  effectiveFacets: ['student', 'individual'],
}

function policyFor(opportunity, points = []) {
  return evaluateNeedFirstMatchPolicy({
    profileContext: anastasiaContext,
    profileNorm: anastasiaNorm,
    opportunity,
    dataPointEval: { matched: points, credit: points.length },
    matchedNeeds: ['education'],
  })
}

describe('need-first production examples', () => {
  it.each([
    ['University at Buffalo Scholarship', 'University at Buffalo'],
    ['Cleveland State University Scholarship', 'Cleveland State University'],
  ])('rejects unrelated institution-specific aid: %s', (title, sponsor) => {
    const result = policyFor(
      { title, sponsor, opportunity_kind: 'SCHOLARSHIP' },
      [{ kind: 'academic', value: 'GPA 3.84', credit: 1 }],
    )
    expect(result.decision).toBe('REJECT')
    expect(result.hardMismatch).toBe(true)
  })

  it.each([
    'Future Nurses Scholarship',
    'Medical Student Education Program',
    'Chiropractic Student Scholarship',
    'National Welding Scholarship',
  ])('rejects the wrong profession or major: %s', (title) => {
    const result = policyFor(
      { title, sponsor: 'Professional Foundation', opportunity_kind: 'SCHOLARSHIP' },
      [{ kind: 'academic', value: 'GPA 3.84', credit: 1 }],
    )
    expect(result.decision).toBe('REJECT')
    expect(result.hardMismatch).toBe(true)
  })

  it('rejects international-only scholarships without an international-student fact', () => {
    const result = policyFor(
      { title: 'Scholarships for International Students Only', opportunity_kind: 'SCHOLARSHIP' },
      [{ kind: 'academic', value: 'GPA 3.84', credit: 1 }],
    )
    expect(result.decision).toBe('REJECT')
  })

  it('rejects childcare assistance when the profile has no child or dependent', () => {
    const result = policyFor(
      { title: 'Childcare Assistance for College Students', opportunity_kind: 'PROGRAM' },
      [{ kind: 'applicant_type', value: 'student', credit: 0.5 }],
    )
    expect(result.decision).toBe('REJECT')
  })

  it('keeps MTSU forensic-science aid because it matches institution and major', () => {
    const result = policyFor(
      {
        title: 'Middle Tennessee State University Forensic Science Scholarship',
        sponsor: 'Middle Tennessee State University',
        opportunity_kind: 'SCHOLARSHIP',
      },
      [
        { kind: 'academic', value: 'GPA 3.84', credit: 1 },
        { kind: 'interest', value: 'forensic science', credit: 1 },
      ],
    )
    expect(result.hardMismatch).toBe(false)
    expect(result.purposeAnchor).toBe(true)
    expect(result.decision).toBeNull()
  })
})
