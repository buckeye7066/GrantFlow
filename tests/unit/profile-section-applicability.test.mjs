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
  ORGANIZATION_DETAILS_TYPES,
  NONPROFIT_COMPLIANCE_TYPES,
  SMALL_BUSINESS_DETAILS_TYPES,
} from '../../shared/profileSectionApplicability.js'
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
