/**
 * profileSpecificGateSurfacing.test.js
 *
 * Guards the DISPLAY-GATE over-drop fix: a row the matchEngine already scored
 * above the surfacing floor must NOT be un-surfaced by the older keyword
 * "no-fit" gate (referral_directory / directory_no_profile_fit /
 * web_lead_no_profile_fit / generic_only_no_profile_fit / generic_directory_page),
 * while genuine ELIGIBILITY / DEMOGRAPHIC mismatches are decided at canonical
 * write time — never as an alternate read-time verdict.
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
  hasPersistedCanonicalDecision,
} from '../services/matching/resultEnricher.js'
import { computeMatchDecision } from '../services/matchEngine.js'

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

describe('persisted canonical artifact contract', () => {
  it('requires both a supported decision and a measured score', () => {
    expect(hasPersistedCanonicalDecision({ match_score: 8, match_decision: 'ACCEPT' })).toBe(true)
    expect(hasPersistedCanonicalDecision({ match_score: 8 })).toBe(false)
    expect(hasPersistedCanonicalDecision({ match_score: null, match_decision: 'REVIEW' })).toBe(false)
    expect(hasPersistedCanonicalDecision({ match_score: 8, match_decision: 'UNKNOWN' })).toBe(false)
    expect(hasPersistedCanonicalDecision(
      { match_score: 8, match_decision: 'ACCEPT' },
      { useStoredDecision: false },
    )).toBe(false)
  })

  it('never resurrects a stored REJECT merely because the row is a directory', () => {
    const result = canonicalResultForProfile(
      { primary_type: 'individual', state: 'TN' },
      storedDirectory({ match_score: 30, match_decision: 'REJECT' }),
      { useStoredDecision: true, preserveDirectories: true },
    )
    expect(result.display).toBe(false)
    expect(result.dropReason).toBe('decision')
    expect(result.decision.decision).toBe('REJECT')
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

    it(`[${type}] displays the persisted artifact unchanged, then canonical rescore rejects the mismatch`, () => {
      const res = canonicalResultForProfile(profile, mismatch, { ...STORED, preserveDirectories: true, rejectHardIneligible: true })
      expect(res.display, `${type}: persisted decision must remain the read authority`).toBe(true)
      expect(res.opportunity.match_decision).toBe(mismatch.match_decision)
      expect(res.opportunity.match_score).toBe(mismatch.match_score)

      const recomputed = computeMatchDecision(profile, mismatch)
      expect(recomputed.decision, `${type}: write-time authority must own the mismatch`).toBe('REJECT')
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

describe('SOFT geographic mismatch is relaxed for an authoritative engine decision', () => {
  // A TN individual. The canonical rule: geography expands outward, and the
  // matchEngine already applied geo before scoring the row above the floor, so a
  // plain out-of-state title/state mismatch is a score signal, not a hard drop.
  const tnIndividual = { primary_type: 'individual', state: 'TN', needs: ['housing'] }

  // An engine-endorsed (REVIEW, score 30) program whose TITLE names another state
  // (OH) → fires the SOFT geographic_title_state_mismatch / geographic_state_mismatch.
  // No student-aid / age / demographic pattern in the copy.
  function outOfStateProgram(overrides = {}) {
    return {
      id: 'oh-housing',
      title: 'Ohio Housing Stability Support',
      description: 'Rental and housing support for Ohio households facing hardship.',
      source: 'oh_dev',
      source_url: 'https://example.org/oh-housing',
      state: 'OH',
      match_score: 30,
      match_decision: 'REVIEW',
      ...overrides,
    }
  }

  it('SURFACES an out-of-state engine-endorsed program (geo expands outward)', () => {
    const gate = evaluateProfileSpecificGate(tnIndividual, outOfStateProgram(), STORED)
    expect(gate.pass).toBe(true)
  })

  it('DROPS the same out-of-state program when it has NO authoritative decision', () => {
    const gate = evaluateProfileSpecificGate(tnIndividual, outOfStateProgram(), UNSCORED)
    expect(gate.pass).toBe(false)
    expect(gate.ruleId.startsWith('geographic_')).toBe(true)
  })

  it('STILL drops an explicitly residents-only-exclusive program even when authoritative', () => {
    // hard: true geographic_residents_only_exclusive is NOT in the skip set.
    const residentsOnly = outOfStateProgram({
      id: 'oh-residents-only',
      title: 'Ohio Residents Only Housing Fund',
      description: 'Open only to residents of Ohio. Must reside in Ohio to apply.',
    })
    const gate = evaluateProfileSpecificGate(tnIndividual, residentsOnly, STORED)
    expect(gate.pass).toBe(false)
    expect(gate.ruleId).toBe('geographic_residents_only_exclusive')
  })
})

describe('the funnel treats a stored above-floor decision as authoritative BY DEFAULT (discovery.js parity)', () => {
  // ROOT-CAUSE GUARD for the central architectural defect: backend/routes/
  // discovery.js reads stored profile_opportunity_matches (carrying the
  // matchEngine's match_score/match_decision) and calls canonicalizeOpportunityList
  // WITHOUT useStoredDecision:true, so the display gate ran its category/geo/no-fit
  // heuristics as a SECOND eligibility trial and silently overturned engine
  // decisions — while computeMatchDecision re-ran and rewrote the stored score
  // (parity drift). The presence of a stored above-floor decision on the row IS
  // the authority; only an EXPLICIT useStoredDecision:false may opt out. These
  // tests call the funnel the way discovery.js does (flag OMITTED).
  const tnIndividual = { primary_type: 'individual', state: 'TN', needs: ['healthcare', 'disability'], disability_status: true }

  // An engine-ACCEPTED program (score 40) whose copy names veterans/military —
  // fires the CATEGORY veteran_military_without_profile_signal rule (this profile
  // has no military signal). It is NOT a directory/web-lead and has a real URL,
  // so the ONLY thing that can drop it is that population keyword net.
  function veteranTextProgram(overrides = {}) {
    return {
      id: 'vet-family-grant',
      title: 'Veterans and Military Family Assistance Grant',
      description: 'Assistance grants supporting veterans and military families with essential needs.',
      source: 'crawler-os',
      source_url: 'https://va.gov/family-assistance-grant',
      application_url: 'https://va.gov/family-assistance-grant/apply',
      state: 'TN',
      is_active: 1,
      categories: '["assistance"]',
      keywords: '["family assistance", "essential needs"]',
      match_score: 40,
      match_decision: 'ACCEPT',
      ...overrides,
    }
  }

  it('KEEPS a stored above-floor row a CATEGORY rule would drop, with the flag OMITTED', () => {
    const { kept, dropped } = canonicalizeOpportunityList(tnIndividual, [veteranTextProgram()], {
      preserveDirectories: true,
      rejectHardIneligible: true,
      // useStoredDecision intentionally OMITTED — exactly how discovery.js called it.
    })
    expect(dropped.veteran_military_without_profile_signal ?? 0).toBe(0)
    expect(kept).toHaveLength(1)
  })

  it('REUSES the stored score instead of recomputing it (no parity drift)', () => {
    const { kept } = canonicalizeOpportunityList(tnIndividual, [veteranTextProgram({ match_score: 40 })], {
      preserveDirectories: true,
      rejectHardIneligible: true,
    })
    expect(kept).toHaveLength(1)
    expect(kept[0].match_score).toBe(40)
  })

  it('an EXPLICIT useStoredDecision:false still opts out (strict second-trial preserved)', () => {
    const { kept, dropped } = canonicalizeOpportunityList(tnIndividual, [veteranTextProgram()], {
      preserveDirectories: true,
      rejectHardIneligible: true,
      useStoredDecision: false,
    })
    expect(kept).toHaveLength(0)
    expect(dropped.veteran_military_without_profile_signal).toBe(1)
  })
})
