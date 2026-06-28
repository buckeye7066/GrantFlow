import { describe, expect, it } from 'vitest'
import {
  detectMedicaidContext,
  detectMedicareContext,
  extractBasicInformationHeuristics,
  extractGovernmentAssistanceHeuristics,
  extractMedicalInsuranceHeuristics,
  isLikelyIdentifier,
  parseDateToISO,
} from '../services/documentIngestion/heuristics.js'

/**
 * Synthetic TN Medicaid (TennCare) and ECF CHOICES document shapes.
 *
 * These tests pin the user-facing contract:
 *   "If the user uploads a TennCare card or ECF
 *    CHOICES award letter, the Medicaid number lands on the profile."
 *
 * Mission goals served:
 *   - Goal 2 (match actual needs): a captured Medicaid number routes
 *     the applicant to TennCare/ECF-CHOICES specific resources.
 *   - Goal 3 (use the full profile): documents are first-class profile
 *     inputs, not narrative-only bait.
 *   - Goal 9 (explainable + reliable): deterministic regexes mean the
 *     same card always produces the same fields without an LLM.
 */

describe('parseDateToISO', () => {
  it('parses MM/DD/YYYY', () => {
    expect(parseDateToISO('10/11/1964')).toBe('1964-10-11')
  })
  it('parses M/D/YYYY', () => {
    expect(parseDateToISO('1/15/1972')).toBe('1972-01-15')
  })
  it('parses spelled-out month', () => {
    expect(parseDateToISO('October 11, 1964')).toBe('1964-10-11')
    expect(parseDateToISO('March 1 2024')).toBe('2024-03-01')
  })
  it('parses ISO already', () => {
    expect(parseDateToISO('1964-10-11')).toBe('1964-10-11')
    expect(parseDateToISO('1964-10-11T00:00:00Z')).toBe('1964-10-11')
  })
  it('returns null for nonsense', () => {
    expect(parseDateToISO('')).toBeNull()
    expect(parseDateToISO(null)).toBeNull()
    expect(parseDateToISO('abc')).toBeNull()
  })
})

describe('isLikelyIdentifier', () => {
  it('accepts realistic Medicaid IDs', () => {
    expect(isLikelyIdentifier('ZECM15043724')).toBe(true)
    expect(isLikelyIdentifier('999888777')).toBe(true)
    expect(isLikelyIdentifier('ABC1234567')).toBe(true)
  })
  it('rejects narrative text', () => {
    expect(isLikelyIdentifier('Sample Client')).toBe(false)
    expect(isLikelyIdentifier('TennCare BlueCare')).toBe(false)
    expect(isLikelyIdentifier('1234')).toBe(false) // too short
  })
})

describe('detectMedicaidContext / detectMedicareContext', () => {
  it('flags TennCare', () => {
    expect(detectMedicaidContext('TennCare BlueCare member card')).toBe(true)
  })
  it('flags ECF CHOICES', () => {
    expect(detectMedicaidContext('Employment & Community First CHOICES enrollment')).toBe(true)
    expect(detectMedicaidContext('ECF CHOICES Notice of Action')).toBe(true)
  })
  it('flags HCBS waivers', () => {
    expect(detectMedicaidContext('Home and Community-Based Services waiver eligibility')).toBe(true)
  })
  it('flags MCO brands carrying state Medicaid', () => {
    expect(detectMedicaidContext('Amerigroup TennCare ID card')).toBe(true)
    expect(detectMedicaidContext('UnitedHealthcare Community Plan')).toBe(true)
    expect(detectMedicaidContext('Humana Healthy Horizons')).toBe(true)
  })
  it('flags Medicaid programs in other states', () => {
    expect(detectMedicaidContext('MassHealth eligibility notice')).toBe(true)
    expect(detectMedicaidContext('Medi-Cal Beneficiary Identification Card')).toBe(true)
    expect(detectMedicaidContext('Apple Health managed care')).toBe(true)
  })
  it('flags Medicare separately', () => {
    expect(detectMedicareContext('Medicare Part A and Part B')).toBe(true)
    expect(detectMedicareContext('MAPD plan enrollment')).toBe(true)
    expect(detectMedicaidContext('Medicare beneficiary')).toBe(false)
  })
  it('does not over-trigger on unrelated text', () => {
    expect(detectMedicaidContext('Application for state lottery winnings')).toBe(false)
    expect(detectMedicaidContext('')).toBe(false)
  })
})

