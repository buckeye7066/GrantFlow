import { describe, it, expect } from 'vitest'
import emitFieldOfStudy from '../config/sourceClaims/emitFieldOfStudy.js'
import { applicantConflicts } from '../config/sourceClaims/core.js'

/** All claims a row emits for the field_of_study dimension. */
const emit = (row) => emitFieldOfStudy(row)
/** The single (or first) claim with a given scope. */
const withScope = (claims, scope) => claims.find((c) => c.scope === scope)

describe('emitFieldOfStudy — scope-aware field claims', () => {
  // ── The motivating APPLICANT case: the field modifies the award noun in the
  //    title and names who may receive it. Sponsor "Lee Cockrell" names no field.
  it('scopes a field-modified award title as APPLICANT (Nursing Scholarship)', () => {
    const claims = emit({
      title: 'Marybelle Huggins Memorial Nursing Scholarship',
      sponsor: 'Lee Cockrell',
    })
    const applicant = withScope(claims, 'applicant')
    expect(applicant).toBeTruthy()
    expect(applicant.dimension).toBe('field_of_study')
    expect(applicant.value).toBe('nursing')
    expect(applicant.strength).toBe('explicit')
    // Exactly ONE applicant-scoped claim, and no non-applicant field noise here.
    expect(claims.filter((c) => c.scope === 'applicant')).toHaveLength(1)
    expect(claims.some((c) => c.scope === 'sponsor')).toBe(false)
  })

  // ── THE CRUX: the field is part of the FUNDER's org name, not an applicant bar.
  //    The current field-of-study gate wrongly hard-rejects this for a paramedic;
  //    the scope model must classify it 'sponsor' (informs fit, never rejects).
  it('scopes a funder-org title as SPONSOR, not applicant (Society of Highway Engineers)', () => {
    const claims = emit({ title: 'American Society of Highway Engineers Scholarship' })
    const sponsor = withScope(claims, 'sponsor')
    expect(sponsor).toBeTruthy()
    expect(sponsor.value).toBe('engineering')
    expect(sponsor.scope).toBe('sponsor')
    // Critically: NOT applicant — a paramedic must never be hard-rejected by this.
    expect(claims.some((c) => c.scope === 'applicant')).toBe(false)
  })

  it('scopes "Ohio Nurses Foundation Scholarship" as SPONSOR (field inside org name)', () => {
    const claims = emit({ title: 'Ohio Nurses Foundation Scholarship' })
    const sponsor = withScope(claims, 'sponsor')
    expect(sponsor).toBeTruthy()
    expect(sponsor.value).toBe('nursing')
    expect(sponsor.scope).toBe('sponsor')
    expect(claims.some((c) => c.scope === 'applicant')).toBe(false)
  })

  it('emits NO field claim for a generic award ("Community Impact Scholarship")', () => {
    expect(emit({ title: 'Community Impact Scholarship', sponsor: 'A Foundation' })).toEqual([])
  })

  it('scopes "Scholarship for Nursing Students" as APPLICANT', () => {
    const claims = emit({ title: 'Scholarship for Nursing Students' })
    const applicant = withScope(claims, 'applicant')
    expect(applicant).toBeTruthy()
    expect(applicant.value).toBe('nursing')
    expect(applicant.scope).toBe('applicant')
  })

  // ── Extra coverage: the field word in the SPONSOR field is always sponsor scope.
  it('scopes a field word sitting in the sponsor field as SPONSOR', () => {
    const claims = emit({ title: 'Excellence Scholarship', sponsor: 'Ohio Nurses Foundation' })
    const sponsor = withScope(claims, 'sponsor')
    expect(sponsor).toBeTruthy()
    expect(sponsor.value).toBe('nursing')
    expect(sponsor.evidence.field).toBe('sponsor')
    expect(claims.some((c) => c.scope === 'applicant')).toBe(false)
  })

  // ── The whole point, wired through the comparator: a sponsor-scoped field never
  //    hard-rejects a mismatched applicant, but an applicant-scoped one does.
  it('sponsor-scoped field does NOT conflict a paramedic; applicant-scoped one does', () => {
    const paramedicFacts = { education: { intended_major: 'Paramedic' } }

    const engSponsor = emit({ title: 'American Society of Highway Engineers Scholarship' })
    expect(applicantConflicts(engSponsor, paramedicFacts)).toHaveLength(0)

    const nursingApplicant = emit({
      title: 'Marybelle Huggins Memorial Nursing Scholarship',
      sponsor: 'Lee Cockrell',
    })
    const conflicts = applicantConflicts(nursingApplicant, paramedicFacts)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].value).toBe('nursing')
    expect(conflicts[0].scope).toBe('applicant')
  })
})
