/**
 * matchEngineIdentityAndMultiState.test.js
 *
 * Regression coverage for two production matching bugs:
 *
 * BUG A — Ethnicity-restricted scholarships matched ineligible profiles at 96%.
 *   A White/Caucasian profile was surfaced "UNCF" (African-American-only) and
 *   "Hispanic Scholarship Fund" (Hispanic-only) as strong matches because the
 *   matcher only BOOSTED on ethnicity match and never GATED an explicit
 *   exclusivity mismatch. Canonical rule G4: population/eligibility mismatches
 *   reduce score, not discard — UNLESS the opportunity is EXPLICITLY EXCLUSIVE.
 *   UNCF/HSF ARE explicitly exclusive, so a clearly-ineligible profile must be
 *   HARD-REJECTED, while a profile of UNKNOWN ethnicity must NOT be hard-rejected
 *   (missing field = neutral).
 *
 * BUG B — A profile with TWO states (home + school, or a multi-state service
 *   area) must match LOCAL opportunities in BOTH states, not only the primary.
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'
import { normalizeProfile } from '../services/profileNormalizer.js'
import { normalizeOpportunity, ethnicityToBucket } from '../services/opportunityNormalizer.js'

// ---------------------------------------------------------------------------
// BUG A — explicit ethnicity restriction gating
// ---------------------------------------------------------------------------

const UNCF_OPP = {
  id: 'uncf',
  title: 'UNCF (United Negro College Fund) Scholarship',
  description:
    'Scholarships for African American students pursuing higher education. Open to Black students.',
  application_url: 'https://uncf.org/scholarships',
  is_national: true,
  funding_type: 'scholarship',
  categories: ['education', 'scholarship'],
}

const HSF_OPP = {
  id: 'hsf',
  title: 'Hispanic Scholarship Fund',
  description:
    'Scholarships for Hispanic/Latino students. Hispanic heritage required. Open only to Latino applicants.',
  application_url: 'https://hsf.net/scholarship',
  is_national: true,
  funding_type: 'scholarship',
  categories: ['education', 'scholarship'],
}

const INCLUSIVE_OPP = {
  id: 'inclusive',
  title: 'General Merit Scholarship',
  description:
    'A merit scholarship for undergraduate students. We welcome diverse applicants from all backgrounds.',
  application_url: 'https://example.org/merit',
  is_national: true,
  funding_type: 'scholarship',
  categories: ['education', 'scholarship'],
}

// A White/Caucasian student profile (clearly ineligible for UNCF/HSF).
const whiteStudentProfile = {
  id: 'p-white',
  primary_type: 'student',
  state: 'TN',
  ethnicity: 'White / Caucasian',
}
const whiteStudentSections = {
  basic_information: { state: 'TN', gender: 'male' },
  education: { is_student: true, school_name: 'MTSU', gpa: 3.6 },
  demographics: { ethnicity: 'White / Caucasian', citizenship: 'American' },
}

// A student profile with NO ethnicity stated (unknown → neutral).
const unknownEthnicityProfile = {
  id: 'p-unknown',
  primary_type: 'student',
  state: 'TN',
}
const unknownEthnicitySections = {
  basic_information: { state: 'TN' },
  education: { is_student: true, school_name: 'MTSU', gpa: 3.6 },
}

// An African-American student profile (clearly eligible for UNCF).
const blackStudentProfile = {
  id: 'p-black',
  primary_type: 'student',
  state: 'TN',
  ethnicity: 'African American',
}
const blackStudentSections = {
  basic_information: { state: 'TN' },
  education: { is_student: true, school_name: 'MTSU', gpa: 3.6 },
  demographics: { african_american: true },
}

describe('BUG A — explicit ethnicity restriction gating', () => {
  it('normalizeOpportunity flags UNCF as African-American-only and HSF as Hispanic-only', () => {
    expect(normalizeOpportunity(UNCF_OPP).requiresEthnicity).toContain('african_american')
    expect(normalizeOpportunity(HSF_OPP).requiresEthnicity).toContain('hispanic_latino')
  })

  it('does NOT flag an inclusive "we welcome diverse applicants" opportunity as restricted', () => {
    expect(normalizeOpportunity(INCLUSIVE_OPP).requiresEthnicity).toEqual([])
  })

  it('ethnicityToBucket classifies a White/Caucasian string as white', () => {
    expect(ethnicityToBucket('White / Caucasian')).toBe('white')
  })

  it('normalizeProfile derives ethnicityBucket=white for a White/Caucasian profile', () => {
    const norm = normalizeProfile(whiteStudentProfile, whiteStudentSections, null)
    expect(norm.ethnicityBucket).toBe('white')
  })

  it('REJECTS a White/Caucasian profile for an African-American-only scholarship (UNCF)', () => {
    const norm = normalizeProfile(whiteStudentProfile, whiteStudentSections, null)
    const decision = computeMatchDecision(norm, UNCF_OPP, { profileSections: whiteStudentSections })
    expect(decision.decision).toBe('REJECT')
    expect(decision.score).toBe(0)
    expect(decision.eligible).toBe(false)
    expect(decision.ineligibilityReasons.join(' ')).toMatch(/african_american/i)
  })

  it('REJECTS a White/Caucasian profile for a Hispanic-only scholarship (HSF)', () => {
    const norm = normalizeProfile(whiteStudentProfile, whiteStudentSections, null)
    const decision = computeMatchDecision(norm, HSF_OPP, { profileSections: whiteStudentSections })
    expect(decision.decision).toBe('REJECT')
    expect(decision.score).toBe(0)
  })

  it('does NOT hard-reject an UNKNOWN-ethnicity profile for UNCF (missing field = neutral)', () => {
    const norm = normalizeProfile(unknownEthnicityProfile, unknownEthnicitySections, null)
    expect(norm.ethnicityBucket).toBeFalsy()
    const decision = computeMatchDecision(norm, UNCF_OPP, { profileSections: unknownEthnicitySections })
    expect(decision.decision).not.toBe('REJECT')
    expect(decision.missingEligibilityFields).toContain('ethnicity')
  })

  it('does NOT reject (and still surfaces) an eligible African-American profile for UNCF', () => {
    const norm = normalizeProfile(blackStudentProfile, blackStudentSections, null)
    expect(norm.ethnicityBucket).toBe('african_american')
    const decision = computeMatchDecision(norm, UNCF_OPP, { profileSections: blackStudentSections })
    expect(decision.decision).not.toBe('REJECT')
    expect(decision.score).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// BUG B — multi-state geographic matching
// ---------------------------------------------------------------------------

const TN_OPP = {
  id: 'tn-opp',
  title: 'Tennessee Local Family Assistance',
  description: 'Local financial assistance for Tennessee residents in need.',
  application_url: 'https://tn.example.org/assistance',
  state: 'TN',
  is_national: false,
  categories: ['financial_assistance'],
}
const OH_OPP = {
  id: 'oh-opp',
  title: 'Ohio Local Family Assistance',
  description: 'Local financial assistance for Ohio residents in need.',
  application_url: 'https://oh.example.org/assistance',
  state: 'OH',
  is_national: false,
  categories: ['financial_assistance'],
}
const CA_OPP = {
  id: 'ca-opp',
  title: 'California Local Family Assistance',
  description: 'Local financial assistance for California residents.',
  application_url: 'https://ca.example.org/assistance',
  state: 'CA',
  is_national: false,
  categories: ['financial_assistance'],
}

// Single-address (primary OH) profile.
const ohOnlyProfile = { id: 'p-oh', primary_type: 'individual', state: 'OH', needs: ['financial_assistance'] }
const ohOnlySections = { basic_information: { state: 'OH' } }

// Two-state profile: home OH + school TN (via secondary_address).
const ohPlusTnProfile = { id: 'p-oh-tn', primary_type: 'individual', state: 'OH', needs: ['financial_assistance'] }
const ohPlusTnSections = {
  basic_information: {
    state: 'OH',
    secondary_address: { state: 'TN', city: 'Murfreesboro' },
  },
}

describe('BUG B — multi-state geographic matching', () => {
  it('normalizeProfile surfaces BOTH states for a two-address profile', () => {
    const norm = normalizeProfile(ohPlusTnProfile, ohPlusTnSections, null)
    expect(norm.states).toContain('OH')
    expect(norm.states).toContain('TN')
  })

  it('a single-address profile still surfaces exactly its one state', () => {
    const norm = normalizeProfile(ohOnlyProfile, ohOnlySections, null)
    expect(norm.states).toEqual(['OH'])
  })

  it('a two-state profile is NOT geo-rejected for an opportunity in EITHER state', () => {
    const norm = normalizeProfile(ohPlusTnProfile, ohPlusTnSections, null)
    const oh = computeMatchDecision(norm, OH_OPP, { profileSections: ohPlusTnSections })
    const tn = computeMatchDecision(norm, TN_OPP, { profileSections: ohPlusTnSections })
    expect(oh.decision).not.toBe('REJECT')
    expect(tn.decision).not.toBe('REJECT')
  })

  it('the secondary-state opportunity scores in-state (state tier), not a mismatch', () => {
    const norm = normalizeProfile(ohPlusTnProfile, ohPlusTnSections, null)
    const tn = computeMatchDecision(norm, TN_OPP, { profileSections: ohPlusTnSections })
    const geoComponent = tn.match_explain?.scoreBreakdown?.geo_component ?? 0
    // State tier = 75 in scoreGeoComponent; a mismatch would be 10.
    expect(geoComponent).toBeGreaterThanOrEqual(75)
  })

  it('adding a second state never lowers the score for the primary-state opportunity', () => {
    const ohOnlyNorm = normalizeProfile(ohOnlyProfile, ohOnlySections, null)
    const ohPlusTnNorm = normalizeProfile(ohPlusTnProfile, ohPlusTnSections, null)
    const single = computeMatchDecision(ohOnlyNorm, OH_OPP, { profileSections: ohOnlySections })
    const multi = computeMatchDecision(ohPlusTnNorm, OH_OPP, { profileSections: ohPlusTnSections })
    expect(multi.score).toBeGreaterThanOrEqual(single.score)
  })

  it('a state in NEITHER of the profile states still does not get full in-state geo credit', () => {
    const norm = normalizeProfile(ohPlusTnProfile, ohPlusTnSections, null)
    const ca = computeMatchDecision(norm, CA_OPP, { profileSections: ohPlusTnSections })
    const geoComponent = ca.match_explain?.scoreBreakdown?.geo_component ?? 100
    expect(geoComponent).toBeLessThan(75)
  })
})
