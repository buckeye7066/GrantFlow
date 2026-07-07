/**
 * needAnchoredScoring.test.js
 *
 * Owner directive 2026-07-06: the match score IS need coverage —
 *   score = (% of the profile's main needs addressed) × eligibilityFactor × geoFactor
 *
 * A 50 must literally mean "covers about half of what this profile needs".
 * The retired additive model handed ~45 baseline points to any national,
 * entity-eligible source ("Prevention of Disease, Disability, and Death"
 * scored 50 for a ministry whose needs it did not touch at all).
 */
import { describe, it, expect } from 'vitest'
import { scoreOpportunity, computeMatchDecision } from '../services/matchEngine.js'
import {
  SCORE_FLOOR, NO_NEEDS_TOPICAL_CAP, GOOD_MATCH_SCORE, AUTO_ADD_SCORE,
} from '../config/matchThresholds.js'
import { canonicalOpportunityKey, titleIdentityKey } from '../crawler-os/contract.js'

const MINISTRY_PROFILE = {
  id: 'p-ministry',
  primary_type: 'nonprofit',
  state: 'TN',
  needs: ['housing', 'food', 'transportation', 'education'],
}

const TWO_NEED_OPP = {
  id: 'opp-2need',
  title: 'Community Housing Repair and Food Security Grants',
  description:
    'Grants for nonprofit organizations to repair affordable housing and run food and nutrition programs for their communities.',
  application_url: 'https://example-funder.org/apply',
  is_national: true,
  categories: ['housing', 'food'],
}

const GENERIC_FEDERAL_OPP = {
  id: 'opp-generic',
  title: 'Prevention of Disease, Disability, and Death by Infectious Diseases',
  description:
    'A national program supporting projects for the prevention of disease, disability, and death by infectious diseases. Nonprofit organizations may apply.',
  application_url: 'https://example.gov/prevention',
  is_national: true,
  categories: ['health'],
}

