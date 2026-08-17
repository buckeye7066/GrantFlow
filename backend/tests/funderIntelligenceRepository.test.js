import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  FunderIntelligenceError,
  getFunderIntelligence,
} from '../services/funderIntel/funderIntelligenceRepository.js'

const EIN = '131684331'
const OBJECT_ID = '202513219349106006'
const databases = []

function makeDb({ schema = true } = {}) {
  const raw = new Database(':memory:')
  databases.push(raw)
  if (schema) {
    raw.exec(`
      CREATE TABLE grant_transactions (
        id TEXT PRIMARY KEY, funder_ein TEXT NOT NULL, funder_name TEXT,
        recipient_name TEXT NOT NULL, recipient_ein TEXT, recipient_city TEXT,
        recipient_state TEXT, recipient_country TEXT, amount NUMERIC, purpose TEXT,
        tax_year INTEGER, form_type TEXT, source_object_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE funder_990_ingest_state (
        funder_ein TEXT PRIMARY KEY, attempted_at DATETIME, attempts INTEGER DEFAULT 0,
        env_attempts INTEGER DEFAULT 0, last_reason TEXT, ingested_object_id TEXT,
        tax_year INTEGER, transactions_found INTEGER, updated_at DATETIME
      );
    `)
  }
  return { raw, db: wrapSqlite(raw) }
}

afterEach(() => {
  while (databases.length) databases.pop().close()
})

function seed(raw) {
  const insert = raw.prepare(`
    INSERT INTO grant_transactions (
      id, funder_ein, funder_name, recipient_name, recipient_state, amount,
      purpose, tax_year, form_type, source_object_id, created_at
    ) VALUES (?, ?, 'Ford Foundation', ?, ?, ?, ?, ?, '990PF', ?, ?)
  `)
  insert.run('tx-1', EIN, 'Housing Alliance', 'TN', 100, 'Rental assistance', 2024, OBJECT_ID, '2026-08-01T10:00:00.000Z')
  insert.run('tx-2', EIN, 'Housing Alliance', 'TN', 300, 'Shelter services', 2024, OBJECT_ID, '2026-08-01T10:00:00.000Z')
  insert.run('tx-3', EIN, 'Food Network', 'OH', 500, 'Food access', 2024, OBJECT_ID, '2026-08-01T10:00:00.000Z')
  insert.run('tx-4', EIN, 'Community Clinic', 'TN', 1100, 'Health care', 2023, OBJECT_ID, '2026-08-01T10:00:00.000Z')
  raw.prepare(`
    INSERT INTO funder_990_ingest_state (
      funder_ein, attempted_at, last_reason, ingested_object_id, tax_year,
      transactions_found, updated_at
    ) VALUES (?, ?, 'parsed', ?, 2024, 4, ?)
  `).run(EIN, '2026-08-01T10:01:00.000Z', OBJECT_ID, '2026-08-01T10:02:00.000Z')
}

describe('canonical persisted funder-intelligence read model', () => {
  it('returns transaction summaries, recipient patterns, trends, and filing provenance', async () => {
    const { raw, db } = makeDb()
    seed(raw)
    const intelligence = await getFunderIntelligence(db, { ein: EIN, limit: 2 })

    expect(intelligence.data_state).toBe('available')
    expect(intelligence.historical_evidence_only).toBe(true)
    expect(intelligence.summary).toMatchObject({
      transaction_count: 4,
      total_amount: 2000,
      average_amount: 500,
      median_amount: 400,
      minimum_amount: 100,
      maximum_amount: 1100,
    })
    expect(intelligence.amount_trends.map((row) => row.tax_year)).toEqual([2024, 2023])
    expect(intelligence.recipient_patterns.top_recipients[0]).toMatchObject({
      recipient_name: 'Community Clinic',
      total_amount: 1100,
    })
    expect(intelligence.recipient_patterns.recipient_states[0]).toMatchObject({
      recipient_state: 'TN',
      grant_count: 3,
      total_amount: 1500,
    })
    expect(intelligence.page).toEqual({ limit: 2, offset: 0, returned: 2, total: 4 })
    expect(intelligence.filing_provenance[0]).toMatchObject({
      source_object_id: OBJECT_ID,
      retrieved_at: '2026-08-01T10:02:00.000Z',
      retrieval_basis: 'funder_990_ingest_state.updated_at',
    })
    expect(intelligence.filing_provenance[0].filing_xml_url).toContain(OBJECT_ID)
  })

  it('applies state/year filters to both transaction pages and aggregate claims', async () => {
    const { raw, db } = makeDb()
    seed(raw)
    const intelligence = await getFunderIntelligence(db, {
      ein: EIN,
      recipientState: 'tn',
      taxYear: 2024,
    })
    expect(intelligence.summary.transaction_count).toBe(2)
    expect(intelligence.summary.total_amount).toBe(400)
    expect(intelligence.summary.median_amount).toBe(200)
    expect(intelligence.transactions.every((row) => row.recipient_state === 'TN' && row.tax_year === 2024)).toBe(true)

    const noMatches = await getFunderIntelligence(db, {
      ein: EIN,
      recipientState: 'CA',
      taxYear: 2024,
    })
    expect(noMatches.data_state).toBe('no_matches')
    expect(noMatches.ledger_transaction_count).toBe(4)
    expect(noMatches.summary.transaction_count).toBe(0)
  })

  it('returns an honest not-ingested state when the ledger schema is unavailable', async () => {
    const { db } = makeDb({ schema: false })
    const intelligence = await getFunderIntelligence(db, { ein: EIN })
    expect(intelligence.schema_available).toBe(false)
    expect(intelligence.data_state).toBe('not_ingested')
    expect(intelligence.transactions).toEqual([])
  })

  it('rejects malformed EINs rather than constructing a source URL from them', async () => {
    const { db } = makeDb()
    await expect(getFunderIntelligence(db, { ein: 'not-an-ein' })).rejects.toBeInstanceOf(FunderIntelligenceError)
  })
})
