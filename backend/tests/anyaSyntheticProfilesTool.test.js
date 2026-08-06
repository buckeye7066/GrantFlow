/**
 * owner.list_synthetic_profiles — Anya's internal window into Amy's synthetic
 * crawler-training profiles. The owner-facing /api/profiles list HIDES
 * created_by='agent:amy'; this tool lets Anya answer "which profiles did Amy
 * create" (she previously reported she could not locate any). Owner-gated.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { invokeTool } from '../services/anyaToolRegistry.js'
import { createAmyProfile, markProfileCrawled } from '../services/amy/amyProfileStore.js'
import { generateScenarios } from '../services/amy/syntheticProfileCatalog.js'
import { ADMIN_EMAIL } from '../config/constants.js'

const OWNER = ADMIN_EMAIL

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(profile_id, section_key)
    );
    CREATE TABLE anya_tool_usage (
      id TEXT PRIMARY KEY, tool_name TEXT, session_id TEXT, user_id TEXT,
      profile_id TEXT, parameters TEXT, success INTEGER, error_message TEXT,
      execution_time_ms INTEGER
    );
  `)
  return db
}

const ownerCtx = (db) => ({ db, ctx: { isAdmin: true, email: OWNER, userId: 'owner1' }, user: { role: 'admin', email: OWNER } })

describe('owner.list_synthetic_profiles', () => {
  it('lists Amy profiles with crawl status + rollup counts, and reports never-crawled', async () => {
    const db = createDb()
    try {
      const scenarios = generateScenarios({ runId: 'amy-list', targetCount: 3 })
      const crawled = await createAmyProfile(db, scenarios[0], { runId: 'amy-list', ttlHours: 48 })
      await markProfileCrawled(db, crawled.profileId, { floor: 72 })
      await createAmyProfile(db, scenarios[1], { runId: 'amy-list', ttlHours: 48 }) // never crawled
      await createAmyProfile(db, scenarios[2], { runId: 'amy-list', ttlHours: 48 }) // never crawled

      const { output } = await invokeTool('owner.list_synthetic_profiles', {}, ownerCtx(db))
      expect(output.created_by).toBe('agent:amy')
      expect(output.summary.total).toBe(3)
      expect(output.summary.crawled).toBe(1)
      expect(output.summary.never_crawled).toBe(2)
      expect(output.profiles).toHaveLength(3)

      const crawledRow = output.profiles.find((p) => p.id === crawled.profileId)
      expect(crawledRow.crawled).toBe(true)
      expect(crawledRow.crawl_count).toBe(1)
      expect(crawledRow.last_crawl_floor).toBe(72)
      expect(typeof crawledRow.age_hours).toBe('number')

      // onlyNeverCrawled filter narrows to the two un-crawled profiles.
      const { output: filtered } = await invokeTool('owner.list_synthetic_profiles', { onlyNeverCrawled: true }, ownerCtx(db))
      expect(filtered.profiles.every((p) => p.crawled === false)).toBe(true)
      expect(filtered.count).toBe(2)
    } finally {
      db.close()
    }
  })

  it('is rejected for a non-owner admin (owner gate before handler)', async () => {
    const db = createDb()
    try {
      await expect(
        invokeTool('owner.list_synthetic_profiles', {}, {
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