describe('need-anchored score semantics', () => {
  it('the score IS the data-point ratio: 2 of 4 needs + geo + type matched → 4 of 6 points', () => {
    const { score, match_explain } = scoreOpportunity(MINISTRY_PROFILE, TWO_NEED_OPP)
    expect(match_explain.scoreBreakdown.matched_needs_count).toBe(2)
    const dp = match_explain.dataPointEvidence
    // Inventory: 4 needs + geo:state + applicant_type = 6. Matched: 2 needs
    // + geo (national serves TN) + nonprofit applicant type = 4.
    expect(dp.total).toBe(6)
    expect(dp.matched_count).toBe(4)
    // score = 4/6 × clean gates ≈ 67; the number and the evidence agree.
    expect(score).toBeGreaterThanOrEqual(60)
    expect(score).toBeLessThanOrEqual(70)
    expect(score).toBeGreaterThanOrEqual(GOOD_MATCH_SCORE)
  })

  it('a generic national opp matching ZERO needs on a RICH profile scores near the floor — the Focus Forward class', () => {
    // The original complaint class: "Prevention of Disease…" scored 50 for a
    // ministry it didn't help. Real org profiles carry 50–150 data points, so
    // right-geo + right-entity-type alone is ~2% coverage — near the floor.
    const richMinistry = {
      ...MINISTRY_PROFILE,
      id: 'p-ministry-rich',
      needs: MINISTRY_PROFILE.needs,
      keywords: JSON.stringify(Array.from({ length: 40 }, (_, i) => `ministryfact${String(i).padStart(2, '0')}`)),
    }
    const { score, match_explain } = scoreOpportunity(richMinistry, GENERIC_FEDERAL_OPP)
    expect(match_explain.scoreBreakdown.matched_needs_count).toBe(0)
    expect(score).toBeLessThan(AUTO_ADD_SCORE)
    expect(score).toBeLessThanOrEqual(SCORE_FLOOR + 15)
  })

  it('on a SPARSE profile the same generic opp reads as honest partial coverage (geo+type of what little we know)', () => {
    const { score, match_explain } = scoreOpportunity(MINISTRY_PROFILE, GENERIC_FEDERAL_OPP)
    expect(match_explain.scoreBreakdown.matched_needs_count).toBe(0)
    // 6-point inventory, geo+type matched → 2/6 ≈ 33 before gates. Sparse
    // profiles scoring visibly on thin evidence is the owner's intended
    // reading ("2 data points, source matches 1 → 50").
    const dp = match_explain.dataPointEvidence
    expect(dp.total).toBe(6)
    expect(dp.matched.filter((m) => m.kind === 'need')).toHaveLength(0)
    expect(score).toBeGreaterThan(SCORE_FLOOR)
    expect(score).toBeLessThanOrEqual(40)
  })

  it('a profile with NO usable data points at all is capped at NO_NEEDS_TOPICAL_CAP', () => {
    const empty = { id: 'p-empty' }
    const { score, match_explain } = scoreOpportunity(empty, TWO_NEED_OPP)
    expect(match_explain.dataPointEvidence.total).toBe(0)
    expect(score).toBeLessThanOrEqual(NO_NEEDS_TOPICAL_CAP)
  })

  it('a near-empty profile (state+type only) scores its full tiny inventory honestly', () => {
    // Owner arithmetic at the small end: we only know 2 things; a national
    // nonprofit grant matches both → 2/2. High scores on thin profiles are
    // by design — the readiness gate, not the scorer, handles onboarding.
    const bare = { id: 'p-bare', primary_type: 'nonprofit', state: 'TN' }
    const { score, match_explain } = scoreOpportunity(bare, TWO_NEED_OPP)
    expect(match_explain.dataPointEvidence.total).toBe(2)
    expect(match_explain.dataPointEvidence.matched_count).toBe(2)
    expect(score).toBeGreaterThanOrEqual(90)
  })

  it('org × individual-assistance guard: a church never scores high on person/household rent assistance', () => {
    const church = {
      id: 'p-church',
      primary_type: 'nonprofit',
      state: 'OH',
      needs: ['housing', 'community'],
    }
    const rentAssistance = {
      id: 'opp-rent',
      title: 'Emergency Rent & Housing Assistance',
      description:
        'Emergency rent assistance and utility assistance for individuals and families in Lorain County facing eviction.',
      application_url: 'https://example-charity.org/help',
      state: 'OH',
      categories: ['housing', 'emergency'],
    }
    const { score, match_explain } = scoreOpportunity(church, rentAssistance)
    // Housing "matches" textually, but the recipient is a PERSON, not an org —
    // the eligibility gate must crush the score (this was Vermilion's 96).
    expect(match_explain.scoreBreakdown.eligibility_mismatches).toContain('org_profile_individual_assistance')
    expect(score).toBeLessThan(AUTO_ADD_SCORE)
  })

  it('sponsor name containing "Church" does not bypass the org guard', () => {
    // The FUNDER being a church must not read as "organizations may apply" —
    // Emmanuel Lutheran's rent fund kept scoring 80 for another church because
    // the sponsor name supplied the org-entity signal.
    const church = {
      id: 'p-church-2',
      primary_type: 'nonprofit',
      state: 'OH',
      needs: ['housing', 'community'],
    }
    const rentFund = {
      id: 'opp-rent-3',
      title: 'Community Outreach Emergency Housing Assistance',
      sponsor: 'Emmanuel Lutheran Church – Elyria',
      description: 'Emergency rent and housing assistance for individuals and families facing eviction in Elyria.',
      application_url: 'https://example-elc.org/help',
      state: 'OH',
      categories: ['housing', 'emergency'],
    }
    const { score, match_explain } = scoreOpportunity(church, rentFund)
    expect(match_explain.scoreBreakdown.eligibility_mismatches).toContain('org_profile_individual_assistance')
    expect(score).toBeLessThan(AUTO_ADD_SCORE)
  })

  it('title/category "church" vocabulary does not bypass the org guard (Emmanuel Lutheran class)', () => {
    // Real prod shape: the TITLE names the church, categories say "church
    // assistance" (= aid FROM a church), eligibility bullets describe PEOPLE.
    const church = { id: 'p-church-3', primary_type: 'nonprofit', state: 'OH', needs: ['housing', 'community'] }
    const rentFund = {
      id: 'opp-rent-4',
      title: 'Emmanuel Lutheran Church – Community Outreach Emergency Housing Assistance',
      sponsor: 'Emmanuel Lutheran Church – Elyria',
      description: 'Provides community outreach services including emergency rent assistance, housing support, and crisis aid. Helps individuals and families facing eviction with direct financial assistance and referrals.',
      eligibility_bullets: JSON.stringify(['Residents of Lorain County and Elyria, Ohio', 'Low income households', 'Single parents facing housing crisis']),
      categories: JSON.stringify(['emergency housing assistance', 'rent assistance', 'faith based aid', 'church assistance']),
      application_url: 'https://example-elc.org/help',
      state: 'OH',
    }
    const { score, match_explain } = scoreOpportunity(church, rentFund)
    expect(match_explain.scoreBreakdown.eligibility_mismatches).toContain('org_profile_individual_assistance')
    expect(score).toBeLessThan(AUTO_ADD_SCORE)
  })

  it('an operator grant that NAMES org applicants in eligibility prose passes the guard', () => {
    const nonprofit = { id: 'p-np-3', primary_type: 'nonprofit', state: 'OH', needs: ['housing', 'community'] }
    const operatorGrant = {
      id: 'opp-operator',
      title: 'Emergency Rent Assistance Operating Grants',
      sponsor: 'Ohio Housing Trust',
      description: 'Grants to nonprofits and community organizations operating emergency rent assistance programs in Ohio.',
      eligibility_bullets: JSON.stringify(['Eligible applicants: 501(c)(3) nonprofit organizations serving Ohio residents']),
      application_url: 'https://example-oht.org/apply',
      state: 'OH',
      categories: JSON.stringify(['housing', 'capacity']),
    }
    const { match_explain } = scoreOpportunity(nonprofit, operatorGrant)
    expect(match_explain.scoreBreakdown.eligibility_mismatches ?? []).not.toContain('org_profile_individual_assistance')
  })

  it('an INDIVIDUAL with a housing need still scores well on the same assistance program', () => {
    const person = {
      id: 'p-person',
      primary_type: 'individual',
      state: 'OH',
      needs: ['housing', 'utilities'],
    }
    const rentAssistance = {
      id: 'opp-rent-2',
      title: 'Emergency Rent & Housing Assistance',
      description:
        'Emergency rent assistance and utility assistance for individuals and families in Lorain County facing eviction.',
      application_url: 'https://example-charity.org/help',
      state: 'OH',
      categories: ['housing', 'emergency'],
    }
    const { score, match_explain } = scoreOpportunity(person, rentAssistance)
    expect(match_explain.scoreBreakdown.eligibility_mismatches ?? []).not.toContain('org_profile_individual_assistance')
    // Both declared needs are addressed → coverage 100, gates ≥ 0.8/1.0.
    expect(score).toBeGreaterThanOrEqual(AUTO_ADD_SCORE)
  })

  it('decision copy states coverage in plain language', () => {
    const decision = computeMatchDecision(MINISTRY_PROFILE, GENERIC_FEDERAL_OPP)
    expect(String(decision.explanation)).toMatch(/needs/i)
    expect(String(decision.explanation)).not.toMatch(/moderate match signals/i)
  })
})

