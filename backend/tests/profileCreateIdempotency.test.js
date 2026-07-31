import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

const profilesRouter = (await import('../routes/profiles.js')).default

/**
 * POST /api/profiles ownership contract (multi-profile, migration 160/0164).
 *
 * History, because both halves are load-bearing:
 *  - 2026-07-13: the route 500'd in prod ("duplicate key ... ux_profiles_user_id")
 *    because auth email-verify auto-creates a fallback shell profile, making the
 *    user's explicit first create a SECOND owned profile. Fix: adopt the shell.
 *  - 2026-07-31 (owner directive "combine account types"): one login may own
 *    MANY profiles — personal + farm + business + students. ux_profiles_user_id
 *    is gone; the anti-duplicate job moved to ux_profiles_user_display
 *    (user_id, LOWER(display_name)). Adoption now happens ONLY for a same-name
 *    re-submit or the sectionless signup shell. The pre-160 behavior of
 *    adopting ANY existing owned profile silently RENAMED the user's personal
 *    profile when they created "Anita's Farm" — that corruption is pinned
 *    below so it cannot return.
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
    CREATE UNIQUE INDEX ux_profiles_user_display
      ON profiles(user_id, LOWER(display_name))
      WHERE user_id IS NOT NULL;
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
      const isOwnedPrecheck =
        normalized.startsWith('select p.id, p.display_name') && normalized.includes('where p.user_id = ?')
      // (the per-profile shell check runs profile_id-scoped SELECTs against
      // profile_sections; those are never blinded)
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => {
          // Race simulation: the owned-profiles pre-check misses once, so the
          // INSERT hits the real unique index and the catch has to adopt the
          // same-name winner's row.
          if (hidePrecheckOnce && !precheckHidden && isOwnedPrecheck) {
            precheckHidden = true
            return []
          }
          return stmt.all(...args)
        },
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

// user-1 is a real users row, so requestContext resolves a trusted identity.
const ENDUSER_CTX = { userId: 'user-1', isAdmin: false, identityResolved: true, email: 'dupe@example.test' }

afterEach(() => {
  delete process.env.MAX_OWNED_PROFILES
})

describe('POST /api/profiles ownership contract (multi-profile per user)', () => {
  it('first explicit create ADOPTS the sectionless signup shell', async () => {
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

  it('a SAME-NAME retry is idempotent: one profile, one signup application, no stacked free trial', async () => {
    const raw = createRawDb()
    try {
      const app = createApp(wrapDb(raw), ENDUSER_CTX)
      const first = await request(app).post('/api/profiles').send({ display_name: 'Joshua Dasher' })
      expect(first.status).toBe(201)
      const freeUntilAfterFirst = raw
        .prepare(`SELECT free_until FROM billing_accounts WHERE profile_id = 'profile-shell'`)
        .get()?.free_until

      // Exact same name (case-insensitively) — the network-retry shape.
      const second = await request(app).post('/api/profiles').send({ display_name: 'joshua dasher' })
      expect(second.status).toBe(201)
      expect(second.body.id).toBe('profile-shell')
      expect(second.body.adopted_existing).toBe(true)

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

  it('a DIFFERENT-NAME create makes an ADDITIONAL owned profile and never touches the first', async () => {
    const raw = createRawDb()
    try {
      const app = createApp(wrapDb(raw), ENDUSER_CTX)
      // First create fills the shell with the personal identity.
      const personal = await request(app)
        .post('/api/profiles')
        .send({ display_name: 'Anita Mayes', primary_type: 'individual_need' })
      expect(personal.status).toBe(201)
      expect(personal.body.id).toBe('profile-shell')

      // Second create is a different applicant identity: her farm.
      const farm = await request(app)
        .post('/api/profiles')
        .send({ display_name: "Anita's Farm", primary_type: 'farm' })
      expect(farm.status).toBe(201)
      expect(farm.body.adopted_existing).toBeUndefined()
      expect(farm.body.id).not.toBe('profile-shell')

      const owned = raw
        .prepare(`SELECT id, display_name, primary_type FROM profiles WHERE user_id = 'user-1' ORDER BY created_at, id`)
        .all()
      expect(owned).toHaveLength(2)

      // THE PRE-160 CORRUPTION, pinned: the personal profile must be intact —
      // the old unconditional adopt RENAMED it to "Anita's Farm".
      const personalRow = owned.find((r) => r.id === 'profile-shell')
      expect(personalRow.display_name).toBe('Anita Mayes')
      expect(personalRow.primary_type).toBe('individual_need')

      // The farm profile is fully initialized (canonical sections backfilled).
      const farmSections = raw
        .prepare('SELECT COUNT(*) AS n FROM profile_sections WHERE profile_id = ?')
        .get(farm.body.id).n
      expect(farmSections).toBeGreaterThan(0)
    } finally {
      raw.close()
    }
  })

  it('a later create adopts by NAME even when other owned profiles exist', async () => {
    const raw = createRawDb()
    try {
      const app = createApp(wrapDb(raw), ENDUSER_CTX)
      await request(app).post('/api/profiles').send({ display_name: 'Anita Mayes' })
      const farm = await request(app).post('/api/profiles').send({ display_name: "Anita's Farm" })
      // Retry of the farm create converges on the farm row, not the personal one.
      const retry = await request(app).post('/api/profiles').send({ display_name: "anita's farm" })
      expect(retry.status).toBe(201)
      expect(retry.body.id).toBe(farm.body.id)
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE user_id = 'user-1'`).get().n).toBe(2)
    } finally {
      raw.close()
    }
  })

  it('enforces MAX_OWNED_PROFILES with a 409, admins exempt', async () => {
    const raw = createRawDb()
    try {
      process.env.MAX_OWNED_PROFILES = '2'
      const app = createApp(wrapDb(raw), ENDUSER_CTX)
      await request(app).post('/api/profiles').send({ display_name: 'Personal' })
      await request(app).post('/api/profiles').send({ display_name: 'Farm' })
      const third = await request(app).post('/api/profiles').send({ display_name: 'Bakery' })
      expect(third.status).toBe(409)
      expect(third.body.error).toMatch(/limit/i)
      // A same-name re-submit still adopts even at the cap (idempotency survives).
      const retry = await request(app).post('/api/profiles').send({ display_name: 'Farm' })
      expect(retry.status).toBe(201)
      expect(retry.body.adopted_existing).toBe(true)
    } finally {
      raw.close()
    }
  })

  it('adopts the winner when a concurrent SAME-NAME create loses the unique-index race (no 500)', async () => {
    const raw = createRawDb()
    try {
      // The shell already carries the name the racing request submits, and the
      // pre-check is blinded once — the INSERT collides with
      // ux_profiles_user_display and the catch must adopt the winner.
      raw.prepare(`UPDATE profiles SET display_name = 'Racing Dasher' WHERE id = 'profile-shell'`).run()
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
