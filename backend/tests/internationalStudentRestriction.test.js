/**
 * International-applicant restriction (2026-09-17).
 *
 * Before this rule the engine could detect a foreign PUBLISHER (ccTLD / funder
 * registry) but had no notion of a foreign APPLICANT requirement: an MTSU
 * "International Merit Scholarship" ("…for international students") scored
 * ACCEPT 100 for a profile whose demographics say US citizen.
 *
 * Two strengths, per canonical_rules G4 ("explicitly exclusive" hard-gates;
 * everything else reduces, never discards):
 *   exclusive wording + KNOWN US citizen  → REJECT
 *   exclusive wording + unknown citizenship → REVIEW (missing: citizenship)
 *   stated audience  + KNOWN US citizen  → REVIEW (score capped), never REJECT
 *   non-citizen / unknown vs audience     → neutral
 */
import { describe, it, expect } from 'vitest'
import { internationalStudentRestriction } from '../config/demographicRestrictionPatterns.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'
import { computeMatchDecision, evaluateEligibility } from '../services/matchEngine.js'
import { normalizeProfile } from '../services/profileNormalizer.js'

describe('internationalStudentRestriction — text classifier', () => {
  it.each([
    ['International students only.', 'exclusive'],
    ['Open only to international students.', 'exclusive'],
    ['Applicants must be an international student on an F-1 visa.', 'exclusive'],
    ['Restricted to international applicants.', 'exclusive'],
    ['F-1 visa required.', 'exclusive'],
    ['Non-US citizens only.', 'exclusive'],
    ['This award is not open to US citizens.', 'exclusive'],
    ['Scholarships based entirely on GPA for international students, ranging from $4,000 to $16,000.', 'audience'],
    ['MTSU offers the International Merit Scholarship to help reduce tuition costs for international students.', 'audience'],
    ['International freshmen who demonstrate academic excellence and meet minimum GPA requirements.', 'audience'],
    ['Scholarships for undergraduate international students planning to study in the USA.', 'audience'],
  ])('%s → %s', (text, expected) => {
    expect(internationalStudentRestriction(text)).toBe(expected)
  })

  it.each([
    'Open to domestic and international students.',
    'Available to both domestic and international applicants.',
    'International and U.S. students may apply.',
    'All students regardless of citizenship are welcome.',
    'Travel grants for international conference attendance.',
    'Office of International Programs study-abroad scholarship.',
    'Leadership Scholarship for emerging leaders.',
    '',
  ])('is neither exclusive nor audience: %s', (text) => {
    expect(internationalStudentRestriction(text)).toBeNull()
  })
})

const BASE = {
  id: 'opp-intl',
  title: 'Merit Scholarship',
  description: 'An award for high-achieving students.',
  sponsor: 'Example University',
  application_url: 'https://example.edu/apply',
  is_national: 1,
}

describe('normalizeOpportunity.requiresInternationalStudent', () => {
  it('reads audience wording from description and exclusive wording from eligibility_text', () => {
    expect(normalizeOpportunity({ ...BASE, description: 'Tuition support for international students.' }).requiresInternationalStudent).toBe('audience')
    expect(normalizeOpportunity({ ...BASE, eligibility_text: 'International students only.' }).requiresInternationalStudent).toBe('exclusive')
    expect(normalizeOpportunity({ ...BASE }).requiresInternationalStudent).toBeNull()
  })

  it('honors a structured requires_international_student stated by the source', () => {
    expect(normalizeOpportunity({ ...BASE, requires_international_student: true }).requiresInternationalStudent).toBe('exclusive')
    expect(normalizeOpportunity({ ...BASE, requires_international_student: 'audience' }).requiresInternationalStudent).toBe('audience')
  })
})

function profileWith(demographics) {
  const profile = { id: 'p-intl', primary_type: 'student', state: 'TN' }
  const sections = {
    basic_information: { state: 'TN', city: 'Cleveland', zip_code: '37312', location: { state: 'TN', zip_code: '37312' } },
    education: { current_institution: 'Example University', gpa: 3.8, education_level: 'undergraduate' },
    demographics,
  }
  return { profile, sections }
}

