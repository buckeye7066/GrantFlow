import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { restorePersistedMatchTruth } from '../services/matching/persistedMatchTruth.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

describe('owner-facing persisted match truth', () => {
  it('restores the stored data-point score and decision after a read-time recompute', () => {
    const canonical = [{
      id: 'opp-1',
      title: 'Specific Scholarship',
      sponsor: 'Real Funder',
      application_url: 'https://example.org/apply',
      match_score: 97,
      match_decision: 'ACCEPT',
      match_explanation: "Covers about 97% of this profile's main needs.",
      opportunity_kind: 'SCHOLARSHIP',
    }]
    const persisted = [{
      ...canonical[0],
      match_score: 12,
      match_decision: 'review',
      matcher_version: 'crawler-os',
      match_explain_json: {
        dataPointEvidence: { total: 100, total_credit: 12 },
      },
    }]

    const result = restorePersistedMatchTruth(canonical, persisted)

    expect(result).toHaveLength(1)
    expect(result[0].match_score).toBe(12)
    expect(result[0].match_decision).toBe('REVIEW')
    expect(result[0].match_explanation).toBe(
      'Matched 12 of 100 substantive profile data points; eligibility and geography gates produced a match score of 12.',
    )
    expect(result[0].match_explanation).not.toContain('97%')
  })

  it('never returns a persisted direct REJECT', () => {
    const canonical = [{
      id: 'opp-reject',
      title: 'Wrong Population Grant',
      sponsor: 'Funder',
      application_url: 'https://example.org/apply',
      match_score: 80,
      match_decision: 'ACCEPT',
    }]
    const persisted = [{ ...canonical[0], match_score: 4, match_decision: 'reject' }]

    expect(restorePersistedMatchTruth(canonical, persisted)).toEqual([])
  })

  it('keeps every non-direct resource at REVIEW even when a historical row says ACCEPT', () => {
    const resources = ['DIRECTORY', 'PAST_AWARD_INTEL', 'SCHOOL_PORTAL', 'REFERRAL']
    for (const opportunityKind of resources) {
      const canonical = [{
        id: `resource-${opportunityKind}`,
        title: `${opportunityKind} resource`,
        sponsor: 'Resource Sponsor',
        application_url: 'https://example.org/resource',
        opportunity_kind: opportunityKind,
        match_score: 90,
        match_decision: 'ACCEPT',
      }]
      const persisted = [{ ...canonical[0], match_score: 9, match_decision: 'accept' }]

      const result = restorePersistedMatchTruth(canonical, persisted)
      expect(result).toHaveLength(1)
      expect(result[0].match_score).toBe(9)
      expect(result[0].match_decision).toBe('REVIEW')
      expect(result[0].is_directory).toBe(true)
      expect(result[0].is_resource).toBe(true)
    }
  })

  it('collapses historical cross-source singular/plural duplicates and keeps the highest score', () => {
    const canonical = [
      {
        id: 'a',
        title: 'NAEMT EMS Educational Scholarships',
        sponsor: 'NAEMT',
        application_url: 'https://example.org/a',
        match_score: 90,
        match_decision: 'ACCEPT',
      },
      {
        id: 'b',
        title: 'NAEMT EMS Educational Scholarship',
        sponsor: 'NAEMT',
        application_url: 'https://example.org/b',
        match_score: 85,
        match_decision: 'ACCEPT',
      },
    ]
    const persisted = [
      { ...canonical[0], match_score: 20, match_decision: 'accept' },
      { ...canonical[1], match_score: 16, match_decision: 'accept' },
    ]

    const result = restorePersistedMatchTruth(canonical, persisted)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a')
    expect(result[0].match_score).toBe(20)
  })

  it('pins the funding-source route to the profile-aware persisted-truth boundary', () => {
    const routeSource = fs.readFileSync(
      path.join(HERE, '..', 'routes', 'fundingSources.js'),
      'utf8',
    )
    expect(routeSource).toContain('restorePersistedMatchTruth(canonical.kept, mapped, {')
    expect(routeSource).toContain('profileContext,')
    expect(routeSource).toContain('pom.match_explain_json')
    expect(routeSource).toContain('pom.matcher_version')
    expect(routeSource).toContain('isFundingResource(row)')
  })
})
