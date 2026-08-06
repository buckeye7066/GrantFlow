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

test('formatMatchDeadline distinguishes explicitly rolling from an unknown deadline', () => {
  assert.equal(formatMatchDeadline({ deadline_type: 'rolling' }), 'Rolling / ongoing')
  assert.equal(formatMatchDeadline({ is_rolling: true }), 'Rolling / ongoing')
  assert.equal(formatMatchDeadline({ deadline_type: 'fixed' }), null)
})

test('buildPotentialFundingSummary never adds unknown amounts as guaranteed totals', () => {
  const matches = [
    { match_score: 17, match_decision: 'ACCEPT', amount_min: 5000, amount_max: 10000 },
    { match_score: 11, match_decision: 'ACCEPT', amount_min: 0, amount_max: 25000 },
    { match_score: 8, match_decision: 'REVIEW' }, // no amount
    { match_score: null, amount_max: 0 }, // no amount, no canonical decision
  ]
  const s = buildPotentialFundingSummary(matches)
  assert.equal(s.total_matches, 4)
  assert.equal(s.accepted_matches, 2)
  assert.equal(s.review_matches, 1)
  assert.equal(s.unrated_matches, 1)
  assert.equal(s.rejected_matches, 0)
  assert.equal(s.amount_unknown_count, 2)
  assert.equal(s.potential_low_total, 5000)
  assert.equal(s.potential_high_total, 35000)
})

test('buildPotentialFundingSummary on an empty list returns zeroes', () => {
  const s = buildPotentialFundingSummary([])
  assert.equal(s.total_matches, 0)
  assert.equal(s.accepted_matches, 0)
  assert.equal(s.review_matches, 0)
  assert.equal(s.unrated_matches, 0)
  assert.equal(s.rejected_matches, 0)
  assert.equal(s.potential_low_total, 0)
  assert.equal(s.potential_high_total, 0)
})
