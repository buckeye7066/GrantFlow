/**
 * Hamilton preflight — "parse the whole profile" regression tests.
 *
 * Guards the fix for false hard stops where a required value WAS on the profile
 * but Hamilton flagged it missing because preflight only checked one narrow
 * path (and, in the route, was handed a profile with no section data at all).
 *
 * preflightSingleSource must treat a field as present when it lives at its
 * canonical path, OR anywhere in the profile under a known alias, OR in the
 * resolved-field cache.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'
import { preflightSingleSource } from '../../backend/services/hamilton/hamiltonPreflight.js'

// Real in-memory db so preflight's auth/document store lookups resolve against
// actual (empty) tables; the focus stays on field detection.
const stubDb = wrapSqlite(new Database(':memory:'))

const scholarshipOpp = {
  id: 'opp_1',
  title: 'Forensic Science Scholarship',
  description: 'A merit scholarship for college students.',
}

function missingKeys(report) {
  return report.blockers.filter((b) => b.kind === 'missing_field').map((b) => b.key)
}

describe('preflight parses the whole profile', () => {
  it('does not flag first/last/email present in nested sections', async () => {
    const profile = {
      id: 'p1',
      display_name: 'Anastasia Nicole White',
      basic_information: {
        first_name: 'Anastasia',
        last_name: 'White',
        email: 'tishka1201@icloud.com',
        phone: '4234752124',
      },
    }
    const report = await preflightSingleSource(stubDb, {
      profile, profileId: 'p1', source: { opportunity_id: 'opp_1' }, opportunity: scholarshipOpp,
    })
    const keys = missingKeys(report)
    assert.ok(!keys.includes('first_name'), `first_name should not be missing: ${keys}`)
    assert.ok(!keys.includes('last_name'), `last_name should not be missing: ${keys}`)
    assert.ok(!keys.includes('email'), `email should not be missing: ${keys}`)
  })

  it('finds the school via academic_status.current_institution (not just university_applications)', async () => {
    const profile = {
      id: 'p1',
      basic_information: {
        first_name: 'Anastasia', last_name: 'White', email: 'a@b.com',
        academic_status: { current_institution: 'Cleveland State Community College' },
      },
    }
    const report = await preflightSingleSource(stubDb, {
      profile, profileId: 'p1', source: { opportunity_id: 'opp_1' }, opportunity: scholarshipOpp,
    })
    assert.ok(!missingKeys(report).includes('school_name'), 'school found elsewhere should not be flagged')
  })

  it('counts a value supplied to the resolved-field cache as present', async () => {
    const profile = { id: 'p1', basic_information: { last_name: 'White', email: 'a@b.com' } }
    const report = await preflightSingleSource(stubDb, {
      profile, profileId: 'p1', source: { opportunity_id: 'opp_1' }, opportunity: scholarshipOpp,
      resolvedFields: { first_name: 'Anastasia' },
    })
    assert.ok(!missingKeys(report).includes('first_name'), 'cached first_name should satisfy the check')
  })

  it('still flags a genuinely absent field', async () => {
    const profile = { id: 'p1', basic_information: { first_name: 'Anastasia' } }
    const report = await preflightSingleSource(stubDb, {
      profile, profileId: 'p1', source: { opportunity_id: 'opp_1' }, opportunity: scholarshipOpp,
    })
    const keys = missingKeys(report)
    assert.ok(keys.includes('last_name'), 'truly missing last_name should still be flagged')
    assert.ok(keys.includes('email'), 'truly missing email should still be flagged')
  })
})
