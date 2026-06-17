import test from 'node:test'
import assert from 'node:assert/strict'

import { isMissingSchoolBridgeTable } from '../../backend/utils/schoolBridgeErrors.js'

// Regression for: profile detail page returning 500 from
// `GET /api/profiles/:id/school-link` because the school-portal bridge tables
// (school_student_links / school_partners) were not provisioned on the
// database yet. The matcher MUST classify those table-missing errors as
// "no school link" so the route degrades to { ok: true, link: null } rather
// than blocking the whole profile detail page (mission rules: missing
// fields default to neutral, not exclusionary).

test('matches Postgres relation-does-not-exist for school_student_links', () => {
  const err = Object.assign(new Error('relation "school_student_links" does not exist'), {
    code: '42P01',
  })
  assert.equal(isMissingSchoolBridgeTable(err), true)
})

test('matches Postgres relation-does-not-exist for school_partners', () => {
  const err = Object.assign(new Error('relation "school_partners" does not exist'), {
    code: '42P01',
  })
  assert.equal(isMissingSchoolBridgeTable(err), true)
})

test('matches SQLite "no such table: school_student_links"', () => {
  const err = new Error('SQLITE_ERROR: no such table: school_student_links')
  assert.equal(isMissingSchoolBridgeTable(err), true)
})

test('matches SQLite "no such table: school_partners"', () => {
  const err = new Error('SQLITE_ERROR: no such table: school_partners')
  assert.equal(isMissingSchoolBridgeTable(err), true)
})

test('does NOT match unrelated 42P01 (e.g. another missing table)', () => {
  // A real bug elsewhere — must still bubble up as 500.
  const err = Object.assign(new Error('relation "applications" does not exist'), {
    code: '42P01',
  })
  assert.equal(isMissingSchoolBridgeTable(err), false)
})

test('does NOT match unrelated SQLite "no such table" errors', () => {
  const err = new Error('SQLITE_ERROR: no such table: applications')
  assert.equal(isMissingSchoolBridgeTable(err), false)
})

test('does NOT match generic Postgres errors (e.g. column missing)', () => {
  const err = Object.assign(
    new Error('column "consent_status" does not exist'),
    { code: '42703' },
  )
  assert.equal(isMissingSchoolBridgeTable(err), false)
})

test('handles null / undefined / non-Error inputs without throwing', () => {
  assert.equal(isMissingSchoolBridgeTable(null), false)
  assert.equal(isMissingSchoolBridgeTable(undefined), false)
  assert.equal(isMissingSchoolBridgeTable('not an error'), false)
  assert.equal(isMissingSchoolBridgeTable({}), false)
})
