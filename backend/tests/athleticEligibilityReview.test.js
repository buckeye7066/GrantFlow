import { describe, expect, it } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'

const profile = {
  profile: { id: 'student', primary_type: 'individual', state: 'TN', needs: ['education'] },
  sections: { education: { intended_major: 'Forensic Science', is_student: true, extracurriculars: ['varsity soccer'] } },
  signals: { sports: ['soccer'] },
}
const award = { id: 'award', title: 'Memorial Scholarship', opportunity_kind: 'DIRECT_GRANT', opportunity_type: 'scholarship', application_url: 'https://example.edu/apply', is_national: true }
describe('athletic eligibility needs confirmation', () => {
  it.each([
    'This scholarship supports student-athletes with educational expenses.',
    'This scholarship is aimed at supporting student-athletes with educational expenses.',
    'Applicants must be student-athletes.',
    'This scholarship is part of the University Athletics Endowed Scholarships, supporting student-athletes.',
  ])('holds explicit recipient requirements despite sports interests: %s', (description) => {
    const result = computeMatchDecision(profile, { ...award, description })
    expect(result.decision).toBe('REVIEW')
    expect(result.missingEligibilityFields).toContain('athletic_eligibility')
  })
  it.each([
    'The donor was a student-athlete.',
    'Last year this scholarship was awarded to student-athletes.',
    'This scholarship is open to all students regardless of athletics.',
  ])('does not infer a requirement from context: %s', (description) => {
    expect(computeMatchDecision(profile, { ...award, description }).missingEligibilityFields ?? []).not.toContain('athletic_eligibility')
  })
  it('keeps an explicit major conflict rejected', () => {
    const result = computeMatchDecision(profile, { ...award, title: 'Computer Science Scholarship', description: 'Applicants must be student-athletes.' })
    expect(result.decision).toBe('REJECT')
  })
})
