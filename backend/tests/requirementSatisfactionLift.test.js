/**
 * REQUIREMENT-SATISFACTION coverage lift (false-NEGATIVE fix, 2026-08-24).
 *
 * The live data-point score is profile OVERLAP (matched credit ÷ the WHOLE ~70-
 * point inventory), so a narrow fund a profile FULLY qualifies for touches ~2
 * points → 3-6% coverage → REVIEW. The existing full-satisfaction floor
 * (satisfactionBroadEligibilityLift.test.js) lifts such a fund to ACCEPT ONLY
 * when the funder states a canonical NEED the profile matches — it is blind to a
 * fund whose bar is a FIELD / PROFESSION / RESIDENCY. This generalises the floor
 * to REQUIREMENT SATISFACTION over the source's APPLICANT-scoped CLAIMS
 * (deriveSourceClaims): when the profile POSITIVELY satisfies EVERY stated
 * applicant claim (≥1 claim, zero unmet) and the SAME gates are clean, the same
 * ACCEPT floor applies. SILENCE on a dimension is never satisfaction.
 *
 * Mutation-verified (each reversion reddens a specific test):
 *   - remove the requirement-satisfaction floor block in scoreOpportunity
 *       → "a paramedic student … reaches ACCEPT" reddens (REVIEW)
 *   - treat SILENCE as satisfaction (drop the `f.size > 0` check in
 *     requirementSatisfaction) → "SILENCE is UNMET" reddens (fullySatisfied true)
 *   - count sponsor-scoped claims (drop the APPLICANT_SCOPES filter)
 *       → "a SPONSOR-scoped claim never triggers the floor" reddens
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'
import {
  deriveSourceClaims,
  requirementSatisfaction,
} from '../config/sourceClaims/core.js'
import {
  resolveProfileProfessions,
  professionSignalTextFromSections,
} from '../services/eligibility/professionEligibility.js'
import {
  ACCEPT_SCORE,
  STRONG_MATCH_SCORE,
  SATISFACTION_ACCEPT_COVERAGE,
} from '../config/matchThresholds.js'

// A rich (~63-point, calibratable) inventory so that a narrow fund touching only
// the profession/field lands the RAW profile-overlap ratio BELOW the floor
// (~12%) — the exact 2-of-70 shape from the diagnosis. Whether it reaches ACCEPT
// then depends solely on the requirement-satisfaction lift.
const BIG_INTERESTS = [
  'emergency response', 'first aid', 'fitness', 'volunteering', 'community service', 'reading',
  'hiking', 'music', 'cooking', 'photography', 'chess', 'gardening', 'painting', 'running',
  'cycling', 'swimming', 'camping', 'fishing', 'woodworking', 'pottery', 'knitting', 'baking',
  'yoga', 'meditation', 'birdwatching', 'astronomy', 'chemistry', 'history', 'languages', 'travel',
]
const RICH_SECTIONS = {
  basic_information: { first_name: 'Test', last_name: 'Medic', age: 20 },
  demographics: { age: 20, gender: 'female', ethnicity: 'white', disability_status: 'No disability' },
  health_medical: { conditions: [], has_disability: false, primary_care: 'yes', insurance: 'private' },
  government_assistance: { snap: false, medicaid: false, liheap: false, ssi: false },
  financial_information: { household_income: 28000, household_size: 3, below_poverty_line: false },
  family_life: { marital_status: 'single', number_of_children: 0 },
  housing: { housing_status: 'renting', monthly_rent: 900 },
  military_service: { veteran: false },
}

// A genuinely-qualifying paramedic student. Declares BOTH the field ("Emergency
// Medical Services" → field_of_study paramedic_ems) and the profession ("Paramedic"
// → profession emergency_medical), so it POSITIVELY satisfies the two applicant
// claims the "Paramedic Scholarship" makes about itself.
const PARAMEDIC_STUDENT = {
  id: 'p-paramedic', primary_type: 'college_student', display_name: 'Test Paramedic Student',
  state: 'TN', city: 'Nashville', postal_code: '37201',
  needs: ['education', 'tuition', 'books', 'transportation', 'housing', 'financial_assistance',
    'utilities', 'food', 'clothing_goods', 'childcare', 'healthcare', 'mental_health', 'legal',
    'employment', 'internet'],
  interests: BIG_INTERESTS,
}
const PARAMEDIC_SECTIONS = {
  ...RICH_SECTIONS,
  education: {
    highest_level: 'Some college', current_institution: 'Nashville State Community College',
    intended_major: 'Emergency Medical Services', gpa: 3.4, enrollment_status: 'full-time',
  },
  occupation: { employment_status: 'part-time', occupation: 'Paramedic', industry: 'healthcare' },
  employment: { employer: 'City EMS', years_experience: 1, hours_per_week: 20 },
}

// A narrow scholarship that states its bar as a PROFESSION/FIELD, not a canonical
// need — needTypesSupported is empty, so the needs-only floor can never fire.
function paramedicScholarship(extra = {}) {
  return {
    title: 'Paramedic Scholarship',
    sponsor: 'National EMS Memorial Foundation',
    description: 'A scholarship supporting students pursuing a career as a paramedic.',
    source_url: 'https://www.nemsmf.org/',
    application_url: 'https://www.nemsmf.org/apply',
    is_national: true,
    need_types_supported: [],
    opportunity_kind: 'DIRECT_GRANT',
    ...extra,
  }
}

const score = (profile, opp, sections) =>
  computeMatchDecision(profile, opp, { profileSections: sections })

describe('requirement-satisfaction lift — a narrow fund the profile fully qualifies for reaches ACCEPT', () => {
  it('a paramedic student who satisfies every applicant claim of a Paramedic Scholarship reaches ACCEPT', () => {
    const d = score(PARAMEDIC_STUDENT, paramedicScholarship(), PARAMEDIC_SECTIONS)
    expect(d.decision).toBe('ACCEPT')
    expect(d.score).toBeGreaterThanOrEqual(ACCEPT_SCORE)
    // Ranked in the GOOD band, not STRONG — a narrow fund, not a high-coverage match.
    expect(d.score).toBeLessThan(STRONG_MATCH_SCORE)
    // Coverage was floored by the requirement-satisfaction rule (the raw
    // profile-overlap ratio is far lower — the whole point).
    expect(d.match_explain.scoreBreakdown.data_point_coverage).toBe(SATISFACTION_ACCEPT_COVERAGE)
    // The lift came from the GENERALISED (applicant-requirement) path, not the
    // needs-only path — the funder states no canonical need.
    expect(
      d.reasons.some((r) => /Fully satisfies this funder's stated applicant requirement/i.test(r)),
    ).toBe(true)
    expect(
      d.reasons.some((r) => /Fully satisfies this funder's stated need/i.test(r)),
    ).toBe(false)
  })

  it('does NOT lift an equally-rich profile that declares NO field/profession (silence is unmet)', () => {
    // The A/B twin of the case above: SAME fund, SAME large inventory (so the raw
    // ratio is likewise below the floor), but the profession/field are undeclared.
    // The reject gates stay silent (unknown → neutral) so the row is not rejected
    // — but it is also never LIFTED, because silence is not satisfaction. It falls
    // short of ACCEPT while its paramedic twin reaches it.
    const silentProfile = { ...PARAMEDIC_STUDENT, id: 'p-silent', display_name: 'Undeclared Student' }
    const silentSections = {
      ...RICH_SECTIONS,
      education: { highest_level: 'Some college', current_institution: 'Nashville State Community College', enrollment_status: 'full-time' },
      occupation: { employment_status: 'part-time', industry: 'retail' },
    }
    const d = score(silentProfile, paramedicScholarship(), silentSections)
    expect(
      d.reasons.some((r) => /Fully satisfies this funder's stated applicant requirement/i.test(r)),
    ).toBe(false)
    expect(d.match_explain.scoreBreakdown.data_point_coverage).toBeLessThan(SATISFACTION_ACCEPT_COVERAGE)
    expect(d.decision).not.toBe('ACCEPT')
  })
})

// ── Pure comparator: requirementSatisfaction over deriveSourceClaims ──
// These pin the generalisation's semantics directly, using the SAME deps
// matchEngine wires in (professionSignalTextFromSections + resolveProfileProfessions,
// and a states stub for the residency dimension).
function professionDeps(states = []) {
  return {
    resolveProfileProfessions: (s) => resolveProfileProfessions(professionSignalTextFromSections(s)),
    profileStates: () => states,
  }
}

describe('requirementSatisfaction — the applicant-claim satisfaction contract', () => {
  const paramedicOpp = paramedicScholarship()

  it('fullySatisfied when the profile positively declares every applicant claim', () => {
    const claims = deriveSourceClaims(paramedicOpp)
    // The scholarship makes at least one APPLICANT claim (profession/field).
    expect(claims.some((c) => c.scope === 'applicant')).toBe(true)
    const sat = requirementSatisfaction(claims, PARAMEDIC_SECTIONS, professionDeps(['TN']))
    expect(sat.applicable).toBeGreaterThanOrEqual(1)
    expect(sat.unmet).toHaveLength(0)
    expect(sat.fullySatisfied).toBe(true)
  })

  it('SILENCE is UNMET — a profile that declares no field/profession is never fully satisfied', () => {
    const claims = deriveSourceClaims(paramedicOpp)
    const emptySections = { basic_information: { first_name: 'X' } }
    const sat = requirementSatisfaction(claims, emptySections, professionDeps([]))
    expect(sat.satisfied).toHaveLength(0)
    expect(sat.unmet.length).toBeGreaterThanOrEqual(1)
    expect(sat.fullySatisfied).toBe(false)
  })

  it('a CONFLICTING declaration (a nurse) is UNMET, never satisfied', () => {
    const claims = deriveSourceClaims(paramedicOpp)
    const nurseSections = {
      education: { intended_major: 'Nursing' },
      occupation: { occupation: 'Registered Nurse' },
    }
    const sat = requirementSatisfaction(claims, nurseSections, professionDeps(['TN']))
    expect(sat.fullySatisfied).toBe(false)
    expect(sat.unmet.length).toBeGreaterThanOrEqual(1)
  })

  it('a SPONSOR-scoped claim never triggers the floor (≥1 APPLICANT claim required)', () => {
    // "Ohio Nurses Foundation Scholarship" — the field word sits in the FUNDER's
    // name, so emitFieldOfStudy scopes it 'sponsor', not 'applicant'. With no
    // applicant claim, there is nothing to satisfy → the floor never applies.
    const sponsorOpp = {
      title: 'Ohio Nurses Foundation Scholarship',
      sponsor: 'Ohio Nurses Foundation',
      description: 'A general scholarship funded by the Ohio Nurses Foundation.',
      source_url: 'https://onf.org/', application_url: 'https://onf.org/apply',
      is_national: true, need_types_supported: [], opportunity_kind: 'DIRECT_GRANT',
    }
    const claims = deriveSourceClaims(sponsorOpp)
    expect(claims.some((c) => c.scope === 'applicant')).toBe(false)
    const sat = requirementSatisfaction(claims, PARAMEDIC_SECTIONS, professionDeps(['TN']))
    expect(sat.applicable).toBe(0)
    expect(sat.fullySatisfied).toBe(false)
  })

  it('a residency requirement the profile satisfies counts (jurisdiction/residency dimension)', () => {
    const tnResidentOpp = {
      title: 'Tennessee Residents Only Scholarship',
      sponsor: 'Volunteer State Education Fund',
      description: 'Open to Tennessee residents only.',
      source_url: 'https://vsef.org/', application_url: 'https://vsef.org/apply',
      is_national: false, need_types_supported: [], opportunity_kind: 'DIRECT_GRANT',
    }
    const claims = deriveSourceClaims(tnResidentOpp)
    const residency = claims.find((c) => c.dimension === 'residency' && c.scope === 'applicant')
    expect(residency?.value).toBe('TN')
    // Profile in TN satisfies it; a profile in OH does not.
    expect(requirementSatisfaction(claims, {}, professionDeps(['TN'])).fullySatisfied).toBe(true)
    expect(requirementSatisfaction(claims, {}, professionDeps(['OH'])).fullySatisfied).toBe(false)
  })
})
