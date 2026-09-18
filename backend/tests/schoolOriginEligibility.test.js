import { describe, it, expect } from 'vitest'
import { normalizeProfile, computeProfileFingerprint } from '../services/profileNormalizer.js'
import { normalizeOpportunity, computeOpportunityFingerprint } from '../services/opportunityNormalizer.js'
import { evaluateEligibility, computeMatchDecision } from '../services/matchEngine.js'

const profile = { id: 'school-origin-test', primary_type: 'individual', entity_type: 'individual', state: 'TN', needs: ['education'] }
const baseEducation = { is_student: true, high_school_name: 'Example High School', high_school_graduation_year: 2020 }
const sections = education => ({ basic_information: { state: 'TN', county: 'Bradley' }, education: { ...baseEducation, ...education } })
const requirement = 'Scholarships are restricted to graduates of a public high school in Raleigh County.'
const opportunity = { id: 'school-origin-award', title: 'Community Education Scholarship', description: requirement, application_url: 'https://example.org/apply', entity_types_allowed: ['individual'], need_types_supported: ['education'], is_national: true }
const evaluate = (education = {}, row = opportunity) => evaluateEligibility(normalizeProfile(profile, sections(education)), normalizeOpportunity(row))
const missing = result => result.missingFields.filter(field => field.startsWith('education.high_school_'))

describe('source-grounded high-school origin eligibility', () => {
  it('holds a declared school-area requirement at REVIEW when school history is missing', () => {
    const result = evaluate()
    expect(result.eligible).toBe('maybe')
    expect(missing(result)).toEqual(expect.arrayContaining(['education.high_school_county', 'education.high_school_type']))
    const decision = computeMatchDecision(profile, opportunity, { profileSections: sections() })
    expect(decision.decision).toBe('REVIEW')
    expect(decision.missingEligibilityFields).toContain('education.high_school_county')
    expect(decision.explanation).toMatch(/school/i)
  })
  it('honors graduation history even after the student moves to another state', () => {
    const result = evaluate({ high_school_county: 'Raleigh County', high_school_type: 'public' })
    expect(result.eligible).toBe(true)
    expect(missing(result)).toEqual([])
  })
  it('rejects an explicitly different graduation county, not a different home address', () => {
    const edu = { high_school_county: 'Bradley', high_school_type: 'public' }
    const result = evaluate(edu)
    expect(result.eligible).toBe(false)
    expect(result.ineligibilityReasons.join(' ')).toMatch(/Raleigh County/i)
    const localResident = { ...sections(edu), basic_information: { state: 'WV', county: 'Raleigh' } }
    expect(evaluateEligibility(normalizeProfile({ ...profile, state: 'WV' }, localResident), normalizeOpportunity(opportunity)).eligible).toBe(false)
  })
  it('does not replace a required public-school education with private-school history', () => {
    expect(evaluate({ high_school_county: 'Raleigh', high_school_type: 'private' }).eligible).toBe(false)
    expect(missing(evaluate({ high_school_county: 'Raleigh' }))).toContain('education.high_school_type')
  })
  it('does not infer high-school location from current residence or the college', () => {
    const data = { basic_information: { state: 'WV', county: 'Raleigh' }, education: { ...baseEducation, school_county: 'Raleigh', college_county: 'Raleigh' } }
    expect(missing(evaluateEligibility(normalizeProfile(profile, data), normalizeOpportunity(opportunity)))).toContain('education.high_school_county')
  })
  it('requires completed graduation evidence without hard-rejecting an upcoming graduate', () => {
    expect(missing(evaluate({ high_school_county: 'Raleigh', high_school_type: 'public', high_school_graduation_year: null }))).toContain('education.high_school_graduation_year')
    expect(evaluate({ high_school_county: 'Raleigh', high_school_type: 'public', high_school_graduation_year: 2099 }).eligible).toBe('maybe')
  })
  it.each(['eligibility_text', 'eligibility_bullets'])('reads the source requirement from %s', field => {
    const value = field === 'eligibility_bullets' ? JSON.stringify(['Must be a graduate of a public high school in Raleigh County.']) : requirement
    expect(missing(evaluate({}, { ...opportunity, description: 'Help with education.', [field]: value }))).toContain('education.high_school_county')
  })
  it('unwraps structured education answers without treating unknown text as evidence', () => {
    const norm = normalizeProfile(profile, { education: { answers: { ...baseEducation, high_school_county: 'unknown', high_school_type: 'unknown' } } })
    expect(missing(evaluateEligibility(norm, normalizeOpportunity(opportunity)))).toContain('education.high_school_county')
  })
  it.each([
    'Preference will be given to a graduate of a public high school in Raleigh County. All students may apply.',
    'Applicants need not be a graduate of a public high school in Raleigh County.',
    'The donor was a graduate of a public high school in Raleigh County. This scholarship supports education nationwide.',
    'Applicants may be graduates of a public high school in Raleigh County or surrounding counties.',
  ])('does not turn preferences, negations, biography or widened places into exclusivity: %s', description => {
    expect(missing(evaluate({}, { ...opportunity, description }))).toEqual([])
    expect(evaluate({ high_school_county: 'Bradley', high_school_type: 'private' }, { ...opportunity, description }).ineligibilityReasons).toEqual([])
  })
  it('honors an explicitly named school state without using current residence', () => {
    const row = { ...opportunity, description: requirement.replace('Raleigh County', 'Washington County, West Virginia') }
    expect(missing(evaluate({ high_school_county: 'Washington', high_school_type: 'public' }, row))).toContain('education.high_school_state')
    expect(evaluate({ high_school_county: 'Washington', high_school_type: 'public', high_school_state: 'TN' }, row).eligible).toBe(false)
    expect(evaluate({ high_school_county: 'Washington', high_school_type: 'public', high_school_state: 'WV' }, row).eligible).toBe(true)
  })
  it('changes fingerprints when eligibility-relevant school evidence changes', () => {
    expect(computeProfileFingerprint(normalizeProfile(profile, sections({ high_school_county: 'Raleigh' }))))
      .not.toBe(computeProfileFingerprint(normalizeProfile(profile, sections({ high_school_county: 'Bradley' }))))
    expect(computeOpportunityFingerprint(normalizeOpportunity(opportunity)))
      .not.toBe(computeOpportunityFingerprint(normalizeOpportunity({ ...opportunity, description: 'Education assistance for all students.' })))
  })
})

