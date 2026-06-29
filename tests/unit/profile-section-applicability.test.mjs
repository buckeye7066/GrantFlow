/**
 * profile-section-applicability.test.mjs
 *
 * Mission goals #3 (use full profile) and #4 (support all profile types):
 * section visibility must follow profile type, including churches and corps.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isProfileTypeInList,
  sectionAppliesToProfileType,
  fieldAppliesToProfileType,
  isOrganizationProfileType,
  isPersonProfileType,
  isStudentProfileType,
  ORGANIZATION_DETAILS_TYPES,
  NONPROFIT_COMPLIANCE_TYPES,
  SMALL_BUSINESS_DETAILS_TYPES,
} from '../../shared/profileSectionApplicability.js'
import { PROFILE_TYPE_OPTIONS } from '../../shared/profileTypeOptions.js'
import { SECTION_METADATA } from '../../src/config/sectionMetadata.js'

function isProfileSectionApplicable(sectionKey, profile) {
  const config = SECTION_METADATA[sectionKey]
  if (!config) return true
  return sectionAppliesToProfileType(config, profile)
}

test('church profiles get organization and nonprofit compliance sections', () => {
  const churchProfile = { primary_type: 'church' }
  assert.equal(isProfileSectionApplicable('organization_details', churchProfile), true)
  assert.equal(isProfileSectionApplicable('nonprofit_compliance', churchProfile), true)
  assert.equal(isProfileSectionApplicable('small_business_details', churchProfile), false)
})

test('medium and large corporation profiles get business detail sections', () => {
  assert.equal(isProfileSectionApplicable('small_business_details', { primary_type: 'medium_corporation' }), true)
  assert.equal(isProfileSectionApplicable('small_business_details', { primary_type: 'large_corporation' }), true)
  assert.equal(isProfileSectionApplicable('organization_details', { primary_type: 'large_corporation' }), true)
})

test('family profiles do not get student-only education section by default', () => {
  assert.equal(isProfileSectionApplicable('education', { primary_type: 'family' }), false)
})

test('student profiles get education section', () => {
  assert.equal(isProfileSectionApplicable('education', { primary_type: 'high_school_student' }), true)
})

test('canonicalizeProfileTypeId resolves legacy small_business for business sections', () => {
  assert.equal(isProfileSectionApplicable('small_business_details', { primary_type: 'small_business' }), true)
})

test('type group constants include new corporation profile types', () => {
  assert.ok(ORGANIZATION_DETAILS_TYPES.includes('medium_corporation'))
  assert.ok(ORGANIZATION_DETAILS_TYPES.includes('church'))
  assert.ok(NONPROFIT_COMPLIANCE_TYPES.includes('ministry'))
  assert.ok(SMALL_BUSINESS_DETAILS_TYPES.includes('large_corporation'))
})

test('sectionAppliesToProfileType treats empty applies_to as universal', () => {
  assert.equal(sectionAppliesToProfileType({}, { primary_type: 'individual' }), true)
})

test('isProfileTypeInList returns false when type is missing', () => {
  assert.equal(isProfileTypeInList('', ORGANIZATION_DETAILS_TYPES), false)
  assert.equal(isProfileTypeInList(null, ORGANIZATION_DETAILS_TYPES), false)
})

// ── Person-only sections are hidden from organizations ──────────────────────
const PERSON_ONLY_SECTIONS = [
  'government_assistance',
  'health_medical',
  'demographics',
  'family_life',
  'military_service',
  'occupation',
  'employment',
  'housing',
  'family',
]

test('organizations do not get person-only sections', () => {
  for (const orgType of ['nonprofit', 'county_government', 'business', 'public_school']) {
    for (const sectionKey of PERSON_ONLY_SECTIONS) {
      assert.equal(
        isProfileSectionApplicable(sectionKey, { primary_type: orgType }),
        false,
        `${orgType} should NOT see person section "${sectionKey}"`,
      )
    }
    assert.equal(
      isProfileSectionApplicable('programs_services', { primary_type: orgType }),
      true,
      `${orgType} should see programs_services`,
    )
  }
})

test('people get person-only sections but not programs_services', () => {
  for (const personType of ['individual', 'veteran', 'family', 'college_student', 'senior']) {
    for (const sectionKey of PERSON_ONLY_SECTIONS) {
      assert.equal(
        isProfileSectionApplicable(sectionKey, { primary_type: personType }),
        true,
        `${personType} should see person section "${sectionKey}"`,
      )
    }
    assert.equal(
      isProfileSectionApplicable('programs_services', { primary_type: personType }),
      false,
      `${personType} should NOT see programs_services`,
    )
  }
})

test('explicit "other" sees all sections; a missing type shows only universal ones', () => {
  for (const sectionKey of [...PERSON_ONLY_SECTIONS, 'programs_services', 'organization_details', 'education']) {
    // "other" = explicit catch-all → never hide a section it might need.
    assert.equal(isProfileSectionApplicable(sectionKey, { primary_type: 'other' }), true)
    // No type yet (mid-onboarding) → type-constrained sections stay hidden.
    assert.equal(isProfileSectionApplicable(sectionKey, { primary_type: '' }), false)
  }
})

// ── Classification helpers ──────────────────────────────────────────────────
test('classification helpers recognise the full curated type list', () => {
  assert.equal(isOrganizationProfileType('nonprofit'), true)
  assert.equal(isOrganizationProfileType('county_government'), true)
  assert.equal(isOrganizationProfileType('museum'), true)
  assert.equal(isOrganizationProfileType('individual'), false)

  assert.equal(isPersonProfileType('veteran'), true)
  assert.equal(isPersonProfileType('college_student'), true)
  assert.equal(isPersonProfileType('nonprofit'), false)

  assert.equal(isStudentProfileType('graduate_student'), true)
  assert.equal(isStudentProfileType('individual'), false)
})

test('every curated profile type is classified as person or organization (no drift)', () => {
  for (const { id } of PROFILE_TYPE_OPTIONS) {
    if (id === 'other') continue
    assert.ok(
      isOrganizationProfileType(id) || isPersonProfileType(id),
      `Curated profile type "${id}" is classified as neither person nor organization`,
    )
  }
})

// ── Field-level applicability ───────────────────────────────────────────────
test('academic_status field is student-only; demographics field is person-only', () => {
  const academicField = SECTION_METADATA.basic_information.fields.find((f) => f.name === 'academic_status')
  const demoField = SECTION_METADATA.basic_information.fields.find((f) => f.name === 'demographics')
  assert.ok(academicField && demoField)

  assert.equal(fieldAppliesToProfileType(academicField, { primary_type: 'college_student' }), true)
  assert.equal(fieldAppliesToProfileType(academicField, { primary_type: 'nonprofit' }), false)
  assert.equal(fieldAppliesToProfileType(academicField, { primary_type: 'individual' }), false)

  assert.equal(fieldAppliesToProfileType(demoField, { primary_type: 'individual' }), true)
  assert.equal(fieldAppliesToProfileType(demoField, { primary_type: 'nonprofit' }), false)
})
