import { describe, expect, it } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'

// Owner finding 2026-09-05: a student who is NOT disabled (child of an SSDI
// recipient) carried demographics.disability_status = "Has disability" while
// her medical sections positively stated no disability. The section that owns
// a fact outranks a summary flag elsewhere; silence never denies.

const profile = { id: 'student-a', primary_type: 'student', display_name: 'Student A' }

describe('owning-section contradictions', () => {
  it('a disability flag contradicted by empty, denying medical sections is a conflict, not a fact', () => {
    const s = buildProfileSignals({
      profile,
      sections: {
        demographics: { disability_status: 'Has disability', age_group: 'Youth' },
        medical: { disabilities: [], assistance_programs: [], notes: 'SSDI recipient (as dependent)' },
        health_medical: { disability_type: [], chronic_illness: false, wheelchair_user: false, notes: 'No confirmed medical conditions in the current profile excerpt.' },
        medical_history: { secondary_conditions: [], dme_needed: [], notes: 'Overall health appears stable with no chronic illnesses or disabilities noted.' },
      },
    })
    expect(s.health.has('disability')).toBe(false)
    expect(s.needs.has('disability')).toBe(false)
    expect(s.data_conflicts.some((c) => c.field === 'demographics.disability_status')).toBe(true)
  })

  it('a disability flag stands when the medical sections affirm it', () => {
    const s = buildProfileSignals({
      profile,
      sections: {
        demographics: { disability_status: 'Has disability' },
        health_medical: { disability_type: ['mobility impairment'], wheelchair_user: true },
      },
    })
    expect(s.health.has('disability')).toBe(true)
    expect(s.data_conflicts.length).toBe(0)
  })

  it('a disability flag stands on silence (no medical section at all)', () => {
    const s = buildProfileSignals({ profile, sections: { demographics: { disability_status: 'Has disability' } } })
    expect(s.health.has('disability')).toBe(true)
  })

  it('SSDI named as a dependent-child benefit that ended is not the applicant\'s own disability benefit', () => {
    const s = buildProfileSignals({
      profile,
      sections: {
        financial_information: { receives_assistance: ['SSDI'] },
        government_assistance: { other_programs: 'SSDI dependent-child benefit ENDED 2026-07-19 (aged out at 18). Parent remains an SSDI recipient.' },
      },
    })
    expect(s.assistance.has('ssdi_recipient')).toBe(false)
    expect(s.needs.has('disability')).toBe(false)
    expect(s.data_conflicts.some((c) => c.value === 'SSDI')).toBe(true)
  })

  it('SSDI with no dependent note remains the applicant\'s own benefit', () => {
    const s = buildProfileSignals({ profile: { ...profile, primary_type: 'individual' }, sections: { financial_information: { receives_assistance: ['SSDI'] } } })
    expect(s.assistance.has('ssdi_recipient')).toBe(true)
    expect(s.needs.has('disability')).toBe(true)
  })
})
