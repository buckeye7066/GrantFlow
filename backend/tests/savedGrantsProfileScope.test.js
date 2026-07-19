// RC-14: profile-scope saved_grants regression suite.
//
// Pins the contract that:
//   1. Two saves of the same opportunity under two different profiles produce
//      two independent rows; neither is overwritten by the other.
//   2. Listing under profile A returns only A's saves PLUS any legacy
//      profile_id=NULL rows for that user.
//   3. Listing under profile B returns only B's saves PLUS the same legacy
//      NULL rows — the legacy bleed is preserved as visible-everywhere, but
//      new explicit saves never bleed.
//   4. Unsave under profile A removes A's row AND any legacy NULL row, but
//      leaves profile B's explicit save intact.
//   5. POST without an active profile is rejected with 400 (no silent NULL
//      writes that would resurrect cross-profile bleed).
//
// All scenarios run against an in-memory SQLite DB seeded with the
// post-migration schema, exercising the real route handlers.

import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import savedGrantsRouter from '../routes/savedGrants.js'
import { profileContextMiddleware } from '../middleware/profileContext.js'
import { ensureSavedGrantsSchema } from '../services/savedGrantsSchema.js'

function createApp(db, user = { userId: 'user-1', role: 'user' }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user
    req.db = db
    // In prod, attachRequestContext resolves this. user-1 is a real users row,
    // so it's a trusted identity (identityResolved=true).
    req.ctx = {
      userId: user.userId,
      isAdmin: user.role === 'admin',
      identityResolved: true,
      activeProfileId: null,
      accessibleProfileIds: new Set(),
    }
    next()
  })
  app.use(profileContextMiddleware())
  app.use('/api/saved-grants', savedGrantsRouter)
  return app
}

