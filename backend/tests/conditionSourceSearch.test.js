/**
 * conditionSourceSearch.test.js — the adapter wishlist's consumer.
 *
 * The defect it closes: the fleet scoreboard correctly reported "No disease-specific
 * source lane exists for epilepsy/cipn" every night and NOTHING acted on it — Amy
 * emitted one `blocked` telemetry row and the owner was asked to hand-add adapters.
 * A correct finding with no actor is an unpaid debt that reads like diligence.
 *
 * Fully offline: searchWeb is injected.
 */

import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildConditionQueries,
  isDueForSearch,
  searchForMissingConditionSources,
  readConditionSearchEvidence,
  MAX_ATTEMPTS,
  RESEARCH_COOLDOWN_MS,
} from '../services/coverageAudit/conditionSourceSearch.js'
import { readWebParityGapQueue, CONDITION_COVERAGE_KV_KEY } from '../services/webParityBenchmark.js'
import { CONDITION_COVERAGE_KV_KEY as EVIDENCE_SIDE_KEY } from '../services/coverageEvidenceService.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
  return db
}

const wishlistEntry = (detail, profiles = ['p1']) => ({
  lane: 'disease_specific',
  gap_class: 'no_disease_source',
  detail,
  statement: `No disease-specific source lane exists for "${detail}".`,
  affected_profiles_count: profiles.length,
  affected_profiles: profiles,
})

const REAL_HIT = { url: 'https://epilepsyfoundation.org/help', title: 'Epilepsy Foundation financial assistance', snippet: 'grants and assistance for patients' }
const NOISE_HIT = { url: 'https://www.webmd.com/epilepsy', title: 'Epilepsy overview', snippet: 'health information' }

describe('buildConditionQueries', () => {
  it('asks for FUNDING, not clinical information', () => {
    const qs = buildConditionQueries('epilepsy')
    expect(qs.length).toBeGreaterThan(0)
    // "epilepsy" alone returns WebMD. Every query must carry a funding intent or
    // the search burns its budget on medical encyclopedias.
    for (const q of qs) expect(q).toMatch(/assistance|grant|financial|foundation/i)
    expect(qs.every((q) => q.includes('epilepsy'))).toBe(true)
  })

  it('returns nothing for an empty condition', () => {
    expect(buildConditionQueries('')).toEqual([])
    expect(buildConditionQueries(null)).toEqual([])
  })
})

describe('isDueForSearch', () => {
  const now = new Date('2026-07-16T12:00:00Z')
  it('searches a condition never tried', () => {
    expect(isDueForSearch(undefined, now)).toBe(true)
  })
  it('never re-searches an exhausted condition (we have our answer)', () => {
    expect(isDueForSearch({ exhausted: true, searched_at: '2020-01-01T00:00:00Z' }, now)).toBe(false)
  })
  it('respects the cooldown so Amy does not re-search nightly forever', () => {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    expect(isDueForSearch({ searched_at: yesterday, attempts: 1 }, now)).toBe(false)
    const old = new Date(now.getTime() - RESEARCH_COOLDOWN_MS - 1000).toISOString()
    expect(isDueForSearch({ searched_at: old, attempts: 1 }, now)).toBe(true)
  })
})

