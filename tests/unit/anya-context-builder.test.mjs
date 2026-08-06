import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAnyaContext } from '../../backend/services/anyaContextBuilder.js'

// ── Mock helpers ──────────────────────────────────────────────────────────

function createMockDb(opts = {}) {
  const profiles = opts.profiles || []
  const sections = opts.sections || []
  const opportunities = opts.opportunities || []
  const grants = opts.grants || []

  return {
    prepare(sql) {
      return {
        async get(...params) {
          if (sql.includes('FROM profiles')) {
            return profiles.find((p) => p.id === params[0]) || null
          }
          if (sql.includes('FROM organizations')) {
            return null
          }
          return null
        },
        async all(...params) {
          if (sql.includes('FROM profile_sections')) {
            return sections.filter((s) => s.profile_id === params[0])
          }
          if (sql.includes('FROM funding_opportunities')) {
            return opportunities
          }
          if (sql.includes('FROM grants')) {
            return grants
          }
          return []
        },
      }
    },
  }
}

const MOCK_PROFILE = {
  id: 'prof-1',
  display_name: 'John Doe',
  applicant_type: 'individual',
  primary_type: 'individual',
  state: 'OH',
  city: 'Columbus',
  postal_code: '43215',
  tags: '["housing","utilities"]',
  interests: '["grants"]',
}

const MOCK_SECTIONS = [
  {
    profile_id: 'prof-1',
    section_key: 'demographics',
    data: JSON.stringify({ race: 'white', gender: 'male', age: 42 }),
  },
  {
    profile_id: 'prof-1',
    section_key: 'financial',
    data: JSON.stringify({ household_income: 28000, household_size: 3 }),
  },
]

const MOCK_OPPORTUNITIES = [
  {
    id: 'opp-1',
    title: 'Ohio Emergency Housing Assistance',
    description: 'Housing assistance for Ohio residents',
    sponsor: 'Ohio Dept of Development',
    state: 'OH',
    source_url: 'https://development.ohio.gov/housing',
    is_active: 1,
    source: 'grantflow',
    record_origin: 'crawler',
    categories: 'housing,emergency',
    keywords: 'housing,rent,eviction',
    type: 'PROGRAM',
  },
  {
    id: 'opp-2',
    title: 'LIHEAP Energy Assistance',
    description: 'Utility bill assistance nationwide',
    sponsor: 'HHS',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://acf.hhs.gov/liheap',
    is_active: 1,
    source: 'grantflow',
    record_origin: 'crawler',
    categories: 'utilities,energy',
    keywords: 'energy,utilities,heating',
    type: 'PROGRAM',
  },
]

// ── Tests ─────────────────────────────────────────────────────────────────

test('buildAnyaContext: returns no-profile message when profileId is missing', async () => {
  const db = createMockDb()
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: null })
  assert.ok(result.includes('No profile is currently selected'))
  assert.ok(result.includes('select or create a profile'))
})

test('buildAnyaContext: includes profile snapshot with real data', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1', activeProfileId: 'prof-1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-1' })

  assert.ok(result.includes('Live Context'), 'should contain Live Context header')
  assert.ok(result.includes('John Doe'), 'should contain profile name')
  assert.ok(result.includes('individual'), 'should contain profile type')
  assert.ok(result.includes('OH') || result.includes('Ohio'), 'should contain state')
  assert.ok(result.includes('Columbus') || result.includes('43215'), 'should contain location')
  assert.ok(result.includes('Profile completeness'), 'should contain completeness info')
})

test('buildAnyaContext: includes matching results from real scoring', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-1' })

  assert.ok(result.includes('Available Results'), 'should have results section')
  assert.ok(result.includes('opportunities evaluated'), 'should mention evaluation count')
  assert.ok(result.includes('Top 5') || result.includes('pts'), 'should have scored results')
  assert.ok(result.includes('canonical ACCEPT'), 'should count canonical decisions, not infer acceptance from score')
  assert.ok(result.includes('data_point_v1'), 'should identify the live score scale')
  assert.ok(!result.includes('strong ≥50'), 'should not emit the retired score threshold')
})