it('exposes unscored school-history inputs in both schema and editable profile metadata', async () => {
  const { PROFILE_SCHEMA } = await import('../config/profileSchema.js')
  const { SECTION_METADATA } = await import('../../src/config/sectionMetadata.js')
  for (const name of ['high_school_county', 'high_school_state', 'high_school_type']) {
    expect(PROFILE_SCHEMA.education.fields[name]?.scored).toBe(false)
    const field = SECTION_METADATA.education.fields.find(item => item.name === name)
    expect(field?.scored).toBe(false)
    expect(field?.label).toBeTruthy()
    expect(field?.help).toBeTruthy()
  }
})
it('does not turn an old recipient biography into a current applicant requirement', () => {
  const row = { ...opportunity, description: 'Last year this scholarship was awarded to a graduate of a public high school in Raleigh County. All students are welcome to apply this year.' }
  expect(missing(evaluate({}, row))).toEqual([])
  expect(evaluate({ high_school_county: 'Bradley', high_school_type: 'private' }, row).eligible).toBe(true)
})
it('reports source-grounded school restrictions in its eligibility evidence classification', async () => {
  const { eligibilityEvidenceLevel, ELIGIBILITY_EVIDENCE } = await import('../services/matchEngine.js')
  expect(eligibilityEvidenceLevel(opportunity, normalizeOpportunity(opportunity))).toBe(ELIGIBILITY_EVIDENCE.STRUCTURED_FLAGS)
})
it('does not let missing school history mask independent hard ineligibility', () => {
  const decision = computeMatchDecision(profile, { ...opportunity, requires_veteran: true, deadline: '2001-01-01' }, { profileSections: sections() })
  expect(decision.decision).toBe('REJECT')
})

