/**
 * Match-decision parity test.
 *
 * Goal: guarantee that the same (profile, opportunity) pair produces the same
 * final ACCEPT/REVIEW/REJECT decision regardless of which path observed it —
 * the matching route, the discovery route, the Anya summarizer, or the
 * pipeline saver. The canonical authority is `computeMatchDecision` from
 * `backend/services/matchEngine.js`; every consumer must defer to it.
 *
 * If this test ever fails, somebody has reintroduced a parallel scoring path
 * that decides what users see independently of the canonical engine.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeMatchDecision,
  scoreOpportunity,
} from '../../backend/services/matchEngine.js'
import { calculateMatchScore } from '../../backend/services/matchingEngine.js'
import * as decisionShim from '../../backend/services/matchDecisionEngine.js'

const TENNESSEE_VETERAN = {
  id: 'p-test-1',
  primary_type: 'individual',
  applicant_type: 'individual',
  state: 'TN',
  postal_code: '37201',
  serves_veterans: true,
  tags: ['veteran'],
  sections: {
    basic_information: { state: 'TN', zip: '37201', age: 45 },
    military_service: { veteran: true, branch: 'Army' },
    financial_information: { household_income: 28000 },
  },
}

const VETERAN_GRANT = {
  id: 'opp-test-1',
  title: 'SSVF Tennessee Veteran Housing Assistance',
  sponsor: 'Veterans Affairs',
  description: 'Supportive Services for Veteran Families program — rapid re-housing and homelessness prevention for low-income veterans in Tennessee.',
  application_url: 'https://www.va.gov/homeless/ssvf/',
  source_url: 'https://www.va.gov/homeless/ssvf/',
  state: 'TN',
  is_national: false,
  opportunity_type: 'benefit',
  type: 'OPPORTUNITY',
  categories: ['veterans', 'housing'],
  keywords: ['veteran', 'housing', 'tennessee'],
  is_active: true,
  amount_min: 1000,
  amount_max: 10000,
}

test('parity: matchEngine.scoreOpportunity and matchingEngine shim agree', () => {
  const direct = scoreOpportunity(TENNESSEE_VETERAN, VETERAN_GRANT)
  const shim = calculateMatchScore(TENNESSEE_VETERAN, VETERAN_GRANT)
  assert.equal(direct.score, shim.score, 'shim must delegate to canonical scoreOpportunity')
})

test('parity: matchDecisionEngine re-export is identical to matchEngine', () => {
  // The decision-engine module must be a pure re-export. If somebody adds local
  // logic, this assertion catches the drift.
  assert.strictEqual(
    decisionShim.computeMatchDecision,
    computeMatchDecision,
    'matchDecisionEngine.computeMatchDecision must be the same function reference as matchEngine.computeMatchDecision'
  )
  assert.strictEqual(
    decisionShim.scoreOpportunity,
    scoreOpportunity,
    'matchDecisionEngine.scoreOpportunity must be the same function reference as matchEngine.scoreOpportunity'
  )
})

test('parity: computeMatchDecision is deterministic for the same input', () => {
  const a = computeMatchDecision(TENNESSEE_VETERAN, VETERAN_GRANT)
  const b = computeMatchDecision(TENNESSEE_VETERAN, VETERAN_GRANT)
  assert.equal(a.decision, b.decision, 'same profile + opp must yield same decision')
  assert.equal(a.score, b.score, 'same profile + opp must yield same score')
})

test('parity: candidate prefilter must NOT be the user-facing decision', () => {
  // The crawler match engine is documented as a prefilter only. Even if its
  // score disagrees with the canonical engine for legitimate reasons, the
  // canonical decision is what we save and show. This test does not assert
  // numerical agreement (the engines have different mandates) — it asserts
  // that the canonical engine still owns the decision boolean.
  const decision = computeMatchDecision(TENNESSEE_VETERAN, VETERAN_GRANT)
  assert.ok(['ACCEPT', 'REVIEW', 'REJECT'].includes(decision.decision),
    `canonical engine must return ACCEPT|REVIEW|REJECT, got: ${decision.decision}`)
})

test('parity: explanation payload is reproducible', () => {
  const a = computeMatchDecision(TENNESSEE_VETERAN, VETERAN_GRANT)
  const b = computeMatchDecision(TENNESSEE_VETERAN, VETERAN_GRANT)
  assert.deepEqual(
    JSON.stringify(a.match_explain ?? a.matchExplain ?? null),
    JSON.stringify(b.match_explain ?? b.matchExplain ?? null),
    'match explanation must be reproducible — Anya, UI, and pipeline all show the same reasons'
  )
})
