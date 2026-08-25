import { describe, it, expect } from 'vitest'
import emitCondition from '../config/sourceClaims/emitCondition.js'
import { conditionApplicantConflict } from '../config/sourceClaims/conditionApplicantConflict.js'

// Stage-2 slice-4: a disease-specific award vs a profile with a DIFFERENT named
// condition → conflict; an unnamed disability flag / no health signal → NEUTRAL
// (the conditionSpecificity.js alignment semantics, kept).
const DIABETES = { health_medical: { conditions: ['diabetes'] } }
const AUTISM = { health_medical: { conditions: ['autism'] } }
const BARE_DISABILITY = { health_medical: { chronic_illness: true } } // signal, but names nothing
const NO_HEALTH = {}

describe('emitCondition — concrete named conditions only', () => {
  it('names the condition of a disease-specific award', () => {
    const claims = emitCondition({ title: 'Autism Speaks Scholarship' })
    expect(claims.some((c) => c.value === 'autism' && c.scope === 'applicant')).toBe(true)
  })
  it('emits nothing for a non-disease-specific award', () => {
    expect(emitCondition({ title: 'Community Impact Scholarship' })).toHaveLength(0)
  })
  it('emits nothing for a generic disease-specificity marker with no concrete name', () => {
    expect(emitCondition({ title: 'Rare Disease Family Grant' })).toHaveLength(0)
  })
})

describe('conditionApplicantConflict — different named condition conflicts, silence neutral', () => {
  it('REJECTS a disease-specific award for a profile with a DIFFERENT named condition', () => {
    const c = conditionApplicantConflict(DIABETES, { title: 'Autism Speaks Scholarship' })
    expect(c).toBeTruthy()
    expect(c.value).toBe('autism')
  })

  it('KEEPS a disease-specific award when the profile names the SAME condition', () => {
    expect(conditionApplicantConflict(AUTISM, { title: 'Autism Speaks Scholarship' })).toBeNull()
  })

  it('is NEUTRAL for a bare disability flag that names no condition', () => {
    expect(conditionApplicantConflict(BARE_DISABILITY, { title: 'American Kidney Fund Grant' })).toBeNull()
  })

  it('is NEUTRAL when the profile has no health signal at all', () => {
    expect(conditionApplicantConflict(NO_HEALTH, { title: 'Autism Speaks Scholarship' })).toBeNull()
  })

  it('is NEUTRAL when the award is not disease-specific', () => {
    expect(conditionApplicantConflict(DIABETES, { title: 'Community Impact Scholarship' })).toBeNull()
  })
})