describe('extractMedicalInsuranceHeuristics — TennCare BlueCare card', () => {
  const card = `
TennCare BlueCare
Member Name: SAMPLE CLIENT
Member ID: 999888777
Group No: 0001
RxBIN: 003858
Effective: 01/01/2024
Date of Birth: 10/11/1964
`
  it('captures the member ID', () => {
    const result = extractMedicalInsuranceHeuristics(card)
    expect(result.member_id).toBe('999888777')
  })
  it('captures plan_type=Medicaid via context', () => {
    const result = extractMedicalInsuranceHeuristics(card)
    expect(result.plan_type).toBe('Medicaid')
  })
  it('captures the brand as the insurance_provider', () => {
    const result = extractMedicalInsuranceHeuristics(card)
    expect(result.insurance_provider).toMatch(/BlueCare/i)
  })
  it('captures group_id from "Group No"', () => {
    const result = extractMedicalInsuranceHeuristics(card)
    expect(result.group_id).toBe('0001')
  })
  it('captures effective_date as ISO', () => {
    const result = extractMedicalInsuranceHeuristics(card)
    expect(result.effective_date).toBe('2024-01-01')
  })
})

describe('extractMedicalInsuranceHeuristics — ECF CHOICES award letter', () => {
  const letter = `
TENNESSEE DIVISION OF TENNCARE
Employment & Community First CHOICES Notice of Enrollment
Member: SAMPLE CLIENT
Recipient ID: ABC1234567
Effective Date: March 1, 2024
ECF CHOICES enrollment confirmed.
`
  it('captures member ID from "Recipient ID"', () => {
    const result = extractMedicalInsuranceHeuristics(letter)
    expect(result.member_id).toBe('ABC1234567')
  })
  it('flips plan_type to Medicaid', () => {
    const result = extractMedicalInsuranceHeuristics(letter)
    expect(result.plan_type).toBe('Medicaid')
  })
  it('captures effective_date from spelled-out month', () => {
    const result = extractMedicalInsuranceHeuristics(letter)
    expect(result.effective_date).toBe('2024-03-01')
  })
})

describe('extractMedicalInsuranceHeuristics — ECF CHOICES waiver text', () => {
  // Synthetic waiver-style text:
  //   "Medicaid Waiver Program (ECF CHOICES - TN). Medicaid number: ZECM15043724."
  const text = `
Member Name: ALEX SAMPLE
Medicaid Waiver Program (ECF CHOICES - TN). Medicaid number: ZECM15043724.
DOB: 08/19/1952
`
  it('captures the Medicaid number', () => {
    const result = extractMedicalInsuranceHeuristics(text)
    expect(result.member_id).toBe('ZECM15043724')
  })
  it('flips plan_type to Medicaid', () => {
    const result = extractMedicalInsuranceHeuristics(text)
    expect(result.plan_type).toBe('Medicaid')
  })
})

describe('extractMedicalInsuranceHeuristics — Amerigroup TennCare card', () => {
  const card = `
Amerigroup Community Care
TennCare Medicaid
Member: SAMPLE CLIENT
Member ID #  ABC123456789
Group #: 87654
DOB: 10/11/1964
`
  it('captures the long alphanumeric member ID', () => {
    const result = extractMedicalInsuranceHeuristics(card)
    expect(result.member_id).toBe('ABC123456789')
  })
  it('captures the group number', () => {
    const result = extractMedicalInsuranceHeuristics(card)
    expect(result.group_id).toBe('87654')
  })
  it('uses the MCO brand as insurance_provider', () => {
    const result = extractMedicalInsuranceHeuristics(card)
    expect(result.insurance_provider).toMatch(/Amerigroup/i)
  })
})

