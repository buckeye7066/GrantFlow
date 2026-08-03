/**
 * profileSpecificGateSurfacing.test.js
 *
 * Guards the DISPLAY-GATE over-drop fix: a row the matchEngine already scored
 * above the surfacing floor must NOT be un-surfaced by the older keyword
 * "no-fit" gate (referral_directory / directory_no_profile_fit /
 * web_lead_no_profile_fit / generic_only_no_profile_fit / generic_directory_page),
 * while genuine ELIGIBILITY / DEMOGRAPHIC mismatches STILL drop — for EVERY
 * profile type (the PROFILE-TYPE MATRIX guard).
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateProfileSpecificGate,
  SUPPRESSIBLE_NO_FIT_RULE_IDS,
  hasAuthoritativeStoredDecision,
} from '../services/matching/profileSpecificGate.js'
import {
  canonicalResultForProfile,
  canonicalizeOpportunityList,
  assertNoSilentUnsurfacing,
} from '../services/matching/resultEnricher.js'

// A stored above-floor decision (matchEngine already scored it) — the trigger
// for no-fit suppression. Keyword-thin directory: its short text hits a no-fit
// rule but carries NO eligibility signal.
function storedDirectory(overrides = {}) {
  return {
    id: 'benefits_gov_finder',
    title: 'Benefits.gov Benefit Finder',
    description: 'Find benefits you may qualify for.',
    is_directory_resource: true,
    source: 'benefits_gov',
    source_url: 'https://www.benefits.gov/benefit-finder',
    // NO application_url on purpose → referral_directory fires (without stored).
    match_score: 30,
    match_decision: 'REVIEW',
    ...overrides,
  }
}

const STORED = { useStoredDecision: true, mode: 'display' }
const UNSCORED = { useStoredDecision: false, mode: 'display' }

describe('no-fit suppression for stored above-floor rows', () => {
  const individual = {
    primary_type: 'individual',
    state: 'TN',
    needs: ['disability', 'healthcare'],
    disability_status: true,
  }

  it('keeps a keyword-thin stored above-floor DIRECTORY (benefits_gov shape)', () => {
    const gate = evaluateProfileSpecificGate(individual, storedDirectory(), STORED)
    expect(gate.pass).toBe(true)
  })

  it('DROPS the same directory when it has NO stored above-floor decision', () => {
    const gate = evaluateProfileSpecificGate(individual, storedDirectory(), UNSCORED)
    expect(gate.pass).toBe(false)
    expect(SUPPRESSIBLE_NO_FIT_RULE_IDS.has(gate.ruleId)).toBe(true)
  })

  it('does NOT suppress when the stored score is below the surfacing floor', () => {
    const gate = evaluateProfileSpecificGate(
      individual,
      storedDirectory({ match_score: 3 }),
      STORED,
    )
    expect(gate.pass).toBe(false)
    expect(SUPPRESSIBLE_NO_FIT_RULE_IDS.has(gate.ruleId)).toBe(true)
  })

  it('does NOT suppress a stored REJECT decision', () => {
    const gate = evaluateProfileSpecificGate(
      individual,
      storedDirectory({ match_decision: 'REJECT' }),
      STORED,
    )
    expect(gate.pass).toBe(false)
  })

  it('a raw web-lead with no stored decision still gets the strict keyword gate', () => {
    const webLead = {
      id: 'web-1',
      title: 'General funding support resource directory',
      description: 'A funding finder page.',
      source: 'web_search',
      source_url: 'https://example.org/help',
      // no stored score
    }
    const gate = evaluateProfileSpecificGate(individual, webLead, UNSCORED)
    expect(gate.pass).toBe(false)
    expect(SUPPRESSIBLE_NO_FIT_RULE_IDS.has(gate.ruleId)).toBe(true)
  })

  it('a foster-youth-only row STILL drops for an adult even with a stored score', () => {
    const chafee = {
      id: 'chafee',
      title: 'Chafee Foster Youth Program',
      description: 'For youth aging out of foster care.',
      source: 'acf_chafee_foster',
      source_url: 'https://www.acf.hhs.gov/chafee',
      match_score: 30,
      match_decision: 'REVIEW',
    }
    const gate = evaluateProfileSpecificGate(individual, chafee, STORED)
    expect(gate.pass).toBe(false)
    expect(SUPPRESSIBLE_NO_FIT_RULE_IDS.has(gate.ruleId)).toBe(false)
  })
})

// OWNER DIRECTIVE 2026-08-03 (recall over suppression): the gate's OWN
// CATEGORY_RULES population keyword net must not re-adjudicate away a row the
// matchEngine already scored above the surfacing floor. Explicit exclusivity
// (enforced by the relevance filter, which runs first) STILL drops.
describe("CATEGORY population net trusts an authoritative engine decision", () => {
  const youngIndividual = {
    primary_type: 'individual',
    state: 'TN',
    needs: ['housing'],
    // NOTE: no age → age-based relevance rules PASS (missing fields are
    // neutral, not exclusionary), so the only thing that used to drop a senior
    // resource was the CATEGORY senior_without_profile_signal keyword rule.
  }

  // Relevance filter passes this (no explicit exclusivity, unknown age), so the
  // ONLY thing that dropped it was the CATEGORY senior population keyword rule.
  function seniorAgingResource(overrides = {}) {
    return {
      id: 'aaa-aging',
      title: 'Area Agency on Aging Resource',
      description: 'Aging services for senior citizens and older adults.',
      source: 'aaa_program',
      source_url: 'https://example.org/aaa',
      match_score: 30,
      match_decision: 'REVIEW',
      ...overrides,
    }
  }

  it('SURFACES a CATEGORY-only mismatch when the engine scored it above the floor', () => {
    const gate = evaluateProfileSpecificGate(youngIndividual, seniorAgingResource(), STORED)
    expect(gate.pass).toBe(true)
    expect(gate.trustedOverCategory).toBe(true)
  })

  it('DROPS the same row on the CATEGORY rule when it has NO authoritative decision', () => {
    const gate = evaluateProfileSpecificGate(youngIndividual, seniorAgingResource(), UNSCORED)
    expect(gate.pass).toBe(false)
    expect(gate.ruleId).toBe('senior_without_profile_signal')
  })

  it('does NOT trust the engine over EXPLICIT exclusivity (veterans-only still drops)', () => {
    // "Veterans only" is hard-exclusive in the relevance filter (runs first), so
    // even an above-floor stored score cannot surface it for a non-veteran.
    const vetExclusive = {
      id: 'vet-only-2',
      title: 'Veterans Only Assistance',
      description: 'Open only to veterans. Must be a veteran to apply.',
      source: 'va_program',
      source_url: 'https://example.org/vet',
      match_score: 30,
      match_decision: 'REVIEW',
    }
    const gate = evaluateProfileSpecificGate(youngIndividual, vetExclusive, STORED)
    expect(gate.pass).toBe(false)
    expect(gate.trustedOverCategory).toBeFalsy()
  })
})

describe('hasAuthoritativeStoredDecision', () => {
  it('requires useStoredDecision + above-floor score + ACCEPT/REVIEW', () => {
    expect(hasAuthoritativeStoredDecision({ match_score: 30, match_decision: 'REVIEW' }, { useStoredDecision: true })).toBe(true)
    expect(hasAuthoritativeStoredDecision({ match_score: 30 }, { useStoredDecision: false })).toBe(false)
    expect(hasAuthoritativeStoredDecision({ match_score: 3, match_decision: 'REVIEW' }, { useStoredDecision: true })).toBe(false)
    expect(hasAuthoritativeStoredDecision({ match_score: 30, match_decision: 'REJECT' }, { useStoredDecision: true })).toBe(false)
  })
})

// ── PROFILE-TYPE MATRIX ─────────────────────────────────────────────────────
// One representative fixture per effective profile type, each with (a) a stored
// above-floor keyword-thin DIRECTORY that the no-fit family would drop, and
// (b) a genuine eligibility/demographic mismatch that MUST still drop. This one
// matrix proves the two rule families are correctly separated for ALL types.

function vetOnly(overrides = {}) {
  return {
    id: 'vet-only',
    title: 'Veterans Only Assistance',
    description: 'Open only to veterans and service members. VA benefits.',
    source: 'va_program',
    source_url: 'https://va.gov/x',
    match_score: 30,
    match_decision: 'REVIEW',
    ...overrides,
  }
}
function fosterOnly(overrides = {}) {
  return {
    id: 'foster-only',
    title: 'Foster Youth Program',
    description: 'For youth aging out of foster care.',
    source: 'foster',
    source_url: 'https://x.org/foster',
    match_score: 30,
    match_decision: 'REVIEW',
    ...overrides,
  }
}
function studentAidOnly(overrides = {}) {
  return {
    id: 'fafsa',
    title: 'FAFSA Pell Grant Student Aid',
    description: 'Federal student aid: FAFSA, Pell grant, tuition assistance.',
    source: 'student_aid',
    source_url: 'https://studentaid.gov',
    match_score: 30,
    match_decision: 'REVIEW',
    ...overrides,
  }
}

const MATRIX = [
  {
    type: 'individual',
    profile: { primary_type: 'individual', state: 'TN', needs: ['disability'], disability_status: true },
    mismatch: fosterOnly(),
  },
  {
    type: 'family',
    profile: { primary_type: 'family', state: 'TN', needs: ['housing'], has_children: true, number_of_children: 2 },
    mismatch: fosterOnly(),
  },
  {
    type: 'student',
    profile: { primary_type: 'student', state: 'TN', needs: ['education', 'scholarship'] },
    mismatch: vetOnly(),
  },
  {
    type: 'veteran',
    profile: { primary_type: 'veteran', state: 'TN', veteran_status: true, needs: ['employment'] },
    mismatch: fosterOnly(),
  },
  {
    type: 'nonprofit',
    profile: { primary_type: 'nonprofit', state: 'TN', organization_type: 'nonprofit', needs: ['capacity building'] },
    mismatch: vetOnly(),
  },
  {
    type: 'small_business',
    profile: { primary_type: 'business', state: 'TN', needs: ['working capital'] },
    mismatch: studentAidOnly(),
  },
]

describe('PROFILE-TYPE MATRIX: no-fit suppression is type-agnostic', () => {
  for (const { type, profile, mismatch } of MATRIX) {
    it(`[${type}] keeps a stored above-floor keyword-thin directory`, () => {
      const dir = storedDirectory({ id: `dir-${type}`, title: 'Community Resource Directory' })
      const kept = canonicalResultForProfile(profile, dir, { ...STORED, preserveDirectories: true })
      expect(kept.display, `${type}: directory should surface`).toBe(true)
    })

    it(`[${type}] would DROP that directory WITHOUT a stored decision (proves suppression is load-bearing)`, () => {
      const dir = storedDirectory({ id: `dir-${type}`, title: 'Community Resource Directory' })
      const dropped = canonicalResultForProfile(profile, dir, { ...UNSCORED, preserveDirectories: true })
      expect(dropped.display).toBe(false)
      expect(SUPPRESSIBLE_NO_FIT_RULE_IDS.has(dropped.dropReason)).toBe(true)
    })

    it(`[${type}] STILL drops a genuine eligibility/demographic mismatch despite a stored score`, () => {
      const res = canonicalResultForProfile(profile, mismatch, { ...STORED, preserveDirectories: true, rejectHardIneligible: true })
      expect(res.display, `${type}: mismatch must not surface`).toBe(false)
      expect(
        SUPPRESSIBLE_NO_FIT_RULE_IDS.has(res.dropReason),
        `${type}: dropped for ${res.dropReason} which must be an eligibility rule, not a no-fit rule`,
      ).toBe(false)
    })
  }
})

describe('assertNoSilentUnsurfacing (reconciliation invariant)', () => {
  const profile = { primary_type: 'individual', state: 'TN', needs: ['disability'], disability_status: true }

  it('reports no violations when stored above-floor directories are kept', () => {
    const list = [storedDirectory(), storedDirectory({ id: 'd2', title: 'Tennessee 211 Resource Directory' })]
    const violations = assertNoSilentUnsurfacing(profile, list, { preserveDirectories: true, throwOnViolation: true })
    expect(violations).toEqual([])
  })

  it('canonicalizeOpportunityList exposes a zero unsurfaced_above_floor_nofit count after the fix', () => {
    const list = [storedDirectory(), storedDirectory({ id: 'd2', title: 'Community Resource Directory' })]
    const { unsurfacedAboveFloorNoFit } = canonicalizeOpportunityList(profile, list, {
      useStoredDecision: true,
      preserveDirectories: true,
    })
    expect(unsurfacedAboveFloorNoFit).toEqual([])
  })
})
