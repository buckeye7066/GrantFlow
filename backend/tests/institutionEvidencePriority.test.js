import { describe, it, expect } from 'vitest'
import { evaluateNeedFirstMatchPolicy } from '../services/matching/needFirstMatchPolicy.js'

function evaluate(overrides = {}, school = 'Cleveland State Community College') {
  return evaluateNeedFirstMatchPolicy({
    profileContext: { profile: { primary_type: 'student' }, sections: { education: { current_institution: school } } },
    opportunity: { title: 'Endowed Scholarship', sponsor: 'Cleveland State Community College',
      description: 'This scholarship provides financial assistance to students at Fresno City College.',
      opportunity_kind: 'SCHOLARSHIP', ...overrides },
    matchedNeeds: ['education'],
    dataPointEval: { matched: [{ kind: 'need', value: 'education', credit: 1 }] },
  })
}

describe('institution evidence outranks a conflicting sponsor label', () => {
  it('rejects a positively named enrollment mismatch despite the matching sponsor', () => {
    expect(evaluate().hardMismatch).toBe(true)
  })
  it('accepts the actual school as the enrollment evidence', () => {
    expect(evaluate({}, 'Fresno City College').hardMismatch).toBe(false)
  })
  it.each([
    'This scholarship is not limited to students at Fresno City College.',
    'The donor provided mentoring to students at Fresno City College; applicants at any college may apply.',
    'Scholarships are open to students nationwide. Last year we awarded scholarships to students at Fresno City College.',
    'Scholarships are open to students nationwide. We provide application workshops for students at Fresno City College.',
    'This scholarship is open nationwide, with application workshops for students at Fresno City College.',
  ])('does not manufacture exclusivity from broad or incidental wording', description => {
    expect(evaluate({ description }).hardMismatch).toBe(false)
  })
  it('holds a conflicting source portal even when application_url is absent', () => {
    const result = evaluate({ description: 'Scholarship assistance for college students.', source_url: 'https://cpcc.academicworks.com/', application_url: null })
    expect(result.reviewOnly).toBe(true)
    expect(result.reasons.join(' ')).toContain('portal')
  })
})
