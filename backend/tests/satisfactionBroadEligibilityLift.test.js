/**
 * FULL-SATISFACTION coverage lift for broadly-eligible funds (owner directive
 * 2026-08-23, "scoring later"). The data-point score is matched-credit ÷ the
 * WHOLE profile inventory, so a broadly-eligible fund that states FEW criteria
 * scores LOW even for someone who FULLY satisfies it: a national patient-
 * assistance fund (PAN, HealthWell, Modest Needs) touches 1-2 of a ~70-point
 * inventory → 6-10% coverage → REVIEW, never ACCEPT. The cure is a SATISFACTION
 * ratio: when the profile satisfies EVERY need the funder STATES, the gates pass
 * cleanly, and the inventory is rich enough to calibrate, coverage is floored so
 * the match reaches ACCEPT — ranked in the GOOD band, never STRONG.
 *
 * Two prior bugs blocked the motivating profiles entirely and are pinned here:
 *   1. applicantTypeGate.bucket() did not recognise the individual-root leaves
 *      `disabled_adult` / `senior` / `medical_need`, so every one of their
 *      matches read `profile_applicant_type_missing` → the eligibility-
 *      confirmation cap held EVERY match below ACCEPT (prod 2026-08-23:
 *      disabled_adult 0/42, senior 0/94 accepts fleet-wide).
 *   2. makeDecision's inline `isIndividual` list omitted the same leaves, so the
 *      "source states no applicant type" gate downgraded their ACCEPTs to REVIEW.
 *
 * Mutation-verified (each reversion reddens a specific test — recorded in the PR):
 *   - remove the satisfaction lift  → "reaches ACCEPT" reddens (score 9, REVIEW)
 *   - restore the pre-fix isIndividual list → "reaches ACCEPT" reddens (REVIEW)
 *   - remove bucketByRegistryRoot     → "individual-root leaves bucket" reddens
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision, makeDecision } from '../services/matchEngine.js'
import { resolveProfileBuckets } from '../services/applicantTypeGate.js'
import { ACCEPT_SCORE, STRONG_MATCH_SCORE, SATISFACTION_ACCEPT_COVERAGE } from '../config/matchThresholds.js'

// A genuinely-qualifying disabled adult with a rich (calibratable) inventory.
const DISABLED_ADULT = {
  id: 'p-disabled', primary_type: 'disabled_adult', display_name: 'Test Disabled Adult',
  state: 'OH', city: 'Cleveland', postal_code: '44101',
  needs: ['medical', 'disability', 'financial_assistance', 'utilities', 'transportation', 'housing', 'food', 'clothing_goods'],
  interests: ['adaptive sports', 'gardening', 'reading', 'music', 'cooking', 'history', 'fishing', 'woodworking', 'chess', 'photography'],
}
const DISABLED_SECTIONS = {
  basic_information: { first_name: 'Test', last_name: 'Person', age: 45 },
  demographics: { disability_status: 'Has disability', age: 45, gender: 'male', ethnicity: 'white' },
  health_medical: { conditions: ['chronic illness', 'mobility impairment'], has_disability: true },
  government_assistance: { ssdi_recipient_self: true, medicaid: true, snap: true, liheap: true },
  financial_information: { household_income: 14000, household_size: 1, below_poverty_line: true },
  family_life: { marital_status: 'single', number_of_children: 0 },
  occupation: { employment_status: 'unable to work', industry: 'none' },
}

// A national assistance fund that states ONE need (health_medical), with a usable
// URL and NO entity-type restriction — the shape of a real HealthWell / PAN row.
function nationalMedicalFund(extra = {}) {
  return {
    title: 'HealthWell Foundation Financial Grants',
    sponsor: 'HealthWell Foundation',
    description: 'Financial grants toward medical costs for people with a qualifying condition and financial need.',
    source_url: 'https://www.healthwellfoundation.org/',
    application_url: 'https://www.healthwellfoundation.org/apply',
    is_national: true,
    need_types_supported: ['health_medical'],
    opportunity_kind: 'DIRECT_GRANT',
    ...extra,
  }
}

const score = (profile, opp, sections) =>
  computeMatchDecision(profile, opp, { profileSections: sections })

describe('full-satisfaction lift — a broadly-eligible fund the profile qualifies for reaches ACCEPT', () => {
  it('a disabled adult who fully satisfies a single-criterion national medical fund reaches ACCEPT', () => {
    const d = score(DISABLED_ADULT, nationalMedicalFund(), DISABLED_SECTIONS)
    expect(d.decision).toBe('ACCEPT')
    expect(d.score).toBeGreaterThanOrEqual(ACCEPT_SCORE)
    // Landed in the GOOD band, NOT STRONG — proportionate, ranked below
    // high-coverage strong matches.
    expect(d.score).toBeLessThan(STRONG_MATCH_SCORE)
    // The coverage was floored by the satisfaction rule (the raw ratio is far
    // lower — the whole point).
    expect(d.match_explain.scoreBreakdown.data_point_coverage).toBe(SATISFACTION_ACCEPT_COVERAGE)
    expect(d.reasons.some((r) => /Fully satisfies this funder's stated need/i.test(r))).toBe(true)
  })

  it('does NOT lift a LOW-satisfaction match: the funder states a need the profile does not declare', () => {
    // Funder states health_medical AND education; the profile declares no
    // education need, so satisfaction is 1/2 — not full → no lift.
    const d = score(DISABLED_ADULT, nationalMedicalFund({ need_types_supported: ['health_medical', 'education'] }), DISABLED_SECTIONS)
    expect(d.match_explain.scoreBreakdown.data_point_coverage).toBeLessThan(SATISFACTION_ACCEPT_COVERAGE)
    expect(d.reasons.some((r) => /Fully satisfies this funder's stated need/i.test(r))).toBe(false)
    expect(d.score).toBeLessThan(ACCEPT_SCORE)
  })

  it('does NOT lift a STATED-NOTHING fund (MISSING = NEUTRAL — silence is not full satisfaction)', () => {
    // A genuinely stateless fund: no need vocabulary in title/description, so the
    // normalizer infers no need types (the real "HealthWell Foundation" plain row
    // carried an empty needTypesSupported for exactly this reason). It must NOT be
    // treated as "fully satisfied by everyone".
    const statelessFund = {
      title: 'HealthWell Foundation',
      sponsor: 'HealthWell Foundation',
      description: 'A national foundation.',
      source_url: 'https://www.healthwellfoundation.org/',
      application_url: 'https://www.healthwellfoundation.org/apply',
      is_national: true,
      need_types_supported: [],
      opportunity_kind: 'PROGRAM',
    }
    const d = score(DISABLED_ADULT, statelessFund, DISABLED_SECTIONS)
    expect(d.reasons.some((r) => /Fully satisfies this funder's stated need/i.test(r))).toBe(false)
    expect(d.match_explain.scoreBreakdown.data_point_coverage).toBeLessThan(SATISFACTION_ACCEPT_COVERAGE)
  })

  it('does NOT lift a DIRECTORY/pointer (the locator rule — a pointer never claims ACCEPT)', () => {
    const d = score(DISABLED_ADULT, nationalMedicalFund({ opportunity_kind: 'DIRECTORY' }), DISABLED_SECTIONS)
    expect(d.decision).not.toBe('ACCEPT')
    expect(d.reasons.some((r) => /Fully satisfies this funder's stated need/i.test(r))).toBe(false)
  })

  it('does NOT lift a thin/uncalibratable profile (< MIN_CALIBRATED_INVENTORY) — the stub-junk guard', () => {
    const thinProfile = { id: 'p-thin', primary_type: 'disabled_adult', state: 'OH', city: 'Cleveland', needs: ['medical'] }
    const thinSections = { basic_information: { first_name: 'T' }, demographics: { disability_status: 'Has disability' } }
    const d = score(thinProfile, nationalMedicalFund(), thinSections)
    expect(d.reasons.some((r) => /Fully satisfies this funder's stated need/i.test(r))).toBe(false)
  })
})

describe('applicant-type bucket recognises individual-root leaves (the eligibility-confirmation-cap bug)', () => {
  it.each(['disabled_adult', 'senior', 'medical_need'])(
    'resolveProfileBuckets(%s) rolls up to the individual bucket', (type) => {
      const buckets = resolveProfileBuckets(type)
      expect(buckets.has('individual')).toBe(true)
    },
  )

  it('a business-root leaf is NOT bucketed as an individual', () => {
    expect(resolveProfileBuckets('small_business').has('individual')).toBe(false)
  })
})

describe('makeDecision — a source that states no applicant type still ACCEPTs an individual-root leaf', () => {
  const STATELESS_OPP = {
    title: 'National Support Program', is_national: true,
    source_url: 'https://x.org', application_url: 'https://x.org/apply',
  }
  it('a senior ACCEPTs a stateless-applicability fund at an ACCEPT-level score (not held at REVIEW)', () => {
    const senior = { id: 'p', primary_type: 'senior', state: 'OH', city: 'Cleveland', needs: ['housing'] }
    const d = makeDecision(ACCEPT_SCORE + 4, senior, STATELESS_OPP)
    expect(d.decision).toBe('ACCEPT')
  })
  it('an ORGANIZATION does NOT auto-ACCEPT the same silent fund — org silence stays REVIEW', () => {
    const org = { id: 'o', primary_type: 'nonprofit', state: 'OH', needs: ['housing'] }
    const d = makeDecision(ACCEPT_SCORE + 4, org, STATELESS_OPP)
    expect(d.decision).toBe('REVIEW')
  })
})
