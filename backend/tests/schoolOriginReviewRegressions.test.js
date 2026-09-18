import { it, expect } from 'vitest'
import { normalizeProfile } from '../services/profileNormalizer.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'
import { evaluateEligibility } from '../services/matchEngine.js'

const profile = { id: 'school-origin-review', primary_type: 'college_student', entity_type: 'individual', state: 'TN', needs: ['education'] }
const baseEducation = { is_student: true, high_school_name: 'Example High School', high_school_graduation_year: 2020 }
const sections = education => ({ basic_information: { state: 'TN', county: 'Bradley' }, education: { ...baseEducation, ...education } })
const opportunity = { id: 'school-origin-award', title: 'Community Education Scholarship', description: 'Scholarships are restricted to graduates of a public high school in Raleigh County.', application_url: 'https://example.org/apply', entity_types_allowed: ['individual'], need_types_supported: ['education'], is_national: true }
const evaluate = (education = {}, row = opportunity) => evaluateEligibility(normalizeProfile(profile, sections(education)), normalizeOpportunity(row))

it('merges adult applicant history field by field without replacing explicit unknowns', () => {
  const adult = { ...profile, primary_type: 'veteran' }
  const data = sections({ high_school_county: 'Raleigh', high_school_state: 'WV', high_school_type: 'public' })
  data.basic_information = { applicant_high_school_state: 'TN', applicant_high_school_type: '' }
  const merged = normalizeProfile(adult, data).schoolOrigin
  expect(merged).toMatchObject({ county: 'raleigh', state: 'TN', type: 'public', graduationYear: 2020 })

  data.basic_information.applicant_high_school_county = 'unknown'
  expect(normalizeProfile(adult, data).schoolOrigin.county).toBeNull()
})
it('keeps student precedence and never fills household applicant history from child education', () => {
  const data = sections({ high_school_county: 'Raleigh', high_school_type: 'public' })
  data.basic_information = { applicant_high_school_county: 'Bradley', applicant_high_school_type: 'private' }
  expect(normalizeProfile(profile, data).schoolOrigin).toMatchObject({ county: 'raleigh', type: 'public' })
  expect(normalizeProfile({ ...profile, primary_type: 'family' }, data).schoolOrigin)
    .toMatchObject({ county: 'bradley', type: 'private', graduationYear: null })
})
it.each([
  'This scholarship is available only to graduates of public high schools in Raleigh County.',
  'This award is open only to graduates of public high schools in Raleigh County.',
  'This program is restricted only to graduates of public high schools in Raleigh County.',
])('recognizes optional only in a mandatory school-origin clause: %s', description => {
  expect(evaluate({ high_school_county: 'Bradley', high_school_type: 'private' }, { ...opportunity, description }).eligible).toBe(false)
})
it.each([
  'Graduates of public high schools in Raleigh County receive preference.',
  'This scholarship is available only to organizations providing scholarships to graduates of public high schools in Raleigh County.',
  'This scholarship is available only to graduates of public high schools in Raleigh County or an adjacent county.',
])('does not make optional-only support bypass existing nonexclusive boundaries: %s', description => {
  expect(evaluate({ high_school_county: 'Bradley', high_school_type: 'private' }, { ...opportunity, description }).eligible).not.toBe(false)
})
