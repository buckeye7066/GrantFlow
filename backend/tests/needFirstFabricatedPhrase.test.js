/**
 * A PHRASE the source never wrote must never gate a match.
 *
 * THE PROD REGRESSION (2026-08-01, golden-outcome sentinel, HIGH):
 * "2 verified profile(s) lost required coverage — Gilbert McCosh (ECF CHOICES,
 * verified 2026-07-07): missing tn_ecf_choices; Kimberly Botts (ECF CHOICES,
 * verified 2026-07-07): missing tn_ecf_choices."
 *
 * Measured read-only in prod that morning: 13 ACTIVE `tn_ecf_choices` catalog
 * rows, the lane recording `planned:true queried:true failed:false found:13`
 * for BOTH profiles minutes earlier — and **0** `profile_opportunity_matches`
 * rows pointing at any of them, fleet-wide.
 *
 * Cause: every audience gate in needFirstMatchPolicyV2 tests a MULTI-WORD
 * phrase against one string built by joining independent fragments — including
 * every member of `categories[]` and `keywords[]` — with a bare space. The
 * `tn_ecf_choices` registry row declares
 * `applicant_types: ['individual','family','veteran','disabled','caregiver']`,
 * which `crawler-os/matchEngine.opportunityToCanonicalOpportunity` folds into
 * `categories`. Two adjacent, unrelated tokens — `'family'` and `'caregiver'` —
 * became the literal substring "family caregiver", the caregiver gate fired,
 * the decision became REJECT, and `crawlerOsPersistenceCore` drops rejects
 * (`decision === 'reject' → continue`). The match store is a ROLLING SNAPSHOT,
 * so the owner-verified rows disappeared on the profiles' next crawl.
 *
 * Note what the source ACTUALLY says: the ECF page's own prose is "… including
 * Essential Family Supports for family caregiverS" — plural, so `\bcaregiver\b`
 * never matched it. The ONLY string that ever matched was fabricated by the
 * join.
 *
 * These tests all FAIL on the pre-fix `join(' ')`.
 */
import { describe, expect, it } from 'vitest'
import { evaluateNeedFirstMatchPolicy } from '../services/matching/needFirstMatchPolicyV2.js'

/**
 * The EXACT arrays `crawler-os/matchEngine.opportunityToCanonicalOpportunity`
 * emits for a `tn_ecf_choices` candidate, captured by running the real adapter
 * + mapper on 2026-08-01. Do not "tidy" the order: `categories` ends
 * `… 'disabled', 'family', 'caregiver'`, and it is that ADJACENCY of two
 * independent tokens that a bare-space join turned into "family caregiver".
 * The order falls out of `uniqueStrings([...needs, ...allowedTypes,
 * ...applicantTypes])` over the registry's
 * `applicant_types: ['individual','family','veteran','disabled','caregiver']`.
 */
const ECF_CATEGORIES = Object.freeze([
  'disability', 'healthcare', 'medical', 'employment', 'caregiving',
  'individual', 'veteran', 'disabled', 'family', 'caregiver',
])
const ECF_KEYWORDS = Object.freeze([
  'disability', 'healthcare', 'medical', 'employment', 'caregiving',
  'individual', 'family', 'veteran', 'disabled', 'caregiver',
  'tn_ecf_choices', 'program', 'tenncare',
])

function ecfOpportunity(overrides = {}) {
  return {
    title: 'Katie Beckett Program',
    sponsor: 'TennCare',
    summary: 'Discovered from TennCare Employment and Community First CHOICES (ECF CHOICES): Katie Beckett Program',
    description: 'Eligible applicants: individual, family, veteran, disabled, caregiver',
    opportunity_kind: 'BENEFIT',
    categories: [...ECF_CATEGORIES],
    keywords: [...ECF_KEYWORDS],
    state: 'TN',
    ...overrides,
  }
}

