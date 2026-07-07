import { describe, it, expect } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'

// Regression: ECF CHOICES / Medicaid-waiver membership carried ONLY as free
// text — government_assistance.other_programs = "Medicaid Waiver Program
// (ECF CHOICES - TN)" — never became a signal or data point, because
// buildProfileSignals only read the structured medicaid_waiver_program field
// (the Gilbert/Kim class, 2026-07-07). The free-text scan must derive the same
// assistance flags + needs as the structured branch, whole-word only.
describe('buildProfileSignals waiver membership from free text', () => {
  it('Gilbert-shaped other_programs text derives ECF/waiver assistance signals and needs', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'TN', city: 'Cleveland' },
        government_assistance: {
          other_programs: 'Medicaid Waiver Program (ECF CHOICES - TN).',
        },
      },
    })
    expect(sig.assistance.has('medicaid_waiver')).toBe(true)
    expect(sig.assistance.has('ecf_choices')).toBe(true)
    expect(sig.keywordSet.has('ecf choices')).toBe(true)
    expect(sig.keywordSet.has('medicaid waiver')).toBe(true)
    const needs = [...(sig.needs ?? [])]
    expect(needs).toContain('disability')
    expect(needs).toContain('healthcare')
    expect(needs).toContain('employment') // Employment and Community First
  })

  it('an HCBS mention in medical_insurance.notes derives the waiver signal (no ECF flag without ECF evidence)', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'OH' },
        medical_insurance: {
          plan_type: 'Medicaid',
          notes: 'Enrolled in an HCBS waiver for in-home support services.',
        },
      },
    })
    expect(sig.assistance.has('medicaid_waiver')).toBe(true)
    expect(sig.keywordSet.has('hcbs')).toBe(true)
    expect(sig.assistance.has('ecf_choices')).toBe(false)
    const needs = [...(sig.needs ?? [])]
    expect(needs).toContain('disability')
    expect(needs).toContain('healthcare')
  })

  it('"employment and community first" spelled out derives the ECF flag', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'TN' },
        government_assistance: {
          other_programs: 'Member of the Employment and Community First program through TennCare.',
        },
      },
    })
    expect(sig.assistance.has('ecf_choices')).toBe(true)
    expect(sig.assistance.has('medicaid_waiver')).toBe(true)
  })

  it('an unrelated "waiver" (fee waiver) does NOT fabricate waiver membership', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'TN' },
        government_assistance: {
          other_programs: 'Received a parking fee waiver from the city last year.',
        },
      },
    })
    expect(sig.assistance.has('medicaid_waiver')).toBe(false)
    expect(sig.assistance.has('ecf_choices')).toBe(false)
  })
})
