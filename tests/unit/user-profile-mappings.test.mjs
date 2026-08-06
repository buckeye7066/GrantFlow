import test from 'node:test'
import assert from 'node:assert/strict'

import { getDesignatedProfileForEmail } from '../../backend/config/userProfileMappings.js'

test('userProfileMappings: known user emails map to expected profile ids', () => {
  assert.equal(getDesignatedProfileForEmail('demo.senior-accessibility@example.invalid'), 'profile-demo-senior-accessibility')
  assert.equal(getDesignatedProfileForEmail('demo.wellness-business@example.invalid'), 'profile-demo-wellness-business')
  assert.equal(getDesignatedProfileForEmail('demo.veteran-community@example.invalid'), 'profile-demo-veteran-community')
  assert.equal(getDesignatedProfileForEmail('demo.caregiver-household@example.invalid'), 'profile-demo-caregiver-household')
  assert.equal(getDesignatedProfileForEmail('demo.healthcare-workforce@example.invalid'), 'profile-demo-healthcare-workforce')
  assert.equal(getDesignatedProfileForEmail('demo.workforce-training@example.invalid'), 'profile-demo-workforce-training')
  assert.equal(getDesignatedProfileForEmail('demo.education-support@example.invalid'), 'profile-demo-education-support')
  assert.equal(getDesignatedProfileForEmail('demo.general-support@example.invalid'), 'profile-demo-general-support')
})

test('userProfileMappings: mapping is case-insensitive and trims whitespace', () => {
  assert.equal(getDesignatedProfileForEmail('  DEMO.HEALTHCARE-WORKFORCE@example.invalid '), 'profile-demo-healthcare-workforce')
})
