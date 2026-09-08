import test from 'node:test'
import assert from 'node:assert/strict'
import { pickDashboardNextAction as next } from '../../src/lib/dashboardNextAction.js'
import { safeResumePath, resumeStorageKey } from '../../src/lib/resumePath.js'
import { readScopedNav, writeScopedNav, navPreferenceKey } from '../../src/nav/scopedNavPreferences.js'
import { shouldShowPageGuide } from '../../src/lib/pageGuideVisibility.js'
const base = { isSimplified: true, profileId: 'p1', completionPct: 80 }
const grant = { id: 'g1', profile_id: 'p1', title: 'Test source', status: 'drafting' }

test('attention and deadlines precede optional profile completion', () => {
  const attention = next({ ...base, completionPct: 1, urgentCount: 1, tasks: [{ id: 't1', profile_id: 'p1', status: 'waiting_for_missing_info' }] })
  assert.equal(attention.key, 'needs_you')
  assert.equal(attention.href, '/HamiltonTask/t1')
  const urgent = next({ ...base, completionPct: 1, urgentCount: 1, urgentGrants: [grant] })
  assert.equal(urgent.key, 'deadlines')
  assert.equal(urgent.params.grant_id, 'g1')
})
test('unfinished work resumes before optional profile questions', () => {
  assert.equal(next({ ...base, completionPct: 1, grants: [grant] }).key, 'continue_application')
  const queued = next({ ...base, tasks: [{ id: 't2', profile_id: 'p1', status: 'queued' }] })
  assert.match(queued.description, /queued, not confirmed to be running/)
})
test('profile action carries the exact section and profile', () => {
  const action = next({ ...base, completionPct: 1, nextSectionKey: 'narrative', nextSectionTitle: 'Story and goals' })
  assert.deepEqual(action.params, { id: 'p1', tab: 'profile', section: 'narrative' })
  assert.match(action.description, /Story and goals/)
})
test('loading and unavailable saves are never treated as an empty success', () => {
  assert.equal(next({ ...base, dataState: 'loading' }).key, 'loading')
  assert.equal(next({ ...base, dataState: 'error' }).key, 'load_error')
  for (const savedState of ['loading', 'error']) assert.equal(next({ ...base, savedState }).key, 'check_saved')
  assert.equal(next({ ...base, profileId: null }).key, 'profile_unavailable')
})
test('foreign-profile tasks and source records cannot become the next action', () => {
  const action = next({ ...base, tasks: [{ id: 'foreign', profile_id: 'p2', status: 'waiting_for_user' }], grants: [{ ...grant, profile_id: 'p2' }] })
  assert.equal(action.route, 'DiscoverGrants')
  assert.equal(action.taskId, undefined)
})
test('submitted work is tracked, not offered as a new application', () => {
  const action = next({ ...base, activeCount: 1, grants: [{ ...grant, status: 'submitted' }] })
  assert.equal(action.key, 'track_results')
})
test('saved opportunities are a review action, not an application submission', () => {
  const action = next({ ...base, savedCount: 2 })
  assert.equal(action.route, 'SavedGrants')
  assert.match(action.description, /bookmark, not an application/)
})
test('navigation defaults are expanded and preferences are isolated by account and workspace', () => {
  const data = new Map()
  const storage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) }
  const defaults = ['home', 'find', 'work', 'support']
  assert.deepEqual([...readScopedNav('u1:end-user', defaults, null, storage)], defaults)
  writeScopedNav('u1:end-user', new Set(['work']), storage)
  assert.deepEqual([...readScopedNav('u1:end-user', defaults, null, storage)], ['work'])
  for (const scope of ['u1:admin', 'u2:end-user']) assert.deepEqual([...readScopedNav(scope, defaults, null, storage)], defaults)
  assert.equal(readScopedNav('u1:end-user', defaults, 'find', storage).has('find'), true)
  data.set(navPreferenceKey('u1:end-user'), 'broken JSON')
  assert.deepEqual([...readScopedNav('u1:end-user', defaults, null, storage)], defaults)
})
test('resume rejects unsafe URLs and unrelated record or profile IDs', () => {
  const options = { profileId: 'p1', allowedRoutes: ['ProfileDetail', 'Pipeline', 'Documents', 'DiscoverGrants'], grantIds: ['g1'] }
  for (const value of ['https://bad.invalid', '//bad.invalid/x', '/Admin', '/ProfileDetail?id=p2', '/Pipeline?grant_id=g2', '/Documents?profile_id=p2', '/Documents?id=unknown']) assert.equal(safeResumePath(value, options), null, value)
  assert.equal(safeResumePath('/ProfileDetail?id=p1&section=narrative', options), '/ProfileDetail?id=p1&section=narrative')
  assert.equal(safeResumePath('/Pipeline?grant_id=g1', options), '/Pipeline?grant_id=g1')
  assert.notEqual(resumeStorageKey('u1', 'p1'), resumeStorageKey('u2', 'p1'))
  assert.notEqual(resumeStorageKey('u1', 'p1'), resumeStorageKey('u1', 'p2'))
})

test('the page guide follows the WORKSPACE, not the role', () => {
  // An end user always gets it.
  assert.equal(shouldShowPageGuide({ isAdmin: false, activeProfileId: null }), true)
  assert.equal(shouldShowPageGuide({ isAdmin: false, activeProfileId: 'p1' }), true)
  // An admin working inside a real profile gets the same guidance that
  // profile's owner does. Gating on !isAdmin alone made every workflow change
  // in #1628 invisible to the owner's admin login (report 2026-09-08).
  assert.equal(shouldShowPageGuide({ isAdmin: true, activeProfileId: 'p1' }), true)
  // The admin workspace itself has no journey to explain.
  assert.equal(shouldShowPageGuide({ isAdmin: true, activeProfileId: '__admin__' }), false)
  assert.equal(shouldShowPageGuide({ isAdmin: true, activeProfileId: null }), false)
  assert.equal(shouldShowPageGuide({ isAdmin: true, activeProfileId: '' }), false)
})
