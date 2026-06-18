import { describe, it, expect } from 'vitest'
import {
  classifyTracedSource,
  traceFundingIntoCandidates,
  deriveSeedEntities,
  autoSeedTraceForProfile,
} from '../../backend/services/robert/robertFundingTraceBridge.js'

const FAKE_DB = {} // never touched — all deps are injected

describe('classifyTracedSource', () => {
  it('maps federal agencies to high-trust federal portals', () => {
    expect(classifyTracedSource({ type: 'federal_agency' })).toEqual({
      source_type: 'federal_portal',
      source_scope: 'federal',
      trust: 85,
    })
  })

  it('maps corporate / VC / parent-company channels to corporate_giving', () => {
    for (const type of ['corporate_csr', 'parent_company', 'venture_capital']) {
      expect(classifyTracedSource({ type }).source_type).toBe('corporate_giving')
    }
  })

  it('falls back to a low-trust directory for unknown types', () => {
    const c = classifyTracedSource({ type: 'mystery' })
    expect(c.source_type).toBe('nonprofit_directory')
    expect(c.trust).toBeLessThan(85)
  })
})

describe('traceFundingIntoCandidates (staging path)', () => {
  const traceStub = async () => ({
    entity: 'Acme Corp',
    entity_type: 'company',
    addability: { min_amount: 25000, max_age_years: 5 },
    sources: [
      { name: 'Navy', parent_agency: 'Department of Defense', type: 'federal_agency', origin: 'usaspending', total_amount: 1_000_000, award_count: 3, latest_year: 2024, addable: true, sample_url: 'https://www.usaspending.gov/award/A1' },
      { name: 'Acme Foundation', type: 'foundation', origin: 'ai_synthesis', addable: true, sample_url: 'https://example.org/foundation' },
      { name: 'No URL Funder', type: 'federal_agency', origin: 'usaspending', total_amount: 500000, latest_year: 2024, addable: true, sample_url: null },
      { name: 'Below Floor', type: 'federal_agency', origin: 'usaspending', total_amount: 1000, addable: false, sample_url: 'https://www.usaspending.gov/award/B1' },
    ],
  })

  it('stages only addable sources that have a URL, and skips URL-less ones', async () => {
    const staged = []
    const upsert = async (_db, c) => { staged.push(c); return { id: `id${staged.length}`, inserted: true } }
    const res = await traceFundingIntoCandidates(FAKE_DB, { entity: 'Acme Corp', upsert, traceFn: traceStub })

    expect(res.traced).toBe(4)
    expect(res.addable).toBe(2)          // Navy + Acme Foundation (No-URL excluded; Below-Floor not addable)
    expect(res.upserted).toBe(2)
    expect(res.skipped_no_url).toBe(1)   // "No URL Funder"
    expect(staged.map((c) => c.source_name)).toEqual([
      'Navy (Department of Defense)',
      'Acme Foundation',
    ])
  })

  it('records trace evidence and trust on the staged candidate', async () => {
    const staged = []
    const upsert = async (_db, c) => { staged.push(c); return { id: 'x', inserted: true } }
    await traceFundingIntoCandidates(FAKE_DB, { entity: 'Acme Corp', upsert, traceFn: traceStub })

    const navy = staged.find((c) => c.source_name.startsWith('Navy'))
    expect(navy.source_type).toBe('federal_portal')
    expect(navy.trust_score).toBe(85)
    expect(navy.evidence.tool).toBe('funding_trace')
    expect(navy.evidence.traced_entity).toBe('Acme Corp')
    expect(navy.evidence.total_amount).toBe(1_000_000)
  })

  it('throws without an upsert function', async () => {
    await expect(traceFundingIntoCandidates(FAKE_DB, { entity: 'x', traceFn: traceStub }))
      .rejects.toThrow(/upsert/)
  })
})

describe('deriveSeedEntities', () => {
  it('puts the profile own org first, then peers, all as company entities', () => {
    const seeds = deriveSeedEntities({
      ownOrgName: 'Hope Community Center',
      similarOrgs: [{ name: 'Riverside Youth Org' }, { name: 'Eastside Shelter' }],
    })
    expect(seeds.map((s) => s.entity)).toEqual(['Hope Community Center', 'Riverside Youth Org', 'Eastside Shelter'])
    expect(seeds[0].reason).toBe('profile_own_org')
    expect(seeds[1].reason).toBe('similar_org_peer')
    expect(seeds.every((s) => s.entityType === 'company')).toBe(true)
  })

  it('dedupes case-insensitively and drops stopword / too-short names', () => {
    const seeds = deriveSeedEntities({
      similarOrgs: [{ name: 'Acme Org' }, { name: 'ACME ORG' }, { name: 'Unknown' }, { name: 'abc' }],
    })
    expect(seeds.map((s) => s.entity)).toEqual(['Acme Org'])
  })

  it('caps the number of seeds', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Peer Organization ${i}` }))
    expect(deriveSeedEntities({ similarOrgs: many, max: 3 })).toHaveLength(3)
  })
})

describe('autoSeedTraceForProfile', () => {
  it('finds peers, traces each, and aggregates the results', async () => {
    const findPeers = async () => ({
      similar_orgs: [{ name: 'Peer Alpha' }, { name: 'Peer Beta' }],
      profile_summary: { entity_type: 'nonprofit', org_name: 'My Nonprofit' },
    })
    const traced = []
    const traceInto = async (_db, { entity }) => {
      traced.push(entity)
      return { entity, addable: 2, upserted: 2 }
    }
    const res = await autoSeedTraceForProfile(FAKE_DB, {
      profileId: 'p1',
      maxEntities: 5,
      deps: { findPeers, traceInto, upsert: () => {} },
    })

    expect(traced).toEqual(['My Nonprofit', 'Peer Alpha', 'Peer Beta'])
    expect(res.seeds_traced).toBe(3)
    expect(res.total_upserted).toBe(6)
    expect(res.total_addable).toBe(6)
  })

  it('continues past a failing trace and records the error', async () => {
    const findPeers = async () => ({ similar_orgs: [{ name: 'Good Peer' }, { name: 'Bad Peer' }], profile_summary: {} })
    const traceInto = async (_db, { entity }) => {
      if (entity === 'Bad Peer') throw new Error('boom')
      return { entity, addable: 1, upserted: 1 }
    }
    const res = await autoSeedTraceForProfile(FAKE_DB, {
      profileId: 'p1',
      deps: { findPeers, traceInto, upsert: () => {} },
    })
    expect(res.total_upserted).toBe(1)
    expect(res.per_entity.find((e) => e.entity === 'Bad Peer').error).toMatch(/boom/)
  })

  it('requires profileId and an upsert dep', async () => {
    await expect(autoSeedTraceForProfile(FAKE_DB, { deps: { upsert: () => {} } })).rejects.toThrow(/profileId/)
    await expect(autoSeedTraceForProfile(FAKE_DB, { profileId: 'p1', deps: {} })).rejects.toThrow(/upsert/)
  })
})
