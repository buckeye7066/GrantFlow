/**
 * Larry — fit + urgency scoring.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { computeFitScore } from '../../backend/services/larry/larryFitScorer.js'
import {
  computeUrgencyScore,
  computeCompositeScore,
} from '../../backend/services/larry/larryUrgencyScorer.js'

test('non-grant-seeker types score 0', () => {
  const result = computeFitScore({ applicant_type: 'federal_agency' })
  assert.equal(result.score, 0)
})

test('volunteer fire department scores high on fit', () => {
  const result = computeFitScore({
    applicant_type: 'volunteer_fire_department',
    state: 'TN',
    city: 'Athens',
    ein: '12-3456789',
    website_url: 'https://athensvfd.org',
    contact_verification_status: 'verified',
    programs_json: ['turnout gear replacement'],
    signals_json: { recent_grant_history: '2024 AFG award' },
  })
  assert.ok(result.score >= 70, `expected ≥70, got ${result.score}`)
  const codes = result.reasons.map((r) => r.code)
  assert.ok(codes.includes('known_grant_seeker_type'))
  assert.ok(codes.includes('recent_grant_activity'))
})

test('missing fields do not produce negative scores', () => {
  const result = computeFitScore({ applicant_type: 'nonprofit' })
  assert.ok(result.score >= 0)
  assert.ok(Number.isFinite(result.score))
})

test('urgency: active capital campaign + recent disaster lifts score', () => {
  const result = computeUrgencyScore({
    signals_json: {
      active_capital_campaign: 'building expansion 2026',
      recent_disaster_in_region: 'tornado',
    },
  })
  assert.ok(result.score >= 40, `expected ≥40, got ${result.score}`)
  const codes = result.reasons.map((r) => r.code)
  assert.ok(codes.includes('active_capital_campaign'))
  assert.ok(codes.includes('recent_disaster_in_region'))
})

test('urgency: deadline >60 days out does not contribute', () => {
  const result = computeUrgencyScore({
    signals_json: {
      upcoming_grant_deadline: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    },
  })
  const codes = result.reasons.map((r) => r.code)
  assert.equal(codes.includes('public_funding_deadline_pressure'), false)
})

test('composite is 70/30 fit/urgency weighted', () => {
  assert.equal(computeCompositeScore({ fit_score: 100, urgency_score: 0 }), 70)
  assert.equal(computeCompositeScore({ fit_score: 0, urgency_score: 100 }), 30)
  assert.equal(computeCompositeScore({ fit_score: 100, urgency_score: 100 }), 100)
})
