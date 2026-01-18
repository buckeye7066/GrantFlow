import test from 'node:test'
import assert from 'node:assert/strict'

import { isAdminEmail, ADMIN_EMAILS } from '../../backend/config/constants.js'

test('isAdminEmail: includes default operator email', () => {
  assert.ok(ADMIN_EMAILS.includes('buckeye7066@gmail.com'))
  assert.equal(isAdminEmail('buckeye7066@gmail.com'), true)
  assert.equal(isAdminEmail('  buckeye7066@gmail.com  '), true)
})