describe('canonical opportunity identity (near-duplicate dedup)', () => {
  it('collapses LLM paraphrase variants of the same program (the 7× NAEMT class)', () => {
    const a = titleIdentityKey('NAEMT EMS Scholarship - Paramedics (to advance ems education)', 'NAEMT')
    const b = titleIdentityKey('NAEMT EMS Scholarship – Paramedics (to advance education in ems)', 'NAEMT')
    const c = titleIdentityKey('NAEMT EMS Scholarship – Paramedics (to advance EMS education)', 'NAEMT')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('keeps genuinely different programs distinct', () => {
    const basic = titleIdentityKey('NAEMT EMS Scholarship - EMT-Basic (to become EMT-Paramedic)', 'NAEMT')
    const medics = titleIdentityKey('NAEMT EMS Scholarship - Paramedics (to advance ems education)', 'NAEMT')
    expect(basic).not.toBe(medics)
  })

  it('key precedence: external_id, then title identity, then URL', () => {
    expect(canonicalOpportunityKey({ external_id: 'OPP-123', title: 'X', apply_url: 'https://a.org/x' }))
      .toBe('ext:opp-123')
    expect(canonicalOpportunityKey({ title: 'Community Grant', sponsor: 'United Way' }))
      .toMatch(/^t:/)
    expect(canonicalOpportunityKey({ apply_url: 'https://a.org/x/' }))
      .toBe('u:https://a.org/x')
  })
})
