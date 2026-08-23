/**
 * Unit guards for the portal-fill precision fixes measured in prod 2026-08-22:
 * address-blob splitting, state spelling alternates, grounded eligibility
 * verdicts, filter-button exclusion, and drop-down answering that can only
 * pick a real option on real evidence.
 */
import { describe, it, expect } from 'vitest'
import {
  parseAddressBlob, stateValueAlternates, deriveEligibilityFacts,
  eligibilityAffirmationVerdict, SUBMIT_BUTTON_EXCLUDE_RX,
} from '../services/hamilton/hamiltonAutopilotEngine.js'
import { isAnswerableUnknownField, answerUnknownField } from '../services/hamilton/hamiltonFieldAnswerer.js'

describe('parseAddressBlob', () => {
  it('splits the live "street \\n City, ST 12345" blob', () => {
    expect(parseAddressBlob('3940 Eveningside Dr. NE \nCleveland, TN 37312')).toEqual({
      street: '3940 Eveningside Dr. NE', city: 'Cleveland', state: 'TN', zip: '37312',
    })
  })
  it('handles comma-separated and ZIP+4 forms', () => {
    expect(parseAddressBlob('12 Oak St, Apt 4, Knoxville, TN 37902-1234')).toEqual({
      street: '12 Oak St, Apt 4', city: 'Knoxville', state: 'TN', zip: '37902',
    })
  })
  it('leaves anything without the unambiguous tail alone', () => {
    expect(parseAddressBlob('3940 Eveningside Dr. NE')).toBeNull()
    expect(parseAddressBlob('Cleveland TN')).toBeNull()
    expect(parseAddressBlob('1 Main St\nToronto, ON M5V 1A1')).toBeNull()
    expect(parseAddressBlob('')).toBeNull()
    expect(parseAddressBlob(null)).toBeNull()
  })
})

describe('stateValueAlternates', () => {
  it('TN <-> Tennessee in both directions, never a guess for unknowns', () => {
    expect(stateValueAlternates('TN')).toEqual(['TN', 'Tennessee'])
    expect(stateValueAlternates('tennessee')).toEqual(['tennessee', 'TN'])
    expect(stateValueAlternates('Narnia')).toEqual(['Narnia'])
    expect(stateValueAlternates('')).toEqual([])
  })
})

describe('eligibility affirmations are grounded in DECLARED facts', () => {
  const COLLEGE_BOUND = 'I am a college-bound student, accepted or enrolled at an undergraduate, trade or vocational school as of September 1, 2027.'
  const NOT_GRAD = 'I am not a graduate student, an international student, or a student attending a college outside the U.S.'
  const CITIZEN = 'I am a U.S. citizen or legal permanent resident.'

  const undergrad = deriveEligibilityFacts(
    { applicant_type: 'student' },
    { school: 'Middle Tennessee State University', degree_level: "Bachelor's", state: 'TN', zip: '37312' },
  )
  const graduate = deriveEligibilityFacts(
    { applicant_type: 'student' },
    { school: 'Vanderbilt', degree_level: 'PhD', state: 'TN' },
  )
  const nobody = deriveEligibilityFacts({}, {})

  it('an enrolled U.S. undergraduate PROVES the enrollment + not-graduate statements', () => {
    expect(eligibilityAffirmationVerdict(COLLEGE_BOUND, undergrad)).toBe(true)
    expect(eligibilityAffirmationVerdict(NOT_GRAD, undergrad)).toBe(true)
  })
  it('a graduate student CONTRADICTS them', () => {
    expect(eligibilityAffirmationVerdict(COLLEGE_BOUND, graduate)).toBe(false)
    expect(eligibilityAffirmationVerdict(NOT_GRAD, graduate)).toBe(false)
  })
  it('a profile that declares nothing settles nothing (null, never a tick)', () => {
    expect(nobody.known).toBe(false)
    expect(eligibilityAffirmationVerdict(COLLEGE_BOUND, nobody)).toBeNull()
    expect(eligibilityAffirmationVerdict(NOT_GRAD, nobody)).toBeNull()
    expect(eligibilityAffirmationVerdict(CITIZEN, undergrad)).toBeNull() // immigration status not declared
  })
  it('citizenship is read only from the declared immigration status', () => {
    const citizen = deriveEligibilityFacts({ demographics: { immigrant_status: 'us_citizen' } }, {})
    const resident = deriveEligibilityFacts({ demographics: { immigrant_status: 'permanent_resident' } }, {})
    const undocumented = deriveEligibilityFacts({ demographics: { immigrant_status: 'undocumented' } }, {})
    expect(eligibilityAffirmationVerdict('I am a U.S. citizen.', citizen)).toBe(true)
    expect(eligibilityAffirmationVerdict('I am a U.S. citizen.', resident)).toBe(false)
    expect(eligibilityAffirmationVerdict(CITIZEN, resident)).toBe(true)
    expect(eligibilityAffirmationVerdict(CITIZEN, undocumented)).toBe(false)
  })
  it('an unrelated statement is never affirmed', () => {
    expect(eligibilityAffirmationVerdict('I own a small business in Ohio.', undergrad)).toBeNull()
  })
})

describe('SUBMIT_BUTTON_EXCLUDE_RX', () => {
  it('excludes filter / search / feedback submits and keeps application submits', () => {
    for (const t of ['Submit all selections', 'Submit search', 'Submit query', 'Submit feedback', 'Submit a question']) {
      expect(SUBMIT_BUTTON_EXCLUDE_RX.test(t), t).toBe(true)
    }
    for (const t of ['Submit', 'Submit and continue', 'Submit application', 'Submit my application']) {
      expect(SUBMIT_BUTTON_EXCLUDE_RX.test(t), t).toBe(false)
    }
  })
})

describe('drop-down answering', () => {
  const PROFILE = { basic_information: { first_name: 'Jane' }, financial_information: { bank_customer_of: 'U.S. Bank' } }
  const field = { tag: 'select', name: 'client', label: 'Are you a U.S. Bank client?', options: ['Select one', 'Yes', 'No'] }
  const llm = (json) => ({ invokeJson: async () => ({ ok: true, json }) })

  it('a select with options is answerable; one without is not', () => {
    expect(isAnswerableUnknownField(field)).toBe(true)
    expect(isAnswerableUnknownField({ tag: 'select', label: 'x' })).toBe(false)
    expect(isAnswerableUnknownField({ tag: 'select', label: 'x', options: [] })).toBe(false)
  })
  it("returns the portal's own option when the model anchors it to a real profile field", async () => {
    const r = await answerUnknownField(field, { profile: PROFILE, _deps: llm({ answer: 'Yes', grounded_in: ['financial_information.bank_customer_of'] }) })
    expect(r?.value).toBe('Yes')
  })
  it('refuses an answer that is not one of the options', async () => {
    const r = await answerUnknownField(field, { profile: PROFILE, _deps: llm({ answer: 'Probably', grounded_in: ['financial_information.bank_customer_of'] }) })
    expect(r).toBeNull()
  })
  it('refuses a bare "No" with nothing in the profile behind it - that is an ask, not an answer', async () => {
    const r = await answerUnknownField(field, { profile: PROFILE, _deps: llm({ answer: 'No', grounded_in: [] }) })
    expect(r).toBeNull()
    const r2 = await answerUnknownField(field, { profile: PROFILE, _deps: llm({ answer: 'No', grounded_in: ['demographics.nonexistent_field'] }) })
    expect(r2).toBeNull()
  })
})
