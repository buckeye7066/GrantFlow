import { describe, it, expect } from 'vitest'
import emitGender from '../config/sourceClaims/emitGender.js'
import { genderApplicantConflict } from '../config/sourceClaims/genderApplicantConflict.js'

// Stage-2 slice-4: gender is APPLICANT-scoped only (the exclusivity phrases are
// inherently applicant bars). KNOWN mismatch rejects; unknown gender is neutral.
const MALE = { demographics: { gender: 'Male' } }
const FEMALE = { basic_information: { gender: 'Female' } }
const UNKNOWN = { demographics: {} }

describe('emitGender — precise exclusivity only', () => {
  it('emits a female applicant claim for "for Women Only"', () => {
    const claims = emitGender({ title: 'Scholarship for Women Only' })
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ scope: 'applicant', value: 'female' })
  })

  it('emits a male applicant claim for "Men Only"', () => {
    const claims = emitGender({ title: 'Men Only Trade Grant' })
    expect(claims[0]).toMatchObject({ scope: 'applicant', value: 'male' })
  })

  it('emits NOTHING for a gender word in a funder name (Society of Women Engineers)', () => {
    expect(emitGender({ title: 'Society of Women Engineers Scholarship' })).toHaveLength(0)
  })
})

describe('genderApplicantConflict — known mismatch rejects, unknown neutral', () => {
  it('REJECTS a women-only award for a male profile', () => {
    const c = genderApplicantConflict(MALE, { title: 'Grant for Women Only' })
    expect(c).toBeTruthy()
    expect(c.value).toBe('female')
  })

  it('REJECTS a men-only award for a female profile', () => {
    expect(genderApplicantConflict(FEMALE, { title: 'Men Only Apprenticeship Award' })).toBeTruthy()
  })

  it('KEEPS a women-only award for a female profile', () => {
    expect(genderApplicantConflict(FEMALE, { title: 'Grant for Women Only' })).toBeNull()
  })

  it('is NEUTRAL when the profile gender is unknown', () => {
    expect(genderApplicantConflict(UNKNOWN, { title: 'Grant for Women Only' })).toBeNull()
  })

  it('is NEUTRAL when the award states no gender bar', () => {
    expect(genderApplicantConflict(MALE, { title: 'Community Scholarship' })).toBeNull()
  })

  it('is NEUTRAL for a funder-name gender word (Society of Women Engineers / male profile)', () => {
    expect(genderApplicantConflict(MALE, { title: 'Society of Women Engineers Scholarship' })).toBeNull()
  })
})
