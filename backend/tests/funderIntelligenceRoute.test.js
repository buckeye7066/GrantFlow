import Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import funderIntelligenceRouter from '../routes/funderIntelligence.js'

const databases = []

function makeApp({ authenticated = true } = {}) {
  const raw = new Database(':memory:')
  databases.push(raw)
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
    INSERT INTO grant_transactions (
      id, funder_ein, funder_name, recipient_name, recipient_state, amount,
      purpose, tax_year, form_type, source_object_id
    ) VALUES (
      'tx-1', '131684331', 'Ford Foundation', 'Housing Alliance', 'TN', 50000,
      'Emergency rent assistance', 2024, '990PF', '202513219349106006'
    );
    INSERT INTO funder_990_ingest_state (
      funder_ein, attempted_at, last_reason, ingested_object_id, tax_year,
      transactions_found, updated_at
    ) VALUES (
      '131684331', CURRENT_TIMESTAMP, 'parsed', '202513219349106006', 2024,
      1, CURRENT_TIMESTAMP
    );
  `)
  const app = express()
  app.use((req, _res, next) => {
    req.db = wrapSqlite(raw)
    if (authenticated) req.user = { userId: 'user-1', role: 'user' }
    next()
  })
  app.use('/api/foundations', funderIntelligenceRouter)
  return app
}

afterEach(() => {
  while (databases.length) databases.pop().close()
})

describe('funder intelligence API', () => {
  it('serves the canonical persisted transaction read model', async () => {
    const response = await request(makeApp())
      .get('/api/foundations/131684331/intelligence')
      .expect(200)
    expect(response.body.intelligence).toMatchObject({
      ein: '131684331',
      data_state: 'available',
      historical_evidence_only: true,
      summary: { transaction_count: 1, total_amount: 50000 },
    })
    expect(response.body.intelligence.filing_provenance[0].retrieved_at).toBeTruthy()
  })

  it('rejects malformed EINs and unauthenticated reads', async () => {
    await request(makeApp()).get('/api/foundations/not-an-ein/intelligence').expect(400)
    await request(makeApp({ authenticated: false }))
      .get('/api/foundations/131684331/intelligence')
      .expect(401)
  })
})
