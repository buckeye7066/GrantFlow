import test from 'node:test'
import assert from 'node:assert/strict'

import { saveToProfilePipeline } from '../../backend/services/opportunityMatcher.js'

const profileContext = {
  profile: {
    id: 'profile-1',
    primary_type: 'student',
    needs: ['education'],
  },
  sections: {},
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
      source: 'grants_gov',
      opportunity_kind: 'GRANT',
      need_types_supported: ['education'],
      amount_max: 1000,
      application_url: 'https://www.grants.gov/example',
    },
    'profile-1',
    profileContext,
  )

  assert.equal(result.saved, false)
  assert.match(String(result.reason), /dismissal lookup failed/i)
})
