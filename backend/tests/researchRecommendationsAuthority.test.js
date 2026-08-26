import { describe, expect, it } from 'vitest'

import {
  loadCanonicalStoredOpportunities,
  loadStoredResearchProfile,
} from '../services/research/canonicalStoredOpportunities.js'
import {
  buildResearchFingerprint,
  rankResearchOpportunities,
} from '../services/research/cvPublicationMatcher.js'

function canonicalDb(rows, { decisionColumn = 'match_decision' } = {}) {
  const queries = []
  return {
    dialect: 'sqlite',
    queries,
    prepare(sql) {
      queries.push(sql)
      return {
        async all(...params) {
          if (sql.includes('PRAGMA table_info')) {
            return [{ name: 'profile_id' }, { name: 'opportunity_id' }, { name: decisionColumn }]
          }
          const requestedIds = params.slice(1).filter((value) => typeof value === 'string')
          return rows
            .filter((row) => requestedIds.length === 0 || requestedIds.includes(row.id))
            .map((row) => ({
              ...row,
              canonical_decision: row[decisionColumn],
            }))
        },
      }
    },
  }
}

describe('research recommendation canonical authority', () => {
  it('reloads the profile-scoped stored verdict and excludes a client-claimed ACCEPT when storage says REJECT', async () => {
    const db = canonicalDb([
      {
        id: 'stored-reject',
        title: 'Cancer Genomics Award',
        description: 'Genomics and machine learning',
        match_decision: 'REJECT',
        is_active: 1,
      },
      {
        id: 'stored-accept',
        title: 'Cancer Research Award',
        description: 'Cancer genomics',
        match_decision: 'ACCEPT',
        is_active: 1,
      },
    ])

    const canonical = await loadCanonicalStoredOpportunities(db, {
      profileId: 'profile-1',
      // Descriptive and verdict fields are deliberately absent from this
      // route contract; only identifiers cross the client trust boundary.
      opportunityIds: ['stored-reject', 'stored-accept', 'not-stored'],
    })
    const fingerprint = buildResearchFingerprint({
      cvText: 'Cancer genomics and machine learning',
    })
    const result = rankResearchOpportunities({
      fingerprint,
      opportunities: canonical.opportunities,
    })

    expect(canonical.opportunities.map((row) => row.id)).toEqual(['stored-reject', 'stored-accept'])
    expect(canonical.unavailableIds).toEqual(['not-stored'])
    expect(result.ranked.map((row) => row.id)).toEqual(['stored-accept'])
    expect(result.excluded).toContainEqual({
      id: 'stored-reject',
      reason: 'canonical_eligibility_reject',
    })
  })

  it('supports the legacy decision column without accepting arbitrary SQL identifiers', async () => {
    const db = canonicalDb([{
      id: 'legacy-review',
      title: 'Research Fellowship',
      decision: 'REVIEW',
      is_active: 1,
    }], { decisionColumn: 'decision' })

    const result = await loadCanonicalStoredOpportunities(db, {
      profileId: 'profile-1',
      opportunityIds: ['legacy-review'],
    })

    expect(result.opportunities[0]).toMatchObject({
      id: 'legacy-review',
      canonical_decision: 'REVIEW',
    })
    expect(db.queries.some((sql) => sql.includes('m.decision AS canonical_decision'))).toBe(true)
  })

  it('builds research attributes only from the authorized stored profile and sections', async () => {
    const db = {
      prepare(sql) {
        return {
          async get(profileId) {
            expect(profileId).toBe('profile-1')
            expect(sql).toContain('FROM profiles')
            return { id: 'profile-1', display_name: 'Stored Researcher', career_stage: 'faculty' }
          },
          async all(profileId) {
            expect(profileId).toBe('profile-1')
            expect(sql).toContain('FROM profile_sections')
            return [
              { section_key: 'research', data: JSON.stringify({ topics: ['genomics'], methods: ['machine learning'] }) },
              { section_key: 'professional', data: JSON.stringify({ career_stage: 'early_career' }) },
            ]
          },
        }
      },
    }

    await expect(loadStoredResearchProfile(db, 'profile-1')).resolves.toMatchObject({
      id: 'profile-1',
      research_topics: ['genomics'],
      research_methods: ['machine learning'],
      career_stage: 'early_career',
    })
  })
})
