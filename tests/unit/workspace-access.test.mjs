import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OWNER_ADMIN_EMAIL,
  hasFullAdminWorkspace,
  usesSimplifiedWorkspace,
} from '../../src/lib/workspaceAccess.js'

test('canonical owner email keeps the full admin workspace', () => {
  assert.equal(hasFullAdminWorkspace({ email: OWNER_ADMIN_EMAIL }), true)
  assert.equal(hasFullAdminWorkspace({ primary_email: OWNER_ADMIN_EMAIL.toUpperCase() }), true)
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
