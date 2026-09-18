import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assessIdentityAndScope,
  assessProfileCaptures,
  isSuccessfulApiResponse,
  summarizeHamiltonPreflight,
} from '../../scripts/production-audit/app-audit.mjs'

const ok = (body = {}) => ({ status: 200, ok: true, body })

test('authenticated production evidence requires a 2xx non-admin identity containing the approved scope', () => {
  const exact = ok({
    user: { id: 'audit-user', is_admin: false },
    profiles: [{ id: 'profile-b' }, { id: 'profile-a' }],
  })
  assert.deepEqual(assessIdentityAndScope(exact, ['profile-a', 'profile-b']), {
    ok: true,
    reason: 'approved_non_admin_profile_scope',
    expected_profile_count: 2,
    actual_profile_count: 2,
  })

  assert.equal(assessIdentityAndScope({ status: 401, ok: false }, ['profile-a']).ok, false)
  assert.equal(assessIdentityAndScope({ status: 403, ok: false }, ['profile-a']).ok, false)
  assert.equal(assessIdentityAndScope(ok({ user: { id: 'u', is_admin: true }, profiles: [] }), []).ok, false)
  assert.deepEqual(assessIdentityAndScope(exact, ['profile-a']), {
    ok: true,
    reason: 'approved_non_admin_profile_scope',
    expected_profile_count: 1,
    actual_profile_count: 2,
  })
  assert.equal(assessIdentityAndScope(exact, ['profile-a', 'profile-b', 'profile-c']).ok, false)
  assert.equal(assessIdentityAndScope(exact, ['profile-c']).reason, 'auth_me_missing_approved_profile')
  assert.equal(assessIdentityAndScope(exact, []).reason, 'approved_profile_scope_required')
})

test('Hamilton production preflight reports readiness and blockers without treating them as transport failures', () => {
  assert.deepEqual(summarizeHamiltonPreflight(ok({
    ok: true,
    results: [{ ok: true, blockers: [] }, { ok: true, blockers: [] }],
  })), {
    http_status: 200,
    outcome: 'ready',
    source_count: 2,
    ready_source_count: 2,
    blocked_source_count: 0,
    blocker_count: 0,
    blocker_kind_counts: {},
    blocker_reason_counts: {},
  })

  assert.deepEqual(summarizeHamiltonPreflight(ok({
    ok: false,
    results: [
      { ok: true, blockers: [] },
      { ok: false, blockers: [
        { kind: 'missing_authorization', reasons: ['authorization_inactive', 'Profile title must not be logged'] },
        { code: 'missing_profile_fact', reasons: ['missing_field:income'] },
      ] },
    ],
  })), {
    http_status: 200,
    outcome: 'blocked',
    source_count: 2,
    ready_source_count: 1,
    blocked_source_count: 1,
    blocker_count: 2,
    blocker_kind_counts: {
      missing_authorization: 1,
      missing_profile_fact: 1,
    },
    blocker_reason_counts: {
      authorization_inactive: 1,
      'missing_field:income': 1,
    },
  })
  assert.equal(summarizeHamiltonPreflight({
    status: 409, ok: false, body: { error: 'no_ready_sources' },
  }).outcome, 'no_ready_sources')
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

test('production audit keeps its login bearer token in memory and uses CSRF-safe logout', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/production-audit/app-audit.mjs'), 'utf8')
  assert.doesNotMatch(source, /grantflow:access-token/)
  assert.doesNotMatch(source, /localStorage\.getItem\([^)]*access-token/)
  assert.match(source, /fetch\('\/api\/auth\/password\/login',[\s\S]*?credentials: 'include'/)
  assert.match(source, /globalThis\.__GRANTFLOW_AUDIT_ACCESS_TOKEN__/)
  assert.match(source, /fetch\('\/api\/auth\/logout',[\s\S]*?'X-Requested-With': 'XMLHttpRequest'/)
})

test('production audit uploads sanitized evidence before enforcing a browser-lane failure', () => {
  const workflow = fs.readFileSync('.github/workflows/production-audit.yml', 'utf8')
  assert.match(workflow, /id: application_audit\r?\n\s+continue-on-error: true/)
  assert.match(workflow, /name: Upload sanitized artifact[\s\S]+name: Enforce application audit result/)
  assert.match(workflow, /steps\.application_audit\.outcome != 'success'/)
})
