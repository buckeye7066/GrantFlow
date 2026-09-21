import test from 'node:test'
import assert from 'node:assert/strict'
import { profileContextToThesisInput } from '../../backend/services/crawlerOsPersistenceCore.js'
import { buildThesis } from '../../backend/crawler-os/profileIntelligence.js'

import {
  inferProfileTypeFromDisplayName,
  resolveEffectiveProfileType,
  getProfileTypeDisplayLabel,
} from '../../backend/services/profileHelpers.js'

test('inferProfileTypeFromDisplayName detects church organizations from name', () => {
  assert.equal(
    inferProfileTypeFromDisplayName('Church of God of Prophecy International Offices'),
    'church',
  )
})

test('resolveEffectiveProfileType prefers section profile_type over generic individual', () => {
  const resolved = resolveEffectiveProfileType(
    { display_name: 'Example Org', primary_type: 'individual' },
    { basic_information: { profile_type: 'church' } },
  )
  assert.equal(resolved, 'church')
})

test('resolveEffectiveProfileType infers church from display name when stored type is generic', () => {
  const resolved = resolveEffectiveProfileType(
    {
      display_name: 'Church of God of Prophecy International Offices',
      primary_type: 'individual',
    },
    {},
  )
  assert.equal(resolved, 'church')
})

test('getProfileTypeDisplayLabel returns registry label for church', () => {
  assert.equal(getProfileTypeDisplayLabel('church'), 'Church')
})

test('a descriptive organization label cannot erase a declared small business and trigger government routing', () => {
  const profile = { display_name: 'Example Wellness', primary_type: 'small_business' }
  const sections = {
    organization_details: { organization_type: 'Holistic wellness collective' },
    location_focus: { geographic_focus: 'Beaver County, Pennsylvania' },
    family_life: { family_caregiver: true },
    narrative: { primary_goal: 'Expand wellness services and upgrade equipment.' },
  }
  const effective = resolveEffectiveProfileType(profile, sections)
  assert.equal(effective, 'business') // Registry canonical form of small_business.
  const thesis = buildThesis(profileContextToThesisInput({ profile: { ...profile, primary_type: effective }, sections }))
  assert.ok(thesis.applicant_types.includes('business'))
  assert.ok(!thesis.applicant_types.includes('government'))
  assert.ok(!thesis.applicant_types.includes('family'))
})

test('an unregistered descriptive type remains available when no specific registered identity exists', () => {
  assert.equal(resolveEffectiveProfileType({ primary_type: 'organization' }, {
    organization_details: { organization_type: 'Biotechnology / research organization' },
  }), 'Biotechnology / research organization')
})
