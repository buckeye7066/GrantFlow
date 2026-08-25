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

  // Regression, 2026-08-24: "Grants to USA Professional Dancers" (sponsor
  // "Dancers' Fund") reached ACCEPT for a Kentucky farmer/senior. emitProfession
  // produced ONLY a sponsor-scoped claim from the SPONSOR field, because the
  // sponsor-identity branch ran BEFORE the title heuristics — so the title's own
  // recipient phrase ("Grants TO ... Dancers") was never read and this gate saw
  // no applicant claim to conflict with. The "for" recipient preposition was
  // already handled; "to" was not.
  it("REJECTS a recipient-phrase title even when the FUNDER is profession-named (Dancers Fund / farmer)", () => {
    const FARMER = { employment: { occupation: 'Farmer' } }
    for (const sponsor of ["Dancers' Fund", 'Dancers’ Resource']) {
      const conflict = professionApplicantConflict(FARMER, {
        title: 'Grants to USA Professional Dancers',
        sponsor,
      })
      expect(conflict, sponsor).not.toBeNull()
      expect(conflict.value).toBe('dance')
      expect(conflict.field).toBe('title')
    }
  })

  it('KEEPS the funder-name prefix ahead of the recipient rule (Grants to American Dental Association members)', () => {
    // orgPrefixGoverning still settles a governing funder name first, so a
    // "Grants to <Org>" title is NOT turned into an applicant bar.
    expect(
      professionApplicantConflict(PARAMEDIC, { title: 'Grants to American Dental Association members' }),
    ).toBeNull()
  })

  it('is NEUTRAL for an empty / missing opportunity', () => {
    expect(professionApplicantConflict(PARAMEDIC, {})).toBeNull()
    expect(professionApplicantConflict(PARAMEDIC)).toBeNull()
  })
})
