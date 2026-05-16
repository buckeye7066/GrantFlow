import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getPageKey,
  buildSeenKey,
  resolveGuide,
} from '../../src/components/guidance/userStepCoachHelpers.js'

/**
 * Regression tests for src/components/guidance/UserStepCoach.jsx
 * (pure helpers only — the React effect is exercised in browser tests).
 *
 * These three helpers determine:
 *   1. Which guidance entry the coach looks up for a given URL.
 *   2. Whether the user has already seen that entry (localStorage key).
 *   3. The resolved (title/description/nextRoute) for static vs dynamic
 *      entries.
 *
 * The coach should never throw on bad input — a misbehaving guide entry
 * must silently produce no toast rather than blocking the route render.
 */

test('getPageKey: returns "Dashboard" for "/" and empty inputs', () => {
  assert.equal(getPageKey('/'), 'Dashboard')
  assert.equal(getPageKey(''), 'Dashboard')
  assert.equal(getPageKey(null), 'Dashboard')
  assert.equal(getPageKey(undefined), 'Dashboard')
})

test('getPageKey: first path segment with leading slashes stripped', () => {
  assert.equal(getPageKey('/Dashboard'), 'Dashboard')
  assert.equal(getPageKey('/MyProfiles'), 'MyProfiles')
  assert.equal(getPageKey('//DiscoverGrants'), 'DiscoverGrants')
})

test('getPageKey: ignores nested segments and query strings (already stripped by useLocation)', () => {
  assert.equal(getPageKey('/Pipeline/123'), 'Pipeline')
  assert.equal(getPageKey('/ProfileDetail/abc/edit'), 'ProfileDetail')
})

test('buildSeenKey: namespaces by page + profile + version', () => {
  const key = buildSeenKey('Dashboard', 'profile-123')
  assert.equal(key, 'grantflow:guidance:seen:Dashboard:profile-123:v1')
})

test('buildSeenKey: collapses admin sentinel + null/empty to "none"', () => {
  assert.equal(
    buildSeenKey('Pipeline', '__admin__'),
    'grantflow:guidance:seen:Pipeline:none:v1',
    'admin sentinel must collapse so admins do not see a per-profile re-trigger storm',
  )
  assert.equal(
    buildSeenKey('Pipeline', null),
    'grantflow:guidance:seen:Pipeline:none:v1',
  )
  assert.equal(
    buildSeenKey('Pipeline', ''),
    'grantflow:guidance:seen:Pipeline:none:v1',
  )
})

test('buildSeenKey: different profiles get different keys (re-fire on profile switch)', () => {
  const a = buildSeenKey('MyProfiles', 'profile-a')
  const b = buildSeenKey('MyProfiles', 'profile-b')
  assert.notEqual(a, b)
})

test('resolveGuide: static object passes through', () => {
  const r = resolveGuide(
    { title: 'Hi', description: 'There' },
    { profiles: [], activeProfileId: null },
  )
  assert.deepEqual(r, { title: 'Hi', description: 'There' })
})

test('resolveGuide: function form receives ctx and is called', () => {
  let receivedCtx = null
  const r = resolveGuide(
    (ctx) => {
      receivedCtx = ctx
      return { title: 'Dynamic', description: 'OK' }
    },
    { profiles: [{ id: 'p1' }], activeProfileId: 'p1' },
  )
  assert.deepEqual(r, { title: 'Dynamic', description: 'OK' })
  assert.deepEqual(receivedCtx.profiles, [{ id: 'p1' }])
  assert.equal(receivedCtx.activeProfileId, 'p1')
})

test('resolveGuide: function that throws returns null (does not crash the coach)', () => {
  const r = resolveGuide(
    () => {
      throw new Error('boom')
    },
    {},
  )
  assert.equal(r, null)
})

test('resolveGuide: null / empty / non-object inputs return null', () => {
  assert.equal(resolveGuide(null, {}), null)
  assert.equal(resolveGuide(undefined, {}), null)
  assert.equal(resolveGuide('not an object', {}), null)
  assert.equal(resolveGuide(42, {}), null)
})

test('resolveGuide: result with neither title nor description returns null', () => {
  assert.equal(resolveGuide({ unrelated: 'stuff' }, {}), null)
  assert.equal(resolveGuide(() => ({}), {}), null)
})

test('resolveGuide: result with only a title is allowed', () => {
  const r = resolveGuide({ title: 'Title only' }, {})
  assert.deepEqual(r, { title: 'Title only' })
})

test('resolveGuide: result with only a description is allowed', () => {
  const r = resolveGuide({ description: 'Description only' }, {})
  assert.deepEqual(r, { description: 'Description only' })
})
