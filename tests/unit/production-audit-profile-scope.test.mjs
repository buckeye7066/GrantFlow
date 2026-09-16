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

test('production audit scope resolves one exact or unique first-name profile without exposing alternatives', () => {
  assert.deepEqual(resolveUniqueProfileIds(['Approved Profile Alpha'], [
    { id: 'profile-secret', display_name: 'approved profile alpha' },
  ]), ['profile-secret'])
  assert.deepEqual(resolveUniqueProfileIds(['Alexandra'], [
    { id: 'profile-secret', display_name: 'Alexandra Example' },
  ]), ['profile-secret'])
  assert.throws(() => resolveUniqueProfileIds(['Approved Profile Alpha'], []), /No active non-synthetic profile/)
  assert.throws(() => resolveUniqueProfileIds(['Approved Profile Alpha'], [
    { id: 'one', display_name: 'Approved Profile Alpha' },
    { id: 'two', display_name: 'APPROVED PROFILE ALPHA' },
  ]), /ambiguous/)
  assert.throws(() => resolveUniqueProfileIds(['Alexandra'], [
    { id: 'one', display_name: 'Alexandra Example' },
    { id: 'two', display_name: 'Alexandra Sample' },
  ]), /ambiguous/)
  assert.deepEqual(resolveUniqueProfileIds(['Alexandra'], [
    { id: 'exact', display_name: 'Alexandra' },
    { id: 'longer', display_name: 'Alexandra Example' },
  ]), ['exact'])
})

test('production audit workflow uses an expression context valid at job scope', () => {
  const workflow = fs.readFileSync('.github/workflows/production-audit.yml', 'utf8')
  assert.match(workflow, /PROFILE_SCOPE_FILE: \$\{\{ github\.workspace \}\}\/\.grantflow-production-audit-profile-scope/)
  assert.doesNotMatch(workflow, /PROFILE_SCOPE_FILE: \$\{\{ runner\./)
  assert.match(workflow, /GRANTFLOW_PROD_READY_URL: \$\{\{ inputs\.ready_url \}\}/)
  assert.match(workflow, /ready_url:\n(?:        .*\n)*?        required: true/)
})
