import { describe, expect, it } from 'vitest'

import {
  CANONICAL_US_JURISDICTION_RULES,
  canonicalUsFunderJurisdiction,
  correctedCanonicalUsScope,
  resolvedUsOpportunityJurisdiction,
} from '../config/canonicalUsJurisdiction.js'
import {
  correctedGeoScopeFromTitle,
  declaredStateFromTitle,
} from '../config/opportunityJurisdiction.js'
import { isRelevantGeo } from '../config/fundingResultFilters.js'
import { evaluateFundableOpportunity } from '../services/matching/qualityGate.js'
import { restorePersistedMatchTruth } from '../services/matching/persistedMatchTruth.js'

describe('canonical U.S. funder jurisdiction registry', () => {
  it('contains only explicit state rules with identity or host evidence', () => {
    expect(CANONICAL_US_JURISDICTION_RULES.length).toBeGreaterThanOrEqual(2)
    for (const rule of CANONICAL_US_JURISDICTION_RULES) {
      expect(rule.id).toMatch(/^[a-z0-9_]+$/)
      expect(rule.state).toMatch(/^[A-Z]{2}$/)
      expect(rule.hosts.length + rule.identityPatterns.length).toBeGreaterThan(0)
      for (const host of rule.hosts) {
        expect(host).toBe(host.toLowerCase())
        expect(host).not.toMatch(/[/:]/)
      }
    }
  })

  it('repairs Central Piedmont from its official host or exact identity', () => {
    expect(canonicalUsFunderJurisdiction({
      title: 'Emergency Scholarship',
      sponsor: 'Unknown College',
      application_url: 'https://www.cpcc.edu/financial-aid/scholarships',
      state: 'TN',
    })).toMatchObject({ state: 'NC', rule_id: 'central_piedmont' })

    expect(canonicalUsFunderJurisdiction({
      title: 'Central Piedmont Community College Foundation Scholarship',
      state: 'TN',
    })).toMatchObject({ state: 'NC', rule_id: 'central_piedmont' })
  })

  it('repairs the exact Ohio RDA identity without treating a prose mention as jurisdiction', () => {
    expect(canonicalUsFunderJurisdiction({
      title: 'Ohio RDA Home Repair Assistance',
      state: 'TN',
    })).toMatchObject({ state: 'OH', rule_id: 'ohio_rda' })

    expect(canonicalUsFunderJurisdiction({
      sponsor: 'Ohio Rural Development Agency',
      state: 'TN',
    })).toMatchObject({ state: 'OH', rule_id: 'ohio_rda' })

    expect(canonicalUsFunderJurisdiction({
      title: 'National Rural Assistance Program',
      sponsor: 'Example Foundation',
      description: 'This report mentions Ohio RDA as a partner.',
      state: 'TN',
    })).toBe(null)
    expect(canonicalUsFunderJurisdiction({ title: 'Ohio State University Research Grant' })).toBe(null)
  })

  it('gives canonical funder evidence priority over contradictory stored and title state noise', () => {
    const row = {
      title: 'Central Piedmont Community College Scholarship, TN — Apply Now',
      application_url: 'https://www.cpcc.edu/financial-aid/scholarships',
      state: 'TN',
      is_national: 1,
    }
    expect(resolvedUsOpportunityJurisdiction(row)).toMatchObject({
      state: 'NC',
      source: 'canonical_funder',
      stored_state: 'TN',
    })
    expect(correctedCanonicalUsScope(row)).toEqual({ state: 'NC', is_national: 0 })
  })

  it('preserves the existing exact title declaration and stored-state fallback', () => {
    expect(resolvedUsOpportunityJurisdiction({
      title: 'Polk County, TN — Local assistance',
      state: null,
    })).toMatchObject({ state: 'TN', source: 'declared_title' })

    expect(resolvedUsOpportunityJurisdiction({
      title: 'Ordinary Program',
      state: 'WV',
    })).toMatchObject({ state: 'WV', source: 'stored_state' })
  })
})

