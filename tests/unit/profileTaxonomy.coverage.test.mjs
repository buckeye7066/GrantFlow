import test from 'node:test'
import assert from 'node:assert/strict'

import schema from '../../backend/services/profile/applicationSchema.json' with { type: 'json' }
import { buildProfileFacets, requireFacets, SECTION_MAPPERS } from '../../backend/services/profile/profileTaxonomy.js'

test('profile taxonomy: canonical section keys all have mappers', () => {
  const canonicalKeys = Array.isArray(schema?.canonical_section_keys) ? schema.canonical_section_keys : []
  const missingMappers = canonicalKeys.filter((sectionKey) => typeof SECTION_MAPPERS[sectionKey] !== 'function')
  assert.deepEqual(missingMappers, [])
})

test('profile taxonomy: required facets and coverage are populated from canonical sections', () => {
  const profileContext = buildProfileFacets({
    profile: { id: 'profile-coverage-test', primary_type: 'individual_need' },
    sections: {
      basic_information: {
        profile_category: 'individual_need',
        city: 'Nashville',
        state: 'TN',
        zip: '37209',
      },
      narrative: {
        primary_goal: 'Need help with food assistance and utility support for my household',
        target_population: 'single parent family',
        geographic_focus: 'Davidson County, TN',
      },
      family_life: {
        single_parent: true,
      },
      government_assistance: {
        snap_recipient: true,
        tenncare_id: '123456789',
      },
    },
  })

  assert.equal(profileContext.facets.profile.primary_profile_type, 'individual_need')
  assert.equal(profileContext.facets.geo.state, 'TN')
  assert.equal(profileContext.facets.geo.zip, '37209')
  assert.ok(profileContext.facets.intent.primary_need_category)
  assert.notEqual(profileContext.facets.intent.primary_need_category, 'unknown')
  assert.deepEqual(profileContext.coverage.required_missing, [])
  assert.ok((profileContext.coverage?.field_map_coverage?.signal_coverage_pct ?? 0) >= 1)

  assert.equal(profileContext.facets.pii.has_medicaid_id, true)
  assert.match(String(profileContext.facets.pii.medicaid_id_last4_masked || ''), /^\*{3}\d{4}$/)
  assert.equal(String(profileContext.facets.pii.medicaid_id_last4_masked).includes('123456789'), false)

  const required = requireFacets(profileContext, { strict: true })
  assert.equal(required, profileContext)
})

test('profile taxonomy: requireFacets returns structured missing facet errors', () => {
  const profileContext = buildProfileFacets({
    profile: { id: 'profile-missing-facets' },
    sections: {
      basic_information: {},
      narrative: {},
    },
  })

  assert.throws(
    () => requireFacets(profileContext, { strict: true }),
    (error) => {
      assert.equal(error?.code, 'PROFILE_CONTEXT_INCOMPLETE')
      assert.equal(Number(error?.status), 400)
      assert.ok(Array.isArray(error?.details?.required_missing))
      assert.ok(error.details.required_missing.includes('profile.primary_profile_type'))
      assert.ok(error.details.required_missing.includes('geo.state_or_zip'))
      assert.ok(error.details.required_missing.length >= 2)
      return true
    },
  )
})
