/**
 * matchEngineSoftRelevanceAndMatchFunds.test.js
 *
 * P0 regression: soft relevance penalties must reduce score (not be ignored),
 * and requires_match must REVIEW (not hard-REJECT with a false "cannot provide").
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision, makeDecision, normalizeOpportunity } from '../services/matchEngine.js'
import { applyRelevanceFilter } from '../services/relevanceFilter.js'
import { SOFT_RELEVANCE_PENALTY } from '../config/matchThresholds.js'

const maleTnIndividual = {
  profile: {
    id: 'p-soft-1',
    name: 'Test Profile',
    primary_type: 'individual',
    applicant_type: 'individual',
    state: 'TN',
    city: 'Nashville',
    zip: '37203',
    gender: 'male',
    need_categories: ['education', 'workforce'],
  },
  sections: {
    basic_information: {
      gender: 'male',
      state: 'TN',
      city: 'Nashville',
      profile_category: 'individual',
    },
  },
}

function baseOpp(overrides = {}) {
  return {
    id: 'opp-1',
    title: 'Tennessee Workforce Development Grant',
    description: 'Supports workforce training and education for Tennessee residents.',
    application_url: 'https://example.org/apply',
    source_url: 'https://example.org/program',
    state: 'TN',
    is_national: false,
    opportunity_kind: 'DIRECT_GRANT',
    opportunity_type: 'grant',
    ...overrides,
  }
}

describe('soft relevance penalty is applied by computeMatchDecision', () => {
  it('exports a positive scale-aware soft penalty', () => {
    expect(SOFT_RELEVANCE_PENALTY).toBeGreaterThan(0)
    expect(SOFT_RELEVANCE_PENALTY).toBeLessThanOrEqual(25)
  })

  it('does not apply soft relevance penalties to directory or referral pointers', () => {
    for (const opportunityKind of ['DIRECTORY', 'REFERRAL']) {
      const decision = computeMatchDecision(
        maleTnIndividual,
        baseOpp({
          id: `pointer-${opportunityKind.toLowerCase()}`,
          title: 'Education resources for women scholars',
          description: 'A directory of education and workforce resources for women scholars.',
          opportunity_kind: opportunityKind,
          type: opportunityKind,
          is_directory_resource: opportunityKind === 'DIRECTORY',
        }),
      )
      expect(decision.match_explain?.soft_relevance_gate).toBeUndefined()
      expect((decision.match_explain?.scoreCaps || []).join(' ').toLowerCase())
        .not.toContain('soft relevance')
    }
  })

  it('softFail from relevanceFilter reduces canonical score vs clean peer', () => {
    // Avoid "entrepreneurs/business" (business gate) and exclusive "women only"
    // language so softFail is the only mismatch signal.
    const softOpp = baseOpp({
      title: 'Tennessee Education Award for Women Scholars',
      description: 'Supports women scholars pursuing workforce training and education in Tennessee.',
    })
    const cleanOpp = baseOpp({
      title: 'Tennessee Workforce Development Grant',
      description: 'Supports workforce training and education for Tennessee residents.',
    })

    const softFilter = applyRelevanceFilter(
      softOpp,
      { primary_type: 'individual', state: 'TN', gender: 'male' },
      { mode: 'soft' },
    )
    expect(softFilter.pass).toBe(true)
    expect(softFilter.softFail).toBe(true)
    expect(softFilter.ruleId).toBe('demographic_women_prioritized')
    expect(softFilter.penalty).toBe(SOFT_RELEVANCE_PENALTY)

    const softDecision = computeMatchDecision(maleTnIndividual, softOpp)
    const cleanDecision = computeMatchDecision(maleTnIndividual, cleanOpp)

    expect(softDecision.match_explain?.soft_relevance_gate?.softFail).toBe(true)
    expect(softDecision.decision).not.toBe('REJECT')
    expect(softDecision.score).toBeLessThanOrEqual(cleanDecision.score)
    const softReasons = [
      ...(softDecision.reasons || []),
      ...(softDecision.match_explain?.scoreCaps || []),
    ].join(' ')
    expect(softReasons.toLowerCase()).toMatch(/soft relevance|women/)
  })
})

describe('requires_match reduces score / REVIEW — does not hard-REJECT', () => {
  it('makeDecision returns REVIEW for matching-funds opportunities', () => {
    const result = makeDecision(
      20,
      maleTnIndividual.profile,
      baseOpp({ requires_match: true }),
    )
    expect(result.decision).toBe('REVIEW')
    expect(String(result.explanation || '').toLowerCase()).not.toMatch(/cannot provide/)
  })

  it('computeMatchDecision does not REJECT solely for requires_match', () => {
    const decision = computeMatchDecision(
      maleTnIndividual,
      baseOpp({
        requires_match: true,
        title: 'Tennessee Workforce Training Cost-Share Grant',
        description: 'Local workforce support for Tennessee residents; matching funds may be required.',
      }),
    )
    expect(decision.decision).not.toBe('REJECT')
    expect(decision.decision).toBe('REVIEW')
  })

  it('rejects an out-of-state profile before matching-funds review', () => {
    const floridaProfile = {
      ...maleTnIndividual,
      profile: { ...maleTnIndividual.profile, state: 'FL', city: 'Tampa', zip: '33602' },
      sections: {
        ...maleTnIndividual.sections,
        basic_information: {
          ...maleTnIndividual.sections.basic_information,
          state: 'FL',
          city: 'Tampa',
        },
      },
    }
    const decision = computeMatchDecision(
      floridaProfile,
      baseOpp({
        requires_match: true,
        title: 'Tennessee Residents Only Workforce Cost-Share Grant',
        description: 'Exclusively for Tennessee residents. Matching funds are required.',
        state: 'TN',
        state_residents_only: true,
      }),
    )
    expect(decision.decision).toBe('REJECT')
    expect(String(decision.explanation || '')).toMatch(/Geographic (?:mismatch|exclusivity)|Tennessee|TN/i)
  })
})

describe('women exclusivity vs women-prioritized', () => {
  it('uses the same hard classification for named women-restricted programs', () => {
    const namedProgram = baseOpp({
      title: 'Society of Women Engineers Scholarship',
      description: 'Scholarship program for women engineers pursuing technical degrees.',
    })
    const strict = applyRelevanceFilter(
      namedProgram,
      { primary_type: 'individual', state: 'TN', gender: 'male' },
      { mode: 'soft' },
    )
    const normalized = normalizeOpportunity(namedProgram)
    const canonical = computeMatchDecision(maleTnIndividual, namedProgram)

    expect(strict.pass).toBe(false)
    expect(strict.ruleId).toBe('demographic_women_only')
    expect(normalized.requiresWomen).toBe(true)
    expect(normalized.requiresGender).toBe('female')
    expect(canonical.decision).toBe('REJECT')
  })

  it('hard-rejects only explicit women-only language', () => {
    const exclusive = applyRelevanceFilter(
      baseOpp({ title: 'Amber Grant for Women Only' }),
      { primary_type: 'individual', state: 'TN', gender: 'male' },
      { mode: 'soft' },
    )
    expect(exclusive.pass).toBe(false)
    expect(exclusive.ruleId).toBe('demographic_women_only')
  })

  it('soft-penalizes non-exclusive "for women" language instead of hard reject', () => {
    const prioritized = applyRelevanceFilter(
      baseOpp({ title: 'Grant for Women Entrepreneurs in Tennessee' }),
      { primary_type: 'individual', state: 'TN', gender: 'male' },
      { mode: 'soft' },
    )
    expect(prioritized.pass).toBe(true)
    expect(prioritized.softFail).toBe(true)
    expect(prioritized.ruleId).toBe('demographic_women_prioritized')
  })
})
