/**
 * Eligibility age-affirmation checkboxes (owner 2026-08-22, live-diagnosed on
 * the U.S. Bank form): tick a required affirmation the applicant's real age
 * PROVABLY satisfies, leave a false or ambiguous one alone. Never fabricates.
 */
import { describe, it, expect } from 'vitest'
import { computeAgeYears, ageAffirmationVerdict } from '../services/hamilton/hamiltonAutopilotEngine.js'

describe('computeAgeYears', () => {
  it('computes age from a DOB at a fixed now', () => {
    expect(computeAgeYears('2008-07-19', new Date('2026-08-22'))).toBe(18)
    expect(computeAgeYears('2008-07-19', new Date('2026-07-18'))).toBe(17) // day before 18th birthday
    expect(computeAgeYears('2008-07-19', new Date('2026-07-19'))).toBe(18) // on the birthday
    expect(computeAgeYears('', new Date())).toBeNull()
    expect(computeAgeYears('not-a-date', new Date())).toBeNull()
  })
})

describe('ageAffirmationVerdict', () => {
  it('TICKS the U.S. Bank "18 or older" affirmation for an 18-year-old', () => {
    expect(ageAffirmationVerdict('I am 18 years old or older. Please check this box to proceed.', 18)).toBe(true)
  })
  it('LEAVES the "I am 17…" alternate unticked for an 18-year-old', () => {
    expect(ageAffirmationVerdict('I am 17 years old, and my parent/guardian is aware that I am registering', 18)).toBe(false)
  })
  it('ticks the exact "17" affirmation only for a 17-year-old', () => {
    expect(ageAffirmationVerdict('I am 17 years old', 17)).toBe(true)
    expect(ageAffirmationVerdict('I am 17 years old', 18)).toBe(false)
  })
  it('handles at-least / or-older / age-of-majority / under-N', () => {
    expect(ageAffirmationVerdict('Applicant must be at least 21', 18)).toBe(false)
    expect(ageAffirmationVerdict('I am 16 or older', 18)).toBe(true)
    expect(ageAffirmationVerdict('I confirm I am of legal age', 18)).toBe(true)
    expect(ageAffirmationVerdict('I am under 18', 18)).toBe(false)
    expect(ageAffirmationVerdict('I am under 18', 16)).toBe(true)
  })
  it('returns null for a NON-age affirmation (leaves it to attestation/human)', () => {
    expect(ageAffirmationVerdict('I certify the information is true and accurate', 18)).toBeNull()
    expect(ageAffirmationVerdict('I agree to the terms and conditions', 18)).toBeNull()
  })
  it('returns null when age is unknown', () => {
    expect(ageAffirmationVerdict('I am 18 years old or older', null)).toBeNull()
  })
})
