/**
 * crawlerProfileAwareMatch.test.js
 *
 * Pins two profile-aware behaviors of the crawler candidate prefilter:
 *
 *   1. Scoring NEUTRALITY for unknown applicant type (canonical rule G4:
 *      "missing profile fields must not disqualify"). buildProfileSignals()
 *      defaults applicantType to 'individual' for BOTH an explicitly-individual
 *      person and a profile that never declared a type. When the type is NOT
 *      explicit (applicantTypeExplicit === false) a program targeting a different
 *      applicant type must NOT be penalized — it is judged on its other merits.
 *
 *   2. State-aware student-grant query planning — a TN-resident student plan
 *      surfaces the state's own award NAMES (HOPE / TSAA / Promise / Reconnect)
 *      so the right state aid is reachable without the user typing acronyms.
 *
 * Pure functions, no DB or network.
 */
import { describe, it, expect } from 'vitest'
import { scoreProgram } from '../services/crawlers/matchEngine.js'
import { planCrawlerQueries } from '../services/crawlers/queryPlanner.js'

function baseAnalysis(over = {}) {
  return {
    applicantType: 'individual',
    applicantTypeExplicit: false,
    needs: new Set(['education', 'scholarship']),
    demographics: new Set(),
    health: new Set(),
    family: new Set(),
    military: new Set(),
    occupation: new Set(),
    immigration: new Set(),
    geographic: new Set(),
    interests: new Set(),
    sports: new Set(),
    location: { state: 'TN' },
    education: {},
    income: {},
    keywords: ['scholarship'],
    ...over,
  }
}

describe('crawler prefilter — applicant-type neutrality (G4)', () => {
  const orgProgram = {
    id: 'org-edu-grant',
    name: 'Community Organization Education Grant',
    categories: ['education'],
    applicantType: 'organization',
    type: 'grant',
  }

  it('does NOT penalize an org-targeted program when applicant type is UNKNOWN', () => {
    const unknown = scoreProgram(orgProgram, baseAnalysis({ applicantTypeExplicit: false }))
    const explicitIndividual = scoreProgram(orgProgram, baseAnalysis({ applicantTypeExplicit: true }))

    // Unknown type → neutral, so the program keeps its category/locality merits
    // and scores meaningfully higher than the explicitly-penalized individual.
    expect(unknown.matchScore).toBeGreaterThan(explicitIndividual.matchScore)
    expect(unknown.matchReasons.some((r) => /not specified — neutral/.test(r))).toBe(true)
  })

  it('STILL penalizes an explicit applicant-type mismatch (precision preserved)', () => {
    const explicitIndividual = scoreProgram(orgProgram, baseAnalysis({ applicantTypeExplicit: true }))
    expect(explicitIndividual.matchReasons.some((r) => /you: individual/.test(r))).toBe(true)
  })

  it('awards the applicant-type bonus when the types match', () => {
    const matchingProgram = { ...orgProgram, applicantType: 'individual' }
    const scored = scoreProgram(matchingProgram, baseAnalysis({ applicantTypeExplicit: true }))
    expect(scored.matchScore).toBeGreaterThan(0)
  })
})

describe('student_grants query plan — state-aware aid names', () => {
  it('surfaces TN state award names for a TN-resident student', () => {
    const plan = planCrawlerQueries({
      crawlerType: 'student_grants',
      facets: {},
      location: { state: 'TN' },
    })
    const joined = plan.shouldTerms.join(' | ')
    expect(joined).toMatch(/tennessee hope/)
    expect(joined).toMatch(/tsaa/)
    expect(joined).toMatch(/tennessee promise/)
    expect(joined).toMatch(/tennessee reconnect/)
  })

  it('adds no state-specific noise when the state is unknown (neutral)', () => {
    const plan = planCrawlerQueries({
      crawlerType: 'student_grants',
      facets: {},
      location: {},
    })
    // Generic student terms still present; no TN-only program names leak in.
    expect(plan.mustTerms).toContain('scholarship')
    expect(plan.shouldTerms.join(' | ')).not.toMatch(/tennessee hope/)
  })
})
