/**
 * Prod 2026-09-06: a national association's forensic-science scholarship
 * (afte.org), decomposed from a listing with NO geography on the row — no
 * state, ZIP, county or national flag — fell into the geo `soft_mismatch`
 * tier and the 0.3 GEO_MISMATCH_FACTOR turned a 12-data-point major + GPA +
 * STEM match into a 5 (REVIEW). matchThresholds.js says the mismatch factor
 * is for a row that "explicitly serves somewhere else" and the unknown factor
 * for "location signals missing on either side"; the code disagreed.
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'

const profile = {
  id: 'p-tn',
  primary_type: 'student',
  applicant_type: 'student',
  state: 'TN',
  city: 'Cleveland',
  postal_code: '37312',
  basic_information: { first_name: 'A', last_name: 'W', city: 'Cleveland', state: 'TN', postal_code: '37312' },
  education: { intended_major: 'Forensic Science', gpa: 3.84, current_institution: 'Middle Tennessee State University', highest_level: 'Associates Degree' },
  interests: ['forensic science', 'scholarship'],
  needs: ['education', 'scholarship'],
}

const base = {
  title: 'AFTE Scholarship',
  sponsor: 'Association of Firearm and Tool Mark Examiners',
  description: 'Scholarship for students pursuing forensic science, firearm and toolmark examination. Undergraduate students may apply.',
  amount_min: 1500, amount_max: 1500,
  source: 'scholarship_crawler', record_origin: 'scholarship_crawler',
  application_url: 'https://afte.org/about-afte/scholarship-program/',
}

const geoReason = (d) => (d.reasons || []).find((r) => /Serves a different area|Service area unknown/.test(r)) || null

describe('an opportunity that states NO location is unknown geography, never a mismatch', () => {
  it('no state / zip / county / national flag → "Service area unknown" (slight reduction only)', () => {
    const d = computeMatchDecision(profile, { ...base })
    expect(geoReason(d)).toMatch(/Service area unknown/)
    expect(geoReason(d)).not.toMatch(/different area/)
  })

  it('a row that DECLARES another state is still a mismatch (heavy reduction)', () => {
    const d = computeMatchDecision(profile, { ...base, state: 'OH' })
    expect(geoReason(d)).toMatch(/Serves a different area/)
  })

  it('a row declaring the profile state, or national, carries no geo reduction', () => {
    expect(geoReason(computeMatchDecision(profile, { ...base, state: 'TN' }))).toBeNull()
    expect(geoReason(computeMatchDecision(profile, { ...base, is_national: true }))).toBeNull()
  })

  it('the unknown-geo row scores materially higher than the same row declaring the wrong state', () => {
    const unknown = computeMatchDecision(profile, { ...base }).score
    const wrongState = computeMatchDecision(profile, { ...base, state: 'OH' }).score
    expect(unknown).toBeGreaterThan(wrongState)
  })
})
