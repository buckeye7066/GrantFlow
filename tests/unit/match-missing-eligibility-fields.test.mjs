/**
 * Mission System 3: the canonical match decision must surface the profile
 * fields that would strengthen a match (missingEligibilityFields) on the
 * ACCEPT/REVIEW path — not only on REJECT. Previously this was hardcoded to []
 * on the non-reject path, silently dropping "what's missing from your profile"
 * guidance for exactly the matches a user would act on.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeProfile } from '../../backend/services/profileNormalizer.js'
import { normalizeOpportunity } from '../../backend/services/opportunityNormalizer.js'
import {
  evaluateEligibility,
  computeMatchDecision,
} from '../../backend/services/matchDecisionEngine.js'

// Clearly-eligible individual with a housing need and a location, against a
// national housing grant whose ONLY gap is a missing application_url. That gap
// is a caveat (ACCEPT→REVIEW), not a hard reject — so the decision is non-REJECT
// and missingEligibilityFields must still be populated.
const RAW_PROFILE = {
  id: 'p-test',
  entity_type: 'individual',
  state: 'TN',
  zip: '37013',
  needs: ['housing'],
}
const RAW_OPP = {
  id: 'o-test',
  title: 'National Housing Assistance Grant',
  description: 'Direct grant funding for housing and rent assistance for individuals nationwide.',
  funding_type: 'grant',
  is_national: 1,
  need_types_supported: ['housing'],
  entity_types_allowed: ['individual'],
  // NOTE: deliberately no application_url / source_url
}

test('missingEligibilityFields is populated on a non-REJECT decision', () => {
  const decision = computeMatchDecision(RAW_PROFILE, RAW_OPP, {})

  assert.notEqual(decision.decision, 'REJECT', 'precondition: not a hard reject')
  assert.ok(Array.isArray(decision.missingEligibilityFields))
  assert.ok(
    decision.missingEligibilityFields.length > 0,
    'expected missing fields to be surfaced on the ACCEPT/REVIEW path',
  )
  assert.ok(
    decision.missingEligibilityFields.includes('application_url'),
    `expected application_url among missing fields, got ${JSON.stringify(decision.missingEligibilityFields)}`,
  )
})

test('missingEligibilityFields matches evaluateEligibility for the same inputs', () => {
  const pNorm = normalizeProfile(RAW_PROFILE, [])
  const oNorm = normalizeOpportunity(RAW_OPP)
  const elig = evaluateEligibility(pNorm, oNorm)
  const decision = computeMatchDecision(RAW_PROFILE, RAW_OPP, {})

  // The canonical decision must propagate the eligibility evaluator's findings,
  // not silently discard them.
  for (const field of elig.missingFields) {
    assert.ok(
      decision.missingEligibilityFields.includes(field),
      `decision dropped missing field "${field}"`,
    )
  }
})
