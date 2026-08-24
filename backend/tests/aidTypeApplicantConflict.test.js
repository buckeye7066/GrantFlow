import { describe, it, expect } from 'vitest'
import emitAidType from '../config/sourceClaims/emitAidType.js'
import { aidTypeApplicantConflict } from '../config/sourceClaims/aidTypeApplicantConflict.js'

// Stage-2 slice-4: a DECLINED aid type (loan/work-study) is an applicant conflict.
// Profile side = education.aid_types_accepted (unset ⇒ everything except debt).
const NO_LOANS = { education: { aid_types_accepted: ['grant', 'endowment', 'scholarship'] } }
const DEFAULT = {} // no education → default accepted (all non-debt, incl. work-study)

describe('emitAidType — classify from the award name', () => {
  it('classifies a loan', () => {
    expect(emitAidType({ title: 'Direct Unsubsidized Loan' })[0]).toMatchObject({ scope: 'applicant', value: 'loan' })
  })
  it('classifies work-study', () => {
    expect(emitAidType({ title: 'Federal Work-Study' })[0]).toMatchObject({ value: 'work_study' })
  })
  it('emits nothing for an unnameable type', () => {
    expect(emitAidType({ title: 'Community Impact Award' })).toHaveLength(0)
  })
})

describe('aidTypeApplicantConflict — declined aid type conflicts', () => {
  it('REJECTS a loan for a no-loans profile', () => {
    const c = aidTypeApplicantConflict(NO_LOANS, { title: 'Direct Subsidized Loan' })
    expect(c).toBeTruthy()
    expect(c.value).toBe('loan')
  })

  it('REJECTS work-study for a profile that declines it (Demo Student case)', () => {
    expect(aidTypeApplicantConflict(NO_LOANS, { title: 'Federal Work-Study' })).toBeTruthy()
  })

  it('KEEPS a scholarship for a no-loans profile', () => {
    expect(aidTypeApplicantConflict(NO_LOANS, { title: 'Merit Scholarship' })).toBeNull()
  })

  it('REJECTS a loan even for a default (no-preference) profile — debt is excluded by default', () => {
    expect(aidTypeApplicantConflict(DEFAULT, { title: 'Parent PLUS Loan' })).toBeTruthy()
  })

  it('KEEPS work-study for a default profile (default accepts work-study)', () => {
    expect(aidTypeApplicantConflict(DEFAULT, { title: 'Federal Work-Study' })).toBeNull()
  })

  it('is NEUTRAL for an unnameable aid type', () => {
    expect(aidTypeApplicantConflict(NO_LOANS, { title: 'Community Impact Award' })).toBeNull()
  })
})
