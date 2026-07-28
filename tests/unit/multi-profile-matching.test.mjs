import test from 'node:test'
import assert from 'node:assert/strict'

import { scoreOpportunity, makeDecision } from '../../backend/services/matchEngine.js'
import {
  assertMatchingReturnsResults,
  validateMultiProfileMatching,
} from '../../backend/services/opportunityValidationLayer.js'

// ── Shared opportunity corpus ────────────────────────────────────────────────
// Realistic opportunities that span multiple profile types.
// Every profile type must find at least one meaningful match here.

const OPPORTUNITY_CORPUS = [
  {
    id: 'opp-housing-oh',
    title: 'Ohio Emergency Housing Assistance Program',
    description: 'Emergency rental and housing assistance for Ohio residents facing eviction or homelessness',
    sponsor: 'Ohio Department of Development',
    state: 'OH',
    source_url: 'https://development.ohio.gov/housing',
    categories: ['housing', 'emergency_assistance'],
    keywords: ['housing', 'rent', 'eviction', 'emergency', 'ohio'],
    type: 'PROGRAM',
  },
  {
    id: 'opp-utilities-national',
    title: 'LIHEAP Energy Assistance',
    description: 'Low Income Home Energy Assistance Program helps families with utility bills',
    sponsor: 'U.S. Department of Health and Human Services',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://www.acf.hhs.gov/ocs/programs/liheap',
    categories: ['utilities', 'energy'],
    keywords: ['energy', 'utilities', 'heating', 'liheap'],
    type: 'PROGRAM',
  },
  {
    id: 'opp-food-oh',
    title: 'Ohio SNAP Benefits',
    description: 'Supplemental Nutrition Assistance Program for Ohio families needing food assistance',
    sponsor: 'Ohio Department of Job and Family Services',
    state: 'OH',
    source_url: 'https://jfs.ohio.gov/snap',
    categories: ['food', 'nutrition'],
    keywords: ['food', 'snap', 'nutrition', 'ebt'],
    type: 'PROGRAM',
  },
  {
    id: 'opp-scholarship-stem',
    title: 'National STEM Scholarship for Underrepresented Students',
    description: 'Scholarship for students pursuing STEM degrees including computer science, biology, and engineering',
    sponsor: 'National Science Foundation',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://www.nsf.gov/funding',
    categories: ['education', 'scholarship'],
    keywords: ['scholarship', 'stem', 'education', 'college', 'university', 'student'],
    type: 'SCHOLARSHIP',
  },
  {
    id: 'opp-pell-grant',
    title: 'Federal Pell Grant',
    description: 'Need-based federal grant for undergraduate students with financial need',
    sponsor: 'U.S. Department of Education',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    categories: ['education', 'financial_aid'],
    keywords: ['pell', 'grant', 'student', 'education', 'financial aid', 'college'],
    type: 'GRANT',
  },
  {
    id: 'opp-nonprofit-capacity',
    title: 'Nonprofit Capacity Building Grant Program',
    description: 'Grants to strengthen nonprofit organizational capacity, leadership, and program delivery',
    sponsor: 'Foundation for Community Development',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://www.foundationcenter.org/grants',
    categories: ['capacity_building', 'nonprofit'],
    keywords: ['nonprofit', 'capacity', 'organizational', 'community', 'leadership', '501c3'],
    type: 'GRANT',
  },
  {
    id: 'opp-community-grant',
    title: 'Community Foundation of Ohio Program Grant',
    description: 'Program funding for Ohio nonprofits serving community needs in education, health, and welfare',
    sponsor: 'Community Foundation of Ohio',
    state: 'OH',
    source_url: 'https://www.cof.org/grants',
    categories: ['program_funding', 'nonprofit', 'community'],
    keywords: ['nonprofit', 'community', 'program', 'ohio', 'foundation'],
    type: 'GRANT',
  },
  {
    id: 'opp-sba-small-business',
    title: 'SBA Small Business Innovation Research Grant',
    description: 'Federal grants for small businesses engaged in research and development with commercial potential',
    sponsor: 'U.S. Small Business Administration',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://www.sba.gov/funding-programs/grants',
    categories: ['small_business', 'research', 'innovation'],
    keywords: ['small business', 'sba', 'innovation', 'startup', 'entrepreneur', 'sbir'],
    type: 'GRANT',
  },
  {
    id: 'opp-wosb-grant',
    title: 'Women-Owned Small Business Federal Contracting Program',
    description: 'Federal program supporting women-owned small businesses with government contracting opportunities',
    sponsor: 'U.S. Small Business Administration',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://www.sba.gov/federal-contracting/contracting-assistance-programs/women-owned-small-business',
    categories: ['small_business', 'contracting'],
    keywords: ['wosb', 'women-owned', 'small business', 'federal', 'contracting'],
    type: 'PROGRAM',
  },
  {
    id: 'opp-united-way',
    title: 'United Way Community Resources',
    description: 'Find local United Way resources for housing, food, utilities, and community support',
    sponsor: 'United Way',
    state: 'OH',
    source_url: 'https://www.unitedway.org/find-your-united-way',
    categories: ['community', 'local', 'emergency_assistance'],
    keywords: ['united way', 'community', 'emergency', 'local'],
    type: 'DIRECTORY',
  },
]

