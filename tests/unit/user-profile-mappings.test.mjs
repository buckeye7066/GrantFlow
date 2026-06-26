import test from 'node:test'
import assert from 'node:assert/strict'

import { getDesignatedProfileForEmail } from '../../backend/config/userProfileMappings.js'

test('userProfileMappings: known user emails map to expected profile ids', () => {
  assert.equal(getDesignatedProfileForEmail('client.avanell@example.invalid'), 'profile-avanell-leamon')
  assert.equal(getDesignatedProfileForEmail('client.olivia@example.invalid'), 'profile-olivia-beltran')
  assert.equal(getDesignatedProfileForEmail('client.brian@example.invalid'), 'profile-brian-client')
  assert.equal(getDesignatedProfileForEmail('client.hollie@example.invalid'), 'profile-hollie-knox')
  assert.equal(getDesignatedProfileForEmail('client.angelika@example.invalid'), 'profile-angelika-ptak')
  assert.equal(getDesignatedProfileForEmail('client.paul@example.invalid'), 'profile-paul-jason-dasher')
  assert.equal(getDesignatedProfileForEmail('client.rachel@example.invalid'), 'profile-rachel-miller')
  assert.equal(getDesignatedProfileForEmail('client.melissa@example.invalid'), 'profile-melissa-justus')
})

test('userProfileMappings: mapping is case-insensitive and trims whitespace', () => {
  assert.equal(getDesignatedProfileForEmail('  CLIENT.ANGELIKA@example.invalid '), 'profile-angelika-ptak')
})
