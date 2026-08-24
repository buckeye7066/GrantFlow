/**
 * emitProfession.test.js — the profession dimension emitter's SCOPE contract.
 *
 * The hard part is not detecting the profession word (professionEligibility owns
 * that vocabulary) — it is deciding whether the word is an APPLICANT requirement
 * (can hard-reject) or the FUNDER's identity (never a bar). See emitProfession.js.
 */
import { describe, it, expect } from 'vitest'
import emitProfession from '../config/sourceClaims/emitProfession.js'
import { SCOPES } from '../config/sourceClaims/core.js'

/** Convenience: the single claim (or undefined) an opportunity emits. */
function one(opp) {
  const claims = emitProfession(opp)
  expect(Array.isArray(claims)).toBe(true)
  expect(claims.length).toBeLessThanOrEqual(1)
  return claims[0]
}

describe('emitProfession — scope contract', () => {
  it('a profession in the FUNDER org name is scope "sponsor", NOT applicant', () => {
    const c = one({ title: 'American Dental Association Foundation Grant' })
    expect(c).toBeTruthy()
    expect(c.dimension).toBe('profession')
    expect(c.value).toBe('dentistry')
    expect(c.scope).toBe('sponsor')
    // A sponsor claim must never be an applicant bar.
    expect(['applicant', 'beneficiary']).not.toContain(c.scope)
  })

  it('"Nurse Corps Scholarship Program" is a nursing APPLICANT requirement', () => {
    const c = one({ title: 'Nurse Corps Scholarship Program' })
    expect(c).toBeTruthy()
    expect(c.value).toBe('nursing')
    expect(c.scope).toBe('applicant')
    expect(c.strength).toBe('explicit')
  })

  it('"Grant for Licensed Practical Nurses" is a nursing APPLICANT requirement', () => {
    const c = one({ title: 'Grant for Licensed Practical Nurses' })
    expect(c).toBeTruthy()
    expect(c.value).toBe('nursing')
    expect(c.scope).toBe('applicant')
    expect(c.strength).toBe('explicit')
  })

  it('a generic "Community Foundation Grant" makes NO profession claim', () => {
    expect(emitProfession({ title: 'Community Foundation Grant' })).toEqual([])
  })
})

describe('emitProfession — additional scope cases', () => {
  it('"National Nurses United Scholarship" is the funder identity → sponsor', () => {
    const c = one({ title: 'National Nurses United Scholarship' })
    expect(c).toBeTruthy()
    expect(c.value).toBe('nursing')
    expect(c.scope).toBe('sponsor')
  })

  it('the profession word in the SPONSOR field → sponsor', () => {
    const c = one({
      title: 'Annual Education Award',
      sponsor: 'American Nurses Association',
    })
    expect(c).toBeTruthy()
    expect(c.value).toBe('nursing')
    expect(c.scope).toBe('sponsor')
    expect(c.evidence.field).toBe('sponsor')
  })

  it('"Scholarship for Registered Nurses" is an applicant requirement', () => {
    const c = one({ title: 'Scholarship for Registered Nurses' })
    expect(c).toBeTruthy()
    expect(c.value).toBe('nursing')
    expect(c.scope).toBe('applicant')
  })

  it('every emitted claim carries a valid scope and profession evidence', () => {
    const opps = [
      { title: 'American Dental Association Foundation Grant' },
      { title: 'Nurse Corps Scholarship Program' },
      { title: 'Grant for Licensed Practical Nurses' },
    ]
    for (const opp of opps) {
      const c = one(opp)
      expect(SCOPES).toContain(c.scope)
      expect(c.evidence).toBeTruthy()
      expect(typeof c.evidence.field).toBe('string')
      expect(c.evidence.text.length).toBeGreaterThan(0)
    }
  })

  it('returns [] for an empty / non-object opportunity', () => {
    expect(emitProfession()).toEqual([])
    expect(emitProfession({})).toEqual([])
    expect(emitProfession(null)).toEqual([])
  })
})
