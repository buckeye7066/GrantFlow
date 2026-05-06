/**
 * Mission test suite — match parity
 *
 * Mission rule (Phase 2): the same profile + same opportunity must produce
 * the same canonical decision in every code path that displays or saves a
 * match (matching route, discovery route, Anya summary, pipeline save,
 * crawler dispatcher).
 *
 * computeMatchDecision() is the SOLE final scoring/decision authority. The
 * crawler-side prefilters (crawlers/matchEngine.js + comprehensiveCrawler-
 * Optimized.calculateOpportunityMatch) MUST NOT diverge from it for any
 * persisted/displayed result.
 *
 * What this suite asserts:
 *   1. computeMatchDecision is deterministic for the same inputs.
 *   2. computeMatchDecision returns the structured fields every consumer
 *      relies on (score, decision, matched_profile_facts, ineligibility...).
 *   3. crawlers/matchEngine declares its prefilter role explicitly.
 *   4. comprehensiveCrawler's calculateOpportunityMatch lives in a file that
 *      explicitly documents itself as a prefilter, not the match authority.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { computeMatchDecision, MATCHER_VERSION } from '../../backend/services/matchEngine.js'
import { PREFILTER_ROLE } from '../../backend/services/crawlers/matchEngine.js'

const PROFILE = {
  id: 'p-fixture',
  applicant_type: 'volunteer_fire',
  organization_type: 'volunteer_fire_department',
  state: 'TN',
  zip: '38501',
  needs: ['equipment', 'training'],
}

const OPPORTUNITY = {
  id: 'opp-fixture',
  title: 'FEMA AFG — Rural Equipment Grant',
  application_url: 'https://www.fema.gov/grants/preparedness/firefighters',
  source_url: 'https://www.fema.gov/grants/preparedness/firefighters',
  source: 'grants.gov',
  record_origin: 'grants_gov',
  state: 'nationwide',
  is_national: true,
  categories: ['equipment', 'fire'],
  keywords: ['volunteer fire', 'equipment', 'rural'],
  opportunity_type: 'grant',
  deadline: '2099-12-31',
  amount_min: 5000,
  amount_max: 50000,
}

test('parity: computeMatchDecision is deterministic for the same inputs', () => {
  const a = computeMatchDecision(PROFILE, OPPORTUNITY)
  const b = computeMatchDecision(PROFILE, OPPORTUNITY)
  // evaluatedAt is intentionally non-deterministic; everything else must match.
  delete a.evaluatedAt
  delete b.evaluatedAt
  assert.deepEqual(a, b, 'two back-to-back calls returned different results')
})

test('parity: computeMatchDecision exposes all canonical fields consumers rely on', () => {
  const result = computeMatchDecision(PROFILE, OPPORTUNITY)
  const required = [
    'score',
    'reasons',
    'match_explain',
    'decision',
    'explanation',
    'eligible',
    'ineligibilityReasons',
    'matchedNeeds',
    'matchedProfileTraits',
    'matched_profile_facts',
    'needAlignment',
    'confidence',
    'matcherVersion',
    'evaluatedAt',
  ]
  for (const field of required) {
    assert.ok(field in result, `canonical decision payload is missing field: ${field}`)
  }
  assert.equal(result.matcherVersion, MATCHER_VERSION)
  assert.ok(Array.isArray(result.matched_profile_facts), 'matched_profile_facts must be array')
})

test('parity: matched_profile_facts surfaces real profile data (mission rule "what facts caused this to appear?")', () => {
  const result = computeMatchDecision(PROFILE, OPPORTUNITY)
  // Profile state must appear — it's a basic explainability requirement.
  const hasState = result.matched_profile_facts.some((f) => /TN|tennessee/i.test(f))
  assert.ok(
    hasState,
    `matched_profile_facts must include profile state. Got: ${JSON.stringify(result.matched_profile_facts)}`,
  )
})

test('parity: invalid inputs produce a structured REVIEW decision (no throw)', () => {
  const result = computeMatchDecision(null, OPPORTUNITY)
  assert.equal(result.decision, 'REVIEW')
  assert.equal(result.eligible, 'maybe')
  assert.ok(result.matcherVersion)
})

test('parity: crawler matchEngine declares CANDIDATE_PREFILTER role', () => {
  assert.equal(
    PREFILTER_ROLE,
    'CANDIDATE_PREFILTER',
    'crawlers/matchEngine.js must self-identify as a prefilter, not a match authority',
  )
})

test('parity: comprehensiveCrawlerOptimized documents calculateOpportunityMatch as a prefilter', () => {
  // Source-level guard: the file must contain the explicit "CANDIDATE
  // PREFILTER" disclaimer above calculateOpportunityMatch so future readers
  // and refactors don't accidentally promote its score to authority.
  const filePath = path.resolve(
    'backend/services/comprehensiveCrawlerOptimized.js',
  )
  const text = fs.readFileSync(filePath, 'utf8')
  const idx = text.indexOf('function calculateOpportunityMatch')
  assert.ok(idx > 0, 'calculateOpportunityMatch must exist in comprehensiveCrawlerOptimized.js')
  const headerWindow = text.slice(Math.max(0, idx - 600), idx)
  assert.ok(
    /CANDIDATE PREFILTER/i.test(headerWindow),
    'calculateOpportunityMatch must declare itself as a CANDIDATE PREFILTER in its docblock',
  )
  assert.ok(
    /computeMatchDecision/.test(headerWindow),
    'calculateOpportunityMatch must defer to computeMatchDecision in its docblock',
  )
})
