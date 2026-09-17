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
import { loadRegressionFixture, CASE_IDS } from './fixtures/regression/anastasia-2026-09-17/index.js'

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

describe('ATTRIBUTED DEFECTS — measured 2026-09-17; flip each to `it` in the change that repairs it', () => {
  it.fails('engine gap: an "International students" program is not ACCEPT for a profile whose citizenship is US citizen', () => {
    // Row text: "International students" / "…for international students".
    // Profile: citizenship = US citizen, us_citizen = true, nationality American.
    // Replay on a91267ac: ACCEPT 100, eligible=true, "eligibility … check out".
    const decision = replay(CASE_IDS.internationalMeritCatalogRescore)
    expect(decision.decision).not.toBe('ACCEPT')
    expect(decision.eligible).not.toBe(true)
  })

  it.fails('overstatement: a program row with NO eligibility text does not report eligible=true (ECF Family Caregiver Stipend)', () => {
    // eligibility_bullets: [], description is a "Discovered from …" stub. The
    // engine already scores eligibility as UNKNOWN (eligibility_factor 0.8) yet
    // reports eligible=true and "eligibility and location check out".
    const decision = replay(CASE_IDS.ecfCaregiverStipend)
    expect(decision.eligible).toBe('maybe')
  })

  it.fails('overstatement: a benefit row with NO eligibility text does not report eligible=true (TennCare 1915(c) HCBS Waivers)', () => {
    const decision = replay(CASE_IDS.hcbsWaivers)
    expect(decision.eligible).toBe('maybe')
  })

  it.fails('overstatement: an ACCEPT whose opportunity has no stated location does not claim "location check out"', () => {
    // state NULL, is_national false → geo_factor 0.7 (unknown), yet the
    // explanation asserts the location checks out.
    const decision = replay(CASE_IDS.jacksonvilleNoGeo)
    expect(decision.decision).toBe('ACCEPT')
    expect(decision.explanation).not.toMatch(/location check out/i)
  })

  it.fails('profile normalization: a stray ZIP does not win a 1-1 vote against the ZIP consistent with the profile state', () => {
    // basic_information.zip_code = 55402 (Minneapolis) vs location.zip_code =
    // 37312 (Cleveland, TN); state resolves to TN, zip resolves to 55402.
    expect(signals.location.zip).toBe('37312')
  })
})