it('handles the actual stored county-before-school eligibility wording', () => {
  // Public catalog read-back, 2026-09-18T01:52Z; no applicant data.
  const row = { ...opportunity, description: 'Need and merit scholarship.', eligibility_text: 'for Raleigh County, WV high school graduates continuing their education at any accredited vocational school, college or university' }
  expect(missing(evaluate({}, row))).toEqual(expect.arrayContaining(['education.high_school_county', 'education.high_school_state']))
  expect(evaluate({ high_school_county: 'Bradley', high_school_state: 'TN' }, row).eligible).toBe(false)
  expect(evaluate({ high_school_county: 'Raleigh', high_school_state: 'WV' }, row).eligible).toBe(true)
  // The stored row does not say public; that must not be invented from the funder's location.
  expect(missing(evaluate({}, row))).not.toContain('education.high_school_type')
})
it.each([
  'Preference is for Raleigh County, WV high school graduates.',
  'The previous award was for Raleigh County, WV high school graduates. This year all students may apply.',
  'Open to graduates of a public high school in Raleigh County or an adjacent county.',
])('keeps softer and alternative source wording reviewable without school exclusivity: %s', description => {
  expect(missing(evaluate({}, { ...opportunity, description }))).toEqual([])
})

it('does not hard-reject verified school history because the funder state differs from current residence', () => {
  const row = { ...opportunity, state: 'WV', is_national: false, description: 'Scholarships are restricted to graduates of a public high school in Raleigh County, West Virginia.' }
  const decision = computeMatchDecision(profile, row, { profileSections: sections({ high_school_county: 'Raleigh', high_school_state: 'WV', high_school_type: 'public' }) })
  expect(decision.decision).not.toBe('REJECT')
  expect(decision.missingEligibilityFields.filter(field => field.startsWith('education.high_school_'))).toEqual([])
})

describe('direct makeDecision compatibility and hard-gate priority', () => {
  const student = { ...profile, primary_type: 'college_student' }
  it('handles a direct caller without a normalized profile or school requirement', async () => {
    const { makeDecision } = await import('../services/matchEngine.js')
    expect(() => makeDecision(90, student, { ...opportunity, description: 'Education assistance for students.' })).not.toThrow()
  })
  it('uses supplied school sections when the caller has not normalized the profile', async () => {
    const { makeDecision } = await import('../services/matchEngine.js')
    const data = sections({ high_school_county: 'Raleigh', high_school_state: 'WV', high_school_type: 'public' })
    const result = makeDecision(90, student, opportunity, null, null, null, data)
    expect(result.decision).toBe('ACCEPT')
    expect(result.reasons.join(' ')).not.toMatch(/School-origin eligibility unconfirmed/)
  })
  it('keeps an unconfirmed direct school-history caller at REVIEW without throwing', async () => {
    const { makeDecision } = await import('../services/matchEngine.js')
    const result = makeDecision(90, student, opportunity, null, null, null, sections())
    expect(result.decision).toBe('REVIEW')
    expect(result.reasons.join(' ')).toMatch(/education.high_school_county/)
  })
  it('rejects a direct caller with a stated contradictory graduation county', async () => {
    const { makeDecision } = await import('../services/matchEngine.js')
    const result = makeDecision(90, student, opportunity, null, null, null, sections({ high_school_county: 'Bradley', high_school_type: 'public' }))
    expect(result.decision).toBe('REJECT')
    expect(result.explanation).toMatch(/Raleigh County/i)
  })
  it('does not let missing school facts bypass a known exclusive residency mismatch', async () => {
    const { makeDecision } = await import('../services/matchEngine.js')
    const row = { ...opportunity, state: 'WV', is_national: false, state_residents_only: true }
    const data = sections()
    const result = makeDecision(90, student, row, normalizeProfile(student, data), null, null, data)
    expect(result.decision).toBe('REJECT')
    expect(result.explanation).toMatch(/Geographic mismatch/)
  })
})