describe('searchForMissingConditionSources', () => {
  it('queues a real source per affected profile for GATED adoption', async () => {
    const db = makeDb()
    const searchWeb = vi.fn(async () => [REAL_HIT, NOISE_HIT])
    const res = await searchForMissingConditionSources(db, [wishlistEntry('epilepsy', ['p1', 'p2'])], { searchWeb })

    expect(res.ran).toBe(true)
    expect(res.searched).toBe(1)
    // One real hit × two affected profiles — the seeding lane is profile-scoped.
    expect(res.queued).toBe(2)

    const queue = await readWebParityGapQueue(db)
    expect(queue).toHaveLength(2)
    expect(queue.map((c) => c.profile_id).sort()).toEqual(['p1', 'p2'])
    // Provenance must be honest — this did NOT come from the Google-bar benchmark.
    expect(queue[0].source).toBe('condition_source_search')
    expect(queue[0].need).toBe('epilepsy')
    // Queued is NOT added: it enters as a candidate and the gates decide later.
    expect(queue[0].status).toBe('candidate')
  })

  it("does NOT queue ANOTHER state's government portal", async () => {
    // REGRESSION (prod 2026-07-16). Searching "medical debt" for a profile in
    // Cleveland, TENNESSEE queued California's Medi-Cal (dhcs.ca.gov) and
    // BenefitsCal. The benchmark already learned this exact lesson — both domains
    // are named in isOutOfStateGovHit because they cratered the parity score
    // against a TN profile on 2026-07-12 — and this consumer reused
    // isRealFundingHit from that same module while walking straight past the
    // filter next to it. GrantFlow is RIGHT not to surface Medi-Cal in Tennessee.
    const db = makeDb()
    const searchWeb = vi.fn(async () => [
      { url: 'https://www.dhcs.ca.gov/medi-cal/', title: 'Medi-Cal financial assistance', snippet: 'health coverage grants' },
      { url: 'https://benefitscal.com/Help/program/medical/HCPDE', title: 'BenefitsCal medical assistance', snippet: 'apply for benefits' },
      { url: 'https://undueMedicalDebt.org/apply', title: 'Undue Medical Debt relief grants', snippet: 'medical debt assistance' },
    ])
    const res = await searchForMissingConditionSources(db, [wishlistEntry('medical debt', ['tn-profile'])], {
      searchWeb,
      loadProfileState: async () => 'TN',
    })
    const queue = await readWebParityGapQueue(db)
    expect(queue.map((c) => c.url)).toEqual(['https://undueMedicalDebt.org/apply'])
    expect(res.queued).toBe(1)
  })

  it('keeps an IN-state government portal', async () => {
    // The filter must not become "no .gov ever" — a TN profile SHOULD get TN's portal.
    const db = makeDb()
    const searchWeb = vi.fn(async () => [
      { url: 'https://www.tn.gov/humanservices/for-families/grant-assistance.html', title: 'TN grant assistance', snippet: 'financial assistance' },
    ])
    const res = await searchForMissingConditionSources(db, [wishlistEntry('medical debt', ['tn-profile'])], {
      searchWeb, loadProfileState: async () => 'TN',
    })
    expect(res.queued).toBe(1)
  })

  it('never drops a candidate when the profile state is UNKNOWN (no guessing)', async () => {
    const db = makeDb()
    const searchWeb = vi.fn(async () => [
      { url: 'https://www.dhcs.ca.gov/medi-cal/', title: 'Medi-Cal financial assistance', snippet: 'health coverage grants' },
    ])
    const res = await searchForMissingConditionSources(db, [wishlistEntry('x-cond', ['p1'])], {
      searchWeb, loadProfileState: async () => null,
    })
    expect(res.queued).toBe(1)
  })

  it('filters per PROFILE — the same hit can be in-scope for one and not another', async () => {
    const db = makeDb()
    const searchWeb = vi.fn(async () => [
      { url: 'https://www.dhcs.ca.gov/medi-cal/', title: 'Medi-Cal financial assistance', snippet: 'health coverage grants' },
    ])
    const states = { 'ca-profile': 'CA', 'tn-profile': 'TN' }
    const res = await searchForMissingConditionSources(db, [wishlistEntry('x-cond', ['ca-profile', 'tn-profile'])], {
      searchWeb, loadProfileState: async (_db, pid) => states[pid],
    })
    const queue = await readWebParityGapQueue(db)
    expect(queue.map((c) => c.profile_id)).toEqual(['ca-profile'])
    expect(res.queued).toBe(1)
  })

  it('drops non-funding noise (WebMD is never a funder)', async () => {
    const db = makeDb()
    const searchWeb = vi.fn(async () => [NOISE_HIT])
    const res = await searchForMissingConditionSources(db, [wishlistEntry('epilepsy')], { searchWeb })
    expect(res.queued).toBe(0)
    expect(await readWebParityGapQueue(db)).toHaveLength(0)
  })

  it('never writes a catalog row itself — only the queue', async () => {
    // The safety argument: this service adds NO ingestion path. Everything it finds
    // must survive fetch → extract → reality gate → match engine downstream.
    const db = makeDb()
    const searchWeb = vi.fn(async () => [REAL_HIT])
    await searchForMissingConditionSources(db, [wishlistEntry('epilepsy')], { searchWeb })
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    expect(tables).not.toContain('funding_opportunities')
  })

  it('skips a wishlist entry with NO affected profile ids rather than silently queueing nothing', async () => {
    // The scoreboard used to project only `affected_profiles_count`, so a consumer
    // written against that shape queued ZERO while reporting success — the
    // read-green-while-doing-nothing class. Be explicit instead.
    const db = makeDb()
    const searchWeb = vi.fn(async () => [REAL_HIT])
    const entry = { ...wishlistEntry('epilepsy'), affected_profiles: [] }
    const res = await searchForMissingConditionSources(db, [entry], { searchWeb })
    expect(res.searched).toBe(0)
    expect(searchWeb).not.toHaveBeenCalled()
  })

  it('ignores gap classes that are not a condition', async () => {
    const db = makeDb()
    const searchWeb = vi.fn(async () => [REAL_HIT])
    const res = await searchForMissingConditionSources(db, [
      { gap_class: 'matrix_uncovered_critical', detail: 'county_city', affected_profiles: [] },
      { gap_class: 'no_state_source', detail: 'TN', affected_profiles: ['p1'] },
    ], { searchWeb })
    expect(res.searched).toBe(0)
    expect(searchWeb).not.toHaveBeenCalled()
  })

  it('marks exhausted only after MAX_ATTEMPTS honest empty searches — and KEEPS the entry', async () => {
    const db = makeDb()
    const searchWeb = vi.fn(async () => []) // honest: nothing out there
    let res
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      res = await searchForMissingConditionSources(db, [wishlistEntry('cipn')], {
        searchWeb,
        // Step past the cooldown each round.
        now: new Date(Date.parse('2026-07-16T00:00:00Z') + i * (RESEARCH_COOLDOWN_MS + 1000)),
      })
    }
    expect(res.exhausted).toBe(1)
    const ev = await readConditionSearchEvidence(db)
    expect(ev.cipn.attempts).toBe(MAX_ATTEMPTS)
    expect(ev.cipn.exhausted).toBe(true)
    expect(ev.cipn.real_hits).toBe(0)
    // The gap is NOT suppressed — "we looked and found nothing" is a fact the owner
    // must still see. A lane the registry lacks is never a silent miss.
  })

  it('a search-provider outage does NOT spend an attempt (it is not evidence)', async () => {
    // Otherwise a bad night at the provider permanently exhausts a real condition.
    const db = makeDb()
    const searchWeb = vi.fn(async () => { throw new Error('provider 503') })
    const res = await searchForMissingConditionSources(db, [wishlistEntry('epilepsy')], { searchWeb })
    expect(res.searched).toBe(0)
    const ev = await readConditionSearchEvidence(db)
    expect(ev.epilepsy).toBeUndefined()
  })

  it('records honest evidence of what was tried', async () => {
    const db = makeDb()
    const searchWeb = vi.fn(async () => [REAL_HIT])
    await searchForMissingConditionSources(db, [wishlistEntry('epilepsy')], {
      searchWeb, now: new Date('2026-07-16T09:00:00Z'),
    })
    const ev = await readConditionSearchEvidence(db)
    expect(ev.epilepsy).toMatchObject({ condition: 'epilepsy', attempts: 1, real_hits: 1, candidates_queued: 1, exhausted: false })
    expect(ev.epilepsy.searched_at).toBe('2026-07-16T09:00:00.000Z')
  })

  it('is bounded per run (each condition costs real search calls)', async () => {
    const db = makeDb()
    const searchWeb = vi.fn(async () => [])
    const many = ['a-cond', 'b-cond', 'c-cond', 'd-cond', 'e-cond'].map((c) => wishlistEntry(c))
    const res = await searchForMissingConditionSources(db, many, { searchWeb, maxConditions: 2 })
    expect(res.searched).toBe(2)
  })

  it('degrades honestly with no search provider / no db', async () => {
    expect((await searchForMissingConditionSources(makeDb(), [wishlistEntry('x')], {})).ran).toBe(false)
    expect((await searchForMissingConditionSources(null, [], { searchWeb: async () => [] })).ran).toBe(false)
  })
})

describe('condition coverage KV key (static drift tripwire)', () => {
  it('the producer and the consumer name the SAME system_kv key', () => {
    // The overlay is written by webParityBenchmark and read by
    // coverageEvidenceService. They hold the literal independently (importing the
    // heavy evidence service into the benchmark is not worth it), so if these ever
    // drift the wishlist silently stops converging — a gap that IS closed keeps
    // re-emitting forever and nobody notices, because both sides still "work".
    expect(CONDITION_COVERAGE_KV_KEY).toBe(EVIDENCE_SIDE_KEY)
    expect(CONDITION_COVERAGE_KV_KEY).toBe('condition_source_coverage')
  })
})
