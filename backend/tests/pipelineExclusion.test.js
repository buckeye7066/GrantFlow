/**
 * Unit tests for backend/services/pipelineExclusion.js
 *
 * Proves the "never re-surface what's already in the pipeline" guarantee:
 *   1. An opportunity whose id matches a pipeline grant's
 *      funding_opportunity_id is excluded.
 *   2. An opportunity with no id match but an identical identity tuple
 *      (title|funder|deadline|url → same fingerprint) is excluded.
 *   3. A dismissal tombstone excludes by opportunity_id and by fingerprint.
 *   4. Unrelated opportunities pass through untouched.
 *   5. Exclusion is strictly profile-scoped — another profile's pipeline
 *      never suppresses this profile's results (no cross-profile bleed-over).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { grantFingerprintFromOpportunity } from '../utils/grantFingerprint.js'
import { filterOutPipelineMembers, dedupeOpportunityList } from '../services/pipelineExclusion.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      funder TEXT,
      deadline TEXT,
      url TEXT,
      application_url TEXT,
      fingerprint TEXT
    );
  `)
  return raw
}

function insertGrant(db, g) {
  db.prepare(
    `INSERT INTO grants (id, profile_id, funding_opportunity_id, title, funder, deadline, url, application_url, fingerprint)
     VALUES (@id, @profile_id, @funding_opportunity_id, @title, @funder, @deadline, @url, @application_url, @fingerprint)`,
  ).run({
    id: g.id,
    profile_id: g.profile_id,
    funding_opportunity_id: g.funding_opportunity_id ?? null,
    title: g.title ?? null,
    funder: g.funder ?? null,
    deadline: g.deadline ?? null,
    url: g.url ?? null,
    application_url: g.application_url ?? null,
    fingerprint: g.fingerprint ?? null,
  })
}

describe('filterOutPipelineMembers', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('excludes an opportunity already in the pipeline by funding_opportunity_id', async () => {
    insertGrant(db, { id: 'g1', profile_id: 'p1', funding_opportunity_id: 'opp-123', title: 'Saved Grant' })
    const opportunities = [
      { id: 'opp-123', title: 'Saved Grant', sponsor: 'Acme', url: 'https://x.org/a' },
      { id: 'opp-999', title: 'Fresh Grant', sponsor: 'Beta', url: 'https://x.org/b' },
    ]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(1)
    expect(results.map((o) => o.id)).toEqual(['opp-999'])
  })

  it('excludes by fingerprint when the id differs but identity tuple matches', async () => {
    const identity = { title: 'Community Fund', sponsor: 'City', deadline: '2026-09-01', url: 'https://city.gov/fund' }
    const fp = grantFingerprintFromOpportunity(identity)
    insertGrant(db, {
      id: 'g2',
      profile_id: 'p1',
      funding_opportunity_id: 'old-id',
      title: identity.title,
      funder: identity.sponsor,
      deadline: identity.deadline,
      url: identity.url,
      fingerprint: fp,
    })
    // Same opportunity re-crawled under a brand-new catalog id.
    const opportunities = [{ id: 'new-id', ...identity }]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(1)
    expect(results).toHaveLength(0)
  })

  it('excludes opportunities matching a dismissal tombstone', async () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_dismissals (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, fingerprint TEXT,
        opportunity_id TEXT, source_url TEXT, title TEXT, reason TEXT,
        dismissed_by TEXT, dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `)
    db.prepare(
      `INSERT INTO pipeline_dismissals (id, profile_id, fingerprint, opportunity_id, title)
       VALUES ('d1', 'p1', NULL, 'dismissed-opp', 'Dismissed Program')`,
    ).run()
    const opportunities = [
      { id: 'dismissed-opp', title: 'Dismissed Program', url: 'https://x.org/d' },
      { id: 'keep-me', title: 'Keep Me', url: 'https://x.org/k' },
    ]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(1)
    expect(results.map((o) => o.id)).toEqual(['keep-me'])
  })

  it('is profile-scoped — another profile pipeline never suppresses these results', async () => {
    // p2 has the grant saved; p1 (the searcher) does not.
    insertGrant(db, { id: 'g3', profile_id: 'p2', funding_opportunity_id: 'opp-shared', title: 'Shared Grant' })
    const opportunities = [{ id: 'opp-shared', title: 'Shared Grant', url: 'https://x.org/s' }]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(0)
    expect(results.map((o) => o.id)).toEqual(['opp-shared'])
  })

  it('passes everything through when the pipeline is empty', async () => {
    const opportunities = [{ id: 'a' }, { id: 'b' }]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(0)
    expect(results).toHaveLength(2)
  })

  it('excludes a pipeline member re-crawled under a NEW id/source by title+funder', async () => {
    // Repro of the reported leak: the same scholarship is in the pipeline, then
    // re-crawled under a new catalog id AND a different source label, so its
    // deadline/url (and therefore its fingerprint) drift. Only normalized
    // title+funder still matches — this MUST exclude it.
    insertGrant(db, {
      id: 'g-hope',
      profile_id: 'p1',
      funding_opportunity_id: 'national_pd_program:hope',
      title: 'Tennessee HOPE Aspire Award',
      funder: 'Tennessee Student Assistance Corporation',
      deadline: '2026-09-01',
      url: 'https://tn.gov/collegepays/hope-aspire',
    })
    const opportunities = [
      {
        // brand-new id, different source label, drifted deadline + url
        id: 'national_pd_scholarship:hope',
        title: 'Tennessee HOPE Aspire Award',
        sponsor: 'Tennessee Student Assistance Corporation',
        deadline: '2027-09-01',
        url: 'https://tn.gov/different-path',
        match_score: 96,
      },
      { id: 'fresh-1', title: 'Some Other Grant', sponsor: 'Other', url: 'https://x.org/o' },
    ]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(1)
    expect(results.map((o) => o.id)).toEqual(['fresh-1'])
  })

  it('does NOT exclude same generic title when funder differs', async () => {
    // title+funder (not bare title) avoids over-suppressing unrelated programs
    // that happen to share a generic name.
    insertGrant(db, {
      id: 'g-gen',
      profile_id: 'p1',
      funding_opportunity_id: 'gen-1',
      title: 'General Operating Support',
      funder: 'Foundation A',
    })
    const opportunities = [
      { id: 'other', title: 'General Operating Support', sponsor: 'Foundation B', url: 'https://b.org' },
    ]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(0)
    expect(results.map((o) => o.id)).toEqual(['other'])
  })
})

describe('dedupeOpportunityList', () => {
  it('collapses duplicate rows for the same award (different source labels), keeping the best', () => {
    const list = [
      {
        id: 'national_pd_program:hope',
        source: 'national_pd_program',
        title: 'Tennessee HOPE Aspire Award',
        sponsor: 'Tennessee Student Assistance Corporation',
        match_score: 89,
      },
      {
        id: 'national_pd_scholarship:hope',
        source: 'national_pd_scholarship',
        title: 'Tennessee HOPE Aspire Award',
        sponsor: 'Tennessee Student Assistance Corporation',
        match_score: 100, // higher score + more complete → this copy must win
        description: 'Award for continuing students.',
        url: 'https://tn.gov/collegepays/hope-aspire',
      },
      { id: 'unrelated', title: 'The Gates Scholarship', sponsor: 'Gates Foundation', match_score: 95 },
    ]
    const { results, removed } = dedupeOpportunityList(list)
    expect(removed).toBe(1)
    expect(results).toHaveLength(2)
    const hope = results.find((o) => o.title === 'Tennessee HOPE Aspire Award')
    expect(hope.id).toBe('national_pd_scholarship:hope')
    expect(hope.match_score).toBe(100)
    expect(results.some((o) => o.title === 'The Gates Scholarship')).toBe(true)
  })

  it('collapses by shared opportunity_id even when titles differ slightly', () => {
    const list = [
      { id: 'opp-1', title: 'Program', match_score: 50 },
      { opportunity_id: 'opp-1', title: 'Program (renamed)', match_score: 70 },
    ]
    const { results, removed } = dedupeOpportunityList(list)
    expect(removed).toBe(1)
    expect(results).toHaveLength(1)
    expect(results[0].match_score).toBe(70)
  })

  it('keeps rows with no stable key instead of collapsing blanks', () => {
    const list = [{ match_score: 10 }, { match_score: 20 }]
    const { results, removed } = dedupeOpportunityList(list)
    expect(removed).toBe(0)
    expect(results).toHaveLength(2)
  })
})
