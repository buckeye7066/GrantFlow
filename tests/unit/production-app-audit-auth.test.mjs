import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assessIdentityAndScope,
  assessProfileCaptures,
  isSuccessfulApiResponse,
} from '../../scripts/production-audit/app-audit.mjs'

const ok = (body = {}) => ({ status: 200, ok: true, body })

test('authenticated production evidence requires a 2xx non-admin identity with exact profile scope', () => {
  const exact = ok({
    user: { id: 'audit-user', is_admin: false },
    profiles: [{ id: 'profile-b' }, { id: 'profile-a' }],
  })
  assert.deepEqual(assessIdentityAndScope(exact, ['profile-a', 'profile-b']), {
    ok: true,
    reason: 'exact_non_admin_profile_scope',
    expected_profile_count: 2,
    actual_profile_count: 2,
  })

  assert.equal(assessIdentityAndScope({ status: 401, ok: false }, ['profile-a']).ok, false)
  assert.equal(assessIdentityAndScope({ status: 403, ok: false }, ['profile-a']).ok, false)
  assert.equal(assessIdentityAndScope(ok({ user: { id: 'u', is_admin: true }, profiles: [] }), []).ok, false)
  assert.equal(assessIdentityAndScope(exact, ['profile-a']).reason, 'auth_me_profile_scope_mismatch')
  assert.equal(assessIdentityAndScope(exact, ['profile-a', 'profile-b', 'profile-c']).ok, false)
})

test('profile evidence accepts only successful responses for every requested scoped read', () => {
  const complete = {
    profile_id: 'profile-a',
    funding_sources: ok([]),
    hamilton_tasks: ok([]),
    hamilton_readiness: ok({}),
    portal_sync_runs: ok([]),
  }
  assert.equal(assessProfileCaptures([complete], ['profile-a']).ok, true)

  const denied = { ...complete, hamilton_tasks: { status: 403, ok: false, body: { error: 'forbidden' } } }
  const assessment = assessProfileCaptures([denied], ['profile-a'])
  assert.equal(assessment.ok, false)
  assert.deepEqual(assessment.failures, [{
    profile_id: 'profile-a',
    endpoint: 'hamilton_tasks',
    status: 403,
    reason: 'authentication_or_scope_denied',
  }])
  assert.equal(isSuccessfulApiResponse({ status: 401, ok: false, body: {} }), false)
})

test('production audit uses cookie auth and CSRF-safe logout, never legacy localStorage bearer tokens', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/production-audit/app-audit.mjs'), 'utf8')
  assert.doesNotMatch(source, /grantflow:access-token/)
  assert.doesNotMatch(source, /localStorage\.getItem\([^)]*access-token/)
  assert.match(source, /fetch\('\/api\/auth\/logout',[\s\S]*?'X-Requested-With': 'XMLHttpRequest'/)
})
