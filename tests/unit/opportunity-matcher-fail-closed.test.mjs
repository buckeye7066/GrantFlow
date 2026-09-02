import test from 'node:test'
import assert from 'node:assert/strict'

import { saveToProfilePipeline } from '../../backend/services/opportunityMatcher.js'

const profileContext = {
  profile: {
    id: 'profile-1',
    primary_type: 'student',
    applicant_type: 'college_student',
    state: 'TN',
    needs: ['education'],
    categories: ['education'],
    keywords: ['student', 'scholarship', 'education'],
  },
  sections: {
    basic_information: { state: 'TN', profile_category: 'college_student' },
    education: { current_student: true },
  },
}

test('canonical writer refuses resource rows instead of creating pipeline applications', async () => {
  const result = await saveToProfilePipeline(
    {},
    {
      id: 'resource-1',
      title: 'Scholarship Search Directory',
      source: 'grants_gov',
      opportunity_kind: 'DIRECTORY',
      need_types_supported: ['education'],
      source_url: 'https://www.grants.gov/search-grants',
    },
    null,
    profileContext,
  )

  assert.equal(result.saved, false)
  assert.match(String(result.reason), /fundable|resource|grant/i)
})

test('canonical writer fails closed when dismissal state cannot be checked', async () => {
  const db = {
    prepare() {
      throw new Error('dismissal store unavailable')
    },
  }
  const result = await saveToProfilePipeline(
    db,
    {
      id: 'grant-1',
      title: 'Education Award',
      source: 'scholarship_crawler',
      record_origin: 'verified_real',
      source_trust_tier: 'verified',
      opportunity_kind: 'GRANT',
      opportunity_type: 'scholarship',
      need_types_supported: ['education'],
      entity_types_allowed: ['individual', 'student'],
      categories: ['education'],
      keywords: ['student', 'scholarship', 'education'],
      eligibility_text: 'Individual college students with education expenses may apply.',
      state: 'TN',
      amount_max: 1000,
      application_url: 'https://example.org/education-award',
    },
    'profile-1',
    profileContext,
  )

  assert.equal(result.saved, false)
  assert.match(String(result.reason), /dismissal lookup failed/i)
})


test('canonical writer refuses REVIEW when qualification is unknown', async () => {
  // This case is about the qualification gate, so provide a readable, empty
  // dismissal store instead of an object that cannot represent database state.
  const db = {
    prepare() {
      return {
        run: async () => ({ changes: 0 }),
        get: async () => null,
        all: async () => [],
      }
    },
  }
  const result = await saveToProfilePipeline(
    db,
    {
      id: 'grant-review-1',
      title: 'Education Support Award',
      source: 'grants_gov',
      opportunity_kind: 'GRANT',
      need_types_supported: ['education'],
      amount_max: 1000,
      application_url: 'https://www.grants.gov/example-review',
    },
    null,
    profileContext,
  )

  assert.equal(result.saved, false)
  assert.match(String(result.reason), /review|qualification|eligibility/i)
})