/** A TN adult with a disability — NOT a caregiver (the Kimberly Botts shape). */
const disabledAdultContext = {
  profile: { id: 'p-kim', primary_type: 'individual' },
  sections: {
    demographics: {},
    family_life: {},
    occupation: {},
    health_medical: { disability: true },
  },
}
const disabledAdultNorm = {
  entityType: 'individual',
  isCaregiver: false,
  needCategories: ['disability', 'healthcare'],
  effectiveFacets: ['individual'],
}

function evaluate(opportunity, overrides = {}) {
  return evaluateNeedFirstMatchPolicy({
    opportunity,
    profileContext: disabledAdultContext,
    profileNorm: disabledAdultNorm,
    matchedNeeds: ['disability'],
    ...overrides,
  })
}

const hard = (result) => result?.hardMismatches ?? []

describe('a phrase the source never wrote never gates a match', () => {
  it('does NOT call an ECF CHOICES row caregiver-only (the Gilbert/Kim regression)', () => {
    const result = evaluate(ecfOpportunity())
    expect(hard(result)).not.toContain('Caregiver-only program requires a caregiver signal')
    expect(result.hardMismatch).toBe(false)
  })

  it('is the ADJACENCY that was wrong, not the presence of the tokens', () => {
    // Separating the two tokens was already harmless on the old code; leaving
    // them adjacent is exactly what broke. The verdict must be the same either
    // way, because neither arrangement is a statement by the source.
    const adjacent = evaluate(ecfOpportunity())
    const separated = evaluate(ecfOpportunity({
      categories: ECF_CATEGORIES.filter((t) => t !== 'family'),
      keywords: ['tn_ecf_choices'],
    }))
    expect(hard(adjacent)).toEqual(hard(separated))
  })

  it('still hard-mismatches a program whose OWN TITLE names family caregivers', () => {
    // The gate keeps its teeth: this is a real caregiver-targeted award, and a
    // non-caregiver profile must still be refused it.
    const result = evaluate(ecfOpportunity({
      title: 'ECF CHOICES Family Caregiver Stipend',
    }))
    expect(hard(result)).toContain('Caregiver-only program requires a caregiver signal')
  })

  it('still hard-mismatches when the restriction is real prose in the description', () => {
    const result = evaluate(ecfOpportunity({
      title: 'Statewide Respite Program',
      description: 'This award funds respite care for enrolled participants.',
      categories: ['caregiving'],
      keywords: ['respite'],
    }))
    expect(hard(result)).toContain('Caregiver-only program requires a caregiver signal')
  })

  it('the class holds for every multi-word audience gate, not just caregiver', () => {
    // Each pair is two INDEPENDENT tokens that a bare-space join would fuse
    // into the phrase named beside it. None of these programs is restricted.
    const cases = [
      { tokens: ['child', 'care'], reason: 'Child/dependent program requires a child, dependent, or pregnancy signal' },
      { tokens: ['foster', 'youth'], reason: 'Foster-youth program requires a current or former foster-youth signal' },
      { tokens: ['respite', 'care'], reason: 'Caregiver-only program requires a caregiver signal' },
      { tokens: ['caregiver', 'support'], reason: 'Caregiver-only program requires a caregiver signal' },
    ]
    for (const { tokens, reason } of cases) {
      const result = evaluate({
        title: 'Community Assistance Program',
        description: 'General community assistance.',
        opportunity_kind: 'BENEFIT',
        categories: tokens,
        keywords: [],
        state: 'TN',
      })
      expect(hard(result), `tokens ${tokens.join('+')} must not fabricate "${tokens.join(' ')}"`)
        .not.toContain(reason)
    }
  })

  it('a phrase split across the title/description boundary is not fused either', () => {
    const result = evaluate({
      title: 'Bradley County Programs for a Family',
      description: 'Caregiver enrollment is handled by the state.',
      opportunity_kind: 'BENEFIT',
      categories: [],
      keywords: [],
      state: 'TN',
    })
    expect(hard(result)).not.toContain('Caregiver-only program requires a caregiver signal')
  })
})