test('buildAnyaContext: includes missing profile data suggestions', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-1' })

  assert.ok(result.includes('Missing Profile Data'), 'should flag missing sections')
  assert.ok(result.includes('sections are empty'), 'should count empty sections')
  assert.ok(result.includes('Highest-impact'), 'should prioritize by impact')
})

test('buildAnyaContext: missing sections are profile-type-specific', async () => {
  const nonprofitProfile = {
    ...MOCK_PROFILE,
    id: 'prof-np',
    applicant_type: 'nonprofit',
    primary_type: 'nonprofit',
  }
  const db = createMockDb({
    profiles: [nonprofitProfile],
    sections: [
      { profile_id: 'prof-np', section_key: 'demographics', data: '{}' },
    ],
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-np' })

  assert.ok(
    result.includes('Organization Details') || result.includes('organization_details'),
    'nonprofit should be told to fill organization details',
  )
})

test('buildAnyaContext: includes page-specific context', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }

  const discoveryResult = await buildAnyaContext(db, user, {
    profileId: 'prof-1',
    currentPage: 'DiscoverGrants',
  })
  assert.ok(discoveryResult.includes('browsing funding opportunities'), 'Discovery page should have discovery guidance')

  const pipelineResult = await buildAnyaContext(db, user, {
    profileId: 'prof-1',
    currentPage: 'Pipeline',
  })
  assert.ok(pipelineResult.includes('saved grants'), 'Pipeline page should have pipeline guidance')
})

test('buildAnyaContext: includes frontend page context when provided', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, {
    profileId: 'prof-1',
    currentPage: 'DiscoverGrants',
    pageContext: { resultCount: 42 },
  })
  assert.ok(result.includes('42'), 'should include result count from frontend')
})

test('buildAnyaContext: includes context-awareness rules', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-1' })

  // The context itself won't have the rules (those are in the orchestrator),
  // but the Live Context header should be present
  assert.ok(result.includes('grounded in real data'), 'should emphasize data-grounded responses')
})

test('buildAnyaContext: explains WHY results appear', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-1' })

  assert.ok(
    result.includes('When explaining results, reference') || result.includes('Geographic match'),
    'should include explanation guidance for the LLM',
  )
})

test('buildAnyaContext: suggests NEXT actions based on page', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, {
    profileId: 'prof-1',
    currentPage: 'Dashboard',
  })
  assert.ok(
    result.includes('SUGGEST') || result.includes('suggest'),
    'should include suggested actions for the page',
  )
})

test('buildAnyaContext: handles empty opportunity database gracefully', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: [],
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-1' })
  assert.ok(result.includes('No opportunities found'), 'should explain no opportunities')
})

test('buildAnyaContext: gap detection includes impact explanations', async () => {
  const db = createMockDb({
    profiles: [{ ...MOCK_PROFILE, applicant_type: 'veteran' }],
    sections: [],
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-1' })

  assert.ok(
    result.includes('Unlocks') || result.includes('unlocks'),
    'missing section suggestions should explain what they unlock',
  )
})

test('buildAnyaContext: never contains generic advice', async () => {
  const db = createMockDb({
    profiles: [MOCK_PROFILE],
    sections: MOCK_SECTIONS,
    opportunities: MOCK_OPPORTUNITIES,
  })
  const user = { userId: 'u1' }
  const result = await buildAnyaContext(db, user, { profileId: 'prof-1' })

  const genericPhrases = [
    'You may want to consider',
    'Generally speaking',
    'In general',
    'It is recommended to',
  ]
  for (const phrase of genericPhrases) {
    assert.ok(!result.includes(phrase), `should not contain generic advice: "${phrase}"`)
  }
})
