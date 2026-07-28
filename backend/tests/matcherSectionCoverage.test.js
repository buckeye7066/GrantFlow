/**
 * Per-section matcher coverage tests.
 *
 * Domain audit flagged seven canonical profile sections/fields that the
 * matcher had to prove it uses for scoring, not just presentation:
 *
 *   1. veteran_owned
 *   2. woman_owned
 *   3. minority_owned
 *   4. organization_type
 *   5. population_served
 *   6. mission_focus
 *   7. employee_count / annual_revenue / years_in_operation (capacity-fit)
 *
 * Each test asserts that scoreOpportunity() attributes *some* additional
 * score when the relevant signal is present vs. when it's absent, for an
 * opportunity whose description matches that signal. Tests are
 * intentionally narrow — they do NOT bind to an exact point total, just
 * to the directional property "signal X increases score when it fits".
 */
import { describe, it, expect } from 'vitest'
import { scoreOpportunity } from '../services/matchEngine.js'
import { normalizeProfile } from '../services/profileNormalizer.js'

function ctxFor(profile, sections = {}) {
  const norm = normalizeProfile(profile, sections, null)
  return { profile, sections, profileNorm: norm }
}

const baseOppNational = {
  id: 'opp-national',
  title: 'Generic national grant',
  description: 'Open to U.S.-based applicants',
  application_url: 'https://grants.gov/generic',
  is_national: true,
  categories: [],
}

function scoreWith(profile, sections, opp) {
  const ctx = ctxFor(profile, sections)
  const r = scoreOpportunity(ctx, opp)
  return { score: r.score ?? 0, reasons: r.reasons ?? [], match_explain: r.match_explain ?? {} }
}

// Need-anchored scale (2026-07-06): the final score is need-coverage x gates,
// so specialized signals rank via the topical-evidence tie-break instead of
// inflating the percentage. Directional "signal lifts" assertions compare the
// tie-break key (with score never dropping).
function expectLift(withSignal, base) {
  // Data-point denominator semantics (2026-07-27): adding a profile fact
  // grows the inventory, so the coverage RATIO may dip slightly even as the
  // signal itself matches — the lift lives in the topical-evidence tie-break.
  // The score must never be PUNISHED below the dilution allowance of the few
  // points the new facts add to the denominator.
  expect(withSignal.score).toBeGreaterThanOrEqual(base.score - 6)
  expect(withSignal.match_explain.scoreBreakdown.topical_evidence)
    .toBeGreaterThan(base.match_explain.scoreBreakdown.topical_evidence)
}

