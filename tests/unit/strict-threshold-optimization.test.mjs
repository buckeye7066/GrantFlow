import test from 'node:test'
import assert from 'node:assert/strict'

import { matchOpportunities } from '../../backend/services/matchDecisionEngine.js'
import {
  assembleFundingResults,
  TIERS,
} from '../../backend/services/zeroResultLadder.js'

test('matchOpportunities strictMinScore does not relax below requested minimum', () => {
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

test('zeroResultLadder strictMinScore returns no relaxed opportunities below floor', () => {
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
