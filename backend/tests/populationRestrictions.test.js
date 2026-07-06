/**
 * populationRestrictions.test.js
 *
 * Regression coverage for the 2026-07-06 crawler-reliability fix set: the
 * persistent ineligible_surfaced_match / relevance_precision classes Sam's
 * daily report flagged (domestic_violence_survivor, agricultural_cooperative,
 * community_development_corp) plus age / income / faith restrictions.
 *
 * Doctrine under test (canonical G4):
 *   - topical population programs CAP score for non-matching profiles
 *     (mismatch reduces score, never blanket-discards),
 *   - EXPLICITLY exclusive text hard-gates only on a clear contradiction,
 *   - an unknown profile trait is a MISSING field (REVIEW), never a reject.
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision, evaluateEligibility } from '../services/matchEngine.js'
import { normalizeProfile } from '../services/profileNormalizer.js'
import { normalizeOpportunity, detectAgeRestriction } from '../services/opportunityNormalizer.js'

// ── Normalizer flags ─────────────────────────────────────────────────────────

describe('opportunityNormalizer population/sector restriction flags', () => {
  it('flags DV topical programs and explicit survivor-only restrictions separately', () => {
    const topical = normalizeOpportunity({
      id: 'dv-1',
      title: 'OVW Transitional Housing Assistance',
      description: 'Funding for organizations providing victim services under VAWA.',
    })
    expect(topical.isDvProgram).toBe(true)
    expect(topical.requiresDvSurvivor).toBe(false)

    const survivorOnly = normalizeOpportunity({
      id: 'dv-2',
      title: 'Fresh Start Fund',
      description: 'Emergency cash assistance for survivors of domestic violence only.',
    })
    expect(survivorOnly.requiresDvSurvivor).toBe(true)
  })

  it('flags agriculture-only restrictions', () => {
    const n = normalizeOpportunity({
      id: 'ag-1',
      title: 'Value-Added Producer Grant',
      description: 'Eligible applicants are farmers, ranchers, and agricultural producer groups. An FSA farm number is required.',
    })
    expect(n.requiresFarmer).toBe(true)
  })

  it('flags faith-based-only restrictions', () => {
    const n = normalizeOpportunity({
      id: 'faith-1',
      title: 'Sanctuary Facility Improvement Grants',
      description: 'Churches only. Applicant must own its facility.',
    })
    expect(n.requiresFaithBased).toBe(true)
  })

  it('flags CDC-only restrictions', () => {
    const n = normalizeOpportunity({
      id: 'cdc-1',
      title: 'Affordable Housing Development Program',
      description: 'Limited to certified community development corporations (CHDOs).',
    })
    expect(n.requiresCdc).toBe(true)
  })

  it('flags explicit means-tests (requiresLowIncome), not casual low-income mentions', () => {
    const restricted = normalizeOpportunity({
      id: 'inc-1',
      title: 'Energy Bill Relief',
      description: 'Applicants must meet income eligibility limits: income at or below 200% of the federal poverty level.',
    })
    expect(restricted.requiresLowIncome).toBe(true)

    const casual = normalizeOpportunity({
      id: 'inc-2',
      title: 'Community Center Grant',
      description: 'Our foundation invests in programs serving low-income neighborhoods.',
    })
    expect(casual.requiresLowIncome).toBe(false)
  })

  it('detects explicit age restrictions with sane bounds', () => {
    expect(detectAgeRestriction('Applicants must be at least 60 years of age.')).toEqual({ min: 60, max: null })
    expect(detectAgeRestriction('Open to youth ages 14 to 18.')).toEqual({ min: 14, max: 18 })
    expect(detectAgeRestriction('For entrepreneurs under the age of 25.')).toEqual({ min: null, max: 24 })
    expect(detectAgeRestriction('Serving adults 65+ in our county.')).toEqual({ min: 65, max: null })
    expect(detectAgeRestriction('No age language here.')).toBeNull()
    // implausible numbers are ignored, not misparsed
    expect(detectAgeRestriction('established 103 years ago')).toBeNull()
  })
})

// ── Eligibility gate behavior ────────────────────────────────────────────────

const STUDENT_PROFILE = {
  profile: { id: 'p-student', primary_type: 'individual', state: 'TN', city: 'Cleveland', age: 20 },
  sections: { education: { answers: { is_student: true, school_name: 'Cleveland State Community College' } } },
}

const DV_SURVIVOR_PROFILE = {
  profile: { id: 'p-dv', primary_type: 'individual', state: 'TN', city: 'Cleveland', age: 34 },
  sections: {
    personal_circumstances: { answers: { situation: 'Recently left an abusive relationship; survivor of domestic violence seeking housing help.' } },
  },
}

function norm(p) {
  return normalizeProfile(p.profile, { profileSections: p.sections })
}

describe('evaluateEligibility — explicit restrictions demote with reasons, never blind-discard', () => {
  const dvOnlyOpp = normalizeOpportunity({
    id: 'dv-only',
    title: 'Fresh Start Fund',
    description: 'Emergency cash assistance for survivors of domestic violence only. Contact our office to apply.',
    state: 'TN',
    application_url: 'https://example.org/apply',
  })

  it('DV-survivor-only: survivor profile carries the signal; non-survivor is a MISSING field (REVIEW), not a hard reject', () => {
    const survivor = norm(DV_SURVIVOR_PROFILE)
    expect(survivor.isDvSurvivor).toBe(true)
    const rSurvivor = evaluateEligibility(survivor, dvOnlyOpp)
    expect(rSurvivor.ineligibilityReasons.join(' ')).not.toMatch(/domestic violence/i)

    const student = norm(STUDENT_PROFILE)
    const rStudent = evaluateEligibility(student, dvOnlyOpp)
    expect(rStudent.eligible).not.toBe(true)
    expect(rStudent.missingFields).toContain('dv_survivor_status')
  })

  it('agriculture-only: clearly non-agricultural individual gets an explicit ineligibility reason', () => {
    const agOpp = normalizeOpportunity({
      id: 'ag-only',
      title: 'Value-Added Producer Grant',
      description: 'Eligible applicants are farmers, ranchers, and agricultural producers. Awards up to $75,000.',
      is_national: true,
      application_url: 'https://example.org/vapg',
    })
    const student = norm(STUDENT_PROFILE)
    const r = evaluateEligibility(student, agOpp)
    expect(r.eligible).toBe(false)
    expect(r.ineligibilityReasons.join(' ')).toMatch(/agricultural producer/i)
  })

  it('age restriction: hard reason when profile age clearly violates it; missing field when age unknown', () => {
    const seniorOnly = normalizeOpportunity({
      id: 'age-1',
      title: 'Senior Home Repair Fund',
      description: 'Applicants must be at least 60 years of age. Grants of $2,000.',
      state: 'TN',
      application_url: 'https://example.org/senior',
    })
    const young = norm(STUDENT_PROFILE) // age 20
    const r = evaluateEligibility(young, seniorOnly)
    expect(r.eligible).toBe(false)
    expect(r.ineligibilityReasons.join(' ')).toMatch(/age restriction/i)

    const unknownAge = norm({ profile: { id: 'p-noage', primary_type: 'individual', state: 'TN' }, sections: {} })
    const r2 = evaluateEligibility(unknownAge, seniorOnly)
    expect(r2.ineligibilityReasons.join(' ')).not.toMatch(/age restriction/i)
    expect(r2.missingFields).toContain('age')
  })

  it('explicit means-test with no low-income signal → missing field (REVIEW), never a reject', () => {
    const meansTested = normalizeOpportunity({
      id: 'inc-3',
      title: 'Utility Relief',
      description: 'Must meet income eligibility limits (income at or below 150% of FPL).',
      state: 'TN',
      application_url: 'https://example.org/utility',
    })
    const student = norm(STUDENT_PROFILE)
    const r = evaluateEligibility(student, meansTested)
    expect(r.ineligibilityReasons.join(' ')).not.toMatch(/income/i)
    expect(r.missingFields).toContain('income_eligibility')
  })
})

// ── End-to-end: the DV victim-services cap keeps mismatches out of ACCEPT ────

describe('computeMatchDecision — population-program caps demote mismatches', () => {
  const dvServicesOpp = {
    id: 'dv-services',
    title: 'Domestic Violence Victim Services Program',
    sponsor: 'State Coalition Against Domestic Violence',
    description: 'Supporting victim services, emergency shelter, and survivor advocacy under VAWA.',
    state: 'TN',
    application_url: 'https://example.org/dv-services',
    categories: ['housing', 'safety'],
  }

  it('a student with no DV signal can never ACCEPT a victim-services program', () => {
    const r = computeMatchDecision(STUDENT_PROFILE.profile, dvServicesOpp, { profileSections: STUDENT_PROFILE.sections })
    expect(r.decision).not.toBe('ACCEPT')
  })

  it('a DV survivor keeps full scoring access to the same program', () => {
    const rSurvivor = computeMatchDecision(DV_SURVIVOR_PROFILE.profile, dvServicesOpp, { profileSections: DV_SURVIVOR_PROFILE.sections })
    const rStudent = computeMatchDecision(STUDENT_PROFILE.profile, dvServicesOpp, { profileSections: STUDENT_PROFILE.sections })
    expect(rSurvivor.score).toBeGreaterThanOrEqual(rStudent.score)
    expect(rSurvivor.decision).not.toBe('REJECT')
  })
})