describe('evaluateEligibility × citizenship', () => {
  const exclusive = normalizeOpportunity({ ...BASE, eligibility_text: 'International students only.' })
  const audience = normalizeOpportunity({ ...BASE, description: 'Tuition support for international students.' })

  it('exclusive + known US citizen → hard ineligibility', () => {
    const { profile, sections } = profileWith({ citizenship: 'US citizen', us_citizen: true, immigrant_status: 'us_citizen' })
    const result = evaluateEligibility(normalizeProfile(profile, sections), exclusive)
    expect(result.eligible).toBe(false)
    expect(result.ineligibilityReasons).toEqual(expect.arrayContaining([expect.stringMatching(/international.*US citizen/i)]))
  })

  it('exclusive + unknown citizenship → missing field, never a reject', () => {
    const { profile, sections } = profileWith({})
    const result = evaluateEligibility(normalizeProfile(profile, sections), exclusive)
    expect(result.ineligibilityReasons).toEqual([])
    expect(result.missingFields).toContain('citizenship')
  })

  it('audience + known US citizen → soft mismatch (missing field), never a reject', () => {
    const { profile, sections } = profileWith({ citizenship: 'US citizen', us_citizen: true, immigrant_status: 'us_citizen' })
    const result = evaluateEligibility(normalizeProfile(profile, sections), audience)
    expect(result.ineligibilityReasons).toEqual([])
    expect(result.missingFields).toContain('international_audience_mismatch')
  })

  it('audience + permanent resident → neutral', () => {
    const { profile, sections } = profileWith({ immigrant_status: 'permanent_resident' })
    const result = evaluateEligibility(normalizeProfile(profile, sections), audience)
    expect(result.missingFields).not.toContain('international_audience_mismatch')
    expect(result.missingFields).not.toContain('citizenship')
  })
})

describe('computeMatchDecision × citizenship — the canonical decision, not just the explanation', () => {
  it('exclusive wording controls the decision for a known US citizen: REJECT', () => {
    const { profile, sections } = profileWith({ citizenship: 'US citizen', us_citizen: true, immigrant_status: 'us_citizen' })
    const decision = computeMatchDecision(profile, { ...BASE, eligibility_text: 'International students only.' }, { profileSections: sections })
    expect(decision.decision).toBe('REJECT')
    expect(decision.eligible).toBe(false)
    expect(decision.ineligibilityReasons.join(' ')).toMatch(/international/i)
  })

  it('stated audience for a known US citizen: REVIEW with the reason named and the score capped below ACCEPT', () => {
    const { profile, sections } = profileWith({ citizenship: 'US citizen', us_citizen: true, immigrant_status: 'us_citizen' })
    const decision = computeMatchDecision(profile, { ...BASE, description: 'Tuition support for international students.' }, { profileSections: sections })
    expect(decision.decision).toBe('REVIEW')
    expect(decision.eligible).toBe('maybe')
    expect(decision.missingEligibilityFields).toContain('international_audience_mismatch')
    expect(decision.explanation).toMatch(/described for international students/i)
    expect(decision.score).toBeLessThan(11) // ACCEPT_SCORE
  })

  it('exclusive wording with unknown citizenship: REVIEW asking for citizenship, not a reject (G4: unknown is not a contradiction)', () => {
    // A phrasing the ratified 2026-09-05 positive-fact rule does NOT cover, so
    // this exercises the new gate alone.
    const { profile, sections } = profileWith({})
    const decision = computeMatchDecision(profile, { ...BASE, eligibility_text: 'Applicants must be an international student on an F-1 visa.' }, { profileSections: sections })
    expect(decision.decision).toBe('REVIEW')
    expect(decision.missingEligibilityFields).toContain('citizenship')
    expect(decision.explanation).toMatch(/confirm citizenship or visa status/i)
  })

  it('the ratified need-first rule (2026-09-05) still hard-rejects its four "…only" phrasings when the profile has NO international signal', () => {
    // needFirstMatchPolicyV2.positiveFactMismatches, pinned by
    // needFirstMatchPolicy.test.js. Stricter than G4's "unknown is neutral" for
    // exactly these phrasings; left as ratified — see the 2026-09-17 agent-sync
    // note for the recorded tension. The new gate agrees with it whenever the
    // profile is a known US citizen.
    const { profile, sections } = profileWith({})
    const decision = computeMatchDecision(profile, { ...BASE, eligibility_text: 'International students only.' }, { profileSections: sections })
    expect(decision.decision).toBe('REJECT')
    expect(decision.missingEligibilityFields).toContain('citizenship')
    expect(`${decision.explanation} ${decision.reasons.join(' ')}`).toMatch(/international/i)
  })

  it('a mixed audience never triggers the rule', () => {
    const { profile, sections } = profileWith({ citizenship: 'US citizen', us_citizen: true, immigrant_status: 'us_citizen' })
    const decision = computeMatchDecision(profile, { ...BASE, description: 'Open to domestic and international students.' }, { profileSections: sections })
    expect(decision.missingEligibilityFields).not.toContain('international_audience_mismatch')
    expect(decision.decision).not.toBe('REJECT')
  })
})