describe('canonical jurisdiction consumers', () => {
  it('makes existing title-state readers and the writer bridge see the repaired state', () => {
    const ohio = { title: 'Ohio RDA Home Repair Assistance', state: 'TN', is_national: 1 }
    const cpcc = {
      title: 'Central Piedmont Scholarship',
      application_url: 'https://cpcc.edu/scholarships',
      state: 'TN',
      is_national: 1,
    }

    expect(declaredStateFromTitle(ohio)).toBe('OH')
    expect(declaredStateFromTitle(cpcc)).toBe('NC')
    expect(correctedGeoScopeFromTitle(ohio)).toEqual({ state: 'OH', is_national: 0 })
    expect(correctedGeoScopeFromTitle(cpcc)).toEqual({ state: 'NC', is_national: 0 })
  })

  it('rejects objective out-of-state funders but keeps bare stored-state silence neutral', () => {
    expect(isRelevantGeo({
      title: 'Central Piedmont Scholarship',
      application_url: 'https://cpcc.edu/scholarships',
      state: 'TN',
    }, { states: ['TN'] })).toMatchObject({
      relevant: false,
      reason: 'canonical_funder_out_of_state:central_piedmont:NC',
    })

    expect(isRelevantGeo({ title: 'Ohio RDA Home Repair Assistance', state: 'TN' }, { states: ['OH'] }).relevant).toBe(true)
    expect(isRelevantGeo({ title: 'Ohio RDA Home Repair Assistance', state: 'TN' }, { states: ['TN'] }).relevant).toBe(false)

    // A bare `state` can be crawl noise and does not itself prove exclusivity.
    expect(isRelevantGeo({ title: 'Ordinary Program', state: 'NC' }, { states: ['TN'] }).relevant).toBe(true)
    // The exact machine-minted declaration remains restrictive.
    expect(isRelevantGeo({ title: 'Polk County, TN — Local assistance' }, { states: ['OH'] }).relevant).toBe(false)
  })

  it('normalizes canonical state at the non-OS ingest gate', () => {
    const cpcc = evaluateFundableOpportunity({
      title: 'Central Piedmont Scholarship',
      sponsor: 'Central Piedmont Community College',
      application_url: 'https://cpcc.edu/scholarships',
      state: 'TN',
      is_national: 1,
      opportunity_type: 'grant',
    })
    expect(cpcc.ok).toBe(true)
    expect(cpcc.normalized).toMatchObject({ state: 'NC', is_national: 0 })

    const ordinary = evaluateFundableOpportunity({
      title: 'Ordinary Tennessee Program',
      application_url: 'https://example.org/apply',
      state: 'TN',
      opportunity_type: 'grant',
    })
    expect(ordinary.normalized).not.toHaveProperty('state')
  })

  it('does not replay a historical stored ACCEPT into the wrong profile', () => {
    const persisted = {
      id: 'cpcc-1',
      title: 'Central Piedmont Community College Foundation Scholarship',
      sponsor: 'Central Piedmont Community College',
      application_url: 'https://cpcc.edu/scholarships',
      state: 'TN',
      match_score: 100,
      match_decision: 'accept',
      match_explain_json: '{}',
      matcher_version: 'crawler-os',
    }
    const canonical = [{ ...persisted }]

    const tn = restorePersistedMatchTruth(canonical, [persisted], {
      profileContext: {
        profile: { id: 'tn-student', primary_type: 'student', state: 'TN' },
        signals: { states: ['TN'], location: { state: 'TN' } },
        sections: {},
      },
    })
    expect(tn).toEqual([])

    const nc = restorePersistedMatchTruth(canonical, [persisted], {
      profileContext: {
        profile: { id: 'nc-student', primary_type: 'student', state: 'NC' },
        signals: { states: ['NC'], location: { state: 'NC' } },
        sections: {},
      },
    })
    expect(nc).toHaveLength(1)
  })
})
