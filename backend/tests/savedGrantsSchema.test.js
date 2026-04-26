import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import savedGrantsRouter from '../routes/savedGrants.js'

function createSavedGrantsApp(db, user = { userId: 'user-1', role: 'user' }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user
    req.db = db
    next()
  })
  app.use('/api/saved-grants', savedGrantsRouter)
  return app
}

function createFundingOpportunitiesWithoutLinkStatus(db) {
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      deadline TEXT,
      amount_min REAL,
      amount_max REAL,
      application_url TEXT,
      source TEXT,
      source_category TEXT,
      is_loan INTEGER DEFAULT 0,
      requires_matching_funds INTEGER DEFAULT 0,
      description TEXT,
      categories TEXT
    );
  `)
}

describe('saved grants schema repair', () => {
  it('GET /api/saved-grants creates missing saved_grants table instead of returning 500', async () => {
    const db = new Database(':memory:')
    try {
      createFundingOpportunitiesWithoutLinkStatus(db)

      const app = createSavedGrantsApp(db)

      const response = await request(app).get('/api/saved-grants')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({ saved: [], ids: [] })
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saved_grants'").get()
      expect(table?.name).toBe('saved_grants')
    } finally {
      db.close()
    }
  })

  it('GET /api/saved-grants returns one saved grant when funding_opportunities lacks link_status', async () => {
    const db = new Database(':memory:')
    try {
      createFundingOpportunitiesWithoutLinkStatus(db)
      db.exec(`
        CREATE TABLE saved_grants (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          opportunity_id TEXT NOT NULL,
          saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          notes TEXT DEFAULT NULL,
          UNIQUE(user_id, opportunity_id)
        );
        INSERT INTO funding_opportunities (id, title, sponsor, application_url, source, description, categories)
        VALUES ('opp-1', 'Real Grant', 'Real Funder', 'https://example.org/apply', 'verified_real', 'A real grant.', '["grant"]');
        INSERT INTO saved_grants (id, user_id, opportunity_id, notes)
        VALUES ('saved-1', 'user-1', 'opp-1', 'Follow up');
      `)
      const app = createSavedGrantsApp(db)

      const response = await request(app).get('/api/saved-grants')

      expect(response.status).toBe(200)
      expect(response.body.ids).toEqual(['opp-1'])
      expect(response.body.saved).toHaveLength(1)
      expect(response.body.saved[0]).toMatchObject({
        opportunity_id: 'opp-1',
        title: 'Real Grant',
        link_status: 'unknown',
        notes: 'Follow up',
      })
    } finally {
      db.close()
    }
  })

  it('POST then GET /api/saved-grants round-trips multiple grants with a valid shape', async () => {
    const db = new Database(':memory:')
    try {
      createFundingOpportunitiesWithoutLinkStatus(db)
      db.exec(`
        INSERT INTO users (id) VALUES ('user-1');
        INSERT INTO funding_opportunities (id, title, sponsor, application_url, source, description, categories)
        VALUES
          ('opp-1', 'Real Grant One', 'Real Funder', 'https://example.org/apply-1', 'verified_real', 'A real grant.', '["grant"]'),
          ('opp-2', 'Real Grant Two', 'Real Funder', 'https://example.org/apply-2', 'verified_real', 'Another real grant.', '["grant"]');
      `)
      const app = createSavedGrantsApp(db)

      const firstSave = await request(app)
        .post('/api/saved-grants')
        .send({ opportunity_id: 'opp-1', notes: 'First' })
      const secondSave = await request(app)
        .post('/api/saved-grants')
        .send({ opportunity_id: 'opp-2', notes: 'Second' })
      const list = await request(app).get('/api/saved-grants')

      expect(firstSave.status).toBe(200)
      expect(secondSave.status).toBe(200)
      expect(list.status).toBe(200)
      expect(list.body.ids.sort()).toEqual(['opp-1', 'opp-2'])
      expect(list.body.saved).toHaveLength(2)
      expect(list.body.saved.every((row) => row.link_status === 'unknown')).toBe(true)
      expect(list.body.saved.every((row) => row.actionable_url)).toBe(true)
    } finally {
      db.close()
    }
  })
})
