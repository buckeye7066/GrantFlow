import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeRequestedScope,
  resolveUniqueProfileIds,
} from '../../scripts/production-audit/resolve-profile-scope.mjs'

test('production audit scope requires exactly one explicit selector', () => {
  assert.throws(() => normalizeRequestedScope({}), /exactly one/)
  assert.throws(
    () => normalizeRequestedScope({ profileIds: 'profile-1', profileNames: 'Anastasia' }),
    /exactly one/,
  )
  assert.deepEqual(normalizeRequestedScope({ profileNames: ' Anastasia ' }), {
    ids: [],
    names: ['Anastasia'],
  })
})

test('production audit scope resolves one exact active profile without exposing alternatives', () => {
  assert.deepEqual(resolveUniqueProfileIds(['Anastasia'], [
    { id: 'profile-secret', display_name: 'anastasia' },
  ]), ['profile-secret'])
  assert.throws(() => resolveUniqueProfileIds(['Anastasia'], []), /No active non-synthetic profile/)
  assert.throws(() => resolveUniqueProfileIds(['Anastasia'], [
    { id: 'one', display_name: 'Anastasia' },
    { id: 'two', display_name: 'ANASTASIA' },
  ]), /ambiguous/)
})
