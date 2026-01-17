import test from 'node:test'
import assert from 'node:assert/strict'

import { getDesignatedProfileForEmail } from '../../backend/config/userProfileMappings.js'

test('userProfileMappings: known user emails map to expected profile ids', () => {
  assert.equal(getDesignatedProfileForEmail('allmonkey915@gmail.com'), 'profile-avanell-leamon')
  assert.equal(getDesignatedProfileForEmail('oliviabeltran@gmail.com'), 'profile-olivia-beltran')
  assert.equal(getDesignatedProfileForEmail('isawstars08@yahoo.com'), 'profile-brian-client')
  assert.equal(getDesignatedProfileForEmail('holliet52@gmail.com'), 'profile-hollie-knox')
  assert.equal(getDesignatedProfileForEmail('angelikaps.rn@gmail.com'), 'profile-angelika-ptak')
  assert.equal(getDesignatedProfileForEmail('pjandcrdasher@att.net'), 'profile-paul-jason-dasher')
  assert.equal(getDesignatedProfileForEmail('rdashermiller@gmail.com'), 'profile-rachel-miller')
  assert.equal(getDesignatedProfileForEmail('joshua.dasher@gmail.com'), 'profile-josh-dasher')
})

test('userProfileMappings: mapping is case-insensitive and trims whitespace', () => {
  assert.equal(getDesignatedProfileForEmail('  ANGELIKAPS.RN@gmail.com '), 'profile-angelika-ptak')
})

