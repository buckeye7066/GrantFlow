import test from 'node:test'
import assert from 'node:assert/strict'

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
