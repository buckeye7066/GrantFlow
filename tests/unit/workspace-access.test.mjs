import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasFullAdminWorkspace,
  usesSimplifiedWorkspace,
} from '../../src/lib/workspaceAccess.js'

test('an email address alone never grants the full admin workspace', () => {
  assert.equal(hasFullAdminWorkspace({ email: 'admin@example.invalid' }), false)
  assert.equal(hasFullAdminWorkspace({ primary_email: 'ADMIN@example.invalid' }), false)
})

test('recognized admin shapes keep the full workspace', () => {
  assert.equal(hasFullAdminWorkspace({ is_admin: true }), true)
  assert.equal(hasFullAdminWorkspace({ isAdmin: true }), true)
  assert.equal(hasFullAdminWorkspace({ role: 'admin' }), true)
  assert.equal(hasFullAdminWorkspace({ roles: ['user', 'admin'] }), true)
})

test('ordinary users receive the simplified workspace', () => {
  const user = { email: 'member@example.org', role: 'user' }
  assert.equal(hasFullAdminWorkspace(user), false)
  assert.equal(usesSimplifiedWorkspace(user), true)
})

test('missing user is neither admin nor a simplified signed-in user', () => {
  assert.equal(hasFullAdminWorkspace(null), false)
  assert.equal(usesSimplifiedWorkspace(null), false)
})

// GET /api/auth/me answers with { user, profiles, active_profile_id } for every
// DB-backed login (the flat { role } shape is only the legacy synthetic
// ADMIN_TOKEN path). Dashboard passes that envelope straight in; before the
// unwrap fix the policy read the envelope's (absent) top-level fields and the
// OWNER saw the simplified end-user workspace.
test('an /api/auth/me envelope resolves the admin from its nested user record', () => {
  const envelope = {
    user: { id: 'u1', primary_email: 'someone@example.org', is_admin: true },
    profiles: [],
    active_profile_id: null,
  }
  assert.equal(hasFullAdminWorkspace(envelope), true)
  assert.equal(usesSimplifiedWorkspace(envelope), false)
})

test('an /api/auth/me envelope for an ordinary member stays simplified', () => {
  const envelope = {
    user: { id: 'u2', primary_email: 'member@example.org', is_admin: false },
    profiles: [{ id: 'p1' }],
    active_profile_id: 'p1',
  }
  assert.equal(hasFullAdminWorkspace(envelope), false)
  assert.equal(usesSimplifiedWorkspace(envelope), true)
})

test('an email-only user inside an envelope stays simplified', () => {
  const envelope = { user: { primary_email: 'admin@example.invalid' }, profiles: [] }
  assert.equal(hasFullAdminWorkspace(envelope), false)
})