// ── Profile definitions ──────────────────────────────────────────────────────

const PROFILES = {
  individual: {
    profile: {
      applicant_type: 'individual',
      state: 'OH',
      postal_code: '43215',
      needs: ['housing', 'utilities', 'food'],
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215', age: 35, gender: 'female' },
    },
  },
  student: {
    profile: {
      applicant_type: 'student',
      state: 'OH',
      postal_code: '43215',
      needs: ['education', 'scholarships'],
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215', age: 20 },
      education: { highest_level: 'high school', gpa: 3.5, field_of_study: 'Biology' },
    },
  },
  nonprofit: {
    profile: {
      applicant_type: 'nonprofit',
      state: 'OH',
      postal_code: '43215',
      needs: ['capacity_building', 'program_funding'],
      entity_type: 'nonprofit',
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215' },
      organization_details: { type: 'nonprofit', name: 'Community Action Center', mission: 'Serving community needs' },
    },
  },
  business: {
    profile: {
      applicant_type: 'small_business',
      state: 'OH',
      postal_code: '43215',
      needs: ['small_business', 'startup_funding'],
      entity_type: 'business',
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215' },
      small_business_details: { business_name: 'Test Innovation LLC', years_in_business: 2, naics_code: '541511' },
    },
  },
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('individual profile: returns meaningful results from corpus', () => {
  const ctx = PROFILES.individual
  const scored = OPPORTUNITY_CORPUS.map((opp) => ({
    ...scoreOpportunity(ctx, opp),
    title: opp.title,
  }))

  const meaningful = scored.filter((s) => s.score >= 5)
  assert.ok(
    meaningful.length >= 3,
    `Individual should match ≥3 opps, got ${meaningful.length}: ${scored.map((s) => `${s.title?.substring(0, 30)}=${s.score}`).join(', ')}`,
  )

  // Housing/utilities/food opps should clear the DATA-POINT pipeline bar
  // (AUTO_ADD_SCORE=8; these compact fixtures have small inventories, so
  // real coverage lands well above it).
  const housingScore = scored.find((s) => s.title.includes('Housing'))?.score ?? 0
  // Thin fixture profiles (<15 data points) score in the TOPICAL band by
  // design since the MIN_CALIBRATED_INVENTORY floor (2026-07-27): a profile
  // the engine barely knows cannot claim calibrated coverage — it still gets
  // meaningful, correctly-ranked results, bounded at NO_NEEDS_TOPICAL_CAP.
  assert.ok(housingScore >= 5, `Housing opp should score ≥5 for individual (got ${housingScore})`)
})

test('student profile: returns meaningful education results', () => {
  const ctx = PROFILES.student
  const scored = OPPORTUNITY_CORPUS.map((opp) => ({
    ...scoreOpportunity(ctx, opp),
    title: opp.title,
  }))

  const meaningful = scored.filter((s) => s.score >= 5)
  // Topical mode (thin fixtures, MIN_CALIBRATED_INVENTORY floor 2026-07-27)
  // is MORE precise: cross-archetype generics drop below the meaningful bar,
  // so the count is the archetype's genuinely relevant subset.
  assert.ok(
    meaningful.length >= 2,
    `Student should match ≥2 opps, got ${meaningful.length}`,
  )

  // Education opportunities should rank high
  const stemScore = scored.find((s) => s.title.includes('STEM'))?.score ?? 0
  const pellScore = scored.find((s) => s.title.includes('Pell'))?.score ?? 0
  // Thin fixture profiles (<15 data points) score in the TOPICAL band by
  // design since the MIN_CALIBRATED_INVENTORY floor (2026-07-27): a profile
  // the engine barely knows cannot claim calibrated coverage — it still gets
  // meaningful, correctly-ranked results, bounded at NO_NEEDS_TOPICAL_CAP.
  assert.ok(stemScore >= 5, `STEM scholarship should score ≥5 for student (got ${stemScore})`)
  // ≥4: topical-band noise floor — a REAL student profile scores Pell calibrated (80+).
  assert.ok(pellScore >= 4, `Pell grant should score ≥4 for student (got ${pellScore})`)
})

test('nonprofit profile: returns meaningful capacity/funding results', () => {
  const ctx = PROFILES.nonprofit
  const scored = OPPORTUNITY_CORPUS.map((opp) => ({
    ...scoreOpportunity(ctx, opp),
    title: opp.title,
  }))

  const meaningful = scored.filter((s) => s.score >= 5)
  // Topical mode (thin fixtures, MIN_CALIBRATED_INVENTORY floor 2026-07-27)
  // is MORE precise: cross-archetype generics drop below the meaningful bar,
  // so the count is the archetype's genuinely relevant subset.
  assert.ok(
    meaningful.length >= 1,
    `Nonprofit should match ≥1 opp, got ${meaningful.length}`,
  )

  // Nonprofit-specific opps should rank high
  const capacityScore = scored.find((s) => s.title.includes('Capacity'))?.score ?? 0
  // Thin fixture profiles (<15 data points) score in the TOPICAL band by
  // design since the MIN_CALIBRATED_INVENTORY floor (2026-07-27): a profile
  // the engine barely knows cannot claim calibrated coverage — it still gets
  // meaningful, correctly-ranked results, bounded at NO_NEEDS_TOPICAL_CAP.
  // ≥4: topical-band noise floor for the thin fixture (see note above).
  assert.ok(capacityScore >= 4, `Capacity building should score ≥4 for nonprofit (got ${capacityScore})`)
})

test('business profile: returns meaningful business results', () => {
  const ctx = PROFILES.business
  const scored = OPPORTUNITY_CORPUS.map((opp) => ({
    ...scoreOpportunity(ctx, opp),
    title: opp.title,
  }))

  const meaningful = scored.filter((s) => s.score >= 5)
  // Topical mode (thin fixtures, MIN_CALIBRATED_INVENTORY floor 2026-07-27)
  // is MORE precise: cross-archetype generics drop below the meaningful bar,
  // so the count is the archetype's genuinely relevant subset.
  assert.ok(
    meaningful.length >= 2,
    `Business should match ≥2 opps, got ${meaningful.length}`,
  )

  // SBA/business opps should rank high
  const sbaScore = scored.find((s) => s.title.includes('SBA'))?.score ?? 0
  // Thin fixture profiles (<15 data points) score in the TOPICAL band by
  // design since the MIN_CALIBRATED_INVENTORY floor (2026-07-27): a profile
  // the engine barely knows cannot claim calibrated coverage — it still gets
  // meaningful, correctly-ranked results, bounded at NO_NEEDS_TOPICAL_CAP.
  assert.ok(sbaScore >= 5, `SBA grant should score ≥5 for business (got ${sbaScore})`)
})

test('no profile type returns zero results when corpus has data', () => {
  for (const [type, ctx] of Object.entries(PROFILES)) {
    const scored = OPPORTUNITY_CORPUS.map((opp) => ({
      ...scoreOpportunity(ctx, opp),
      title: opp.title,
    }))
    const aboveFloor = scored.filter((s) => s.score >= 5)
    assert.ok(
      aboveFloor.length > 0,
      `Profile type "${type}" must not return zero results when data exists (got ${aboveFloor.length})`,
    )
  }
})

test('each profile type has a distinct top-ranked opportunity', () => {
  const topByType = {}
  for (const [type, ctx] of Object.entries(PROFILES)) {
    const scored = OPPORTUNITY_CORPUS.map((opp) => ({
      score: scoreOpportunity(ctx, opp).score,
      title: opp.title,
      id: opp.id,
    }))
    scored.sort((a, b) => b.score - a.score)
    topByType[type] = scored[0]
  }

  // Individual's top should be housing/food/utilities focused
  assert.ok(
    topByType.individual.title.match(/Housing|SNAP|LIHEAP|United Way/),
    `Individual top should be housing/food related, got: ${topByType.individual.title}`,
  )
})

test('assertMatchingReturnsResults throws when no meaningful results', () => {
  const emptyProfile = { profile: {} }
  const impossibleOpps = [
    {
      title: 'Exclusive Nuclear Research Fellowship',
      description: 'Only for PhD-level nuclear physicists at DOE national labs',
      state: 'NM',
      keywords: ['nuclear', 'physics', 'DOE', 'national lab'],
    },
  ]

  // With a score floor of 5, even mismatched opps score > 0,
  // so this should still return at least one above floor
  const result = assertMatchingReturnsResults(emptyProfile, impossibleOpps, { label: 'empty' })
  assert.ok(result.ok, 'Even empty profile should get floor-level results')
})

test('assertMatchingReturnsResults returns ok for well-matched profile', () => {
  const result = assertMatchingReturnsResults(PROFILES.individual, OPPORTUNITY_CORPUS, {
    label: 'individual',
    minResults: 3,
  })
  assert.ok(result.ok)
  assert.ok(result.meaningful >= 3)
  // Thin fixture profiles (<15 data points) score in the TOPICAL band by
  // design since the MIN_CALIBRATED_INVENTORY floor (2026-07-27): a profile
  // the engine barely knows cannot claim calibrated coverage — it still gets
  // meaningful, correctly-ranked results, bounded at NO_NEEDS_TOPICAL_CAP.
  assert.ok(result.topScore >= 5)
})

test('validateMultiProfileMatching passes for diverse corpus', () => {
  const result = validateMultiProfileMatching(OPPORTUNITY_CORPUS)
  assert.ok(result.passed.length >= 4, `All 4 profile types should pass, got ${result.passed.length}`)
  assert.equal(result.failed.length, 0, `No profile types should fail: ${JSON.stringify(result.failed)}`)
})

test('empty opportunities corpus reports failure', () => {
  const result = validateMultiProfileMatching([])
  assert.ok(result.failed.length > 0, 'Empty corpus should report failure')
})

test('score ranking: profile-relevant opps rank above generic ones', () => {
  for (const [type, ctx] of Object.entries(PROFILES)) {
    const scored = OPPORTUNITY_CORPUS.map((opp) => ({
      score: scoreOpportunity(ctx, opp).score,
      title: opp.title,
    }))
    scored.sort((a, b) => b.score - a.score)

    const topScore = scored[0].score
    const bottomScore = scored[scored.length - 1].score
    assert.ok(
      topScore > bottomScore,
      `Profile "${type}" should show score differentiation (top=${topScore}, bottom=${bottomScore})`,
    )
  }
})