describe('extractMedicalInsuranceHeuristics — Medicaid eligibility notice (no card)', () => {
  const notice = `
Tennessee Department of Human Services
Medicaid Eligibility Notice
Recipient: ALEX SAMPLE
Medicaid Recipient ID: 9876543210
DOB: 01/15/1972
`
  it('captures member ID from "Medicaid Recipient ID"', () => {
    const result = extractMedicalInsuranceHeuristics(notice)
    expect(result.member_id).toBe('9876543210')
  })
})

describe('extractMedicalInsuranceHeuristics — empty / malformed input', () => {
  it('returns empty fields without throwing for empty input', () => {
    const result = extractMedicalInsuranceHeuristics('')
    expect(result).toEqual({
      insurance_provider: '',
      plan_name: '',
      plan_type: '',
      member_id: '',
      group_id: '',
      effective_date: '',
    })
  })
  it('does not invent a member_id when no labels are present', () => {
    const result = extractMedicalInsuranceHeuristics('Random unrelated text 12345')
    expect(result.member_id).toBe('')
  })
})

describe('extractBasicInformationHeuristics — DOB capture', () => {
  it('captures date_of_birth as ISO from "Date of Birth"', () => {
    const result = extractBasicInformationHeuristics(
      'Patient: Sample Client\nDate of Birth: 10/11/1964\nPhone: (555) 010-7777',
    )
    expect(result.date_of_birth).toBe('1964-10-11')
    expect(result.phone).toMatch(/5550107777|\(555\)\s*010[-.]?7777|555[-.\s]010[-.]?7777/)
  })
  it('captures DOB from "DOB" abbreviation', () => {
    const result = extractBasicInformationHeuristics('DOB: 08/19/1952')
    expect(result.date_of_birth).toBe('1952-08-19')
  })
  it('captures DOB from spelled-out month', () => {
    const result = extractBasicInformationHeuristics('Birth Date: October 11, 1964')
    expect(result.date_of_birth).toBe('1964-10-11')
  })
  it('returns empty date_of_birth when no DOB line present', () => {
    const result = extractBasicInformationHeuristics('Plain text with no DOB.')
    expect(result.date_of_birth).toBe('')
  })
})

describe('extractGovernmentAssistanceHeuristics', () => {
  it('flips medicaid_recipient_self for TennCare card text', () => {
    const result = extractGovernmentAssistanceHeuristics('TennCare BlueCare member ID 999888777')
    expect(result.medicaid_recipient_self).toBe(true)
    expect(result.other_programs).toMatch(/TennCare/i)
    expect(result.other_programs).toMatch(/BlueCare/i)
  })
  it('captures ECF CHOICES + HCBS waiver in other_programs', () => {
    const result = extractGovernmentAssistanceHeuristics(
      'Notice: Employment & Community First CHOICES — HCBS waiver enrollment confirmed.',
    )
    expect(result.medicaid_recipient_self).toBe(true)
    expect(result.other_programs).toMatch(/ECF CHOICES/i)
    expect(result.other_programs).toMatch(/HCBS Waiver/i)
  })
  it('flags Medicare separately from Medicaid', () => {
    const result = extractGovernmentAssistanceHeuristics('Medicare Part A and Part B beneficiary')
    expect(result.medicare_recipient_self).toBe(true)
    expect(result.medicaid_recipient_self).toBeUndefined()
  })
  it('flags SSI / SSDI / SNAP / Section 8 enrollment', () => {
    const result = extractGovernmentAssistanceHeuristics(
      'SSI award letter — recipient also enrolled in SNAP and Section 8 Housing Choice Voucher',
    )
    expect(result.ssi_recipient_self).toBe(true)
    expect(result.snap_recipient_self).toBe(true)
    expect(result.section8_recipient_self).toBe(true)
  })
  it('emits an EMPTY object on silent input — no false negatives (Mission rule: missing fields = neutral)', () => {
    const result = extractGovernmentAssistanceHeuristics('Generic letter with no benefit programs.')
    expect(result).toEqual({})
  })
})
