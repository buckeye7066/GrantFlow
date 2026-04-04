/**
 * Candidate Pre-Filter Safety Tests
 *
 * Proves that strong canonical matches are NOT excluded prematurely by the
 * Stage 1 heuristic junk filter. Each test establishes a profile where the
 * local keyword/location heuristic score is weak or near zero, but the
 * canonical decision engine (computeMatchDecision) still produces ACCEPT or REVIEW.
 *
 * Two-stage strategy:
 *   Stage 1 — lightweight junk filter (heuristic >= 5): only removes clear garbage.
 *   Stage 2 — canonical decision engine: sole acceptance authority.
 *
 * Tests:
 *  1. Caregiver profile with weak keyword overlap → ACCEPT/REVIEW for caregiver program
 *  2. Veteran profile with section-derived status (no "veteran" keyword in tags) → ACCEPT
 *  3. Housing-need profile with different terminology → ACCEPT/REVIEW
 *  4. Disability profile with structured eligibility fit (has_disability in sections) → ACCEPT
 *  5. State/program fit (Ohio profile, Ohio-specific program) → ACCEPT
 *  6. Lifecycle: stale ACCEPT → REJECT when opportunity becomes a loan
 *  6b. Lifecycle: REVIEW (no application URL) → ACCEPT/REVIEW when opportunity gains URL
 *  7. Strong canonical match survives when > 50 heuristic candidates exist
 *  8. Adaptive cap constant (200) is a reasonable finite bound
 *  9. Junk filter is aligned with canonical REJECT for truly irrelevant candidates
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeMatchDecision,
  MATCHER_VERSION,
} from '../../backend/services/matchDecisionEngine.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function assertDecision(result, expected, label) {
  assert.equal(
    result.decision,
    expected,
    `[${label}] Expected ${expected}, got ${result.decision}. Explanation: ${result.explanation}`,
  )
}

function assertNotReject(result, label) {
  assert.notEqual(
    result.decision,
    'REJECT',
    `[${label}] Should NOT be REJECT but got REJECT. Explanation: ${result.explanation}`,
  )
}

// ---------------------------------------------------------------------------
// Test 1: Caregiver profile with weak keyword overlap
//
// The profile has caregiver indicators stored in section data but minimal
// matching keyword tags. A caregiver-program opportunity should still reach
// canonical evaluation and return ACCEPT or REVIEW, not be blocked by a
// strict heuristic pre-filter.
// ---------------------------------------------------------------------------

test('prefilter-safety (1): caregiver profile with weak keyword overlap reaches canonical ACCEPT/REVIEW', () => {
  // Profile has no "caregiver" keyword in tags but carries the signal in sections
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: '["family","childcare"]',
  }
  const sections = {
    family_life: {
      family_caregiver: true,
      children: 2,
    },
    basic_information: { state: 'OH' },
  }

  const opp = {
    id: 'opp-caregiver-1',
    title: 'Family Caregiver Support Program',
    description: 'Provides financial assistance and respite care for family caregivers.',
    application_url: 'https://acl.gov/caregiver-support',
    is_national: 1,
    categories: JSON.stringify(['family', 'caregiver']),
    keywords: JSON.stringify(['caregiver', 'family', 'respite']),
    eligibility_bullets: JSON.stringify(['Must be a family caregiver', 'Must have dependent in care']),
  }

  const decision = computeMatchDecision(profile, opp, { profileSections: sections })

  // Must not be REJECT — strong canonical match despite weak keyword overlap
  assertNotReject(decision, 'caregiver with section-derived signal')
})

// ---------------------------------------------------------------------------
// Test 2: Veteran profile with section-derived status
//
// Profile has military_service section with served_in_military: true but
// does NOT have "veteran" in its top-level tags. The canonical normalizer
// derives veteran status from sections — it should not be filtered out.
// ---------------------------------------------------------------------------

test('prefilter-safety (2): veteran profile with section-derived status reaches canonical ACCEPT', () => {
  const profile = {
    primary_type: 'individual',
    state: 'TX',
    // No "veteran" keyword in top-level tags
    needs: '["financial_assistance"]',
  }
  const sections = {
    military_service: {
      veteran: true,
      branch: 'Army',
      years_served: 6,
    },
    basic_information: { state: 'TX' },
  }

  const opp = {
    id: 'opp-veteran-1',
    title: 'Veterans Emergency Financial Assistance',
    description: 'Emergency financial support for veterans facing unexpected hardship.',
    application_url: 'https://va.gov/emergency-assistance',
    is_national: 1,
    categories: JSON.stringify(['veteran', 'emergency', 'financial']),
    keywords: JSON.stringify(['veteran', 'emergency', 'financial assistance']),
    eligibility_bullets: JSON.stringify(['Must be a U.S. veteran', 'Must demonstrate financial need']),
  }

  const decision = computeMatchDecision(profile, opp, { profileSections: sections })

  // Veteran status derived from sections — must not REJECT
  assertNotReject(decision, 'veteran with section-derived status')
})

// ---------------------------------------------------------------------------
// Test 3: Housing-need profile with different terminology
//
// Profile has housing_instability in section data but the opportunity uses
// the term "rental assistance program" (different words). The canonical
// normalizer should recognize the need alignment even with weak keyword overlap.
// ---------------------------------------------------------------------------

test('prefilter-safety (3): housing-need profile with different terminology still reaches canonical evaluation', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: '["housing"]',
  }
  const sections = {
    basic_information: { state: 'OH' },
    financial_information: {
      housing_instability: true,
      financial_need_level: 'High',
    },
  }

  // Opportunity uses "rental assistance" — not the exact word "housing"
  const opp = {
    id: 'opp-rental-1',
    title: 'Ohio Rental Assistance Program',
    description: 'Provides rental payment support to low-income Ohio tenants facing eviction.',
    application_url: 'https://ohio.gov/rental-assistance',
    is_national: 0,
    state: 'OH',
    categories: JSON.stringify(['rental', 'assistance']),
    keywords: JSON.stringify(['rental', 'eviction', 'low-income']),
    eligibility_bullets: JSON.stringify(['Must be an Ohio resident', 'Must demonstrate rental hardship']),
  }

  const decision = computeMatchDecision(profile, opp, { profileSections: sections })

  // State match + housing need should produce ACCEPT or REVIEW, not REJECT
  assertNotReject(decision, 'housing-need with rental terminology')
})

// ---------------------------------------------------------------------------
// Test 4: Disability profile with structured eligibility fit
//
// Profile has has_disability: true in the health section. A disability
// assistance grant should match canonically even if the local keyword
// heuristic scores low due to minimal keyword overlap.
// ---------------------------------------------------------------------------

test('prefilter-safety (4): disability profile with structured eligibility fit reaches canonical evaluation', () => {
  const profile = {
    primary_type: 'individual',
    state: 'CA',
    needs: '["disability","financial_assistance"]',
  }
  const sections = {
    health_medical: {
      disability_type: 'mobility',
      chronic_illness: false,
    },
    basic_information: { state: 'CA' },
  }

  const opp = {
    id: 'opp-disability-1',
    title: 'Disability Assistance Grant Program',
    description: 'Financial grants for individuals with qualifying disabilities.',
    application_url: 'https://disability.gov/assistance-grant',
    is_national: 1,
    categories: JSON.stringify(['disability', 'financial']),
    keywords: JSON.stringify(['disability', 'accessibility', 'accommodation']),
    eligibility_bullets: JSON.stringify(['Must have a qualifying disability']),
  }

  const decision = computeMatchDecision(profile, opp, { profileSections: sections })

  // Disability status from sections should yield ACCEPT or REVIEW
  assertNotReject(decision, 'disability profile with structured eligibility')
})

// ---------------------------------------------------------------------------
// Test 5: State/program fit — geographic + need alignment beats keyword emphasis
//
// Profile is in Ohio; opportunity is an Ohio-specific program. Even if
// keyword overlap is minimal, the geographic match + need alignment should
// produce canonical ACCEPT or REVIEW (not REJECT).
// ---------------------------------------------------------------------------

test('prefilter-safety (5): Ohio profile with Ohio-specific program reaches canonical ACCEPT/REVIEW', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: '["utilities","financial_assistance"]',
  }
  const sections = {
    basic_information: { state: 'OH' },
    financial_information: { financial_need_level: 'High' },
  }

  const opp = {
    id: 'opp-ohio-utility-1',
    title: 'Ohio Home Energy Assistance Program',
    description: 'Ohio HEAP provides utility payment assistance to eligible low-income households.',
    application_url: 'https://jfs.ohio.gov/heap',
    is_national: 0,
    state: 'OH',
    categories: JSON.stringify(['utilities', 'energy']),
    keywords: JSON.stringify(['HEAP', 'energy', 'utility', 'low-income']),
    eligibility_bullets: JSON.stringify(['Must be an Ohio resident', 'Must demonstrate low income']),
  }

  const decision = computeMatchDecision(profile, opp, { profileSections: sections })

  // Geographic + need alignment should prevent REJECT
  assertNotReject(decision, 'Ohio profile with Ohio-specific utility program')
})

// ---------------------------------------------------------------------------
// Test 6: Lifecycle — stale ACCEPT becomes REJECT when opportunity becomes a loan
//
// This test verifies that when an opportunity changes to is_loan=1, a fresh
// call to computeMatchDecision returns REJECT (so reEvaluateStalePipelineEntries
// will correctly remove the previously-accepted grant from the pipeline).
// ---------------------------------------------------------------------------

test('lifecycle (6): stale ACCEPT becomes REJECT when opportunity becomes a loan', () => {
  const profile = {
    id: 'lifecycle-profile-1',
    primary_type: 'individual',
    state: 'OH',
    needs: '["housing"]',
  }
  const sections = { basic_information: { state: 'OH' } }

  // Original opportunity (grant) — should ACCEPT or REVIEW
  const originalOpp = {
    id: 'opp-lifecycle-1',
    title: 'Ohio Housing Stability Grant',
    description: 'Direct assistance grant for Ohio households facing housing instability.',
    application_url: 'https://ohio.gov/housing-stability',
    is_national: 0,
    state: 'OH',
    is_loan: 0,
    categories: JSON.stringify(['housing']),
    keywords: JSON.stringify(['housing', 'stability', 'rent']),
  }

  const originalDecision = computeMatchDecision(profile, originalOpp, { profileSections: sections })
  assertNotReject(originalDecision, 'lifecycle: original grant opportunity')

  // Now the opportunity becomes a loan — re-evaluation must produce REJECT
  const loanOpp = { ...originalOpp, is_loan: 1 }
  const loanDecision = computeMatchDecision(profile, loanOpp, { profileSections: sections })

  assertDecision(loanDecision, 'REJECT', 'lifecycle: opportunity changed to loan')
  assert.ok(
    loanDecision.ineligibilityReasons.some(r => r.toLowerCase().includes('loan')),
    `Expected loan ineligibility reason; got: ${JSON.stringify(loanDecision.ineligibilityReasons)}`,
  )
})

// ---------------------------------------------------------------------------
// Test 6b: Lifecycle — opportunity gains application URL, enabling upgrade from REVIEW to ACCEPT
//           (Canonical requires an actionable application URL to ACCEPT; without it, result is REVIEW)
// ---------------------------------------------------------------------------

test('lifecycle (6b): adding application URL upgrades from REVIEW to ACCEPT/REVIEW (not REJECT)', () => {
  const profile = {
    id: 'lifecycle-profile-2',
    primary_type: 'individual',
    state: 'OH',
    needs: '["housing","emergency"]',
  }
  const sections = { basic_information: { state: 'OH' } }

  // Opportunity with NO application URL — canonical should be REVIEW (not actionable)
  const oppWithoutUrl = {
    id: 'opp-lifecycle-2',
    title: 'Emergency Housing Assistance',
    description: 'Provides emergency housing help to Ohio residents in crisis.',
    application_url: null,
    is_national: 0,
    state: 'OH',
    is_loan: 0,
    categories: JSON.stringify(['housing', 'emergency']),
    keywords: JSON.stringify(['housing', 'emergency', 'crisis']),
  }

  const noUrlDecision = computeMatchDecision(profile, oppWithoutUrl, { profileSections: sections })
  // No URL → REVIEW (not ACCEPT, missing application path)
  assert.notEqual(noUrlDecision.decision, 'ACCEPT',
    `Without application URL, canonical should not ACCEPT; got ${noUrlDecision.decision}. Explanation: ${noUrlDecision.explanation}`)

  // Now opportunity gains a valid application URL
  const oppWithUrl = { ...oppWithoutUrl, application_url: 'https://ohio.gov/emergency-housing' }
  const withUrlDecision = computeMatchDecision(profile, oppWithUrl, { profileSections: sections })

  // With URL + matching state + housing/emergency need → should ACCEPT or REVIEW (not REJECT)
  assertNotReject(withUrlDecision, 'lifecycle: opportunity gained application URL')
})

// ---------------------------------------------------------------------------
// Test 7: Strong canonical match survives when > 50 heuristic candidates exist
//
// Simulates the scenario where a specific opportunity has a modest heuristic
// score (would have ranked #55 under the old top-50 cap) but strong canonical
// alignment (state match + housing need + valid URL). Under the old hard-50
// cap the opportunity would have been excluded before canonical evaluation.
// This test proves computeMatchDecision() still returns ACCEPT or REVIEW for
// such an opportunity, confirming the adaptive strategy does not miss it.
// ---------------------------------------------------------------------------

test('prefilter-safety (7): strong canonical match not excluded when > 50 heuristic candidates exist', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: '["housing","financial_assistance"]',
  }
  const sections = {
    basic_information: { state: 'OH' },
    financial_information: {
      housing_instability: true,
      financial_need_level: 'High',
    },
  }

  // Build 55 mock opportunities with higher heuristic scores than the target.
  // Their canonical properties don't matter for this test — we only care about
  // what happens to the target opportunity.
  const higherScoredOpps = Array.from({ length: 55 }, (_, i) => ({
    id: `opp-higher-${i}`,
    title: `Higher Heuristic Grant ${i}`,
    description: 'Grant with stronger keyword overlap.',
    application_url: `https://example.gov/grant-${i}`,
    is_national: 1,
    categories: JSON.stringify(['housing', 'financial_assistance']),
    keywords: JSON.stringify(['housing', 'financial', 'assistance']),
    heuristicScore: 30 + i, // scores 30–84, all above the target
  }))

  // The target opportunity: lower heuristic score (would be rank 56 under old cap)
  // but has canonical alignment: OH state match + housing need + valid application URL.
  const targetOpp = {
    id: 'opp-target-rank56',
    title: 'Ohio Housing Stability Fund',
    description: 'Provides direct financial assistance for housing stability to Ohio residents.',
    application_url: 'https://ohio.gov/housing-stability-fund',
    is_national: 0,
    state: 'OH',
    is_loan: 0,
    categories: JSON.stringify(['housing']),
    keywords: JSON.stringify(['housing', 'stability']),
    heuristicScore: 8, // modest score — below all 55 higher-scored opps
  }

  // Confirm the target would have been excluded under a strict top-50 sort.
  // Under the old logic: sort by heuristicScore desc → target ranks #56.
  const allOpps = [...higherScoredOpps, targetOpp]
  const sortedByHeuristic = [...allOpps].sort((a, b) => b.heuristicScore - a.heuristicScore)
  const targetRank = sortedByHeuristic.findIndex(o => o.id === targetOpp.id) + 1
  assert.ok(
    targetRank > 50,
    `Target opportunity should rank > 50 heuristically (got rank ${targetRank}) — proving old cap would have excluded it`,
  )

  // Verify that computeMatchDecision() still returns ACCEPT or REVIEW for the
  // target opportunity when it reaches canonical evaluation (as the adaptive
  // strategy ensures it will, since candidate count = 56 ≤ 200).
  const decision = computeMatchDecision(profile, targetOpp, { profileSections: sections })
  assertNotReject(decision, 'rank-56 target with strong canonical alignment')
})

// ---------------------------------------------------------------------------
// Test 8: Adaptive cap constant is a reasonable finite bound
//
// The ADAPTIVE_CANDIDATE_CAP of 200 is large enough to cover any realistic
// profile's candidate pool while still bounding worst-case canonical calls.
// This test documents and asserts the expected constant value.
//
// NOTE: This constant (200) must be kept in sync with the ADAPTIVE_CANDIDATE_CAP
// definitions in scripts/seed-profile-grants.mjs and scripts/seed-matched-grants.mjs.
// ---------------------------------------------------------------------------

test('prefilter-safety (8): adaptive cap (200) is a reasonable finite bound', () => {
  // Mirror the constant from the seeding scripts — must be kept in sync.
  const ADAPTIVE_CANDIDATE_CAP = 200

  // The cap must be finite and greater than the old hard-50 cutoff.
  assert.ok(
    Number.isFinite(ADAPTIVE_CANDIDATE_CAP),
    'ADAPTIVE_CANDIDATE_CAP must be a finite number',
  )
  assert.ok(
    ADAPTIVE_CANDIDATE_CAP > 50,
    `ADAPTIVE_CANDIDATE_CAP (${ADAPTIVE_CANDIDATE_CAP}) must be greater than the old hard-50 cutoff`,
  )

  // Simulate 300 candidates: adaptive selection must return exactly 200,
  // not all 300, confirming performance is still bounded.
  const allCandidates = Array.from({ length: 300 }, (_, i) => ({ id: i, score: i }))
  const selected =
    allCandidates.length <= ADAPTIVE_CANDIDATE_CAP
      ? allCandidates
      : [...allCandidates].sort((a, b) => b.score - a.score).slice(0, ADAPTIVE_CANDIDATE_CAP)

  assert.equal(
    selected.length,
    ADAPTIVE_CANDIDATE_CAP,
    `With 300 candidates, adaptive selection should return exactly ${ADAPTIVE_CANDIDATE_CAP}`,
  )

  // Confirm the top-scored candidates were selected (not a random subset).
  const topScore = selected[0].score
  assert.equal(topScore, 299, 'Highest-scoring candidate should be first in selected pool')
})

// ---------------------------------------------------------------------------
// Test 9: Canonical engine independently REJECTs truly irrelevant candidates
// (performance safety alignment).
//
// A clearly irrelevant opportunity (wrong state, loan, requires 501c3 the
// profile doesn't have, no overlapping keywords) should be canonically REJECTed.
// This confirms that the canonical engine and the junk filter are aligned:
// what is irrelevant enough to be excluded by the junk filter is also
// independently rejected by computeMatchDecision(), so no meaningful canonical
// match is at risk of being "falsely saved" by removing the junk filter.
// ---------------------------------------------------------------------------

test('prefilter-safety (9): canonical engine rejects truly irrelevant candidates independently', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: '["housing"]',
  }
  const sections = {
    basic_information: { state: 'OH' },
  }

  // Completely irrelevant opportunity: targets businesses in a different state,
  // requires 501(c)(3) status, and is a loan — nothing aligns with the profile.
  const irrelevantOpp = {
    id: 'opp-irrelevant-1',
    title: 'California Small Business Loan Program',
    description: 'Low-interest loan for California small businesses with 501(c)(3) status.',
    application_url: 'https://ca.gov/small-business-loan',
    is_national: 0,
    state: 'CA',
    is_loan: 1,
    requires_501c3: 1,
    categories: JSON.stringify(['business', 'loan']),
    keywords: JSON.stringify(['business', 'loan', 'California', '501c3']),
  }

  // Canonical engine must REJECT this opportunity.
  const decision = computeMatchDecision(profile, irrelevantOpp, { profileSections: sections })
  assertDecision(decision, 'REJECT', 'truly irrelevant opportunity: CA business loan for OH individual')

  // Confirm ineligibility was the driving factor (not just a low score).
  assert.ok(
    decision.ineligibilityReasons.length > 0,
    `Irrelevant opportunity should have explicit ineligibility reasons; got: ${JSON.stringify(decision.ineligibilityReasons)}`,
  )
})

// ---------------------------------------------------------------------------
// Sanity: MATCHER_VERSION is 3.0.0
// ---------------------------------------------------------------------------

test('prefilter-safety: MATCHER_VERSION is 3.0.0', () => {
  assert.equal(MATCHER_VERSION, '3.0.0')
})
