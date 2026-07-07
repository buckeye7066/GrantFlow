import test from 'node:test'
import assert from 'node:assert/strict'
import { SCORE_FLOOR } from '../../backend/config/matchThresholds.js'

import {
  validateUrlFormat,
  validateRequiredFields,
  validateOpportunityStrict,
  auditStoredOpportunities,
  assertNoInvalidUrls,
  assertMatchingReturnsResults,
  validateMultiProfileMatching,
} from '../../backend/services/opportunityValidationLayer.js'

import { scoreOpportunity } from '../../backend/services/matchEngine.js'

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD-FAIL GATE: Matching must never return empty when data exists
// ═══════════════════════════════════════════════════════════════════════════════

const GATE_OPPORTUNITIES = [
  {
    title: 'Ohio Emergency Housing Program',
    description: 'Emergency housing assistance for Ohio residents',
    sponsor: 'Ohio DHS',
    state: 'OH',
    source_url: 'https://ohio.gov/housing',
    keywords: ['housing', 'emergency', 'rent'],
    categories: ['housing'],
  },
  {
    title: 'LIHEAP Energy Assistance',
    description: 'Utility bill assistance for low-income families',
    sponsor: 'HHS',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://acf.hhs.gov/liheap',
    keywords: ['utilities', 'energy'],
    categories: ['utilities'],
  },
  {
    title: 'Federal Pell Grant',
    description: 'Need-based grant for undergraduate students',
    sponsor: 'Dept of Education',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://studentaid.gov/pell',
    keywords: ['education', 'student', 'pell', 'college'],
    categories: ['education'],
  },
  {
    title: 'Nonprofit Capacity Building Grant',
    description: 'Strengthening nonprofit organizational capacity',
    sponsor: 'Foundation Center',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://foundationcenter.org/grants',
    keywords: ['nonprofit', 'capacity', 'organization'],
    categories: ['nonprofit'],
  },
  {
    title: 'SBA Small Business Innovation Research',
    description: 'Federal grants for small business R&D',
    sponsor: 'SBA',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://sba.gov/sbir',
    keywords: ['small business', 'sba', 'innovation', 'startup'],
    categories: ['small_business'],
  },
  {
    title: 'United Way Community Resources',
    description: 'Community resources for housing, food, and assistance',
    sponsor: 'United Way',
    state: 'OH',
    source_url: 'https://unitedway.org/find-your-united-way',
    keywords: ['community', 'local'],
    categories: ['community'],
    type: 'DIRECTORY',
  },
]

test('BUILD GATE: individual profile must return results when data exists', () => {
  const profile = {
    profile: {
      applicant_type: 'individual',
      state: 'OH',
      postal_code: '43215',
      needs: ['housing', 'utilities'],
    },
    sections: { basic_information: { state: 'OH', zip: '43215' } },
  }

  const result = assertMatchingReturnsResults(profile, GATE_OPPORTUNITIES, {
    label: 'individual',
    minResults: 1,
  })
  assert.ok(result.ok, 'Individual profile MUST return results')
  assert.ok(result.meaningful >= 1, `Need ≥1 meaningful result, got ${result.meaningful}`)
})

test('BUILD GATE: student profile must return results when data exists', () => {
  const profile = {
    profile: {
      applicant_type: 'student',
      state: 'OH',
      postal_code: '43215',
      needs: ['education', 'scholarships'],
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215' },
      education: { highest_level: 'high school', gpa: 3.5 },
    },
  }

  const result = assertMatchingReturnsResults(profile, GATE_OPPORTUNITIES, {
    label: 'student',
    minResults: 1,
  })
  assert.ok(result.ok, 'Student profile MUST return results')
})

test('BUILD GATE: nonprofit profile must return results when data exists', () => {
  const profile = {
    profile: {
      applicant_type: 'nonprofit',
      state: 'OH',
      postal_code: '43215',
      needs: ['capacity_building', 'program_funding'],
      entity_type: 'nonprofit',
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215' },
      organization_details: { type: 'nonprofit', name: 'Test Org' },
    },
  }

  const result = assertMatchingReturnsResults(profile, GATE_OPPORTUNITIES, {
    label: 'nonprofit',
    minResults: 1,
  })
  assert.ok(result.ok, 'Nonprofit profile MUST return results')
})

test('BUILD GATE: business profile must return results when data exists', () => {
  const profile = {
    profile: {
      applicant_type: 'small_business',
      state: 'OH',
      postal_code: '43215',
      needs: ['small_business', 'startup_funding'],
      entity_type: 'business',
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215' },
      small_business_details: { business_name: 'Test LLC', years_in_business: 2 },
    },
  }

  const result = assertMatchingReturnsResults(profile, GATE_OPPORTUNITIES, {
    label: 'business',
    minResults: 1,
  })
  assert.ok(result.ok, 'Business profile MUST return results')
})

