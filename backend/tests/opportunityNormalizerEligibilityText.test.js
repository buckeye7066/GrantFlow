/**
 * eligibility_text reaches the restriction detectors (2026-08-03): the
 * crawler-os blind extractors write free-text "who may apply" prose into
 * funding_opportunities.eligibility_text, but normalizeOpportunity built its
 * detection text from title + description + sponsor + eligibility_bullets +
 * eligibility_json only — so an exclusivity stated ONLY in eligibility_text
 * (e.g. "Applicants must be a woman") was invisible to every demographic gate,
 * and the row sailed through as unrestricted.
 */

import { describe, it, expect } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'

const BASE = {
  id: 'opp-elig-text',
  title: 'Leadership Scholarship',
  description: 'An award for emerging leaders.',
  sponsor: 'Example Foundation',
}

describe('normalizeOpportunity reads eligibility_text', () => {
  it('detects a gender exclusivity stated ONLY in eligibility_text', () => {
    const n = normalizeOpportunity({
      ...BASE,
      eligibility_text: 'Applicants must be a woman enrolled full-time.',
    })
    expect(n.requiresGender).toBe('female')
  })

  it('the SAME row without the eligibility_text restriction stays unrestricted (A/B)', () => {
    const n = normalizeOpportunity({ ...BASE })
    expect(n.requiresGender).toBeNull()
  })

  it('a non-string eligibility_text never crashes normalization', () => {
    const n = normalizeOpportunity({ ...BASE, eligibility_text: { junk: true } })
    expect(n).toBeTruthy()
    expect(n.requiresGender).toBeNull()
  })

  // A named or women-focused program is not proof of exclusivity. The
  // normalizer may hard-gate only when the source states an explicit condition
  // such as "women only" or "applicants must be a woman."
  it('does not infer women-only eligibility from a sponsor name or focused copy', () => {
    const n = normalizeOpportunity({
      id: 'opp-swe',
      title: 'Society of Women Engineers (SWE) Scholarships',
      description: 'Scholarships for women in engineering programs.',
      sponsor: 'Society of Women Engineers',
    })
    expect(n.requiresWomen).toBe(false)
    expect(n.requiresGender).toBeNull()
  })

  it('"must be a male" prose sets the male restriction (the men-only twin gate)', () => {
    const n = normalizeOpportunity({ ...BASE, description: 'Applicants must be a male student.' })
    expect(n.requiresGender).toBe('male')
  })
})

describe('persisted unrestricted applicant tokens are not entity restrictions', () => {
  const directory = {
    id: 'bradley-directory', title: 'Bradley County, TN — County & city government assistance programs (USA.gov directory)',
    description: 'Official index of city, county, and town government websites for locally administered housing, utility and emergency assistance.',
    sponsor: 'USA.gov', opportunity_kind: 'DIRECTORY', is_national: true,
    source_url: 'https://www.usa.gov/local-governments',
  }
  it.each([['*'], ['any'], ['all'], ['anyone'], ['unrestricted'], [' * ']])('does not create a literal wildcard entity bar: %j', (token) => {
    const n = normalizeOpportunity({ ...directory, entity_types_allowed: JSON.stringify([token]) })
    expect(n.entityTypesAllowed).toEqual([])
    expect(n.applicabilityUnknown).toBe(true)
  })
  it.each(['individual', 'nonprofit', 'business'])('canonical need-first scoring retains the unrestricted resource for %s', (primary_type) => {
    const result = computeMatchDecision({ id: 'p1', primary_type, state: 'TN' }, { ...directory, entity_types_allowed: '["*"]' }, {
      profileSections: { basic_information: { state: 'TN' }, needs: { needs: ['housing', 'utility assistance'] } },
    })
    expect(result.decision).toBe('REVIEW')
    expect(result.explanation).not.toMatch(/Opportunity is for \*/)
  })
  it('specific incompatible eligibility still rejects with or without a wildcard', () => {
    for (const types of [['nonprofit'], ['*', 'nonprofit']]) {
      const result = computeMatchDecision({ id: 'p1', primary_type: 'individual', state: 'TN' }, {
        ...directory, entity_types_allowed: types, description: 'Only nonprofit organizations may apply.',
      }, { profileSections: { basic_information: { state: 'TN' } } })
      expect(result.decision).toBe('REJECT')
    }
  })
  it('wildcard never defeats geographic or explicit population restrictions', () => {
    const result = computeMatchDecision({ id: 'p1', primary_type: 'individual', state: 'OH' }, {
      ...directory, entity_types_allowed: '["*"]', is_national: false, state: 'TN',
    }, { profileSections: { basic_information: { state: 'OH' } } })
    expect(result.decision).toBe('REJECT')
  })
  it('keeps a specific restriction even beside a wildcard', () => {
    expect(normalizeOpportunity({ ...directory, entity_types_allowed: ['*', 'nonprofit'] }).entityTypesAllowed).toEqual(['nonprofit'])
  })
})
