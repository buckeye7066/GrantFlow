/**
 * matchEngineConfidence.test.js
 *
 * Architecture point #7: MATCH score and CONFIDENCE score are SEPARATE.
 *
 *   MATCH      = how well an opportunity fits the profile (need/elig/geo/category).
 *   CONFIDENCE = how sure we are it is real and actionable (source trust,
 *                actionability, eligibility-text completeness, freshness).
 *
 * These tests assert:
 *   1. scoreOpportunity now returns a numeric `confidence` + `confidence_reasons`
 *      + `confidence_band`, alongside the unchanged `score`.
 *   2. Confidence is INDEPENDENT of fit: a high-fit opportunity from an unknown
 *      source with a placeholder URL keeps its high MATCH but earns a LOW
 *      CONFIDENCE; the same fit from an official, actionable source earns a HIGH
 *      CONFIDENCE — while the MATCH score is the same.
 *   3. Confidence is ADDITIVE: toggling confidence-only signals (source/url/
 *      eligibility text/deadline) must NOT change `score`.
 */
import { describe, it, expect } from 'vitest'
import {
  scoreOpportunity,
  calculateConfidence,
  confidenceBand,
} from '../services/matchEngine.js'
import {
  CONFIDENCE_BAND_HIGH,
  CONFIDENCE_BAND_MEDIUM,
} from '../config/matchThresholds.js'

// A well-filled TN student profile so opportunities below score with strong fit.
const STUDENT_PROFILE = {
  id: 'p-student',
  primary_type: 'student',
  applicant_types: ['student'],
  state: 'TN',
  zip: '37130',
  needs: ['education', 'student_aid'],
  keywords: ['scholarship', 'tuition', 'college'],
  program_areas: ['education'],
  is_student: true,
}

// Same FIT content (title/description/categories/needs/geo) across both rows so
// the MATCH score is identical — only the confidence-relevant fields differ.
const FIT_CORE = {
  title: 'Tennessee College Tuition Scholarship for Students',
  description:
    'Scholarship for Tennessee students pursuing higher education. Covers tuition and college costs.',
  state: 'TN',
  is_national: false,
  funding_type: 'scholarship',
  categories: ['education', 'scholarship', 'student_aid'],
  keywords: ['scholarship', 'tuition', 'college', 'student'],
}

// HIGH confidence: official .gov host, real URL, detailed eligibility, future deadline.
const HIGH_CONFIDENCE_OPP = {
  ...FIT_CORE,
  id: 'opp-official',
  record_origin: 'grants_gov',
  application_url: 'https://www.ed.gov/scholarships/tn-tuition',
  eligibility_bullets: [
    'Must be a Tennessee resident',
    'Must be enrolled at an accredited college',
    'Minimum 2.5 GPA required',
  ],
  deadline_type: 'fixed',
  deadline: '2099-12-31',
}

// LOW confidence: unknown origin, placeholder URL, no eligibility text, no deadline.
// Same FIT content → same MATCH score, but we are NOT sure it is real/actionable.
const LOW_CONFIDENCE_OPP = {
  ...FIT_CORE,
  id: 'opp-unknown',
  record_origin: 'live_crawl',
  application_url: 'https://example.com/placeholder',
  eligibility_bullets: [],
}

describe('scoreOpportunity returns a separate confidence score', () => {
  it('includes confidence, confidence_reasons and confidence_band', () => {
    const result = scoreOpportunity(STUDENT_PROFILE, HIGH_CONFIDENCE_OPP)
    expect(typeof result.score).toBe('number')
    expect(typeof result.confidence).toBe('number')
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(100)
    expect(Array.isArray(result.confidence_reasons)).toBe(true)
    expect(result.confidence_reasons.length).toBeGreaterThan(0)
    expect(['high', 'medium', 'low']).toContain(result.confidence_band)
    // match_explain mirrors confidence so Anya / cards can read one object.
    expect(result.match_explain.confidence).toBe(result.confidence)
  })
})

