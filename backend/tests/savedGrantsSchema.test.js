import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import savedGrantsRouter from '../routes/savedGrants.js'

describe('saved grants schema repair', () => {
  it('GET /api/saved-grants creates missing saved_grants table instead of returning 500', async () => {
    const db = new Database(':memory:')
    try {
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
          link_status TEXT,
          source TEXT,
          source_category TEXT,
          is_loan INTEGER DEFAULT 0,
          requires_matching_funds INTEGER DEFAULT 0,
          description TEXT,
          categories TEXT
        );
      `)

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        req.user = { userId: 'user-1', role: 'user' }
        req.db = db
        next()
      })
      app.use('/api/saved-grants', savedGrantsRouter)

      const response = await request(app).get('/api/saved-grants')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({ saved: [], ids: [] })
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saved_grants'").get()
      expect(table?.name).toBe('saved_grants')
    } finally {
      db.close()
    }
  })
})
