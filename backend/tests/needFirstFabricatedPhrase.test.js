/**
 * A PHRASE the source never wrote must never gate a match.
 *
 * THE PROD REGRESSION (2026-08-01, golden-outcome sentinel, HIGH):
 * "2 verified profile(s) lost required coverage — Demo Assistive Technology Persona (ECF CHOICES,
 * verified 2026-07-07): missing tn_ecf_choices; Demo HCBS Support Persona (ECF CHOICES,
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
import {
  TEXT_FRAGMENT_SEPARATOR,
  evaluateNeedFirstMatchPolicy,
} from '../services/matching/needFirstMatchPolicyV2.js'
import {
  IDENTITY_FRAGMENT_SEPARATOR,
  detectForeignOpportunity,
} from '../config/opportunityJurisdiction.js'

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

/** A TN adult with a disability — NOT a caregiver (the Demo HCBS Support Persona shape). */
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

/**
 * THE SAME CLASS, ONE DOOR OVER: the FOREIGN-JURISDICTION funder-identity gate.
 *
 * `detectForeignOpportunity` built its identity haystack as
 * `` `${title} ${sponsor}` `` and ran the `FOREIGN_FUNDER_NAMES` registry and
 * `US_MISSION_ABROAD_RX` over it — the identical bare-space join, so the
 * boundary between two independent fields spelled phrases neither field states.
 *
 * This gate is STRICTLY more destructive than the audience gates above: a
 * `foreign: true` verdict is a REJECT inside `matchEngine.makeDecision` AND the
 * candidate key for `enforceForeignJurisdictionMatches`, whose whole job is to
 * DELETE the match row. So every fabricated phrase here silently removes a real
 * US funding source from a real profile and keeps removing it every boot.
 *
 * The three FAIL cases below were measured against the real registry on the
 * pre-fix code: all three returned `foreign: true`. They pass only with the
 * non-word `IDENTITY_FRAGMENT_SEPARATOR` join.
 */
describe('a FOREIGN verdict is a statement the row made, never one a join created', () => {
  const foreign = (row) => detectForeignOpportunity(row).foreign

  it('does not call a Louisiana row British by fusing "LA" + "Flex"', () => {
    // "…, LA" (Shreveport) + a sponsor starting "Flex" fabricated "la flex",
    // the UK Local Authority Flexible Eligibility scheme.
    expect(foreign({
      title: 'Community Development Grants — Shreveport, LA',
      sponsor: 'Flex Fund of Louisiana',
    })).toBe(false)
  })

  it('does not call a US row a diplomatic post by fusing "U.S." + "Embassy Suites"', () => {
    expect(foreign({
      title: 'Hospitality Workforce Grant — U.S.',
      sponsor: 'Embassy Suites Community Foundation',
    })).toBe(false)
  })

  it('does not call a US row a diplomatic post by fusing "U.S." + "Consulate Health Care"', () => {
    expect(foreign({
      title: 'Small Business Aid U.S.',
      sponsor: 'Consulate Health Care Foundation',
    })).toBe(false)
  })

  it('KEEPS ITS TEETH: a funder whose own field states the identity is still foreign', () => {
    // Each of these is a single field making the claim about itself, so the
    // separator changes nothing. If any of these flips, the fix went inert.
    const stillForeign = [
      { title: 'LA Flex ECO4 Insulation Scheme', sponsor: 'UK Local Authority' },
      { title: 'Individual Medical Grants', sponsor: 'Tata Trusts' },
      { title: 'Tata Trusts Individual Medical Grants', sponsor: '' },
      { title: 'U.S. Embassy Luanda Small Grants Program', sponsor: 'Dept of State' },
      { title: 'U.S. Mission to Azerbaijan — English-Language Program', sponsor: '' },
      { title: 'Energy Saving Grants — ECO4 scheme', sponsor: '' },
      { title: 'Housing Adaptation Grant', sponsor: 'Citizens Information', source_url: 'https://citizensinformation.ie/x' },
    ]
    for (const row of stillForeign) {
      expect(foreign(row), `${row.title} / ${row.sponsor} must stay FOREIGN`).toBe(true)
    }
  })

  it('the ordinary-English guard on "mission" still holds', () => {
    expect(foreign({
      title: 'Grant supporting our U.S. mission statement',
      sponsor: 'Community Fund',
    })).toBe(false)
  })

  it('STATIC DRIFT TRIPWIRE: both fragment separators are the same non-word literal', () => {
    // `config/opportunityJurisdiction.js` re-declares the separator instead of
    // importing it, because it is imported BY `services/matchEngine.js` and the
    // reverse import would close a cycle (the ESM import-time boot-crash class).
    // If the two ever drift, one gate silently regains the fabrication bug while
    // both still "work" — pin them here.
    expect(IDENTITY_FRAGMENT_SEPARATOR).toBe(TEXT_FRAGMENT_SEPARATOR)
    // The property that actually matters: the separator contains no word
    // character, so no `\b`-anchored phrase can straddle two fragments.
    expect(/\w/.test(IDENTITY_FRAGMENT_SEPARATOR)).toBe(false)
  })
})