it.each(['education_information', 'student'])('reads explicit completed school history from legacy %s sections', sectionName => {
  const norm = normalizeProfile(profile, { [sectionName]: { ...baseEducation, high_school_county: 'Bradley', high_school_type: 'public' } })
  expect(evaluateEligibility(norm, normalizeOpportunity(opportunity)).eligible).toBe(false)
})
it('retains a current restriction when the fund establishment date is historical', () => {
  const row = { ...opportunity, description: 'The fund was established in 2000 and is available to graduates of public high schools in Raleigh County.' }
  expect(evaluate({ high_school_county: 'Bradley', high_school_type: 'public' }, row).eligible).toBe(false)
})
it.each([
  'Open to graduates of a public high school in Raleigh County, WV, or an adjacent county.',
  'Open to graduates of a public high school in Raleigh County, West Virginia, or an adjacent county.',
])('preserves an alternative after a comma-delimited school state: %s', description => {
  expect(missing(evaluate({}, { ...opportunity, description }))).toEqual([])
  expect(evaluate({ high_school_county: 'Fayette', high_school_state: 'WV', high_school_type: 'public' }, { ...opportunity, description }).eligible).toBe(true)
})
it('does not apply beneficiary school history to an organizational applicant', () => {
  const row = { ...opportunity, entity_types_allowed: ['nonprofit'], description: 'Funding is available to nonprofit organizations providing scholarships to graduates of public high schools in Raleigh County.' }
  const nonprofit = normalizeProfile({ primary_type: 'nonprofit', entity_type: 'nonprofit', state: 'TN', needs: ['education'], is_nonprofit: true }, {})
  const result = evaluateEligibility(nonprofit, normalizeOpportunity(row))
  expect(missing(result)).toEqual([])
  expect(result.ineligibilityReasons.join(' ')).not.toMatch(/school/i)
})

it.each([
  'Graduates of public high schools in Raleigh County receive preference.',
  'Graduates of public high schools in Raleigh County are preferred, but all students may apply.',
  'Graduates of public high schools in Raleigh County, WV receive preference.',
])('does not turn a trailing preference into exclusive eligibility: %s', eligibility_text => {
  const row = { ...opportunity, description: 'Education assistance.', eligibility_text }
  expect(missing(evaluate({}, row))).toEqual([])
  expect(evaluate({ high_school_county: 'Bradley', high_school_type: 'private' }, row).eligible).toBe(true)
})
it('enforces explicit leading-only eligibility without misreading may-apply as optional', () => {
  const row = { ...opportunity, description: 'Only graduates of public high schools in Raleigh County may apply.' }
  expect(evaluate({ high_school_county: 'Bradley', high_school_type: 'public' }, row).eligible).toBe(false)
  expect(evaluate({ high_school_county: 'Raleigh', high_school_type: 'private' }, row).eligible).toBe(false)
  expect(evaluate({ high_school_county: 'Raleigh', high_school_type: 'public' }, row).eligible).toBe(true)
  expect(missing(evaluate({}, row))).toContain('education.high_school_county')
})
it.each(['Raleigh Co.', 'Raleigh Co', '  Raleigh   COUNTY.  '])('canonicalizes harmless county suffix formatting: %s', high_school_county => {
  expect(evaluate({ high_school_county, high_school_type: 'public' }).eligible).toBe(true)
})
it('keeps a mandatory school restriction when a later independent subject preference is stated', () => {
  const row = { ...opportunity, description: 'Only graduates of public high schools in Raleigh County may apply; preference is given to science majors.' }
  expect(evaluate({ high_school_county: 'Bradley', high_school_type: 'public' }, row).eligible).toBe(false)
})
