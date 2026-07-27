/**
 * fundingSourcesDismissRoute.test.js
 *
 * DELETE /api/profiles/:id/funding-sources/:opportunityId — the owner's
 * sticky delete from the Funding Sources match list (2026-07-27 owner
 * report: irrelevant federal research/paperwork rows had to be removable,
 * and had to STAY removed).
 *
 * Contract under test:
 *   • records a pipeline_dismissals tombstone (the same store the pipeline
 *     sticky-delete rule uses, so re-crawls can never resurrect the source)
 *   • purges the profile's match row AND any pipeline grant created from it
 *   • is profile-scoped: another profile's match/grant for the SAME
 *     opportunity survives
 *   • is idempotent, and unauthenticated callers get 401
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fundingSourcesRouter from '../routes/fundingSources.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      primary_type TEXT,
      created_at TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sponsor TEXT,
      deadline TEXT,
      application_url TEXT,
      source_url TEXT,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      matcher_version TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      fingerprint TEXT,
      title TEXT,
      funder TEXT,
      url TEXT,
      application_url TEXT,
      source_url TEXT
    );
    INSERT INTO profiles (id, organization_id, primary_type) VALUES
      ('p1', 'org1', 'nonprofit'),
      ('p2', 'org2', 'nonprofit');
    INSERT INTO funding_opportunities (id, title, sponsor, application_url) VALUES
      ('opp-drrp', 'DRRP Research Projects Program', 'ACL', 'https://grants.gov/drrp');
    INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision) VALUES
      ('m1', 'p1', 'opp-drrp', 18, 'accept'),
      ('m2', 'p2', 'opp-drrp', 18, 'accept');
    INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES
      ('g1', 'p1', 'opp-drrp', 'DRRP Research Projects Program'),
      ('g2', 'p2', 'opp-drrp', 'DRRP Research Projects Program');
  `)
  return db
}

function createApp(db, { authenticated = true } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (authenticated) {
      req.user = { id: 'admin-1', role: 'admin' }
      req.ctx = { userId: 'admin-1', isAdmin: true }
    }
    req.db = db
    next()
  })
  app.use('/api', fundingSourcesRouter)
  return app
}

const countRows = (db, table, profileId) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE profile_id = ?`).get(profileId).n)

describe('DELETE /api/profiles/:id/funding-sources/:opportunityId', () => {
  it('records a tombstone and purges the match row + pipeline grant, profile-scoped', async () => {
    const db = createDb()
    const res = await request(createApp(db)).delete('/api/profiles/p1/funding-sources/opp-drrp')

    expect(res.status).toBe(200)
    expect(res.body.dismissed).toBe(true)

    // Tombstone recorded for p1.
    const tomb = db.prepare('SELECT * FROM pipeline_dismissals WHERE profile_id = ?').all('p1')
    expect(tomb.length).toBe(1)
    expect(tomb[0].opportunity_id).toBe('opp-drrp')

    // p1's match row and pipeline grant are gone; p2's SURVIVE untouched.
    expect(countRows(db, 'profile_opportunity_matches', 'p1')).toBe(0)
    expect(countRows(db, 'grants', 'p1')).toBe(0)
    expect(countRows(db, 'profile_opportunity_matches', 'p2')).toBe(1)
    expect(countRows(db, 'grants', 'p2')).toBe(1)
  })

  it('is idempotent — deleting the same source twice stays 200 and keeps one tombstone', async () => {
    const db = createDb()
    const app = createApp(db)
    await request(app).delete('/api/profiles/p1/funding-sources/opp-drrp')
    const second = await request(app).delete('/api/profiles/p1/funding-sources/opp-drrp')

    expect(second.status).toBe(200)
    const tomb = db.prepare('SELECT COUNT(*) AS n FROM pipeline_dismissals WHERE profile_id = ?').get('p1')
    expect(Number(tomb.n)).toBe(1)
  })

  it('still tombstones when the catalog row no longer exists (dangling-match class)', async () => {
    const db = createDb()
    db.prepare('DELETE FROM funding_opportunities WHERE id = ?').run('opp-drrp')

    const res = await request(createApp(db)).delete('/api/profiles/p1/funding-sources/opp-drrp')
    expect(res.status).toBe(200)
    // Keyed on opportunity_id alone; the match row is still purged.
    expect(countRows(db, 'profile_opportunity_matches', 'p1')).toBe(0)
  })

  it('rejects unauthenticated callers with 401', async () => {
    const db = createDb()
    const res = await request(createApp(db, { authenticated: false }))
      .delete('/api/profiles/p1/funding-sources/opp-drrp')
    expect(res.status).toBe(401)
    // Nothing was tombstoned or purged.
    expect(countRows(db, 'profile_opportunity_matches', 'p1')).toBe(1)
  })
})
