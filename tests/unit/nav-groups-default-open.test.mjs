import assert from 'node:assert/strict'
import test from 'node:test'

import { applyDefaultOpenGroups } from '../../src/nav/navGroupsDefaults.js'

const ADMIN_GROUP_IDS = ['home', 'setup', 'find', 'work', 'track', 'admin', 'help']

// The regression this policy exists for: after a logout wiped localStorage,
// an admin's sidebar rendered every group collapsed — My Profiles and the
// rest of the admin tabs invisible behind closed group headers.
test('a fresh browser with admin defaults opens every admin group', () => {
  const next = applyDefaultOpenGroups(new Set(), false, ADMIN_GROUP_IDS)
  assert.ok(next, 'expected a new open set')
  for (const id of ADMIN_GROUP_IDS) {
    assert.ok(next.has(id), `expected group "${id}" to be open`)
  }
})

test('bootstrap noise in storage does not block the defaults', () => {
  // The route effect auto-persists the active group before the user object
  // arrives, so "storage is non-empty" must not be read as a user choice.
  const next = applyDefaultOpenGroups(new Set(['home']), false, ADMIN_GROUP_IDS)
  assert.ok(next)
  assert.ok(next.has('setup'), 'setup (My Profiles) must open despite pre-seeded storage')
  assert.ok(next.has('home'), 'already-open groups stay open')
})

test('once the marker is seen, the user’s collapse choices are authoritative', () => {
  assert.equal(applyDefaultOpenGroups(new Set(['home']), true, ADMIN_GROUP_IDS), null)
})

test('no declared defaults (end-user nav) never changes anything', () => {
  assert.equal(applyDefaultOpenGroups(new Set(), false, null), null)
  assert.equal(applyDefaultOpenGroups(new Set(), false, []), null)
})

test('already-satisfied defaults report no change', () => {
  assert.equal(applyDefaultOpenGroups(new Set(ADMIN_GROUP_IDS), false, ADMIN_GROUP_IDS), null)
})
