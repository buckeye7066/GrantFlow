import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { VERIFIED_FOUR_TRUTH_PROOF } from './helpers/fourTruthFixture.js'

import { createGrantsGovAdapter } from '../crawler-os/adapters/grantsGovAdapter.js'
import { normalize } from '../crawler-os/normalizer.js'
import { createMemoryStore } from '../crawler-os/store.js'
import { storage } from '../crawler-os/index.js'
import { persistRun } from '../services/crawlerOsPersistence.js'

const DETAIL_ID = '98765'
const PUBLIC_NUMBER = 'PUBLIC-2026-77'
const DETAIL_URL = `https://www.grants.gov/search-results-detail/${DETAIL_ID}`
const OLD_ID = 'legacy-numeric-catalog-id'
const OLD_FIRST_SEEN = '2025-01-02T03:04:05.000Z'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, sponsor TEXT, description TEXT,
      source TEXT, source_id TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      deadline TEXT, amount_min REAL, amount_max REAL, amount_text TEXT, amount_status TEXT,
      amount_confidence REAL, is_loan INTEGER, requires_match INTEGER,
      is_national INTEGER, state TEXT, categories TEXT, opportunity_kind TEXT,
      source_trust_tier TEXT, reality_status TEXT, record_origin TEXT,
      canonical_opportunity_key TEXT, fingerprint TEXT, evidence_url TEXT,
      is_active INTEGER DEFAULT 1, is_hidden INTEGER DEFAULT 0,
      last_crawled DATETIME, last_verified_at DATETIME, discovered_at DATETIME,
      updated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE opportunity_sources (
      opportunity_id TEXT NOT NULL, source_id TEXT NOT NULL,
      external_id TEXT, apply_url TEXT, first_seen_at DATETIME, last_seen_at DATETIME,
      PRIMARY KEY (opportunity_id, source_id)
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      match_score REAL, match_confidence REAL, match_decision TEXT,
      match_explanation TEXT, match_reasons TEXT, match_explain_json TEXT,
      matcher_version TEXT, computed_at DATETIME, updated_at DATETIME, evaluated_at DATETIME,
      UNIQUE (profile_id, opportunity_id)
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, status TEXT
    );
  `)
  db.dialect = 'sqlite'
  return db
}

function seedLegacyNumericRow(db, {
  id = OLD_ID,
  key = `ext:${DETAIL_ID}`,
  sourceId = DETAIL_ID,
} = {}) {
  db.prepare(
    `INSERT INTO funding_opportunities
       (id, title, sponsor, source, source_id, source_url, application_url, apply_url,
        canonical_opportunity_key, fingerprint, reality_status, record_origin)
     VALUES (?, 'Federal Resilience Opportunity', 'Federal Resilience Agency',
             'grants_gov', ?, ?, ?, ?, ?, ?, 'verified', 'live_crawl')`,
  ).run(id, sourceId, DETAIL_URL, DETAIL_URL, DETAIL_URL, key, key)
}

function makePublicNumberCrawl() {
  const source = {
    source_id: 'grants_gov',
    trust_tier: 'OFFICIAL_API',
    geography: { national: true, states: [] },
  }
  const candidate = createGrantsGovAdapter().mapCandidate({
    external_id: DETAIL_ID,
    number: PUBLIC_NUMBER,
    title: 'Federal Resilience Opportunity',
    sponsor: 'Federal Resilience Agency',
    summary: 'Federal resilience funding.',
    deadline: '12/31/2099',
    opp_status: 'posted',
  }, { source })
  const opportunity = normalize(candidate, {
    kind: 'DIRECT_GRANT',
    reality_status: 'verified',
  }, {
    source,
    evidence: {
      url: DETAIL_URL,
      content_hash: 'content-v2',
      fetched_at: '2026-08-17T00:00:00.000Z',
    },
  })
  const store = createMemoryStore()
  storage.upsertOpportunity(store, opportunity)
  storage.upsertMatch(store, {
    profile_id: 'profile-1',
    opportunity_id: opportunity.id,
    match_score: 91,
    match_confidence: 0.9,
    decision: 'accept',
    match_explain: { why: 'Aligned resilience need.', four_truth_proof: VERIFIED_FOUR_TRUTH_PROOF },
  })
  return { store, opportunity }
}

describe('Crawler OS Grants.gov rolling identity migration', () => {
  it('upgrades an old numeric identity onto the public number without duplicating or changing the canonical row id', async () => {
    const db = makeDb()
    seedLegacyNumericRow(db)
    db.prepare(
      `INSERT INTO opportunity_sources
         (opportunity_id, source_id, external_id, apply_url, first_seen_at, last_seen_at)
       VALUES (?, 'grants_gov', ?, ?, ?, ?)`,
    ).run(OLD_ID, DETAIL_ID, DETAIL_URL, OLD_FIRST_SEEN, OLD_FIRST_SEEN)

    const { store, opportunity } = makePublicNumberCrawl()
    const result = await persistRun(db, store, {})

    const catalog = db.prepare(
      'SELECT id, source_id, canonical_opportunity_key, fingerprint FROM funding_opportunities',
    ).all()
    expect(catalog).toEqual([{
      id: OLD_ID,
      source_id: PUBLIC_NUMBER,
      canonical_opportunity_key: `ext:${PUBLIC_NUMBER.toLowerCase()}`,
      fingerprint: `ext:${PUBLIC_NUMBER.toLowerCase()}`,
    }])
    expect(result.idRemap.get(opportunity.id)).toBe(OLD_ID)

    const match = db.prepare(
      'SELECT opportunity_id FROM profile_opportunity_matches WHERE profile_id = ?',
    ).get('profile-1')
    expect(match.opportunity_id).toBe(OLD_ID)

    const provenance = db.prepare(
      `SELECT opportunity_id, source_id, external_id, apply_url, first_seen_at
         FROM opportunity_sources`,
    ).get()
    expect(provenance).toMatchObject({
      opportunity_id: OLD_ID,
      source_id: 'grants_gov',
      external_id: PUBLIC_NUMBER,
      apply_url: DETAIL_URL,
      first_seen_at: OLD_FIRST_SEEN,
    })
  })

  it('fails closed on ambiguous old+new identities and performs no catalog mutation or third insert', async () => {
    const db = makeDb()
    seedLegacyNumericRow(db)
    seedLegacyNumericRow(db, {
      id: 'already-public-row',
      key: `ext:${PUBLIC_NUMBER.toLowerCase()}`,
      sourceId: PUBLIC_NUMBER,
    })
    const before = db.prepare(
      'SELECT id, source_id, canonical_opportunity_key, fingerprint FROM funding_opportunities ORDER BY id',
    ).all()

    const { store } = makePublicNumberCrawl()
    await expect(persistRun(db, store, {})).rejects.toMatchObject({
      code: 'CRAWLER_OS_GRANTS_GOV_IDENTITY_CONFLICT',
    })

    const after = db.prepare(
      'SELECT id, source_id, canonical_opportunity_key, fingerprint FROM funding_opportunities ORDER BY id',
    ).all()
    expect(after).toEqual(before)
    expect(after).toHaveLength(2)
  })
})
