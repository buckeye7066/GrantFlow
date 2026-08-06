/**
 * Committed school narrowing — student profile contract.
 *
 * User rule (this repo):
 *   "I also need a way for student profiles to be updated once they have
 *    chosen a university to where the others fall off."
 *
 * What this test locks in:
 *   1. With NO committed school, the existing behavior is preserved:
 *      generateSchoolCards emits cards for every school in the profile.
 *   2. As soon as ANY school is marked status='committed' (or 'enrolled'
 *      or 'attending'), the school-card generator narrows to JUST that
 *      school. The other applications stay on the profile for reference
 *      but stop producing school-specific funding cards.
 *   3. Multiple committed schools (transfer flow) → cards for both.
 *   4. Non-committed status values that look similar (e.g. 'accepted')
 *      do NOT trigger narrowing — only the explicit commit statuses do,
 *      because a student can be 'accepted' to multiple schools while
 *      still deciding.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  generateSchoolCards,
  isCommittedSchool,
  COMMITTED_SCHOOL_STATUSES,
} from '../../backend/services/crawlers/crawlerManager.js'

const DEMO_STUDENT_BASE = {
  applicantType: 'student',
  demographics: new Set(['female']),
  interests: new Set(['forensic science']),
  sports: new Set(),
}

function withSchools(schools) {
  return { ...DEMO_STUDENT_BASE, schools }
}

describe('committed-school narrowing — generateSchoolCards', () => {
  it('emits cards for every school when none are committed', () => {
    const cards = generateSchoolCards(
      withSchools([
        { name: 'Middle Tennessee State University', status: 'planning' },
        { name: 'University of Central Florida', status: 'planning' },
        { name: 'University of Alabama', status: 'accepted' },
      ]),
    )
    const schoolNames = new Set(cards.map((c) => c.schoolName))
    assert.equal(schoolNames.size, 3, `expected 3 distinct schools, got ${[...schoolNames].join(', ')}`)
    assert.ok(schoolNames.has('Middle Tennessee State University'))
    assert.ok(schoolNames.has('University of Central Florida'))
    assert.ok(schoolNames.has('University of Alabama'))
  })

  it('narrows to ONLY the committed school once one is chosen', () => {
    const cards = generateSchoolCards(
      withSchools([
        { name: 'Middle Tennessee State University', status: 'committed' },
        { name: 'University of Central Florida', status: 'planning' },
        { name: 'University of Alabama', status: 'accepted' },
      ]),
    )
    const schoolNames = new Set(cards.map((c) => c.schoolName))
    assert.equal(schoolNames.size, 1, `expected only MTSU, got ${[...schoolNames].join(', ')}`)
    assert.ok(schoolNames.has('Middle Tennessee State University'))
    assert.ok(!schoolNames.has('University of Central Florida'), 'UCF cards must fall off after commit')
    assert.ok(!schoolNames.has('University of Alabama'), 'Alabama cards must fall off after commit')
  })

  it('treats "enrolled" and "attending" the same as "committed"', () => {
    for (const status of ['enrolled', 'attending', 'COMMITTED', '  committed  ']) {
      const cards = generateSchoolCards(
        withSchools([
          { name: 'Middle Tennessee State University', status },
          { name: 'University of Central Florida', status: 'planning' },
        ]),
      )
      const schoolNames = new Set(cards.map((c) => c.schoolName))
      assert.equal(
        schoolNames.size,
        1,
        `status="${status}" should narrow to one school, got ${schoolNames.size} (${[...schoolNames].join(', ')})`,
      )
      assert.ok(schoolNames.has('Middle Tennessee State University'))
    }
  })

  it('does NOT narrow on "accepted" alone — student can be accepted to multiple schools while deciding', () => {
    const cards = generateSchoolCards(
      withSchools([
        { name: 'Middle Tennessee State University', status: 'accepted' },
        { name: 'University of Central Florida', status: 'accepted' },
        { name: 'University of Alabama', status: 'accepted' },
      ]),
    )
    const schoolNames = new Set(cards.map((c) => c.schoolName))
    assert.equal(schoolNames.size, 3, '"accepted" alone must keep all schools visible')
  })

  it('supports multiple committed schools (e.g. transfer flow)', () => {
    const cards = generateSchoolCards(
      withSchools([
        { name: 'Middle Tennessee State University', status: 'committed' },
        { name: 'University of Central Florida', status: 'enrolled' }, // dual-enroll edge case
        { name: 'University of Alabama', status: 'planning' },
      ]),
    )
    const schoolNames = new Set(cards.map((c) => c.schoolName))
    assert.equal(schoolNames.size, 2)
    assert.ok(schoolNames.has('Middle Tennessee State University'))
    assert.ok(schoolNames.has('University of Central Florida'))
    assert.ok(!schoolNames.has('University of Alabama'))
  })

  it('still produces the full per-school card set for the committed school (finaid + housing + offcampus + scholarships)', () => {
    const cards = generateSchoolCards(
      withSchools([
        { name: 'Middle Tennessee State University', status: 'committed' },
        { name: 'University of Central Florida', status: 'planning' },
      ]),
    )
    const mtsu = cards.filter((c) => c.schoolName === 'Middle Tennessee State University')
    const ids = mtsu.map((c) => c.id)
    assert.ok(ids.some((id) => id.startsWith('school-finaid-')), 'finaid card missing for committed school')
    assert.ok(ids.some((id) => id.startsWith('school-housing-')), 'housing card missing for committed school')
    assert.ok(ids.some((id) => id.startsWith('school-offcampus-')), 'off-campus card missing for committed school')
    assert.ok(ids.some((id) => id.startsWith('school-scholarships-')), 'scholarships card missing for committed school')
  })

  it('isCommittedSchool helper recognizes all canonical statuses + handles bad input gracefully', () => {
    for (const status of COMMITTED_SCHOOL_STATUSES) {
      assert.equal(isCommittedSchool({ status }), true, `status "${status}" should be committed`)
    }
    for (const status of ['planning', 'accepted', 'submitted', 'denied', 'waitlisted', '', null, undefined]) {
      assert.equal(isCommittedSchool({ status }), false, `status "${status}" must NOT be committed`)
    }
    assert.equal(isCommittedSchool(null), false)
    assert.equal(isCommittedSchool(undefined), false)
    assert.equal(isCommittedSchool('not even an object'), false)
  })
})
