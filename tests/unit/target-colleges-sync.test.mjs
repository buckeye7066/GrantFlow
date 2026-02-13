/**
 * Unit tests for target colleges sync utilities and normalization.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTargetColleges,
  getMissingCollegeNames,
  syncTargetCollegesToApplications,
  buildApplicationFromCollegeName,
} from '../../src/utils/targetCollegesSync.js'

test('normalizeTargetColleges: string with comma split and trim', () => {
  const result = normalizeTargetColleges('Ohio State, Michigan , Harvard ')
  assert.deepEqual(result, ['Ohio State', 'Michigan', 'Harvard'])
})

test('normalizeTargetColleges: array input', () => {
  const result = normalizeTargetColleges(['A', 'B', 'C'])
  assert.deepEqual(result, ['A', 'B', 'C'])
})

test('normalizeTargetColleges: array dedupe', () => {
  const result = normalizeTargetColleges(['A', 'A', 'B', 'A'])
  assert.deepEqual(result, ['A', 'B'])
})

test('normalizeTargetColleges: case-insensitive dedupe', () => {
  const result = normalizeTargetColleges(['Ohio State', 'ohio state', 'OHIO STATE'])
  assert.deepEqual(result, ['Ohio State'])
})

test('normalizeTargetColleges: empty string returns empty array', () => {
  assert.deepEqual(normalizeTargetColleges(''), [])
  assert.deepEqual(normalizeTargetColleges('   '), [])
})

test('normalizeTargetColleges: null/undefined returns empty', () => {
  assert.deepEqual(normalizeTargetColleges(null), [])
  assert.deepEqual(normalizeTargetColleges(undefined), [])
})

test('getMissingCollegeNames: adds missing', () => {
  const target = ['Ohio State', 'Michigan', 'Harvard']
  const existing = [{ name: 'Ohio State' }]
  const missing = getMissingCollegeNames(target, existing)
  assert.deepEqual(missing, ['Michigan', 'Harvard'])
})

test('getMissingCollegeNames: no duplicate on second run (case-insensitive)', () => {
  const target = ['Ohio State', 'Michigan']
  const existing = [{ name: 'ohio state' }, { name: 'Michigan' }]
  const missing = getMissingCollegeNames(target, existing)
  assert.deepEqual(missing, [])
})

test('getMissingCollegeNames: empty target returns empty', () => {
  assert.deepEqual(getMissingCollegeNames([], [{ name: 'A' }]), [])
})

test('syncTargetCollegesToApplications: adds missing apps', () => {
  const education = { target_colleges: 'Ohio State, Michigan' }
  const current = [{ id: 'x', name: 'Ohio State' }]
  const { applications, addedCount } = syncTargetCollegesToApplications(education, current)
  assert.equal(addedCount, 1)
  assert.equal(applications.length, 2)
  assert.equal(applications[1].name, 'Michigan')
  assert.equal(applications[1].status, 'planning')
})

test('syncTargetCollegesToApplications: does not duplicate on second run', () => {
  const education = { target_colleges: ['Ohio State', 'Michigan'] }
  const first = syncTargetCollegesToApplications(education, [])
  assert.equal(first.addedCount, 2)
  const second = syncTargetCollegesToApplications(education, first.applications)
  assert.equal(second.addedCount, 0)
  assert.equal(second.applications.length, 2)
})

test('buildApplicationFromCollegeName: produces valid shape', () => {
  const app = buildApplicationFromCollegeName('Test University')
  assert.ok(app.id)
  assert.equal(app.name, 'Test University')
  assert.equal(app.status, 'planning')
  assert.deepEqual(app.portals, {})
  assert.deepEqual(app.local_funding, [])
})
