import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatMatchAmount,
  formatMatchDeadline,
  buildPotentialFundingSummary,
} from '../../src/components/anya/anyaResultsFormatters.js'

test('formatMatchAmount renders a known min-max range', () => {
  assert.equal(formatMatchAmount({ amount_min: 5000, amount_max: 25000 }), '$5,000 – $25,000')
})

test('formatMatchAmount falls back to "Up to $X" when only max is known', () => {
  assert.equal(formatMatchAmount({ amount_max: 10000 }), 'Up to $10,000')
})

test('formatMatchAmount returns "Amount varies" when nothing is known', () => {
  assert.equal(formatMatchAmount({}), 'Amount varies')
})

test('formatMatchAmount honors amount_description as a label', () => {
  assert.equal(formatMatchAmount({ amount_description: 'Up to one tank of fuel' }), 'Up to one tank of fuel')
})

test('formatMatchDeadline returns null when there is no deadline', () => {
  assert.equal(formatMatchDeadline({}), null)
})

test('buildPotentialFundingSummary never adds unknown amounts as guaranteed totals', () => {
  const matches = [
    { match_score: 0.9, amount_min: 5000, amount_max: 10000 },
    { match_score: 0.8, amount_min: 0, amount_max: 25000 },
    { match_score: 0.6 }, // no amount
    { match_score: 0.5, amount_max: 0 }, // no amount
  ]
  const s = buildPotentialFundingSummary(matches)
  assert.equal(s.total_matches, 4)
  assert.equal(s.strong_matches, 2)
  assert.equal(s.review_matches, 2)
  assert.equal(s.amount_unknown_count, 2)
  assert.equal(s.potential_low_total, 5000)
  assert.equal(s.potential_high_total, 35000)
})

test('buildPotentialFundingSummary on an empty list returns zeroes', () => {
  const s = buildPotentialFundingSummary([])
  assert.equal(s.total_matches, 0)
  assert.equal(s.strong_matches, 0)
  assert.equal(s.review_matches, 0)
  assert.equal(s.potential_low_total, 0)
  assert.equal(s.potential_high_total, 0)
})