test('BUILD GATE: validateMultiProfileMatching passes for all types', () => {
  const { passed, failed } = validateMultiProfileMatching(GATE_OPPORTUNITIES)
  assert.equal(
    failed.length,
    0,
    `Multi-profile matching MUST pass for all types. Failed: ${JSON.stringify(failed)}`,
  )
  assert.ok(passed.includes('individual'), 'Individual must pass')
  assert.ok(passed.includes('student'), 'Student must pass')
  assert.ok(passed.includes('nonprofit'), 'Nonprofit must pass')
  assert.ok(passed.includes('business'), 'Business must pass')
})

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD-FAIL GATE: Invalid URLs must never be stored
// ═══════════════════════════════════════════════════════════════════════════════

test('BUILD GATE: validateOpportunityStrict rejects all invalid URL patterns', () => {
  const invalidUrls = [
    'https://example.com/fake',
    'https://example.org/grant',
    'https://localhost:3000/api',
    'https://127.0.0.1/test',
    'https://facebook.com/grants',
    'javascript:alert(1)',
    'data:text/html,hello',
    'ftp://files.example.com',
    '',
    null,
  ]

  for (const url of invalidUrls) {
    const opp = {
      title: 'Test Grant Program',
      sponsor: 'Test Agency',
      description: 'A valid description',
      url: url,
      source_url: url,
    }
    const result = validateOpportunityStrict(opp)
    assert.equal(
      result.valid,
      false,
      `Opp with URL "${url}" should be REJECTED but was accepted`,
    )
  }
})

test('BUILD GATE: validateOpportunityStrict accepts all valid URL patterns', () => {
  const validUrls = [
    'https://www.grants.gov/search-results-detail/12345',
    'https://studentaid.gov/understand-aid/types/grants/pell',
    'https://www.sba.gov/funding-programs/grants',
    'https://development.ohio.gov/housing',
    'https://www.unitedway.org/find-your-united-way',
    'http://grants.ohio.gov/programs',
  ]

  for (const url of validUrls) {
    const opp = {
      title: 'Valid Grant Program',
      sponsor: 'Real Agency',
      description: 'A real grant program.',
      source_url: url,
    }
    const result = validateOpportunityStrict(opp)
    assert.equal(
      result.valid,
      true,
      `Opp with URL "${url}" should be ACCEPTED but was rejected: ${result.errors.join(', ')}`,
    )
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD-FAIL GATE: DB audit catches stored invalid data
// ═══════════════════════════════════════════════════════════════════════════════

test('BUILD GATE: auditStoredOpportunities catches invalid records in mock DB', async () => {
  const mockDb = {
    dialect: 'sqlite',
    prepare: () => ({
      all: async () => [
        { id: '1', title: 'Good Grant', url: 'https://grants.gov/test', source_url: 'https://grants.gov/test' },
        { id: '2', title: 'Bad', url: 'https://example.com/fake', source_url: null },
        { id: '3', title: null, url: null, source_url: null },
      ],
    }),
  }

  const result = await auditStoredOpportunities(mockDb)
  assert.equal(result.total, 3)
  assert.ok(result.invalid >= 2, `Should find at least 2 invalid records, got ${result.invalid}`)
})

test('BUILD GATE: assertNoInvalidUrls throws on bad data', async () => {
  const mockDb = {
    dialect: 'sqlite',
    prepare: () => ({
      all: async () => [
        { id: '1', title: null, url: 'https://example.com/fake' },
      ],
    }),
  }

  await assert.rejects(
    () => assertNoInvalidUrls(mockDb),
    (err) => {
      assert.ok(err.message.includes('ValidationLayer'))
      return true
    },
  )
})

test('BUILD GATE: assertNoInvalidUrls passes on clean data', async () => {
  const mockDb = {
    dialect: 'sqlite',
    prepare: () => ({
      all: async () => [
        { id: '1', title: 'Valid Grant', url: 'https://grants.gov/real', source_url: 'https://grants.gov/real' },
        { id: '2', title: 'Another Grant', url: 'https://sba.gov/program', source_url: 'https://sba.gov/program' },
      ],
    }),
  }

  const result = await assertNoInvalidUrls(mockDb)
  assert.equal(result.invalid, 0)
})

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD-FAIL GATE: Score floor guarantee
// ═══════════════════════════════════════════════════════════════════════════════

test('BUILD GATE: score floor ensures no zero scores for validated opportunities', () => {
  const profiles = [
    { profile: { applicant_type: 'individual', state: 'OH' } },
    { profile: { applicant_type: 'student' } },
    { profile: { applicant_type: 'nonprofit', entity_type: 'nonprofit' } },
    { profile: { applicant_type: 'small_business', entity_type: 'business' } },
    { profile: {} },
  ]

  for (const ctx of profiles) {
    for (const opp of GATE_OPPORTUNITIES) {
      const result = scoreOpportunity(ctx, opp)
      assert.ok(
        result.score >= SCORE_FLOOR,
        `Score floor violated: ${ctx.profile?.applicant_type || 'empty'} + "${opp.title}" → ${result.score}`,
      )
    }
  }
})
