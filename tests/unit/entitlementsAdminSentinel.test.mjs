/**
 * Regression: tier-gated routes (e.g. POST /api/ai/invoke) must not treat the
 * UI-only __admin__ sentinel as a real profile id — that produced 400
 * "Profile not found" when admins clicked "Find Picture with AI".
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveProfileId } from '../../backend/middleware/entitlements.js'

test('resolveProfileId ignores __admin__ sentinel from headers and body', () => {
  const req = {
    params: {},
    body: { profile_id: '__admin__' },
    query: {},
    ctx: {},
    headers: { 'x-profile-id': '__admin__' },
  }
  assert.equal(resolveProfileId(req), null)
})

test('resolveProfileId prefers real body profile_id over sentinel header', () => {
  const req = {
    params: {},
    body: { profile_id: 'profile-cleveland-band' },
    query: {},
    ctx: { activeProfileId: '__admin__' },
    headers: { 'x-profile-id': '__admin__' },
  }
  assert.equal(resolveProfileId(req), 'profile-cleveland-band')
})
