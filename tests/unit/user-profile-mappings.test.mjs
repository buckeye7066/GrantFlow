import test from 'node:test'
import assert from 'node:assert/strict'

import { getDesignatedProfileForEmail } from '../../backend/config/userProfileMappings.js'

test('userProfileMappings: known user emails map to expected profile ids', () => {
  assert.equal(getDesignatedProfileForEmail('allmonkey915@gmail.com'), 'profile-avanell-leamon')
  assert.equal(getDesignatedProfileForEmail('oliviabeltran@gmail.com'), 'profile-olivia-beltran')
  assert.equal(getDesignatedProfileForEmail('isawstars08@yahoo.com'), 'profile-brian-client')
  assert.equal(getDesignatedProfileForEmail('holliet52@gmail.com'), 'profile-hollie-knox')
  assert.equal(getDesignatedProfileForEmail('angelikaps.rn@gmail.com'), '886debfb-aae3-4560-8a3e-69b098b2becc')
  assert.equal(getDesignatedProfileForEmail('pjandcrdasher@att.net'), '7b7484c6-391c-4fb9-950f-c47759ba9440')
  assert.equal(getDesignatedProfileForEmail('rdashermiller@gmail.com'), 'profile-rachel-miller')
})

test('userProfileMappings: mapping is case-insensitive and trims whitespace', () => {
  assert.equal(getDesignatedProfileForEmail('  ANGELIKAPS.RN@gmail.com '), '886debfb-aae3-4560-8a3e-69b098b2becc')
})

