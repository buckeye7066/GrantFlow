import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { persistRun } from '../services/crawlerOsPersistence.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, sponsor TEXT, description TEXT,
      source TEXT, source_id TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      deadline TEXT, deadline_type TEXT, deadline_status TEXT,
      amount_min REAL, amount_max REAL, amount_text TEXT, amount_status TEXT,
      amount_confidence REAL, is_loan INTEGER, requires_match INTEGER,
      is_national INTEGER, state TEXT, regions TEXT, geo_county TEXT, geo_zip TEXT,
      geo_scope TEXT, geo_eligibility TEXT,
      categories TEXT, entity_types_allowed TEXT, need_types_supported TEXT,
      opportunity_kind TEXT, source_trust_tier TEXT, reality_status TEXT,
      record_origin TEXT, canonical_opportunity_key TEXT, fingerprint TEXT,
      evidence_url TEXT, is_active INTEGER DEFAULT 1, is_hidden INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active', last_crawled TEXT, last_verified_at TEXT,
      discovered_at TEXT, updated_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      link_status TEXT DEFAULT 'unverified', link_status_code INTEGER,
      verification_method TEXT, verified_by TEXT, verification_error TEXT,
      final_url TEXT, http_status INTEGER, type TEXT, opportunity_type TEXT,
      result_kind TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, status TEXT
    );
  `)
  return db
}

function memStore(catalog) {
  return {
    all(table) {
      return table === 'funding_opportunities' ? catalog : []
    },
  }
}

function osRow(overrides = {}) {
  return {
    id: 'structured-1',
    source_id: 'official_test',
    external_id: 'EXT-1',
    kind: 'DIRECT_GRANT',
    canonical_opportunity_key: 'structured-key-1',
    title: 'Regional Essential Needs Grant',
    sponsor: 'Official Test Foundation',
    summary: 'Direct assistance.',
    apply_url: 'https://official.example.org/apply',
    info_url: 'https://official.example.org/program',
    deadline: null,
    is_rolling: 1,
    amount_min: null,
    amount_max: null,
    is_loan: 0,
    requires_cost_share: 0,
    applicant_types_json: JSON.stringify(['nonprofit', 'small_business']),
    need_categories_json: JSON.stringify(['housing', 'transportation']),
    geography_json: JSON.stringify({
      national: false,
      states: ['TN', 'KY'],
      counties: ['Hamilton County', 'Bradley County'],
      zips: ['37402', '37311'],
      cities: ['Chattanooga'],
    }),
    trust_tier: 'official_portal',
    reality_status: 'allowed',
    evidence_url: 'https://official.example.org/program',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('crawler-os live persistence preserves structured source truth', () => {
  it('ships PostgreSQL columns required to retain the same structured semantics', () => {
    const sql = readFileSync(
      path.resolve('backend/db/postgres/migrations/0168_funding_opportunity_match_semantics.sql'),
      'utf8',
    )
    for (const column of [
      'entity_types_allowed',
      'need_types_supported',
      'deadline_status',
      'official_source_type',
      'source_trust_score',
      'opportunity_fingerprint',
    ]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i'))
    }
  })

  it('round-trips applicant/need facts, full geography, and rolling deadline semantics', async () => {
    const db = makeDb()
    await persistRun(db, memStore([osRow()]), {})

    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('structured-1')
    expect(JSON.parse(row.entity_types_allowed)).toEqual(['nonprofit', 'small_business'])
    expect(JSON.parse(row.need_types_supported)).toEqual(['housing', 'transportation'])
    expect(JSON.parse(row.categories)).toEqual(['housing', 'transportation'])
    expect(row).toMatchObject({
      is_national: 0,
      state: 'TN',
      geo_county: 'Hamilton County',
      geo_zip: '37402',
      geo_scope: 'zip',
      deadline: null,
      deadline_type: 'rolling',
      deadline_status: 'rolling',
    })
    expect(JSON.parse(row.regions)).toEqual(['TN', 'KY'])
    expect(JSON.parse(row.geo_eligibility)).toEqual({
      national: false,
      states: ['TN', 'KY'],
      counties: ['Hamilton County', 'Bradley County'],
      zips: ['37402', '37311'],
      cities: ['Chattanooga'],
      regions: [],
    })
    db.close()
  })

  it('stores a missing deadline as unknown, never as rolling', async () => {
    const db = makeDb()
    await persistRun(db, memStore([osRow({
      id: 'unknown-deadline',
      canonical_opportunity_key: 'unknown-deadline-key',
      deadline: null,
      is_rolling: 0,
    })]), {})

    expect(db.prepare('SELECT deadline,deadline_type,deadline_status FROM funding_opportunities WHERE id=?')
      .get('unknown-deadline')).toEqual({
      deadline: null,
      deadline_type: 'unknown',
      deadline_status: 'unknown',
    })
    db.close()
  })

  it('changes rolling to fixed without retaining a stale rolling status', async () => {
    const db = makeDb()
    await persistRun(db, memStore([osRow()]), {})
    await persistRun(db, memStore([osRow({
      deadline: '2099-12-31',
      is_rolling: 0,
    })]), {})

    expect(db.prepare('SELECT deadline,deadline_type,deadline_status FROM funding_opportunities WHERE id=?')
      .get('structured-1')).toEqual({
      deadline: '2099-12-31',
      deadline_type: 'fixed',
      deadline_status: null,
    })
    db.close()
  })

  it('changes fixed to rolling without retaining a stale fixed date', async () => {
    const db = makeDb()
    await persistRun(db, memStore([osRow({
      deadline: '2099-12-31',
      is_rolling: 0,
    })]), {})
    await persistRun(db, memStore([osRow({ deadline: null, is_rolling: 1 })]), {})

    expect(db.prepare('SELECT deadline,deadline_type,deadline_status FROM funding_opportunities WHERE id=?')
      .get('structured-1')).toEqual({
      deadline: null,
      deadline_type: 'rolling',
      deadline_status: 'rolling',
    })
    db.close()
  })

  it('an explicit national scope clears stale scalar regional projections', async () => {
    const db = makeDb()
    await persistRun(db, memStore([osRow()]), {})
    await persistRun(db, memStore([osRow({
      geography_json: JSON.stringify({ national: true }),
    })]), {})

    const row = db.prepare(`
      SELECT is_national,state,regions,geo_county,geo_zip,geo_scope,geo_eligibility
        FROM funding_opportunities WHERE id=?
    `).get('structured-1')
    expect(row).toMatchObject({
      is_national: 1,
      state: null,
      geo_county: null,
      geo_zip: null,
      geo_scope: 'national',
    })
    expect(JSON.parse(row.regions)).toEqual([])
    expect(JSON.parse(row.geo_eligibility)).toEqual({
      national: true,
      states: [],
      counties: [],
      zips: [],
      cities: [],
      regions: [],
    })
    db.close()
  })

  it('a partial recrawl cannot erase learned facts or rewrite terminal lifecycle evidence', async () => {
    const db = makeDb()
    const initial = osRow({ deadline: '2026-12-31', is_rolling: 0 })
    await persistRun(db, memStore([initial]), {})
    db.prepare(`
      UPDATE funding_opportunities
         SET is_active=0, is_hidden=1, status='expired', link_status='skipped',
             verification_error='retired_after_definitive_recheck:permanent_http_gone:HTTP 410',
             last_verified_at='2026-08-05T00:00:00.000Z'
       WHERE id='structured-1'
    `).run()

    await persistRun(db, memStore([{
      ...initial,
      // A terminal row keeps the deadline that justified its lifecycle even
      // when a later catalog pass reports a conflicting future date.
      deadline: '2099-12-31',
      is_rolling: 0,
      applicant_types_json: '[]',
      need_categories_json: '[]',
      geography_json: JSON.stringify({ national: false, states: [], counties: [], zips: [] }),
    }]), {})

    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('structured-1')
    expect(row).toMatchObject({
      is_active: 0,
      is_hidden: 1,
      status: 'expired',
      link_status: 'skipped',
      deadline: '2026-12-31',
      deadline_type: 'fixed',
      last_verified_at: '2026-08-05T00:00:00.000Z',
    })
    expect(row.verification_error).toMatch(/^retired_after_definitive_recheck:/)
    expect(JSON.parse(row.entity_types_allowed)).toEqual(['nonprofit', 'small_business'])
    expect(JSON.parse(row.need_types_supported)).toEqual(['housing', 'transportation'])
    expect(JSON.parse(row.regions)).toEqual(['TN', 'KY'])
    db.close()
  })

  it('a recrawl never unhides or reactivates a retryable link quarantine', async () => {
    const db = makeDb()
    await persistRun(db, memStore([osRow()]), {})
    db.prepare(`
      UPDATE funding_opportunities
         SET is_active=0, is_hidden=1, status='paused', link_status='broken',
             verification_error='retryable_after_recheck:timeout'
       WHERE id='structured-1'
    `).run()

    await persistRun(db, memStore([osRow()]), {})

    expect(db.prepare('SELECT is_active,is_hidden,status,link_status,verification_error FROM funding_opportunities WHERE id=?')
      .get('structured-1')).toEqual({
      is_active: 0,
      is_hidden: 1,
      status: 'paused',
      link_status: 'broken',
      verification_error: 'retryable_after_recheck:timeout',
    })
    db.close()
  })

  it('fails a terminal-status row closed even when older state flags are inconsistent', async () => {
    const db = makeDb()
    await persistRun(db, memStore([osRow()]), {})
    db.prepare(`
      UPDATE funding_opportunities
         SET is_active=1, is_hidden=0, status='permanently_retired', link_status='broken'
       WHERE id='structured-1'
    `).run()

    await persistRun(db, memStore([osRow()]), {})

    expect(db.prepare('SELECT is_active,is_hidden,status,link_status FROM funding_opportunities WHERE id=?')
      .get('structured-1')).toEqual({
      is_active: 0,
      is_hidden: 1,
      status: 'permanently_retired',
      link_status: 'broken',
    })
    db.close()
  })
})
