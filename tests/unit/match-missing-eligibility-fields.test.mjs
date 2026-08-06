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
// women-only national housing grant. The profile does not declare gender, so
// eligibility is honestly unknown (REVIEW), not a hard reject, and the missing
// field must remain visible. Missing all source/action URLs is intentionally not
// used here because the canonical source-quality contract rejects that unsafe
// direct-opportunity state.
const RAW_PROFILE = {
  id: 'p-test',
  entity_type: 'individual',
  primary_type: 'individual',
  state: 'TN',
  zip: '37013',
  needs: ['housing'],
}
const RAW_OPP = {
  id: 'o-test',
  title: 'Women Only National Housing Assistance Grant',
  description: 'Direct grant funding for housing and rent assistance for women nationwide.',
  funding_type: 'grant',
  is_national: 1,
  need_types_supported: ['housing'],
  entity_types_allowed: ['individual'],
  application_url: 'https://example.org/apply',
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
    decision.missingEligibilityFields.includes('gender'),
    `expected gender among missing fields, got ${JSON.stringify(decision.missingEligibilityFields)}`,
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
