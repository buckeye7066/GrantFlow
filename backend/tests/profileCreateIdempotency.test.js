import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

const profilesRouter = (await import('../routes/profiles.js')).default

/**
 * POST /api/profiles used to 500 in prod with "duplicate key value violates
 * unique constraint ux_profiles_user_id" (2026-07-13): auth email-verify
 * auto-creates a fallback shell profile for every new user, so the user's
 * explicit "create profile" was ALWAYS a second owned profile and prod
 * Postgres (which has the unique index — the fresh SQLite schema does not)
 * rejected the INSERT. The route must ADOPT the existing owned profile:
 * apply the submitted identity fields and return 201 with the same id.
 */
function createRawDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      organization_id TEXT,
      user_id TEXT,
      created_by TEXT,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      avatar_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX ux_profiles_user_id ON profiles(user_id) WHERE user_id IS NOT NULL;
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT,
      updated_by TEXT,
      UNIQUE (profile_id, section_key)
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE service_applications (
      id TEXT PRIMARY KEY,
      type TEXT,
      full_name TEXT,
      email TEXT,
      status TEXT,
      profile_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_email TEXT,
      is_admin INTEGER DEFAULT 0
    );
    CREATE TABLE billing_accounts (
      id TEXT PRIMARY KEY,
      profile_id TEXT UNIQUE,
      tier_id TEXT,
      assigned_by TEXT,
      assigned_reason TEXT,
      discount_type TEXT DEFAULT 'none',
      discount_percent REAL DEFAULT 0,
      is_pro_bono INTEGER DEFAULT 0,
      free_until TEXT,
      free_granted_at TEXT,
      free_kind TEXT,
      free_reason TEXT,
      free_notice_pending INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    -- The signup shell auth email-verify creates for every new user.
    INSERT INTO users (id, primary_email) VALUES ('user-1', 'dupe@example.test');
    INSERT INTO profiles (id, display_name, primary_type, user_id)
    VALUES ('profile-shell', 'dupe', 'individual_need', 'user-1');
  `)
  return db
}

function wrapDb(raw, { hidePrecheckOnce = false } = {}) {
  let precheckHidden = false
  const wrapper = {
    dialect: 'sqlite',
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => {
          // Race simulation: the pre-check misses once, so the INSERT hits the
          // real unique index and the catch has to adopt the winner's row.
          if (
            hidePrecheckOnce &&
            !precheckHidden &&
            normalized === 'select id from profiles where user_id = ?'
          ) {
            precheckHidden = true
            return undefined
          }
          return stmt.get(...args)
        },
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      }
    },
    async withTransaction(fn) {
      return fn(wrapper)
    },
  }
  return wrapper
}

function createApp(db, ctx) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.ctx = ctx
    next()
  })
  app.use('/api/profiles', profilesRouter)
  return app
}

const ENDUSER_CTX = { userId: 'user-1', isAdmin: false, email: 'dupe@example.test' }

describe('POST /api/profiles adopts the existing owned profile (ux_profiles_user_id)', () => {
  it('returns 201 with the shell profile id and applies the submitted fields', async () => {
    const raw = createRawDb()
    try {
      const res = await request(createApp(wrapDb(raw), ENDUSER_CTX))
        .post('/api/profiles')
        .send({ display_name: 'Joshua Dasher', primary_type: 'individual_need' })

      expect(res.status).toBe(201)
      expect(res.body.id).toBe('profile-shell')
      expect(res.body.adopted_existing).toBe(true)
      expect(res.body.display_name).toBe('Joshua Dasher')

      const rows = raw.prepare(`SELECT id FROM profiles WHERE user_id = 'user-1'`).all()
      expect(rows).toHaveLength(1)

      // Canonical sections were backfilled onto the shell.
      const sectionCount = raw
        .prepare(`SELECT COUNT(*) AS n FROM profile_sections WHERE profile_id = 'profile-shell'`)
        .get().n
      expect(sectionCount).toBeGreaterThan(0)
    } finally {
      raw.close()
    }
  })

  it('is idempotent: a retry keeps one profile, one signup application, and does not stack the free trial', async () => {
    const raw = createRawDb()
    try {
      const app = createApp(wrapDb(raw), ENDUSER_CTX)
      const first = await request(app).post('/api/profiles').send({ display_name: 'Joshua Dasher' })
      expect(first.status).toBe(201)
      const freeUntilAfterFirst = raw
        .prepare(`SELECT free_until FROM billing_accounts WHERE profile_id = 'profile-shell'`)
        .get()?.free_until

      const second = await request(app).post('/api/profiles').send({ display_name: 'Joshua D. Dasher' })
      expect(second.status).toBe(201)
      expect(second.body.id).toBe('profile-shell')

      expect(raw.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE user_id = 'user-1'`).get().n).toBe(1)
      expect(
        raw
          .prepare(`SELECT COUNT(*) AS n FROM service_applications WHERE profile_id = 'profile-shell' AND type = 'signup'`)
          .get().n,
      ).toBeLessThanOrEqual(1)

      // grantFreePeriod EXTENDS an existing window — the retry must not stack.
      const freeUntilAfterSecond = raw
        .prepare(`SELECT free_until FROM billing_accounts WHERE profile_id = 'profile-shell'`)
        .get()?.free_until
      expect(freeUntilAfterSecond).toBe(freeUntilAfterFirst)
    } finally {
      raw.close()
    }
  })

  it('adopts the winner when a concurrent create loses the unique-index race (no 500)', async () => {
    const raw = createRawDb()
    try {
      const res = await request(createApp(wrapDb(raw, { hidePrecheckOnce: true }), ENDUSER_CTX))
        .post('/api/profiles')
        .send({ display_name: 'Racing Dasher' })

      expect(res.status).toBe(201)
      expect(res.body.id).toBe('profile-shell')
      expect(res.body.adopted_existing).toBe(true)
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE user_id = 'user-1'`).get().n).toBe(1)
    } finally {
      raw.close()
    }
  })

  it('admin creating an UNOWNED profile (no user_id) still inserts a fresh row', async () => {
    const raw = createRawDb()
    try {
      const res = await request(createApp(wrapDb(raw), { userId: 'admin-1', isAdmin: true, email: 'admin@example.test' }))
        .post('/api/profiles')
        .send({ display_name: 'Admin-created client profile' })

      expect(res.status).toBe(201)
      expect(res.body.adopted_existing).toBeUndefined()
      expect(res.body.id).not.toBe('profile-shell')
      const row = raw.prepare('SELECT user_id FROM profiles WHERE id = ?').get(res.body.id)
      expect(row.user_id).toBeNull()
    } finally {
      raw.close()
    }
  })
})
