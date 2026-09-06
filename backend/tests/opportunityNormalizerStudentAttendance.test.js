/**
 * Prod 2026-09-06: "HOPE Lottery Scholarship", decomposed from
 * mtsu.edu/financial-aid/tels/ for a Tennessee undergraduate, was REJECTED as
 * "Opportunity is for institutions or research organizations only" (score 0).
 * The full-text INSTITUTIONAL patterns include the bare word 'institution',
 * and the award's eligibility prose said "attending an eligible Tennessee
 * postsecondary institution" — a statement about WHERE the student studies,
 * not WHO receives the money.
 */
import { describe, it, expect } from 'vitest'
import { normalizeOpportunity, stripStudentAttendanceClauses } from '../services/opportunityNormalizer.js'

const mk = (title, description, extra = {}) => normalizeOpportunity({
  title, description, sponsor: 'Funder', source: 'scholarship_crawler', record_origin: 'scholarship_crawler',
  source_url: 'https://funder.org/award', ...extra,
})

describe('student-attendance clauses never mark an award institutional-only', () => {
  it('the verbatim HOPE Lottery Scholarship prose is NOT institutional-only', () => {
    const n = mk('HOPE Lottery Scholarship', 'HOPE Lottery Scholarship — Tennessee residents attending an eligible Tennessee postsecondary institution; GPA/ACT requirements; awarded via FAFSA.')
    expect(n.isInstitutionalOnly).toBe(false)
  })

  it.each([
    'Applicants must be enrolled at an accredited institution of higher learning.',
    'Open to students accepted to a Tennessee institution of higher education.',
    'Must be a full-time student at a Title IV eligible institution.',
    'Awarded to students enrolled full-time at a participating institution.',
    'Recipients must be admitted to and attend an approved postsecondary institution in the fall.',
  ])('%s → not institutional-only', (text) => {
    expect(mk('Merit Scholarship', text).isInstitutionalOnly).toBe(false)
  })

  it.each([
    ['Capacity Building Grants for Institutions', 'Eligible applicants are institutions of higher education and research organizations.'],
    ['Research Infrastructure', 'Proposals may be submitted by academic institutions; the principal investigator must hold a faculty appointment.'],
    ['Community Grants', 'Grants are made to local government and county government agencies only.'],
    ['Hospital Innovation Fund', 'Applications are accepted from health system and hospital system partners.'],
  ])('%s STILL reads institutional-only', (title, text) => {
    expect(mk(title, text).isInstitutionalOnly).toBe(true)
  })

  it('an explicit DB flag and an already-awarded record are structural and untouched', () => {
    expect(mk('Any Award', 'Students attending an eligible institution.', { is_institutional_only: true }).isInstitutionalOnly).toBe(true)
  })

  it('stripStudentAttendanceClauses removes only the applicant-enrollment clause', () => {
    const out = stripStudentAttendanceClauses('Tennessee residents attending an eligible Tennessee postsecondary institution; funds go to the institution of higher education on the student\'s behalf.')
    expect(out).not.toMatch(/attending an eligible Tennessee postsecondary institution/)
    expect(out).toMatch(/funds go to the/)
  })
})

describe('a scholarship for the NEXT GENERATION of a profession is a student award, not a call for the profession', () => {
  it('the verbatim AFTE prose types student, never researcher-only', () => {
    const n = mk('AFTE Scholarship', 'AFTE is proud to support the next generation of forensic scientists through annual scholarships of up to $2,000.', { sponsor: 'The Association of Firearm and Tool Mark Examiners' })
    expect(n.entityTypesAllowed).toContain('student')
    expect(n.entityTypesAllowed).not.toContain('researcher')
  })

  it('a real research call still types researcher', () => {
    const n = mk('Research Infrastructure Awards', 'Proposals from faculty researchers and principal investigators at research institutions.')
    expect(n.entityTypesAllowed).toContain('researcher')
    expect(n.entityTypesAllowed).not.toContain('student')
  })

  it('a plain professional award for scientists stays researcher', () => {
    const n = mk('Conference Travel Grant', 'Travel grants for scientists presenting at the annual meeting.')
    expect(n.entityTypesAllowed).toContain('researcher')
  })
})
