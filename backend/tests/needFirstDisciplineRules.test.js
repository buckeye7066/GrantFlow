/**
 * 2026-09-05: a first-year forensic-science student's Hamilton-ready set held
 * seven departmental scholarships outside her major (business, insurance,
 * media, music, teaching) and a K-12 voucher program, every one at ACCEPT
 * 73-81 with "Institution match: College of Business". A scholarship whose
 * title names a discipline is a positive restriction; a student who declares
 * a different major cannot hold it. Silence stays neutral both ways.
 */
import { describe, expect, it } from 'vitest'
import { evaluateNeedFirstMatchPolicy } from '../services/matching/needFirstMatchPolicy.js'

const studentNorm = {
  isStudent: true,
  entityType: 'student',
  education: { intendedMajor: 'Forensic Science' },
  academics: { gpa: 3.84 },
  needCategories: ['education'],
  effectiveFacets: ['student', 'individual'],
}

const forensicStudent = {
  profile: { id: 'student-a', primary_type: 'student' },
  sections: {
    basic_information: { date_of_birth: '2008-07-19', state: 'TN', city: 'Cleveland' },
    education: {
      current_institution: 'Middle Tennessee State University',
      intended_major: 'Forensic Science',
      highest_level: 'Associates Degree',
    },
    university_applications: { applications: [{ name: 'Middle Tennessee State University', status: 'committed' }] },
    family_life: { caregiver: true },
  },
}

function policyFor(opportunity, context = forensicStudent, norm = studentNorm) {
  return evaluateNeedFirstMatchPolicy({
    profileContext: context,
    profileNorm: norm,
    opportunity,
    dataPointEval: { matched: [], credit: 0 },
    matchedNeeds: ['education'],
  })
}

describe('field-of-study restriction', () => {
  it.each([
    ['Nancy J. Fann Business Education Scholarship', 'Scholarship for students in the Jones College of Business.', ''],
    ['Tommy T. Martin Chair of Insurance Scholarship', 'Awarded to students pursuing a degree in insurance or finance.', ''],
    ['PRIMUS Financial Services Scholarship', 'Scholarship at MTSU.', ''],
    ['Media Scholarship', 'Scholarship for students in the College of Media and Entertainment.', ''],
    ['Where Every Note Counts Scholarship Campaign', 'Give to support student scholarships.', 'https://give.mtsu.edu/pages/music-campaign'],
    ['ASPIRE to Teach Emergency Fund', 'Emergency fund for teacher-candidates in the College of Education.', ''],
  ])('rejects %s for a declared forensic-science major', (title, description, url) => {
    const result = policyFor({ title, opportunity_kind: 'DIRECT_GRANT', description, apply_url: url || null })
    expect(result.decision).toBe('REJECT')
    expect(result.hardMismatch).toBe(true)
  })

  it.each([
    ['AFTE Forensic Science Scholarship', 'Scholarship for students in forensic science programs.'],
    ['STEM Scholarship for Tennessee Students', 'For students majoring in science, technology, engineering or math.'],
    ['DREAM Scholarship', 'Merit scholarship for incoming freshmen.'],
    ['The Buchanan Fellowship', 'MTSU Honors College fellowship for incoming freshmen.'],
    ['Tennessee General Assembly Merit Scholarship', 'Merit-based award for Tennessee residents.'],
  ])('keeps %s (discipline matches or none is named)', (title, description) => {
    const result = policyFor({ title, opportunity_kind: 'DIRECT_GRANT', description })
    expect(result.decision).not.toBe('REJECT')
    expect(result.hardMismatch).toBe(false)
  })

  it('silence is neutral: a student who declares no major keeps a business scholarship', () => {
    const noMajor = { profile: { id: 'student-b', primary_type: 'student' }, sections: { education: { current_institution: 'Middle Tennessee State University' } } }
    const result = policyFor(
      { title: 'Nancy J. Fann Business Education Scholarship', opportunity_kind: 'DIRECT_GRANT', description: 'Scholarship in the Jones College of Business.' },
      noMajor,
      { ...studentNorm, education: {} },
    )
    expect(result.decision).not.toBe('REJECT')
  })
})

describe('K-12 programs vs a post-secondary student', () => {
  it('rejects the Education Freedom Scholarship Act for an enrolled university student', () => {
    const result = policyFor({
      title: 'Education Freedom Scholarship Act',
      opportunity_kind: 'DIRECT_GRANT',
      description: 'Education savings accounts for K-12 students attending private schools in Tennessee.',
    })
    expect(result.decision).toBe('REJECT')
    expect(result.hardMismatch).toBe(true)
  })

  it('keeps a K-12 program for a high-school student', () => {
    const highSchooler = { profile: { id: 'student-c', primary_type: 'student' }, sections: { education: { current_institution: 'Walker Valley High School', highest_level: 'High School' } } }
    const result = policyFor(
      { title: 'Education Freedom Scholarships', opportunity_kind: 'DIRECT_GRANT', description: 'Education savings accounts for K-12 students.' },
      highSchooler,
      { ...studentNorm, education: {} },
    )
    expect(result.decision).not.toBe('REJECT')
  })
})
