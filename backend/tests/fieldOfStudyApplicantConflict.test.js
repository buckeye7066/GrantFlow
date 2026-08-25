import { describe, it, expect } from 'vitest'
import { fieldOfStudyApplicantConflict } from '../config/sourceClaims/core.js'

// Stage-2 slice 1: the engine's field-of-study gate is now scope-aware. It fires
// ONLY on an applicant-scoped field claim, so a field word in the SPONSOR's name
// no longer hard-rejects — fixing the over-rejection the title-only gate #1360
// produced (measured on Robert: 590 field rejects, most sponsor/facility-scoped).
const PARAMEDIC = { education: { intended_major: 'Paramedic' }, student_portal_plan: { major: 'Paramedic' } }
const NURSING = { education: { intended_major: 'Nursing' } }
const NO_MAJOR = { basic_information: {} }

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
