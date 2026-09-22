import { describe, it, expect } from 'vitest'
import { fieldOfStudyApplicantConflict } from '../config/sourceClaims/core.js'
import { computeMatchDecision } from '../services/matchEngine.js'

// Stage-2 slice 1: the engine's field-of-study gate is now scope-aware. It fires
// ONLY on an applicant-scoped field claim, so a field word in the SPONSOR's name
// no longer hard-rejects — fixing the over-rejection the title-only gate #1360
// produced (measured on Robert: 590 field rejects, most sponsor/facility-scoped).
const PARAMEDIC = { education: { intended_major: 'Paramedic' }, student_portal_plan: { major: 'Paramedic' } }
const NURSING = { education: { intended_major: 'Nursing' } }
const NO_MAJOR = { basic_information: {} }

describe('specific academic majors in recipient criteria', () => {
  const forensic = { education: { intended_major: 'Forensic Science' } }
  const award = { title: 'Homer Brown Scholarship', description: 'This scholarship is awarded to an outstanding Computer Science major who has completed CSCI/MATH 3180.' }
  it('does not equate a shared science word with the required major', () => {
    expect(fieldOfStudyApplicantConflict(forensic, award)?.classId).toBe('computer_science')
    expect(fieldOfStudyApplicantConflict({ education: { intended_major: 'Computer Science' } }, award)).toBeNull()
  })
  it('recognizes political science as a distinct recipient major', () => {
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Memorial Scholarship', eligibility_text: 'Applicants must be majoring in political science.' })?.classId).toBe('political_science')
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Memorial Scholarship', description: 'This scholarship is awarded to students studying political science, helping alleviate the financial burden of college education.' })?.classId).toBe('political_science')
  })
  it('enforces the declared-major conflict through the canonical matcher', () => {
    const result = computeMatchDecision({ profile: { id: 'forensic-student', primary_type: 'individual', state: 'TN', needs: ['education'] }, sections: forensic }, { ...award, id: 'named-scholarship', is_national: true, application_url: 'https://example.edu/apply', opportunity_type: 'scholarship', opportunity_kind: 'DIRECT_GRANT' })
    expect(result.decision).toBe('REJECT')
    expect(JSON.stringify(result)).toMatch(/computer_science|field.of.study/i)
  })
  it('keeps alternative eligible majors', () => {
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Science Scholarship', description: 'This scholarship is awarded to computer science or forensic science majors.' })).toBeNull()
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Science Scholarship', description: 'This scholarship is awarded to students majoring in computer science or forensic science.' })).toBeNull()
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Science Scholarship', description: 'This scholarship is awarded to computer science, forensic science, or political science majors.' })).toBeNull()
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Science Scholarship', description: 'This scholarship is awarded to computer science majors or forensic science majors.' })).toBeNull()
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Science Scholarship', description: 'This scholarship is open to computer science students or students studying forensic science.' })).toBeNull()
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Science Scholarship', description: 'This scholarship is open to computer science majors, forensic science majors, or political science majors.' })).toBeNull()
  })
  it.each([
    'The donor was a Computer Science major who founded this scholarship.',
    'Last year this scholarship was awarded to an outstanding Computer Science major.',
    'Applicants need not be majoring in computer science.',
    'This scholarship is open to all majors; computer science students are encouraged to apply.',
    'This scholarship is awarded to students who volunteer as mentors for computer science students.',
  ])('does not turn contextual prose into a restriction: %s', (description) => {
    expect(fieldOfStudyApplicantConflict(forensic, { title: 'Memorial Scholarship', description })).toBeNull()
  })
})

describe('fieldOfStudyApplicantConflict — scope-aware engine gate', () => {
  it('REJECTS an applicant-scoped field mismatch (Nursing Scholarship / paramedic)', () => {
    const c = fieldOfStudyApplicantConflict(PARAMEDIC, { title: 'Marybelle Huggins Memorial Nursing Scholarship', sponsor: 'Lee Cockrell' })
    expect(c).toBeTruthy()
    expect(c.reason).toMatch(/nursing/i)
  })

  it('REJECTS a genuine degree/program field mismatch (MSN / paramedic)', () => {
    expect(fieldOfStudyApplicantConflict(PARAMEDIC, { title: 'Master of Science in Nursing (MSN)' })).toBeTruthy()
  })

  it('WITHHOLDS a sponsor-scoped field word (American Society of Highway Engineers) — the #1360 fix', () => {
    expect(fieldOfStudyApplicantConflict(PARAMEDIC, { title: 'American Society of Highway Engineers Scholarship', sponsor: 'ASHE' })).toBeNull()
  })

  it('WITHHOLDS a sponsor-field org name (Ohio Nurses Foundation)', () => {
    expect(fieldOfStudyApplicantConflict(PARAMEDIC, { title: 'Ohio Nurses Foundation Scholarship', sponsor: 'Ohio Nurses Foundation' })).toBeNull()
  })

  it('KEEPS the profile\'s own field (Paramedic scholarship / paramedic major)', () => {
    expect(fieldOfStudyApplicantConflict(PARAMEDIC, { title: 'Cleveland State Community College Paramedic Scholarship', sponsor: 'Cleveland State CC' })).toBeNull()
  })

  it('KEEPS a matching-field student (Nursing Scholarship / nursing major)', () => {
    expect(fieldOfStudyApplicantConflict(NURSING, { title: 'Marybelle Huggins Memorial Nursing Scholarship', sponsor: 'Lee Cockrell' })).toBeNull()
  })

  it('is NEUTRAL when the profile declares no major (silence)', () => {
    expect(fieldOfStudyApplicantConflict(NO_MAJOR, { title: 'Nursing Scholarship', sponsor: 'X' })).toBeNull()
  })

  it('is NEUTRAL when the award names no specific field', () => {
    expect(fieldOfStudyApplicantConflict(PARAMEDIC, { title: 'Community Impact Scholarship', sponsor: 'X' })).toBeNull()
  })
})
