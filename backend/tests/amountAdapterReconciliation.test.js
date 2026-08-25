import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

import {
  AMOUNT_ADAPTER_RECONCILIATION_KV_KEY,
  enforceGrantDirectAmountEnrichment,
  reconcileBurnedAmountAdapters,
} from '../startup/enforceInvariants.js'
import { AMOUNT_ADAPTER_REGISTRY_VERSION } from '../services/sources/amountAdapters.js'
import { PIPELINE_ACTIVE_STATUSES } from '../config/pipelineValue.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, source_url TEXT, application_url TEXT,
      evidence_url TEXT, source TEXT, source_id TEXT, record_origin TEXT,
      amount_min REAL, amount_max REAL, amount_status TEXT, amount_text TEXT,
      amount_enrich_attempted_at TEXT, amount_enrich_attempts INTEGER,
      amount_enrich_env_attempts INTEGER, amount_enrich_last_reason TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, status TEXT,
      funding_opportunity_id TEXT, title TEXT, url TEXT, application_url TEXT,
      amount_min REAL, amount_max REAL, amount_requested REAL,
      amount_status TEXT, amount_text TEXT, amount_confidence REAL,
      amount_enrich_attempted_at TEXT, amount_enrich_attempts INTEGER,
      amount_enrich_env_attempts INTEGER, amount_enrich_last_reason TEXT
    );
    CREATE TABLE profiles (id TEXT PRIMARY KEY, created_by TEXT);
  `)
  return db
}

describe('versioned amount-adapter reconciliation', () => {
  it('reopens legacy burns newly owned by adapters across both answer stores, once per registry version', async () => {
    const db = makeDb()
    try {
      const insertFo = db.prepare(`
        INSERT INTO funding_opportunities
          (id, title, source_url, amount_status, amount_enrich_attempted_at,
           amount_enrich_attempts, amount_enrich_env_attempts, amount_enrich_last_reason)
        VALUES (?, ?, ?, 'not_listed', '2026-08-20T00:00:00Z', 3, 2, 'thin_page')`)
      insertFo.run(
        'etf',
        'East Tennessee Foundation',
        'https://www.easttennesseefoundation.org/nonprofits/apply-for-grants/',
      )
      insertFo.run('unowned', 'Unowned Program', 'https://unowned.example/program')

      const insertGrant = db.prepare(`
        INSERT INTO grants
          (id, title, url, amount_status, amount_enrich_attempted_at,
           amount_enrich_attempts, amount_enrich_env_attempts, amount_enrich_last_reason)
        VALUES (?, ?, ?, 'not_listed', '2026-08-20T00:00:00Z', 3, 2, 'thin_page')`)
      insertGrant.run('mtsu', 'Dr. Nancy Wahl Scholarship', 'https://www.mtsu.edu/csc/scholarships/')
      insertGrant.run('grant-unowned', 'Unowned Grant', 'https://unowned.example/grant')

      const first = await reconcileBurnedAmountAdapters(db)
      expect(first).toMatchObject({ reopened: 2, version: AMOUNT_ADAPTER_REGISTRY_VERSION })
      expect(db.prepare('SELECT amount_enrich_attempted_at, amount_enrich_attempts, amount_enrich_env_attempts, amount_enrich_last_reason FROM funding_opportunities WHERE id = ?').get('etf')).toMatchObject({
        amount_enrich_attempted_at: null,
        amount_enrich_attempts: 0,
        amount_enrich_env_attempts: 0,
        amount_enrich_last_reason: `adapter_registry_v${AMOUNT_ADAPTER_REGISTRY_VERSION}_reopened`,
      })
      expect(db.prepare('SELECT amount_enrich_attempted_at FROM grants WHERE id = ?').get('mtsu').amount_enrich_attempted_at).toBeNull()
      expect(db.prepare('SELECT amount_enrich_attempted_at FROM funding_opportunities WHERE id = ?').get('unowned').amount_enrich_attempted_at).not.toBeNull()
      expect(db.prepare('SELECT amount_enrich_attempted_at FROM grants WHERE id = ?').get('grant-unowned').amount_enrich_attempted_at).not.toBeNull()

      const marker = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_ADAPTER_RECONCILIATION_KV_KEY).value)
      expect(marker).toMatchObject({ version: AMOUNT_ADAPTER_REGISTRY_VERSION, reopened: 2 })

      // A source that honestly produces no per-award number may burn again.
      // The same registry version must not reopen it forever on every boot.
      db.prepare("UPDATE funding_opportunities SET amount_enrich_attempted_at = '2026-08-25T00:00:00Z' WHERE id = 'etf'").run()
      const second = await reconcileBurnedAmountAdapters(db)
      expect(second).toMatchObject({ reopened: 0, skipped: 'current' })
      expect(db.prepare('SELECT amount_enrich_attempted_at FROM funding_opportunities WHERE id = ?').get('etf').amount_enrich_attempted_at).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('passes the grant title to listing-page amount adapters', async () => {
    const db = makeDb()
    try {
      db.prepare('INSERT INTO profiles (id, created_by) VALUES (?, ?)').run('real-profile', 'user:owner')
      db.prepare(`
        INSERT INTO grants
          (id, profile_id, status, title, url, amount_status, amount_enrich_attempts,
           amount_enrich_env_attempts)
        VALUES (?, ?, ?, ?, ?, 'not_listed', 0, 0)
      `).run(
        'listing-grant',
        'real-profile',
        PIPELINE_ACTIVE_STATUSES[0],
        'Dr. Nancy Wahl Scholarship',
        'https://www.mtsu.edu/csc/scholarships/',
      )
      const enrichImpl = vi.fn(async () => ({
        found: true,
        page_read: true,
        amounts: {
          amount_min: 1_000,
          amount_max: 1_000,
          amount_text: '$1,000',
          amount_status: 'fixed',
          amount_confidence: 0.95,
        },
      }))

      const result = await enforceGrantDirectAmountEnrichment(db, {
        enrichImpl,
        limit: 1,
        envReprobeLimit: 0,
        reclaimLimit: 1,
      })

      expect(result.ok).toBe(true)
      expect(enrichImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          source_url: 'https://www.mtsu.edu/csc/scholarships/',
          title: 'Dr. Nancy Wahl Scholarship',
        }),
        expect.any(Object),
      )
    } finally {
      db.close()
    }
  })
})