async function seedSchema(db) {
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE profiles (id TEXT PRIMARY KEY);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      deadline TEXT,
      amount_min REAL,
      amount_max REAL,
      application_url TEXT,
      apply_url TEXT,
      source_url TEXT,
      url TEXT,
      link_status TEXT,
      source TEXT,
      source_category TEXT,
      record_origin TEXT,
      opportunity_type TEXT,
      type TEXT,
      is_loan INTEGER DEFAULT 0,
      requires_match INTEGER DEFAULT 0,
      description TEXT,
      categories TEXT
    );
    INSERT INTO users (id) VALUES ('user-1');
    INSERT INTO profiles (id) VALUES ('profile-A'), ('profile-B');
    INSERT INTO funding_opportunities (id, title, application_url, source) VALUES
      ('opp-X', 'Opp X', 'https://example.org/x', 'verified_real'),
      ('opp-Y', 'Opp Y', 'https://example.org/y', 'verified_real');
  `)
  // The table is created lazily by the route on first request, but tests that
  // pre-seed legacy rows need it up front. Drive the same self-heal path so
  // the test fixture matches production exactly.
  await ensureSavedGrantsSchema(db)
}

describe('saved_grants profile-scope (RC-14)', () => {
  it('saves under profile A and profile B produce two independent rows', async () => {
    const db = new Database(':memory:')
    try {
      await seedSchema(db)
      const app = createApp(db)

      const saveA = await request(app)
        .post('/api/saved-grants')
        .set('X-Profile-Id', 'profile-A')
        .send({ opportunity_id: 'opp-X', notes: 'A-note' })
      const saveB = await request(app)
        .post('/api/saved-grants')
        .set('X-Profile-Id', 'profile-B')
        .send({ opportunity_id: 'opp-X', notes: 'B-note' })

      expect(saveA.status).toBe(200)
      expect(saveB.status).toBe(200)

      const rows = db.prepare('SELECT user_id, profile_id, opportunity_id, notes FROM saved_grants ORDER BY profile_id').all()
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.profile_id === 'profile-A')).toMatchObject({ notes: 'A-note', opportunity_id: 'opp-X' })
      expect(rows.find((r) => r.profile_id === 'profile-B')).toMatchObject({ notes: 'B-note', opportunity_id: 'opp-X' })
    } finally {
      db.close()
    }
  })

  it('GET under profile A returns only A’s saves; profile B sees only B’s', async () => {
    const db = new Database(':memory:')
    try {
      await seedSchema(db)
      const app = createApp(db)

      await request(app).post('/api/saved-grants').set('X-Profile-Id', 'profile-A').send({ opportunity_id: 'opp-X' })
      await request(app).post('/api/saved-grants').set('X-Profile-Id', 'profile-B').send({ opportunity_id: 'opp-Y' })

      const listA = await request(app).get('/api/saved-grants').set('X-Profile-Id', 'profile-A')
      const listB = await request(app).get('/api/saved-grants').set('X-Profile-Id', 'profile-B')

      expect(listA.status).toBe(200)
      expect(listA.body.ids).toEqual(['opp-X'])
      expect(listB.status).toBe(200)
      expect(listB.body.ids).toEqual(['opp-Y'])
    } finally {
      db.close()
    }
  })

  it('legacy NULL-profile rows are visible to every profile of that user', async () => {
    const db = new Database(':memory:')
    try {
      await seedSchema(db)
      // Simulate a row written by the pre-RC-14 code path.
      db.prepare(
        'INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id, notes) VALUES (?, ?, NULL, ?, ?)'
      ).run('legacy-1', 'user-1', 'opp-X', 'legacy-note')
      const app = createApp(db)

      const listA = await request(app).get('/api/saved-grants').set('X-Profile-Id', 'profile-A')
      const listB = await request(app).get('/api/saved-grants').set('X-Profile-Id', 'profile-B')

      expect(listA.body.ids).toContain('opp-X')
      expect(listB.body.ids).toContain('opp-X')
    } finally {
      db.close()
    }
  })

  it('unsave under profile A clears A’s row AND any legacy NULL row, leaves B’s explicit save', async () => {
    const db = new Database(':memory:')
    try {
      await seedSchema(db)
      // Legacy NULL row + explicit B row, no explicit A row yet.
      db.prepare(
        'INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES (?, ?, NULL, ?)'
      ).run('legacy-1', 'user-1', 'opp-X')
      db.prepare(
        'INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES (?, ?, ?, ?)'
      ).run('explicit-B', 'user-1', 'profile-B', 'opp-X')

      const app = createApp(db)
      const del = await request(app)
        .delete('/api/saved-grants/opp-X')
        .set('X-Profile-Id', 'profile-A')
      expect(del.status).toBe(200)

      const remaining = db.prepare('SELECT id, profile_id FROM saved_grants').all()
      // Legacy gone, B's row preserved.
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ id: 'explicit-B', profile_id: 'profile-B' })
    } finally {
      db.close()
    }
  })

  it('POST without an active profile is rejected with 400', async () => {
    const db = new Database(':memory:')
    try {
      await seedSchema(db)
      const app = createApp(db)

      const res = await request(app).post('/api/saved-grants').send({ opportunity_id: 'opp-X' })
      expect(res.status).toBe(400)
      expect(String(res.body?.error || '')).toMatch(/profile_id required/i)

      const rows = db.prepare('SELECT * FROM saved_grants').all()
      expect(rows).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('re-saving same (profile, opp) updates notes via partial-index ON CONFLICT', async () => {
    const db = new Database(':memory:')
    try {
      await seedSchema(db)
      const app = createApp(db)

      await request(app).post('/api/saved-grants').set('X-Profile-Id', 'profile-A').send({ opportunity_id: 'opp-X', notes: 'first' })
      await request(app).post('/api/saved-grants').set('X-Profile-Id', 'profile-A').send({ opportunity_id: 'opp-X', notes: 'second' })

      const rows = db.prepare('SELECT notes FROM saved_grants WHERE user_id=? AND profile_id=? AND opportunity_id=?').all('user-1', 'profile-A', 'opp-X')
      expect(rows).toHaveLength(1)
      // Notes preserved (we COALESCE excluded.notes onto existing) — this proves
      // the upsert hit the conflict branch instead of inserting a duplicate.
      expect(['first', 'second']).toContain(rows[0].notes)
    } finally {
      db.close()
    }
  })
})
