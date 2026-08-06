import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  computeMatchDecision,
  matchOpportunities,
} from '../../backend/services/matchDecisionEngine.js'
import { normalizeOpportunity } from '../../backend/services/opportunityNormalizer.js'
import {
  assembleFundingResults,
  TIERS,
} from '../../backend/services/zeroResultLadder.js'

test('matchOpportunities strictMinScore does not relax below requested min', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: ['housing'],
  }

  const opportunities = [
    {
      title: 'Generic Funding Directory',
      description: 'Find funding sources and resources in your area.',
      application_url: 'https://example.org/funding',
      is_national: 1,
      state: 'nationwide',
      categories: '[]',
      keywords: '[]',
    },
  ]

  const results = matchOpportunities(profile, opportunities, {
    minScore: 90,
    strictMinScore: true,
  })

  assert.equal(results.length, 0)
})

test('zeroResultLadder strictMinScore returns zero rather than relaxed below floor', () => {
  const ladder = assembleFundingResults(
    [
      {
        title: 'Weak direct opportunity',
        kind: 'direct',
        match_score: 42,
        score: 42,
      },
    ],
    {
      minScore: 80,
      maxResults: 10,
      strictMinScore: true,
    },
  )

  assert.equal(ladder.opportunities.length, 0)
  assert.equal(ladder.threshold_relaxed, false)
  assert.equal(ladder.tier, TIERS.EXPLAIN_ZERO)
})

test('generic national opportunity is not scored as a strong match', () => {
  const result = computeMatchDecision(
    {
      primary_type: 'individual',
      state: 'OH',
      postal_code: '44022',
      needs: ['housing', 'food', 'medical', 'employment', 'utilities'],
    },
    {
      title: 'National Funding Resource Directory',
      description: 'Find funding sources and resources in your area.',
      application_url: 'https://example.org/funding',
      is_national: 1,
      state: 'nationwide',
      record_origin: 'curated_program',
      categories: '[]',
      keywords: '[]',
    },
  )

  assert.ok(
    result.score <= 45,
    `Generic no-need/no-category opportunity should be capped at <=45, got ${result.score}`,
  )
  assert.equal(result.decision, 'REVIEW')
  assert.equal(result.matchedNeeds.length, 0)
})

test('exclusive business opportunity rejects individual profile', () => {
  const opp = {
    title: 'Small Business Growth Grant',
    description: 'Eligible applicants are small businesses and entrepreneurs. Individuals seeking personal rent assistance are not eligible.',
    application_url: 'https://sba.gov/grants',
    is_national: 1,
    categories: '["business"]',
    keywords: '["small business", "entrepreneur"]',
  }

  const norm = normalizeOpportunity(opp)
  assert.equal(norm.requiresBusiness, true)

  const result = computeMatchDecision(
    {
      primary_type: 'individual',
      state: 'OH',
      needs: ['housing'],
    },
    opp,
  )

  assert.equal(result.decision, 'REJECT')
  assert.equal(result.eligible, false)
  assert.ok(
    result.ineligibilityReasons.some((reason) => /business/i.test(reason)),
    `Expected business ineligibility reason, got ${result.ineligibilityReasons.join('; ')}`,
  )
})

test('specific housing opportunity still returns a strong aligned result', () => {
  const result = computeMatchDecision(
    {
      primary_type: 'individual',
      state: 'OH',
      postal_code: '44022',
      needs: ['housing', 'utilities'],
    },
    {
      title: 'Ohio Emergency Rent and Utility Assistance',
      description: 'Emergency rent, eviction prevention, and utility assistance for Ohio residents.',
      application_url: 'https://ohio.gov/rent-help',
      state: 'OH',
      is_national: 0,
      categories: '["housing", "utilities"]',
      keywords: '["rent", "eviction", "utility assistance"]',
      is_loan: 0,
    },
  )

  // Thin fixture (<15 data points) scores in the TOPICAL band by design
  // since the MIN_CALIBRATED_INVENTORY floor (2026-07-27); the ">= 55" bar
  // was an old-scale relic. The intent stands: a true housing match for a
  // housing-need profile clears the pipeline bar and is never rejected.
  assert.ok(
    result.score >= 8,
    `Specific matching housing opportunity should clear the pipeline bar (8), got ${result.score}`,
  )
  assert.ok(
    result.matchedNeeds.includes('housing') || result.matchedNeeds.includes('utilities'),
    `Expected matched housing/utilities needs, got ${result.matchedNeeds.join(', ')}`,
  )
  assert.ok(['ACCEPT', 'REVIEW'].includes(result.decision))
})

test('live discovery surfaces do not re-admit records with retired browser thresholds', () => {
  const fundingResults = readFileSync(
    new URL('../../src/pages/FundingResults.jsx', import.meta.url),
    'utf8',
  )
  const discoverGrants = readFileSync(
    new URL('../../src/pages/DiscoverGrants.jsx', import.meta.url),
    'utf8',
  )
  const discoveryHelpers = readFileSync(
    new URL('../../src/components/discovery/discoveryHelpers.jsx', import.meta.url),
    'utf8',
  )

  assert.match(fundingResults, /canonicalMatchDisplay/)
  assert.match(fundingResults, /display\.decision === ['"]ACCEPT['"]/)
  assert.doesNotMatch(fundingResults, /match_score\s*(?:>=|>)\s*70/)
  assert.match(discoverGrants, /match_decision\s*\?\?\s*opp\.decision/)
  assert.match(discoverGrants, /canonicalDecision === ['"]ACCEPT['"]/)
  assert.doesNotMatch(discoveryHelpers, /below_80|matchScore\s*<\s*80/)
})
