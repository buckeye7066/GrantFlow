import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  normalizeRequestedScope,
  resolveUniqueProfileIds,
} from '../../scripts/production-audit/resolve-profile-scope.mjs'

test('production audit scope requires exactly one explicit selector', () => {
  assert.throws(() => normalizeRequestedScope({}), /exactly one/)
  assert.throws(
    () => normalizeRequestedScope({ profileIds: 'profile-1', profileNames: 'Approved Profile Alpha' }),
    /exactly one/,
  )
  assert.deepEqual(normalizeRequestedScope({ profileNames: ' Approved Profile Alpha ' }), {
    ids: [],
    names: ['Approved Profile Alpha'],
  })
})

test('production audit scope resolves one exact active profile without exposing alternatives', () => {
  assert.deepEqual(resolveUniqueProfileIds(['Approved Profile Alpha'], [
    { id: 'profile-secret', display_name: 'approved profile alpha' },
  ]), ['profile-secret'])
  assert.throws(() => resolveUniqueProfileIds(['Approved Profile Alpha'], []), /No active non-synthetic profile/)
  assert.throws(() => resolveUniqueProfileIds(['Approved Profile Alpha'], [
    { id: 'one', display_name: 'Approved Profile Alpha' },
    { id: 'two', display_name: 'APPROVED PROFILE ALPHA' },
  ]), /ambiguous/)
})

test('production audit workflow uses an expression context valid at job scope', () => {
  const workflow = fs.readFileSync('.github/workflows/production-audit.yml', 'utf8')
  assert.match(workflow, /PROFILE_SCOPE_FILE: \$\{\{ github\.workspace \}\}\/\.grantflow-production-audit-profile-scope/)
  assert.doesNotMatch(workflow, /PROFILE_SCOPE_FILE: \$\{\{ runner\./)
})
