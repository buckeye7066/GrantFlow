/**
 * Result-quality attribution — replay of the 2026-09-17 production capture
 * through the PRODUCTION-PATH functions (no route-local copies).
 *
 * Two kinds of assertion, deliberately separated:
 *
 *   `it(...)`       invariants that hold on the deployed commit (a91267ac) and
 *                   must keep holding.
 *   `it.fails(...)` the ATTRIBUTED defects. Each was measured on the captured
 *                   rows (capture-meta.json `cases`) and reproduced locally on
 *                   the same commit. Vitest passes an `it.fails` block only
 *                   while its body still fails, so the engine repair that fixes
 *                   a case MUST flip that block to `it` in the same change —
 *                   the suite stays green now and cannot forget the case later.
 *
 * Scores are not pinned: the crawler-os lane scores an OS-normalized thesis and
 * the rescore lane scores the catalog row, so magnitudes differ between capture
 * and replay while decisions agree. Decisions, eligibility values, missing
 * fields, and explanation claims are what these tests hold.
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { qualifiesForDisplay, displayRefusal } from '../config/matchSurfacing.js'
import { canonicalMatchDisplay } from '../../src/lib/matchDisplayThresholds.js'
import { loadRegressionFixture, CASE_IDS } from './fixtures/regression/tn-student-2026-09-17/index.js'

const fixture = loadRegressionFixture()
const { profile, sectionsByKey } = fixture
const signals = buildProfileSignals({ profile, sections: sectionsByKey })

function replay(opportunityId) {
  const opportunity = fixture.opportunityById(opportunityId)
  expect(opportunity, `fixture row ${opportunityId}`).toBeTruthy()
  return computeMatchDecision(profile, opportunity, { profileSections: sectionsByKey, signals })
}

function storedRow(opportunityId) {
  const match = fixture.matchByOpportunityId(opportunityId)
  const opportunity = fixture.opportunityById(opportunityId)
  return {
    ...opportunity,
    match_decision: match.match_decision,
    match_score: match.match_score,
    match_explain_json: match.match_explain_json,
    is_active: 1,
    is_hidden: 0,
  }
}

describe('capture provenance', () => {
  it('was taken read-only from the deployed commit and names every case', () => {
    expect(fixture.meta.deployed_commit).toBe('a91267ac0f025f3dfb1e49e4cb9d21b7ed6aa822')
    expect(fixture.meta.source).toMatch(/read-only/)
    for (const key of ['jacksonville_no_geo', 'ecf_caregiver_stipend_no_elig_text', 'hcbs_waivers_no_elig_text', 'international_merit_us_citizen']) {
      expect(fixture.meta.cases[key]).toBeTruthy()
    }
  })

  it('carries the profile facts the defects hinge on, verbatim', () => {
    expect(sectionsByKey.demographics.citizenship).toBe('US citizen')
    expect(sectionsByKey.demographics.us_citizen).toBe(true)
    expect(sectionsByKey.demographics.disability_status).toBe('No disability')
    expect(sectionsByKey.government_assistance.medicaid_enrolled).toBe(true)
    expect(sectionsByKey.government_assistance.medicaid_waiver_program).toBe('none')
    expect(sectionsByKey.family_life.family_caregiver).toBe(true)
    expect(sectionsByKey.basic_information.location.state).toBe('TN')
    expect(signals.demographics.has('us_citizen')).toBe(true)
    expect(signals.location.state).toBe('TN')
  })
})

describe('engine behavior that already holds and must keep holding', () => {
  it('holds the ECF CHOICES parent row at REVIEW when its text names a condition the profile does not', () => {
    const decision = replay(CASE_IDS.ecfParent)
    expect(decision.decision).toBe('REVIEW')
    expect(decision.eligible).toBe('maybe')
    expect(decision.match_explain?.missing_eligibility_fields ?? decision.missingEligibilityFields)
      .toContain('condition_specific_condition_not_named')
  })

  it('holds the Jacksonville row WITH a state at REVIEW and says so plainly (NC program, TN profile)', () => {
    const decision = replay(CASE_IDS.jacksonvilleNc)
    expect(decision.decision).toBe('REVIEW')
    expect(decision.explanation).toMatch(/NC/)
    expect(decision.explanation).toMatch(/confirm eligibility/i)
  })

  it('never displays a canonical reject, and names the refusal', () => {
    const row = { ...storedRow(CASE_IDS.jacksonvilleNoGeo), match_decision: 'reject', match_score: 80 }
    expect(qualifiesForDisplay(row, 7)).toBe(false)
    expect(displayRefusal(row, 7)?.reason).toBe('rejected')
  })

  it('documents the presentation reality: the captured no-state Jacksonville accept renders "Excellent Match"', () => {
    // 32 ≥ STRONG_MATCH_SCORE (17) with a persisted ACCEPT + all_passed proof.
    // This is what the profile saw. The label is derived from decision + score
    // only; nothing in the display path reads the "location unknown" reason.
    const row = storedRow(CASE_IDS.jacksonvilleNoGeo)
    expect(qualifiesForDisplay(row, 7)).toBe(true)
    expect(canonicalMatchDisplay({ score: row.match_score, decision: row.match_decision }).label).toBe('Excellent Match')
    const explain = fixture.parseExplain(fixture.matchByOpportunityId(CASE_IDS.jacksonvilleNoGeo))
    expect(explain.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/Location unknown/)]))
  })
})

describe('ATTRIBUTED DEFECTS — measured 2026-09-17 on a91267ac, repaired in PR2 (each block was `it.fails` until its repair landed)', () => {
  it('engine gap: an "International students" program is REVIEW, not ACCEPT, for a profile whose citizenship is US citizen', () => {
    // Row text: "…for international students" (stated AUDIENCE, not exclusive
    // wording). Profile: citizenship = US citizen. Before: ACCEPT 100,
    // eligible=true, "eligibility … check out". After: a soft contradiction —
    // REVIEW with the reason named and the score capped, never REJECT (G4:
    // only explicit exclusivity hard-gates).
    for (const id of [CASE_IDS.internationalMeritCatalogRescore, CASE_IDS.internationalMeritInstitution, CASE_IDS.internationalMeritsProgram]) {
      const decision = replay(id)
      expect(decision.decision, id).toBe('REVIEW')
      expect(decision.eligible, id).toBe('maybe')
      expect(decision.missingEligibilityFields, id).toContain('international_audience_mismatch')
      expect(decision.explanation, id).toMatch(/described for international students/i)
      expect(decision.explanation, id).not.toMatch(/check out/i)
    }
  })

  it('overstatement: a program row with NO eligibility text says so instead of "eligibility checks out" (ECF Family Caregiver Stipend)', () => {
    // eligibility_bullets: [], description is a "Discovered from …" stub. The
    // decision stays ACCEPT (silence is neutral, G4 — a verdict flip here would
    // hide 41% of the fleet's accepts), but the engine now reports HOW MUCH
    // eligibility evidence it had, and the explanation matches it.
    const decision = replay(CASE_IDS.ecfCaregiverStipend)
    expect(decision.decision).toBe('ACCEPT')
    expect(decision.eligibility_evidence).toBe('structured_flags') // title says "caregiver"; no prose
    expect(decision.match_explain.eligibility_evidence).toBe('structured_flags')
    expect(decision.explanation).not.toMatch(/eligibility and location check out/i)
    expect(decision.explanation).toMatch(/criteria are not published .* confirm before applying/i)
  })

  it('overstatement: a benefit row with NO eligibility text and no restriction flags is "applicant type only" (TennCare 1915(c) HCBS Waivers)', () => {
    const decision = replay(CASE_IDS.hcbsWaivers)
    expect(decision.decision).toBe('ACCEPT')
    expect(decision.eligibility_evidence).toBe('applicant_types_only')
    expect(decision.explanation).toMatch(/eligibility criteria are not stated by the source/i)
    expect(decision.explanation).not.toMatch(/check out\)/)
  })

  it('overstatement: an ACCEPT whose opportunity has no stated location says "Service area not stated", never "location check out"', () => {
    // state NULL, is_national false → geo_factor 0.7 (unknown).
    const decision = replay(CASE_IDS.jacksonvilleNoGeo)
    expect(decision.decision).toBe('ACCEPT')
    expect(decision.eligibility_evidence).toBe('prose') // this row DOES carry eligibility text
    expect(decision.explanation).toMatch(/Eligibility checks out\. Service area not stated by the source\./)
    expect(decision.explanation).not.toMatch(/location check out/i)
  })

  it('control: a row with stated eligibility AND a stated location keeps the full "eligibility and location check out" claim', () => {
    const opportunity = { ...fixture.opportunityById(CASE_IDS.jacksonvilleNoGeo), state: 'TN', geo_scope: 'state' }
    const decision = computeMatchDecision(profile, opportunity, { profileSections: sectionsByKey, signals })
    expect(decision.decision).toBe('ACCEPT')
    expect(decision.explanation).toMatch(/eligibility and location check out/i)
  })

  it('profile normalization: a stray ZIP loses a 1-1 vote to the ZIP consistent with the declared state', () => {
    // basic_information.zip_code = 55402 (Minneapolis) vs location.zip_code =
    // 37312 (Cleveland, TN); state is TN. Before: 55402 won as "the flat value".
    expect(signals.location.zip).toBe('37312')
    expect(signals.location.county).toBe('Bradley')
  })
})
