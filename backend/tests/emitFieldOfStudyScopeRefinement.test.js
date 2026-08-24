import { describe, it, expect } from 'vitest'
import emitFieldOfStudy from '../config/sourceClaims/emitFieldOfStudy.js'

// Stage-2 refinement: a field named as the applicant's DEGREE/PROGRAM (or after a
// funder-name separator) is scope 'applicant' even when a sponsor org is nearby;
// a field that is part of the funder's own name, a facility type, or a job title
// stays 'sponsor'. Measured against the real Robert catalog (604 old rejects,
// most of them sponsor/facility-scoped; genuine degree programs must still reject).
const applicantFields = (row) => emitFieldOfStudy(row).filter((c) => c.scope === 'applicant').map((c) => c.value)
const scopeOf = (row) => emitFieldOfStudy(row).map((c) => `${c.value}/${c.scope}`)

describe('emitFieldOfStudy — degree/program + separator scope refinement', () => {
  it('scopes a DEGREE/PROGRAM in the field as applicant', () => {
    expect(applicantFields({ title: 'Master of Science in Nursing (MSN)' })).toContain('nursing')
    expect(applicantFields({ title: 'US Army Graduate Program in Anesthesia Nursing', sponsor: 'US Army' })).toContain('nursing')
  })

  it('scopes a field AFTER a funder-name separator as applicant', () => {
    // "Foundation" precedes the field, but a separator marks the award clause.
    expect(applicantFields({ title: 'ANA Foundation — Nursing Career Recovery Scholarship', sponsor: 'ANA Foundation' })).toContain('nursing')
    expect(applicantFields({ title: 'TEACH Grant — Teacher Education Assistance', sponsor: 'US Dept of Education' })).toContain('teaching_education')
  })

  it('keeps a field INSIDE the funder org name as sponsor (never applicant)', () => {
    expect(applicantFields({ title: 'American Society of Highway Engineers Scholarship', sponsor: 'ASHE' })).toHaveLength(0)
    expect(scopeOf({ title: 'American Society of Highway Engineers Scholarship', sponsor: 'ASHE' })).toContain('engineering/sponsor')
  })

  it('keeps a field followed by a funder org word as sponsor', () => {
    // "Ohio NURSES Foundation Scholarship" — Nurses is the funder's name.
    expect(applicantFields({ title: 'Ohio Nurses Foundation Scholarship', sponsor: 'Ohio Nurses Foundation' })).toHaveLength(0)
  })

  it('does NOT scope a facility type or a job title as an applicant field', () => {
    expect(applicantFields({ title: "Mitchell's Nursing Home (social facility)" })).toHaveLength(0)
    expect(applicantFields({ title: 'Physician - Sports Medicine' })).toHaveLength(0)
  })

  it('still scopes a direct "<Field> Scholarship" and the profile\'s own field as applicant', () => {
    expect(applicantFields({ title: 'Marybelle Huggins Memorial Nursing Scholarship', sponsor: 'Lee Cockrell' })).toContain('nursing')
    expect(applicantFields({ title: 'Cleveland State Community College Paramedic Scholarship', sponsor: 'Cleveland State CC' })).toContain('paramedic_ems')
  })
})
