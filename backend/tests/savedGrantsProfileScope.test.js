import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import savedGrantsRouter from '../routes/savedGrants.js'

// RC-14: saved grants must be scoped to the active profile so a user's saves
// never bleed across their profiles, and the same opportunity can be saved
// independently under more than one profile.

function createApp(db, user = { userId: 'user-1', role: 'user' }) {
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

function seedBaseSchema(db) {
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      created_by TEXT
    );
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
    INSERT INTO users (id) VALUES ('user-1'), ('user-2');
    -- user-1 owns profiles A and B; user-2 owns profile X.
    INSERT INTO profiles (id, user_id, created_by) VALUES
      ('prof-A', 'user-1', 'user-1'),
      ('prof-B', 'user-1', 'user-1'),
      ('prof-X', 'user-2', 'user-2');
    INSERT INTO funding_opportunities (id, title, sponsor, application_url, source, description, categories)
    VALUES
      ('opp-1', 'Grant One', 'Funder', 'https://example.org/1', 'verified_real', 'd', '["grant"]'),
      ('opp-2', 'Grant Two', 'Funder', 'https://example.org/2', 'verified_real', 'd', '["grant"]');
  `)
}

describe('saved grants profile scoping (RC-14)', () => {
  it('does not surface a save made under one profile when querying another', async () => {
    const db = new Database(':memory:')
    try {
      seedBaseSchema(db)
      const app = createApp(db)

      const save = await request(app)
        .post('/api/saved-grants')
        .send({ opportunity_id: 'opp-1', profile_id: 'prof-A' })
      expect(save.status).toBe(200)

      const underA = await request(app).get('/api/saved-grants?profile_id=prof-A')
      expect(underA.status).toBe(200)
      expect(underA.body.ids).toEqual(['opp-1'])

      const underB = await request(app).get('/api/saved-grants?profile_id=prof-B')
      expect(underB.status).toBe(200)
      expect(underB.body.ids).toEqual([]) // isolation: A's save must not leak into B
    } finally {
      db.close()
    }
  })

  it('lets the same opportunity be saved independently under two profiles', async () => {
    const db = new Database(':memory:')
    try {
      seedBaseSchema(db)
      const app = createApp(db)

      const a = await request(app)
        .post('/api/saved-grants')
        .send({ opportunity_id: 'opp-1', profile_id: 'prof-A', notes: 'for A' })
      const b = await request(app)
        .post('/api/saved-grants')
        .send({ opportunity_id: 'opp-1', profile_id: 'prof-B', notes: 'for B' })
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)

      // Two distinct rows now exist for the same opportunity (multi-profile).
      const rows = db
        .prepare('SELECT profile_id, notes FROM saved_grants WHERE opportunity_id = ? ORDER BY profile_id')
        .all('opp-1')
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.profile_id)).toEqual(['prof-A', 'prof-B'])

      const underA = await request(app).get('/api/saved-grants?profile_id=prof-A')
      const underB = await request(app).get('/api/saved-grants?profile_id=prof-B')
      expect(underA.body.ids).toEqual(['opp-1'])
      expect(underB.body.ids).toEqual(['opp-1'])
    } finally {
      db.close()
    }
  })

  it('re-saving the same opportunity under the same profile updates rather than duplicates', async () => {
    const db = new Database(':memory:')
    try {
      seedBaseSchema(db)
      const app = createApp(db)

      await request(app).post('/api/saved-grants').send({ opportunity_id: 'opp-1', profile_id: 'prof-A', notes: 'first' })
      await request(app).post('/api/saved-grants').send({ opportunity_id: 'opp-1', profile_id: 'prof-A', notes: 'second' })

      const rows = db.prepare('SELECT notes FROM saved_grants WHERE opportunity_id = ? AND profile_id = ?').all('opp-1', 'prof-A')
      expect(rows).toHaveLength(1)
      expect(rows[0].notes).toBe('second')
    } finally {
      db.close()
    }
  })

  it('rejects saving under a profile the user does not own (403)', async () => {
    const db = new Database(':memory:')
    try {
      seedBaseSchema(db)
      const app = createApp(db) // acting as user-1

      const res = await request(app)
        .post('/api/saved-grants')
        .send({ opportunity_id: 'opp-1', profile_id: 'prof-X' }) // prof-X belongs to user-2
      expect(res.status).toBe(403)

      const count = db.prepare('SELECT COUNT(*) AS n FROM saved_grants').get()
      expect(count.n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('shows legacy (no-profile) saves under every profile as a grace, but not other profiles\' saves', async () => {
    const db = new Database(':memory:')
    try {
      seedBaseSchema(db)
      const app = createApp(db)

      // A legacy save with no profile (profile_id defaults to '').
      await request(app).post('/api/saved-grants').send({ opportunity_id: 'opp-2' })
      // A profile-A scoped save.
      await request(app).post('/api/saved-grants').send({ opportunity_id: 'opp-1', profile_id: 'prof-A' })

      const underA = await request(app).get('/api/saved-grants?profile_id=prof-A')
      const underB = await request(app).get('/api/saved-grants?profile_id=prof-B')

      // A sees its own save + the legacy global one.
      expect(underA.body.ids.sort()).toEqual(['opp-1', 'opp-2'])
      // B sees only the legacy global one, never A's scoped save.
      expect(underB.body.ids).toEqual(['opp-2'])
    } finally {
      db.close()
    }
  })

  it('scoped DELETE only removes the save for the named profile', async () => {
    const db = new Database(':memory:')
    try {
      seedBaseSchema(db)
      const app = createApp(db)

      await request(app).post('/api/saved-grants').send({ opportunity_id: 'opp-1', profile_id: 'prof-A' })
      await request(app).post('/api/saved-grants').send({ opportunity_id: 'opp-1', profile_id: 'prof-B' })

      const del = await request(app).delete('/api/saved-grants/opp-1?profile_id=prof-A')
      expect(del.status).toBe(200)

      const remaining = db.prepare('SELECT profile_id FROM saved_grants WHERE opportunity_id = ?').all('opp-1')
      expect(remaining.map((r) => r.profile_id)).toEqual(['prof-B'])
    } finally {
      db.close()
    }
  })

  it('heals a pre-existing old-shape table (no profile_id, 2-col unique) on first request', async () => {
    const db = new Database(':memory:')
    try {
      seedBaseSchema(db)
      // Simulate the table as it existed before RC-14.
      db.exec(`
        CREATE TABLE saved_grants (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          opportunity_id TEXT NOT NULL,
          saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          notes TEXT DEFAULT NULL,
          UNIQUE(user_id, opportunity_id)
        );
        INSERT INTO saved_grants (id, user_id, opportunity_id, notes)
        VALUES ('legacy-1', 'user-1', 'opp-1', 'kept');
      `)
      const app = createApp(db)

      // Any request triggers ensureSavedGrantsSchema → rebuild.
      const res = await request(app).get('/api/saved-grants')
      expect(res.status).toBe(200)

      const cols = db.prepare('PRAGMA table_info(saved_grants)').all().map((c) => c.name)
      expect(cols).toContain('profile_id')

      const tableSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='saved_grants'")
        .get().sql.replace(/\s+/g, ' ').toLowerCase()
      expect(tableSql).toContain('unique(user_id, profile_id, opportunity_id)')

      // The legacy row survived the rebuild and became a no-profile ('') save.
      const row = db.prepare('SELECT profile_id, notes FROM saved_grants WHERE id = ?').get('legacy-1')
      expect(row).toMatchObject({ profile_id: '', notes: 'kept' })
    } finally {
      db.close()
    }
  })
})
