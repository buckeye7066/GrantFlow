/**
 * Regression test for the `/api/profiles/__admin__ 404` reported on the
 * Documents page after admin login.
 *
 * Background
 * ----------
 * `__admin__` is a UI-only sentinel produced by `src/stores/authStore.js`
 * (and `src/pages/Layout.jsx`) to represent the admin "view all" mode in
 * the sidebar. It is NOT a row in the `profiles` table — there is no
 * server route that resolves it. Yet the Documents page initialized
 * `selectedProfileId = activeProfileId ?? null` and then immediately fired
 * `GET /api/profiles/__admin__`, which 404'd and surfaced as a red console
 * error to the user.
 *
 * The boundary helper `assertRealProfileId` (in
 * `src/api/profileIdGuards.js`) refuses to issue any /api/profiles/<sentinel>
 * request, throwing a tagged error instead. That way every future caller —
 * pages we have already fixed (Documents) and pages we have not — fails
 * fast with a developer-visible message rather than silently 404ing in
 * the user's face.
 *
 * The test imports the pure boundary module directly (no Vite, no
 * network) and pins the contract.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADMIN_PROFILE_SENTINEL,
  isRealProfileId,
  assertRealProfileId,
  resolveProfileIdForApi,
} from '../../src/api/profileIdGuards.js'

test('isRealProfileId returns false for the __admin__ sentinel', () => {
  assert.equal(isRealProfileId(ADMIN_PROFILE_SENTINEL), false)
  assert.equal(isRealProfileId('__admin__'), false)
})

test('isRealProfileId returns false for null / undefined / empty string / non-string types', () => {
  for (const fixture of [null, undefined, '', {}, [], false, NaN]) {
    assert.equal(isRealProfileId(fixture), false, `expected false for ${JSON.stringify(fixture)}`)
  }
})

test('isRealProfileId returns true for normal UUIDs and numeric ids', () => {
  assert.equal(isRealProfileId('76baea14-cd1f-4ed8-9c3b-9758e34ef036'), true)
  assert.equal(isRealProfileId(42), true)
  assert.equal(isRealProfileId('any-non-empty-string'), true)
})

test('assertRealProfileId throws INVALID_PROFILE_ID for the __admin__ sentinel', () => {
  assert.throws(
    () => assertRealProfileId(ADMIN_PROFILE_SENTINEL, 'getProfile'),
    (err) => {
      assert.equal(err.code, 'INVALID_PROFILE_ID')
      assert.match(err.message, /__admin__/, 'must include the offending id in the error message')
      assert.match(err.message, /getProfile/, 'must include the calling function name')
      return true
    },
  )
})

test('assertRealProfileId throws for null / undefined / empty string', () => {
  for (const fixture of [null, undefined, '']) {
    assert.throws(
      () => assertRealProfileId(fixture, 'getProfile'),
      (err) => err.code === 'INVALID_PROFILE_ID',
      `expected INVALID_PROFILE_ID for ${JSON.stringify(fixture)}`,
    )
  }
})

test('assertRealProfileId is a no-op for valid ids', () => {
  assert.doesNotThrow(() => assertRealProfileId('uuid-here', 'getProfile'))
  assert.doesNotThrow(() => assertRealProfileId(42, 'getProfile'))
})

test('resolveProfileIdForApi skips sentinel and picks first real id', () => {
  assert.equal(resolveProfileIdForApi('__admin__', null, 'profile-abc'), 'profile-abc')
  assert.equal(resolveProfileIdForApi('profile-xyz'), 'profile-xyz')
  assert.equal(resolveProfileIdForApi('__admin__', ''), null)
})
