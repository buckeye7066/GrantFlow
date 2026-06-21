import { describe, it, expect } from 'vitest'
import {
  buildProfileTargeting,
  recordMatchesProfile,
} from '../services/matching/professionalDevelopmentPolicy.js'

// A White/Polish TN student (mirrors the Anastasia case that surfaced this bug).
const tnPolishStudent = buildProfileTargeting({
  profile: { primary_type: 'student' },
  signals: { location: { state: 'TN' }, states: ['TN'], occupation: new Set(), interests: new Set() },
  sections: { demographics: { ethnicity: 'White / Caucasian', heritage: 'Polish, Russian, Ukrainian' } },
})

describe('curated-PD injection: profile-aware relevance gate', () => {
  it('drops state-restricted programs for an out-of-state profile', () => {
    const texasNurse = { name: 'Texas Nurses Foundation — Nursing CE', state: 'TX', occupationMatch: ['nurse'], categories: ['scholarship'] }
    const wvPromise = { name: 'WV PROMISE Scholarship', stateRestriction: 'WV', eligibility: { stateResident: 'WV' }, categories: ['scholarship'] }
    expect(recordMatchesProfile(texasNurse, tnPolishStudent)).toBe(false)
    expect(recordMatchesProfile(wvPromise, tnPolishStudent)).toBe(false)
  })

  it('drops occupation-specific programs the profile does not match', () => {
    const nasw = { name: 'NASW Foundation — Social Work CE', isNational: true, occupationMatch: ['social_worker', 'lcsw'], categories: ['scholarship'] }
    const aamft = { name: 'AAMFT Foundation — MFT CE', isNational: true, occupationMatch: ['lmft'], categories: ['scholarship'] }
    expect(recordMatchesProfile(nasw, tnPolishStudent)).toBe(false)
    expect(recordMatchesProfile(aamft, tnPolishStudent)).toBe(false)
  })

  it('drops ethnic-heritage scholarships the profile does not match (by name)', () => {
    const apia = { name: 'APIA Scholars (Asian & Pacific Islander American Scholarship Fund)', isNational: true, categories: ['scholarship'] }
    const uncf = { name: 'UNCF (United Negro College Fund) Scholarships', isNational: true, categories: ['scholarship'] }
    const hsf = { name: 'Hispanic Scholarship Fund', isNational: true, categories: ['scholarship'] }
    expect(recordMatchesProfile(apia, tnPolishStudent)).toBe(false)
    expect(recordMatchesProfile(uncf, tnPolishStudent)).toBe(false)
    expect(recordMatchesProfile(hsf, tnPolishStudent)).toBe(false)
  })

  it("does NOT let 'asian' substring-match 'Caucasian'", () => {
    const apia = { name: 'Asian & Pacific Islander American Scholarship Fund', isNational: true, categories: ['scholarship'] }
    expect(recordMatchesProfile(apia, tnPolishStudent)).toBe(false)
  })

  it('KEEPS heritage scholarships the profile DOES match', () => {
    const kosciuszko = { name: 'Kosciuszko Foundation — Polish American Scholarships', isNational: true, categories: ['scholarship'] }
    expect(recordMatchesProfile(kosciuszko, tnPolishStudent)).toBe(true)
  })

  it('KEEPS in-state and generic programs', () => {
    const tnHope = { name: 'Tennessee HOPE Scholarship', state: 'TN', categories: ['scholarship'] }
    const generic = { name: 'National Continuing Education Fund', isNational: true, categories: ['continuing_education'] }
    expect(recordMatchesProfile(tnHope, tnPolishStudent)).toBe(true)
    expect(recordMatchesProfile(generic, tnPolishStudent)).toBe(true)
  })

  it('matches an in-state nurse profile to the nurse program', () => {
    const txNurse = buildProfileTargeting({
      profile: { primary_type: 'individual' },
      signals: { location: { state: 'TX' }, states: ['TX'], occupation: new Set(['nurse']), interests: new Set() },
      sections: { demographics: {} },
    })
    const texasNurse = { name: 'Texas Nurses Foundation — Nursing CE', state: 'TX', occupationMatch: ['nurse'], categories: ['scholarship'] }
    expect(recordMatchesProfile(texasNurse, txNurse)).toBe(true)
  })

  it('no targeting info → keep (degrade to broad list, not empty)', () => {
    const anyRecord = { name: 'Texas Nurses Foundation', state: 'TX', occupationMatch: ['nurse'], categories: ['scholarship'] }
    expect(recordMatchesProfile(anyRecord, null)).toBe(true)
  })
})
