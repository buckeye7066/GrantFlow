import { describe, it, expect } from 'vitest'
import { professionApplicantConflict } from '../config/sourceClaims/professionApplicantConflict.js'

// Stage-2 slice 2: the profession twin of fieldOfStudyApplicantConflict. It fires
// ONLY on an APPLICANT-scoped profession claim, so a profession word that names
// the FUNDER ("American Dental Association Foundation Grant") never hard-rejects,
// while a profession that names who may apply ("Nurse Corps Scholarship") does.
const PARAMEDIC = { education: { intended_major: 'Paramedic' }, employment: { occupation: 'Paramedic' } }
const NURSE = { education: { intended_major: 'Nursing' } }
const DENTIST = { education: { intended_major: 'Dentistry' } }
const NO_FIELD = { basic_information: {} }

describe('professionApplicantConflict — scope-aware profession gate', () => {
  it('WITHHOLDS a sponsor-scoped profession (American Dental Association Foundation Grant / dentist)', () => {
    // The profession word is the FUNDER's identity — never an applicant bar.
    expect(
      professionApplicantConflict(DENTIST, { title: 'American Dental Association Foundation Grant' }),
    ).toBeNull()
  })

  it('WITHHOLDS a sponsor-scoped profession even for a DIFFERENT profession (ADA grant / paramedic)', () => {
    expect(
      professionApplicantConflict(PARAMEDIC, { title: 'American Dental Association Foundation Grant' }),
    ).toBeNull()
  })

  it('WITHHOLDS the funder-identity form (National Nurses United Scholarship / paramedic)', () => {
    expect(
      professionApplicantConflict(PARAMEDIC, { title: 'National Nurses United Scholarship' }),
    ).toBeNull()
  })

  it('WITHHOLDS a profession sitting in the SPONSOR field (paramedic)', () => {
    expect(
      professionApplicantConflict(PARAMEDIC, { title: 'Annual Education Award', sponsor: 'American Nurses Association' }),
    ).toBeNull()
  })

  it('REJECTS an applicant-scoped profession mismatch (Nurse Corps Scholarship / paramedic)', () => {
    const c = professionApplicantConflict(PARAMEDIC, { title: 'Nurse Corps Scholarship' })
    expect(c).toBeTruthy()
    expect(c.value).toBe('nursing')
    expect(c.reason).toMatch(/nursing/i)
  })

  it('REJECTS an explicit "for <profession>" requirement (Grant for Licensed Nurses / paramedic)', () => {
    expect(
      professionApplicantConflict(PARAMEDIC, { title: 'Grant for Licensed Nurses' }),
    ).toBeTruthy()
  })

  it('REJECTS a degree/program field mismatch (Master of Science in Nursing / paramedic)', () => {
    expect(
      professionApplicantConflict(PARAMEDIC, { title: 'Master of Science in Nursing' }),
    ).toBeTruthy()
  })

  it('KEEPS a matching-profession profile (Nurse Corps Scholarship / nurse)', () => {
    expect(professionApplicantConflict(NURSE, { title: 'Nurse Corps Scholarship' })).toBeNull()
  })

  it('KEEPS a matching-profession degree (Master of Science in Nursing / nurse)', () => {
    expect(professionApplicantConflict(NURSE, { title: 'Master of Science in Nursing' })).toBeNull()
  })

  it('is NEUTRAL when the profile declares no recognised profession (silence, profile side)', () => {
    expect(professionApplicantConflict(NO_FIELD, { title: 'Nurse Corps Scholarship' })).toBeNull()
  })

  it('is NEUTRAL when the award names no profession (silence, award side)', () => {
    expect(professionApplicantConflict(PARAMEDIC, { title: 'Community Impact Scholarship' })).toBeNull()
  })

  it('is NEUTRAL for an empty / missing opportunity', () => {
    expect(professionApplicantConflict(PARAMEDIC, {})).toBeNull()
    expect(professionApplicantConflict(PARAMEDIC)).toBeNull()
  })
})
