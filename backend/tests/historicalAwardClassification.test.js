import { describe, expect, it } from 'vitest'
import { opportunityKindOf, isProposalEligibleOpportunity } from '../../shared/opportunityFundability.js'
import { buildOpportunityReadModel } from '../services/opportunityContract.js'
import { classifyFundingResult, RESULT_BUCKETS } from '../config/fundingResultFilters.js'
import { classifyOpportunityKind } from '../services/opportunityRealityGate.js'
import Database from 'better-sqlite3'
import { reconcileHistoricalAwardKinds } from '../services/historicalAwardClassification.js'

describe('historical award records remain reference-only', () => {
  it('reconciles legacy catalog kinds in bounded batches without touching application progress', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, source TEXT, opportunity_kind TEXT);
        CREATE TABLE grants (id TEXT, status TEXT);
        INSERT INTO funding_opportunities VALUES ('one','nih.reporter','PROGRAM'),('two','nsf.awards','direct'),('three','grants.gov','DIRECT_GRANT');
        INSERT INTO grants VALUES ('submitted-award','submitted');`)
      expect(await reconcileHistoricalAwardKinds(db, 1)).toEqual({ scanned: 1, repaired: 1 })
      expect(await reconcileHistoricalAwardKinds(db, 1)).toEqual({ scanned: 1, repaired: 1 })
      expect(await reconcileHistoricalAwardKinds(db, 1)).toEqual({ scanned: 0, repaired: 0 })
      expect(db.prepare("SELECT opportunity_kind FROM funding_opportunities WHERE id = 'three'").get().opportunity_kind).toBe('DIRECT_GRANT')
      expect(db.prepare('SELECT * FROM grants').all()).toEqual([{ id: 'submitted-award', status: 'submitted' }])
    } finally { db.close() }
  })
  it.each(['nih.reporter', 'nih_reporter', 'nsf.awards', 'nsf_awards', 'usaspending.gov', 'usaspending', 'usa_spending'])('overrides legacy PROGRAM classification for %s', source => {
    const row = { source, title: 'Research award', sponsor: 'Federal agency', opportunity_kind: 'PROGRAM', application_url: 'https://reporter.nih.gov/project/123', deadline_type: 'rolling' }
    expect(opportunityKindOf(row)).toBe('PAST_AWARD_INTEL')
    expect(isProposalEligibleOpportunity(row)).toBe(false)
    expect(buildOpportunityReadModel(row).opportunity_kind).toBe('PAST_AWARD_INTEL')
    expect(classifyOpportunityKind(row)).toBe('past_award_intel')
    expect(classifyFundingResult(row).bucket).toBe(RESULT_BUCKETS.RESOURCE)
  })

  it('recognizes explicit awarded-record fingerprints without rejecting open scholarship awards', () => {
    const past = { opportunity_type: 'award', description: 'Awardee: Research University; PI: Jane Example', opportunity_kind: 'DIRECT_GRANT' }
    expect(opportunityKindOf(past)).toBe('PAST_AWARD_INTEL')
    expect(opportunityKindOf({ title: 'Excellence Award Scholarship', source: 'grants.gov', opportunity_kind: 'SCHOLARSHIP' })).toBe('SCHOLARSHIP')
    expect(isProposalEligibleOpportunity({ source: 'grants.gov', opportunity_kind: 'DIRECT_GRANT', description: 'The successful awardee will be notified.' })).toBe(true)
  })
})
