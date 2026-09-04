import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { ingestOpportunities } from '../services/sources/ingestionService.js'

function transactionalDb(raw) {
  const facade = {
    dialect: 'sqlite',
    prepare(sql) {
      const statement = raw.prepare(sql)
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args),
      }
    },
    async withTransaction(fn) {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const result = await fn(facade)
        raw.exec('COMMIT')
        return result
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
    },
  }
  return facade
}

describe('ingestion proof-guard atomicity', () => {
  let raw

  afterEach(() => raw?.close())

  it('rolls back the business insert when the post-write proof guard fails', async () => {
    raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE ingestion_runs (
        id TEXT PRIMARY KEY, source TEXT, started_at TEXT, completed_at TEXT,
        status TEXT, records_fetched INTEGER, records_inserted INTEGER,
        records_updated INTEGER, error_message TEXT
      );
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, source TEXT, source_id TEXT, title TEXT, sponsor TEXT,
        description TEXT, application_url TEXT, source_url TEXT, deadline TEXT,
        deadline_type TEXT, amount_min REAL, amount_max REAL, amount_description TEXT,
        is_national INTEGER, state TEXT, categories TEXT, keywords TEXT,
        eligibility_bullets TEXT, requires_match INTEGER, requires_501c3 INTEGER,
        match_percentage REAL, opportunity_type TEXT, is_active INTEGER,
        raw_source_payload TEXT, last_crawled TEXT, opportunity_kind TEXT,
        source_trust_tier TEXT, reality_status TEXT, reality_reasons TEXT,
        result_kind TEXT, type TEXT, last_verified_at TEXT, link_status TEXT,
        link_status_code INTEGER, verification_method TEXT, verified_by TEXT,
        verification_error TEXT, final_url TEXT, http_status INTEGER,
        is_hidden INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
      );
      CREATE TRIGGER fail_proof_quarantine
      BEFORE UPDATE OF is_hidden ON funding_opportunities
      BEGIN
        SELECT RAISE(ABORT, 'simulated proof guard failure');
      END;
    `)

    const result = await ingestOpportunities(transactionalDb(raw), [{
      id: 'atomic-opp',
      source: 'grants.gov',
      source_id: 'TEST-ATOMIC-1',
      title: 'Community Infrastructure Grant Program',
      sponsor: 'U.S. Department of Agriculture',
      description: 'Competitive grant funding for eligible community infrastructure projects.',
      application_url: 'https://grants.gov/search-results-detail/TEST-ATOMIC-1',
      source_url: 'https://grants.gov/search-results-detail/TEST-ATOMIC-1',
      opportunity_type: 'grant',
      opportunity_kind: 'DIRECT_GRANT',
      is_active: 1,
    }], 'grants.gov')

    expect(result.success).toBe(false)
    expect(result.error).toContain('simulated proof guard failure')
    expect(raw.prepare('SELECT COUNT(*) AS count FROM funding_opportunities').get().count).toBe(0)
    expect(raw.prepare('SELECT status FROM ingestion_runs').get().status).toBe('failed')
  })
})
