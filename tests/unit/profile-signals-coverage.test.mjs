import test from 'node:test'
import assert from 'node:assert/strict'

import { buildProfileSignals } from '../../backend/services/profileHelpers.js'
import { buildSearchKeywords, calculateMatchScore } from '../../backend/services/crawlers/crawlerHelpers.js'

test('profile signals: all-data passthrough influences crawler keyword search + scoring', () => {
  const sections = {
    basic_information: {
      full_name: 'Test Applicant',
      state: 'TN',
    },
    // Simulate a “comprehensive application” field not explicitly modeled elsewhere.
    organization_details: {
      nicra_rate: '10%',
      audit_status: 'audited',
    },
  }

  const profile = {
    id: 'profile-test',
    primary_type: 'organization',
    display_name: 'Test Org',
    tags: [],
    interests: [],
  }

  const signals = buildProfileSignals({ profile, sections })
  const enrichedProfile = { ...profile, signals, sections, state: 'TN' }

  const keywords = buildSearchKeywords(enrichedProfile, 60).join(' ')
  assert.match(keywords, /\bnicra\b/i)

  const opportunity = {
    title: 'NICRA Support Program',
    description: 'Funding for NICRA and indirect cost compliance support.',
    categories: [],
    keywords: [],
    is_national: true,
  }

  const scored = calculateMatchScore(opportunity, enrichedProfile)
  assert.ok(
    scored.matchedSignals.some((s) => s === 'kw:nicra'),
    `expected kw:nicra in matchedSignals; got: ${JSON.stringify(scored.matchedSignals)}`,
  )
})

