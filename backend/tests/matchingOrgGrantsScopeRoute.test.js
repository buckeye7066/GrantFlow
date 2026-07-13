import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import matchingRouter from '../routes/matching.js'
import { profileContextMiddleware } from '../middleware/profileContext.js'
import { assertProfileScopedSql } from '../db/scopedQuery.js'

/**
 * End-to-end reproduction of the 2026-07-13 prod 500:
 *   GET /api/matching/profile/:id/grants → ProfileScopeError
 * for a NON-ADMIN user whose profile has an organization_id (the org branch
 * queries grants by organization_id, and the scope guard used to accept only
 * profile_id predicates for the grants tier).
 *
 * The db wrapper mirrors backend/db/index.js: assertProfileScopedSql() runs on
 * every prepare(), and profileContextMiddleware() claims the profile from the
 * URL exactly as prod does.
 */
function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_email TEXT,
      is_admin INTEGER DEFAULT 0
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      applicant_type TEXT,
      organization_id TEXT,
      user_id TEXT,
      created_by TEXT,
      status TEXT,
      state TEXT,
      zip TEXT,
      tags TEXT,
      interests TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT,
      state TEXT,
      city TEXT,
      zip TEXT,
      mission TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      description TEXT,
      eligibility_bullets TEXT DEFAULT '[]',
      amount_min REAL,
      amount_max REAL,
      deadline TEXT,
      deadline_type TEXT,
      is_national INTEGER DEFAULT 1,
      state TEXT,
      keywords TEXT DEFAULT '[]',
      categories TEXT DEFAULT '[]',
      requires_501c3 INTEGER DEFAULT 0,
      requires_match INTEGER DEFAULT 0,
      match_percentage REAL
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      title TEXT,
      funder TEXT,
      status TEXT,
      deadline TEXT,
      notes TEXT,
      funding_opportunity_id TEXT,
      organization_id TEXT,
      profile_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO users (id, primary_email, is_admin)
    VALUES ('user-josh', 'joshua.dasher@example.test', 0);
    INSERT INTO organizations (id, name, state, city, zip)
    VALUES ('org-1', 'Community Ministries Inc', 'OH', 'Columbus', '43215');
    INSERT INTO profiles (id, display_name, primary_type, applicant_type, organization_id, user_id, status, state, zip, tags, interests, created_at, updated_at)
    VALUES ('profile-josh', 'Josh Dasher', 'nonprofit', 'nonprofit', 'org-1', 'user-josh', 'active', 'OH', '43215', '["community"]', '["housing"]', '2026-07-01', '2026-07-01');
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('profile-josh', 'basic_information', '{"state":"OH","zip_code":"43215","profile_category":"nonprofit"}');
    INSERT INTO funding_opportunities (id, title, sponsor, description, deadline_type, amount_min, amount_max, keywords, categories)
    VALUES ('fo-1', 'Community Housing Grant', 'Real Foundation', 'Funding for nonprofits serving community housing needs.', 'rolling', 1000, 5000, '["community","housing"]', '["grant"]');
    INSERT INTO grants (id, title, funder, status, funding_opportunity_id, organization_id, profile_id)
    VALUES ('grant-1', 'Community Housing Grant', 'Real Foundation', 'discovered', 'fo-1', 'org-1', 'profile-josh');
  `)
  return db
}

// Mirror the backend/db/index.js prepare() contract: every SQL statement goes
// through the scope guard before it executes.
function guardedDb(raw) {
  return {
    dialect: 'sqlite',
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      assertProfileScopedSql(sql)
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      }
    },
  }
}

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.ctx = { userId: 'user-josh', isAdmin: false, email: 'joshua.dasher@example.test' }
    req.user = { id: 'user-josh', role: 'enduser', primary_email: 'joshua.dasher@example.test' }
    req.db = db
    next()
  })
  app.use(profileContextMiddleware())
  app.use('/api/matching', matchingRouter)
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err?.name || 'error', message: err?.message })
  })
  return app
}

describe('GET /api/matching/profile/:id/grants — org branch under the scope guard', () => {
  it('does not throw ProfileScopeError for a non-admin org-linked profile', async () => {
    const db = createDb()
    try {
      const response = await request(createApp(guardedDb(db)))
        .get('/api/matching/profile/profile-josh/grants')

      expect(response.body?.error).not.toBe('ProfileScopeError')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    } finally {
      db.close()
    }
  })
})
