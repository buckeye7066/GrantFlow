import express from 'express'
import request from 'supertest'
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import billingRouter from '../routes/billing.js'

// Tables the rich /accounts query joins against — shaped like the REAL
// schema.sql, NOT a convenient fiction. `applicant_type` lives on
// `organizations` (reached via profiles.organization_id); `profiles` has
// `primary_type`/`status` but NO `applicant_type`. A prior fixture invented a
// `profiles.applicant_type` column, so the rich query passed in tests while
// throwing `column p.applicant_type does not exist` in prod (silent fallback).
function baseSchema(sqlite) {
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, user_id TEXT, organization_id TEXT,
      display_name TEXT, primary_type TEXT, status TEXT
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, applicant_type TEXT
    );
    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY, profile_id TEXT, section_key TEXT, data TEXT
    );
  `)
}

function makeApp(sqlite) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { role: 'admin', userId: 'admin-1', email: 'admin@example.com' }
    req.ctx = { isAdmin: true, userId: 'admin-1' }
    req.db = sqlite
    next()
  })
  app.use('/api/billing', billingRouter)
  return app
}

describe('GET /api/billing/accounts', () => {
  it('returns 200 with an empty array when there are no accounts', async () => {
    const sqlite = new Database(':memory:')
    try {
      baseSchema(sqlite)
      const res = await request(makeApp(sqlite)).get('/api/billing/accounts')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    } finally {
      sqlite.close()
    }
  })

  it('backfills the enable_* tier flag columns on a pre-existing (drifted) billing_tiers, no 500', async () => {
    const sqlite = new Database(':memory:')
    try {
      baseSchema(sqlite)
      // Simulate an OLD billing_tiers created before the feature-flag columns —
      // this is what made the rich query throw "column does not exist" -> 500.
      sqlite.exec(`
        CREATE TABLE billing_tiers (
          id TEXT PRIMARY KEY, name TEXT, description TEXT,
          base_monthly_cents INTEGER, hourly_rate_cents INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `)

      const res = await request(makeApp(sqlite)).get('/api/billing/accounts')
      expect(res.status).toBe(200)

      const cols = new Set(sqlite.prepare('PRAGMA table_info(billing_tiers)').all().map((r) => r.name))
      expect(cols.has('enable_pipeline_automation')).toBe(true)
      expect(cols.has('enable_item_funding')).toBe(true)
      expect(cols.has('enable_document_ai')).toBe(true)
    } finally {
      sqlite.close()
    }
  })

  it('returns the account with profile metadata via the rich query', async () => {
    const sqlite = new Database(':memory:')
    try {
      baseSchema(sqlite)
      const app = makeApp(sqlite)
      // First call creates + seeds the billing schema (tiers include 'foundation').
      await request(app).get('/api/billing/accounts')

      // applicant_type comes from the linked organization, not the profile.
      sqlite.prepare("INSERT INTO organizations (id, name, applicant_type) VALUES (?, ?, ?)")
        .run('o1', 'Acme Org', 'nonprofit')
      sqlite.prepare("INSERT INTO profiles (id, organization_id, display_name, primary_type, status) VALUES (?, ?, ?, ?, ?)")
        .run('p1', 'o1', 'Acme Org', 'nonprofit', 'active')
      sqlite.prepare("INSERT INTO billing_accounts (id, profile_id, tier_id, discount_type) VALUES (?, ?, ?, ?)")
        .run('acct1', 'p1', 'foundation', 'none')

      const res = await request(app).get('/api/billing/accounts')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].profile_name).toBe('Acme Org')
      // profile_status is ONLY selected by the rich query — proves the rich
      // path executed (the org JOIN resolved) instead of the resilient fallback.
      expect(res.body[0].profile_status).toBe('active')
    } finally {
      sqlite.close()
    }
  })

  it('never 500s — falls back to a resilient query when profile columns/tables are missing', async () => {
    const sqlite = new Database(':memory:')
    try {
      // profiles WITHOUT primary_type/applicant_type and NO profile_sections table:
      // the rich query throws; the handler must fall back and still return the account.
      sqlite.exec(`CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT);`)
      const app = makeApp(sqlite)
      await request(app).get('/api/billing/accounts') // seed schema

      sqlite.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p1', 'Fallback Org')
      sqlite.prepare("INSERT INTO billing_accounts (id, profile_id, tier_id, discount_type) VALUES (?, ?, ?, ?)")
        .run('acct1', 'p1', 'foundation', 'none')

      const res = await request(app).get('/api/billing/accounts')
      expect(res.status).toBe(200) // never 500
      expect(res.body).toHaveLength(1)
      expect(res.body[0].profile_name).toBe('Fallback Org')
    } finally {
      sqlite.close()
    }
  })
})