describe('matcher per-section coverage (audit fix)', () => {
  it('1. veteran_owned lifts score for veteran-owned-business opportunities', () => {
    const opp = {
      ...baseOppNational,
      title: 'VOSB small business capital',
      description:
        'This grant is open to service-disabled veteran-owned small businesses (SDVOSB, VOSB). Preference for veteran entrepreneurs.',
    }
    const base = scoreWith(
      { id: 'p-a', state: 'TN', primary_type: 'small_business' },
      {},
      opp
    )
    const withFlag = scoreWith(
      { id: 'p-b', state: 'TN', primary_type: 'small_business' },
      { organization_details: { veteran_owned: true } },
      opp
    )
    expectLift(withFlag, base)
    expect(withFlag.reasons.join(' ')).toMatch(/veteran-owned/i)
  })

  it('2. woman_owned lifts score for WBE/WOSB opportunities', () => {
    const opp = {
      ...baseOppNational,
      title: 'Women-owned business enterprise grant',
      description:
        'Open to women-owned businesses and certified WBE / WOSB enterprises.',
    }
    const base = scoreWith({ id: 'p-a', primary_type: 'small_business' }, {}, opp)
    const withFlag = scoreWith(
      { id: 'p-b', primary_type: 'small_business' },
      { organization_details: { woman_owned: true } },
      opp
    )
    expectLift(withFlag, base)
    expect(withFlag.reasons.join(' ')).toMatch(/woman-owned/i)
  })

  it('3. minority_owned lifts score for MBE / disadvantaged-business opportunities', () => {
    const opp = {
      ...baseOppNational,
      title: 'Minority-owned business enterprise capital',
      description:
        'Funding for certified minority-owned businesses (MBE) and disadvantaged business enterprises.',
    }
    const base = scoreWith({ id: 'p-a', primary_type: 'small_business' }, {}, opp)
    const withFlag = scoreWith(
      { id: 'p-b', primary_type: 'small_business' },
      { organization_details: { minority_owned: true } },
      opp
    )
    expectLift(withFlag, base)
    expect(withFlag.reasons.join(' ')).toMatch(/minority-owned/i)
  })

  it('4. organization_type=nonprofit lifts score for nonprofit-targeted opportunities', () => {
    const opp = {
      ...baseOppNational,
      title: 'Community programs grant',
      description:
        'Open to registered nonprofit organizations (501c3) serving local communities.',
    }
    const base = scoreWith({ id: 'p-a' }, {}, opp)
    const withOrgType = scoreWith(
      { id: 'p-b' },
      { organization_details: { organization_type: 'nonprofit' } },
      opp
    )
    expectLift(withOrgType, base)
    expect(withOrgType.reasons.join(' ')).toMatch(/(org-type|nonprofit|capacity)/i)
  })

  it('5. population_served lifts score when the opportunity mentions that population', () => {
    const opp = {
      ...baseOppNational,
      title: 'Youth workforce programs',
      description:
        'Grants for programs serving at-risk youth populations in underserved communities.',
    }
    const base = scoreWith({ id: 'p-a', primary_type: 'nonprofit' }, {}, opp)
    const withPop = scoreWith(
      { id: 'p-b', primary_type: 'nonprofit' },
      { organization_details: { population_served: ['youth'] } },
      opp
    )
    // Ported to the need-anchored expectLift (like tests 1-4/7): with orgs now
    // deriving REAL fundable needs (operations/programs) instead of person-
    // benefit boilerplate, generic program grants earn genuine need credit for
    // both profiles, and population alignment ranks via the tie-break.
    expectLift(withPop, base)
    const reasonText = withPop.reasons.join(' ').toLowerCase()
    expect(reasonText).toMatch(/ownership|mission|youth|serves/)
  })

  it('6. mission_focus lifts score when the opportunity aligns with the stated focus', () => {
    const opp = {
      ...baseOppNational,
      title: 'Workforce development grant',
      description:
        'Funding for workforce development, job training, and employment-readiness programs.',
    }
    const base = scoreWith({ id: 'p-a', primary_type: 'nonprofit' }, {}, opp)
    const withFocus = scoreWith(
      { id: 'p-b', primary_type: 'nonprofit' },
      { organization_details: { mission_focus: ['workforce development'] } },
      opp
    )
    expectLift(withFocus, base)
  })

  it('7. capacity signals (employee_count / annual_revenue / years_in_operation) lift score for matching-stage opportunities', () => {
    const opp = {
      ...baseOppNational,
      title: 'Startup seed funding',
      description:
        'Microenterprise and early-stage startup funding for emerging small businesses with fewer than 50 employees and under $500k revenue.',
    }
    const base = scoreWith(
      { id: 'p-a', primary_type: 'small_business' },
      {},
      opp
    )
    const withCapacity = scoreWith(
      { id: 'p-b', primary_type: 'small_business' },
      {
        organization_details: {
          employee_count: 5,
          annual_revenue: 120000,
          years_in_operation: 1,
          organization_type: 'small business',
        },
      },
      opp
    )
    expectLift(withCapacity, base)
    const reasonText = withCapacity.reasons.join(' ').toLowerCase()
    expect(reasonText).toMatch(/capacity|employees|revenue|years|startup/)
  })

  it('capacity signals do NOT disqualify when opportunity does not match — they only boost', () => {
    const opp = {
      ...baseOppNational,
      title: 'Generic national grant',
      description: 'General-purpose funding open to all applicants.',
    }
    const lean = scoreWith({ id: 'p-a' }, {}, opp)
    const richSignals = scoreWith(
      { id: 'p-b' },
      {
        organization_details: {
          employee_count: 5,
          annual_revenue: 120000,
          years_in_operation: 1,
          organization_type: 'nonprofit',
          population_served: ['youth'],
          mission_focus: ['workforce'],
          veteran_owned: true,
          woman_owned: true,
          minority_owned: true,
        },
      },
      opp
    )
    // Rich profile must still score for a generic opportunity — capacity
    // signals must never zero-out or disqualify a profile when the
    // opportunity is broad.
    expect(richSignals.score).toBeGreaterThan(0)
    // And the gap vs a lean profile must stay small; capacity signals are
    // strictly additive when they fit. Allow a small differential for
    // unrelated scoring noise (e.g., profile depth) but never a meaningful
    // penalty.
    expect(lean.score - richSignals.score).toBeLessThan(5)
  })
})
