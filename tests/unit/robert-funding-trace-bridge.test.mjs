import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTracedSource,
  traceFundingIntoCandidates,
  deriveSeedEntities,
  autoSeedTraceForProfile,
  selectWeakestProfiles,
  autoSeedWeakestProfiles,
} from '../../backend/services/robert/robertFundingTraceBridge.js'

const FAKE_DB = {} // never touched — all deps are injected

describe('classifyTracedSource', () => {
  it('maps federal agencies to high-trust federal portals', () => {
    assert.deepEqual(classifyTracedSource({ type: 'federal_agency' }), {
      source_type: 'federal_portal',
      source_scope: 'federal',
      trust: 85,
    })
  })

  it('maps corporate / VC / parent-company channels to corporate_giving', () => {
    for (const type of ['corporate_csr', 'parent_company', 'venture_capital']) {
      assert.equal(classifyTracedSource({ type }).source_type, 'corporate_giving')
    }
  })

  it('falls back to a low-trust directory for unknown types', () => {
    const c = classifyTracedSource({ type: 'mystery' })
    assert.equal(c.source_type, 'nonprofit_directory')
    assert.ok(c.trust < 85)
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

    assert.equal(res.traced, 4)
    assert.equal(res.addable, 2)          // Navy + Acme Foundation (No-URL excluded; Below-Floor not addable)
    assert.equal(res.upserted, 2)
    assert.equal(res.skipped_no_url, 1)   // "No URL Funder"
    assert.deepEqual(staged.map((c) => c.source_name), [
      'Navy (Department of Defense)',
      'Acme Foundation',
    ])
  })

  it('records trace evidence and trust on the staged candidate', async () => {
    const staged = []
    const upsert = async (_db, c) => { staged.push(c); return { id: 'x', inserted: true } }
    await traceFundingIntoCandidates(FAKE_DB, { entity: 'Acme Corp', upsert, traceFn: traceStub })

    const navy = staged.find((c) => c.source_name.startsWith('Navy'))
    assert.equal(navy.source_type, 'federal_portal')
    assert.equal(navy.trust_score, 85)
    assert.equal(navy.evidence.tool, 'funding_trace')
    assert.equal(navy.evidence.traced_entity, 'Acme Corp')
    assert.equal(navy.evidence.total_amount, 1_000_000)
  })

  it('throws without an upsert function', async () => {
    await assert.rejects(
      traceFundingIntoCandidates(FAKE_DB, { entity: 'x', traceFn: traceStub }),
      /upsert/,
    )
  })
})

describe('deriveSeedEntities', () => {
  it('puts the profile own org first, then peers, all as company entities', () => {
    const seeds = deriveSeedEntities({
      ownOrgName: 'Hope Community Center',
      similarOrgs: [{ name: 'Riverside Youth Org' }, { name: 'Eastside Shelter' }],
    })
    assert.deepEqual(seeds.map((s) => s.entity), ['Hope Community Center', 'Riverside Youth Org', 'Eastside Shelter'])
    assert.equal(seeds[0].reason, 'profile_own_org')
    assert.equal(seeds[1].reason, 'similar_org_peer')
    assert.equal(seeds.every((s) => s.entityType === 'company'), true)
  })

  it('dedupes case-insensitively and drops stopword / too-short names', () => {
    const seeds = deriveSeedEntities({
      similarOrgs: [{ name: 'Acme Org' }, { name: 'ACME ORG' }, { name: 'Unknown' }, { name: 'abc' }],
    })
    assert.deepEqual(seeds.map((s) => s.entity), ['Acme Org'])
  })

  it('caps the number of seeds', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Peer Organization ${i}` }))
    assert.equal(deriveSeedEntities({ similarOrgs: many, max: 3 }).length, 3)
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

    assert.deepEqual(traced, ['My Nonprofit', 'Peer Alpha', 'Peer Beta'])
    assert.equal(res.seeds_traced, 3)
    assert.equal(res.total_upserted, 6)
    assert.equal(res.total_addable, 6)
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
    assert.equal(res.total_upserted, 1)
    assert.match(res.per_entity.find((e) => e.entity === 'Bad Peer').error, /boom/)
  })

  it('requires profileId and an upsert dep', async () => {
    await assert.rejects(autoSeedTraceForProfile(FAKE_DB, { deps: { upsert: () => {} } }), /profileId/)
    await assert.rejects(autoSeedTraceForProfile(FAKE_DB, { profileId: 'p1', deps: {} }), /upsert/)
  })
})

describe('selectWeakestProfiles', () => {
  const rows = [
    { profile_id: 'a', zero_result_risk: 100, coverage_score: 5 },
    { profile_id: 'b', zero_result_risk: 80, coverage_score: 40 },
    { profile_id: 'c', zero_result_risk: 35, coverage_score: 70 },  // below default minRisk
    { profile_id: 'd', zero_result_risk: 80, coverage_score: 20 },
  ]

  it('ranks by risk desc then coverage asc, and applies the risk floor', () => {
    // c (risk 35) excluded by minRisk=60; b and d tie on risk 80 -> lower coverage (d) first
    assert.deepEqual(selectWeakestProfiles(rows, { limit: 10 }), ['a', 'd', 'b'])
  })

  it('respects the limit', () => {
    assert.deepEqual(selectWeakestProfiles(rows, { limit: 1 }), ['a'])
  })

  it('returns nothing when all profiles are above the risk floor', () => {
    assert.deepEqual(selectWeakestProfiles(rows, { minRisk: 200 }), [])
  })
})

describe('autoSeedWeakestProfiles', () => {
  it('scores listed profiles, picks the weakest, and seeds each', async () => {
    const listProfileIds = async () => ['a', 'b', 'c']
    const coverageByProfile = {
      a: { profile_id: 'a', zero_result_risk: 100, coverage_score: 0 },
      b: { profile_id: 'b', zero_result_risk: 20, coverage_score: 90 },  // healthy -> skip
      c: { profile_id: 'c', zero_result_risk: 70, coverage_score: 30 },
    }
    const analyzeCoverage = async (_db, id) => coverageByProfile[id]
    const seeded = []
    const autoSeed = async (_db, { profileId }) => {
      seeded.push(profileId)
      return { profile_id: profileId, total_upserted: 4 }
    }
    const res = await autoSeedWeakestProfiles(FAKE_DB, {
      limit: 5,
      deps: { listProfileIds, analyzeCoverage, autoSeed },
    })

    assert.deepEqual(seeded, ['a', 'c'])   // b skipped (low risk), a before c (higher risk)
    assert.equal(res.evaluated, 3)
    assert.equal(res.weak_profiles, 2)
    assert.equal(res.total_upserted, 8)
  })

  it('survives a coverage-analysis failure for one profile', async () => {
    const listProfileIds = async () => ['ok', 'broken']
    const analyzeCoverage = async (_db, id) => {
      if (id === 'broken') throw new Error('coverage boom')
      return { profile_id: id, zero_result_risk: 90, coverage_score: 10 }
    }
    const autoSeed = async (_db, { profileId }) => ({ profile_id: profileId, total_upserted: 1 })
    const res = await autoSeedWeakestProfiles(FAKE_DB, { deps: { listProfileIds, analyzeCoverage, autoSeed } })
    assert.equal(res.weak_profiles, 1)
    assert.equal(res.total_upserted, 1)
  })

  it('requires an upsert dep when using the default seeder', async () => {
    await assert.rejects(
      autoSeedWeakestProfiles(FAKE_DB, { deps: { listProfileIds: async () => [], analyzeCoverage: async () => null } }),
      /upsert/,
    )
  })
})
