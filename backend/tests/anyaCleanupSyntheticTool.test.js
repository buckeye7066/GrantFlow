/**
 * owner.cleanup_synthetic_profiles — Anya deletes Amy's synthetic crawler-
 * training profiles on demand. Delegates to the guarded cleanupAmyProfiles, so
 * it only ever removes Amy's own tagged rows. Owner-gated.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { invokeTool } from '../services/anyaToolRegistry.js'
import { createAmyProfile, markProfileCrawled, listAmyProfiles } from '../services/amy/amyProfileStore.js'
import { generateScenarios } from '../services/amy/syntheticProfileCatalog.js'
import { ADMIN_EMAIL } from '../config/constants.js'

const OWNER = ADMIN_EMAIL

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT,
      status TEXT DEFAULT 'active', tags TEXT DEFAULT '[]',
      created_by TEXT, created_at TEXT, updated_at TEXT, last_discovery_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL, section_key TEXT NOT NULL, data TEXT NOT NULL,
      updated_by TEXT, created_at TEXT, updated_at TEXT, UNIQUE(profile_id, section_key)
    );
    CREATE TABLE anya_tool_usage (
      id TEXT PRIMARY KEY, tool_name TEXT, session_id TEXT, user_id TEXT,
      profile_id TEXT, parameters TEXT, success INTEGER, error_message TEXT,
      execution_time_ms INTEGER
    );
    -- A REAL profile that must NEVER be touched by the cleanup.
    INSERT INTO profiles (id, display_name, created_by, status) VALUES ('real-1', 'Real Person', 'user', 'active');
  `)
  return db
}

const ownerCtx = (db) => ({ db, ctx: { isAdmin: true, email: OWNER, userId: 'owner1' }, user: { role: 'admin', email: OWNER } })

describe('owner.cleanup_synthetic_profiles', () => {
  it('deletes ALL of Amy\'s synthetic profiles (crawled or not) but never a real profile', async () => {
    const db = createDb()
    try {
      const scenarios = generateScenarios({ runId: 'amy-del', targetCount: 3 })
      const crawled = await createAmyProfile(db, scenarios[0], { runId: 'amy-del', ttlHours: 48 })
      await markProfileCrawled(db, crawled.profileId, { floor: 72 })
      await createAmyProfile(db, scenarios[1], { runId: 'amy-del', ttlHours: 48 }) // never crawled
      await createAmyProfile(db, scenarios[2], { runId: 'amy-del', ttlHours: 48 }) // never crawled

      // Dry run first — reports the count without deleting.
      const { output: preview } = await invokeTool('owner.cleanup_synthetic_profiles', { dryRun: true }, ownerCtx(db))
      expect(preview.dry_run).toBe(true)
      expect(preview.deleted).toBe(3)
      expect((await listAmyProfiles(db)).length).toBe(3) // nothing actually removed

      // Real delete — all three Amy profiles gone.
      const { output } = await invokeTool('owner.cleanup_synthetic_profiles', {}, ownerCtx(db))
      expect(output.deleted).toBe(3)
      expect((await listAmyProfiles(db)).length).toBe(0)

      // The real profile is untouched.
      const real = db.prepare("SELECT id FROM profiles WHERE id = 'real-1'").get()
      expect(real).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('onlyCrawled=true keeps never-crawled profiles', async () => {
    const db = createDb()
    try {
      const scenarios = generateScenarios({ runId: 'amy-del2', targetCount: 2 })
      const crawled = await createAmyProfile(db, scenarios[0], { runId: 'amy-del2', ttlHours: 48 })
      await markProfileCrawled(db, crawled.profileId, { floor: 60 })
      await createAmyProfile(db, scenarios[1], { runId: 'amy-del2', ttlHours: 48 }) // never crawled

      const { output } = await invokeTool('owner.cleanup_synthetic_profiles', { onlyCrawled: true }, ownerCtx(db))
      expect(output.deleted).toBe(1)
      const remaining = await listAmyProfiles(db)
      expect(remaining.length).toBe(1)
      expect(Boolean(remaining[0].metadata?.crawled_at)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('is rejected for a non-owner admin (owner gate before handler)', async () => {
    const db = createDb()
    try {
      await expect(
        invokeTool('owner.cleanup_synthetic_profiles', {}, {
          db,
          ctx: { isAdmin: true, email: 'other-admin@example.com', userId: 'u2' },
          user: { role: 'admin', email: 'other-admin@example.com' },
        }),
      ).rejects.toThrow(/owner account/i)
    } finally {
      db.close()
    }
  })
})