describe('confidence is orthogonal to (independent of) match score', () => {
  const high = scoreOpportunity(STUDENT_PROFILE, HIGH_CONFIDENCE_OPP)
  const low = scoreOpportunity(STUDENT_PROFILE, LOW_CONFIDENCE_OPP)

  it('keeps the MATCH score identical when only confidence signals differ', () => {
    // Identical fit content → identical match score, regardless of source/url/etc.
    expect(low.score).toBe(high.score)
  })

  it('both rows are a strong MATCH (high fit)', () => {
    // 14 = STRONG_MATCH_SCORE on the data-point scale; the old ">= 60" bar
    // predates the 2026-07-06 recalibration and the 2026-07-27
    // MIN_CALIBRATED_INVENTORY denominator floor (this fixture is thin).
    expect(high.score).toBeGreaterThanOrEqual(14)
    expect(low.score).toBeGreaterThanOrEqual(14)
  })

  it('official + actionable + detailed source earns HIGH confidence', () => {
    expect(high.confidence).toBeGreaterThanOrEqual(CONFIDENCE_BAND_HIGH)
    expect(high.confidence_band).toBe('high')
  })

  it('unknown source + placeholder URL earns LOWER confidence than the official row', () => {
    expect(low.confidence).toBeLessThan(high.confidence)
  })

  it('demonstrates the owner principle: same/high MATCH, very different CONFIDENCE', () => {
    // "A result might be a 92 MATCH but only a 55 CONFIDENCE if the source is
    //  weak or eligibility text is incomplete."
    expect(low.score).toBe(high.score)
    expect(high.confidence - low.confidence).toBeGreaterThanOrEqual(20)
  })
})

describe('confidence is ADDITIVE — it never alters score', () => {
  it('toggling eligibility-text / deadline / origin leaves score unchanged', () => {
    const base = scoreOpportunity(STUDENT_PROFILE, {
      ...FIT_CORE,
      id: 'base',
      record_origin: 'live_crawl',
      application_url: 'https://example.com/x',
    })

    const richerConfidence = scoreOpportunity(STUDENT_PROFILE, {
      ...FIT_CORE,
      id: 'richer',
      record_origin: 'grants_gov', // official → higher source trust
      application_url: 'https://www.grants.gov/x', // official host
      eligibility_bullets: ['A', 'B', 'C'], // detailed eligibility
      deadline_type: 'rolling', // best freshness
    })

    expect(richerConfidence.score).toBe(base.score) // MATCH unchanged
    expect(richerConfidence.confidence).toBeGreaterThan(base.confidence) // CONFIDENCE up
  })
})

describe('calculateConfidence component behavior', () => {
  it('rewards official source over unknown source', () => {
    const official = calculateConfidence({
      record_origin: 'grants_gov',
      application_url: 'https://www.grants.gov/opp',
      eligibility_bullets: ['Eligible residents', 'Enrolled students'],
      deadline_type: 'rolling',
    })
    const unknown = calculateConfidence({
      record_origin: 'live_crawl',
      application_url: 'https://example.com/placeholder',
    })
    expect(official.confidence).toBeGreaterThan(unknown.confidence)
    expect(official.confidence_components.source).toBeGreaterThan(
      unknown.confidence_components.source,
    )
  })

  it('penalizes a closed/expired deadline on freshness', () => {
    const fresh = calculateConfidence({
      record_origin: 'grants_gov',
      application_url: 'https://www.grants.gov/opp',
      deadline_type: 'rolling',
    })
    const expired = calculateConfidence({
      record_origin: 'grants_gov',
      application_url: 'https://www.grants.gov/opp',
      deadline: '2000-01-01',
    })
    expect(expired.confidence_components.freshness).toBeLessThan(
      fresh.confidence_components.freshness,
    )
    expect(expired.confidence).toBeLessThan(fresh.confidence)
  })
})

describe('confidenceBand helper', () => {
  it('maps scores to high / medium / low at the configured cutoffs', () => {
    expect(confidenceBand(CONFIDENCE_BAND_HIGH)).toBe('high')
    expect(confidenceBand(CONFIDENCE_BAND_HIGH + 5)).toBe('high')
    expect(confidenceBand(CONFIDENCE_BAND_MEDIUM)).toBe('medium')
    expect(confidenceBand(CONFIDENCE_BAND_MEDIUM - 1)).toBe('low')
    expect(confidenceBand(0)).toBe('low')
    expect(confidenceBand(NaN)).toBe('low')
  })
})
