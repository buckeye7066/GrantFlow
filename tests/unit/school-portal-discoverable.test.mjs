/**
 * school-portal-discoverable.test.mjs
 *
 * Issue #534 acceptance: "Merged scholarships appear in the user's
 * opportunities list and can be edited or removed."
 *
 * Without the upsertSchoolPortalAwardAsOpportunity helper, an imported
 * TSAC award would only live in the user's profile section
 * (university_applications), invisible to:
 *   - Discover Grants (reads from funding_opportunities)
 *   - The canonical matcher pipeline (matches against funding_opportunities)
 *   - Admin / agent dashboards
 *
 * This test pins the fix: each merged award gets a row in
 * funding_opportunities with record_origin='school_portal', and
 * removing the award from the user's profile cleans up that row.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

import {
  upsertSchoolPortalAwardAsOpportunity,
  removeSchoolPortalAwardOpportunity,
} from '../../backend/services/schoolPortalImportService.js'

async function makeDb() {
  // Best-effort: skip cleanly if better-sqlite3 isn't installed.
  let Database
  try {
    Database = (await import('better-sqlite3')).default
  } catch {
    return null
  }
  const tmpPath = path.join(os.tmpdir(), `gf-school-portal-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  const raw = new Database(tmpPath)
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      record_origin TEXT,
      description TEXT,
      eligibility_bullets TEXT,
      amount_min REAL,
      amount_max REAL,
      amount_description TEXT,
      application_url TEXT,
      apply_url TEXT,
      apply_guidelines_url TEXT,
      application_mode TEXT,
      opportunity_type TEXT,
      opportunity_kind TEXT,
      source_trust_tier TEXT,
      is_active INTEGER,
      last_verified_at DATETIME,
      categories TEXT,
      keywords TEXT
    );
  `)
  return {
    raw,
    cleanup: () => { try { raw.close(); fs.unlinkSync(tmpPath) } catch {} },
    db: {
      dialect: 'sqlite',
      prepare(sql) {
        const stmt = raw.prepare(sql)
        return {
          run: async (...args) => stmt.run(...args),
          get: async (...args) => stmt.get(...args),
          all: async (...args) => stmt.all(...args),
        }
      },
    },
  }
}

const SAMPLE_AWARD = {
  id: 'portal_award_abc123',
  external_id: 'TSAC-HOPE-2026',
  title: 'Tennessee HOPE Scholarship',
  description: 'State scholarship for Tennessee residents',
  amount: 3500,
  amount_display: '$3,500',
  status: 'offered',
  academic_year: '2026-2027',
  source_url: 'https://www.tn.gov/collegepays.html',
  portal_url: 'https://www.tn.gov/collegepays.html',
  provider_id: 'tsac',
  provider_name: 'Tennessee Student Assistance Corporation (TSAC)',
}

const SAMPLE_CONNECTION = {
  id: 'portal_connection_1',
  provider_name: 'Tennessee Student Assistance Corporation (TSAC)',
  portal_url: 'https://www.tn.gov/collegepays.html',
  integration_mode: 'pilot_manual_import',
}

test('upsertSchoolPortalAwardAsOpportunity inserts a funding_opportunities row with record_origin=school_portal', async () => {
  const env = await makeDb()
  if (!env) return // skip if better-sqlite3 not present
  try {
    const ok = await upsertSchoolPortalAwardAsOpportunity(env.db, SAMPLE_AWARD, SAMPLE_CONNECTION)
    assert.equal(ok, true)

    const row = env.raw.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(SAMPLE_AWARD.id)
    assert.ok(row, 'row must be inserted')
    assert.equal(row.record_origin, 'school_portal')
    assert.equal(row.source, 'school_portal')
    assert.equal(row.title, 'Tennessee HOPE Scholarship')
    assert.equal(row.sponsor, 'Tennessee Student Assistance Corporation (TSAC)')
    assert.equal(row.amount_min, 3500)
    assert.equal(row.amount_max, 3500)
    assert.equal(row.opportunity_type, 'scholarship')
    // 'school_portal' is the canonical opportunity_kind per the schema
    // taxonomy ('direct' | 'benefit' | 'directory' | 'referral' | 'school_portal').
    assert.equal(row.opportunity_kind, 'school_portal')
    assert.equal(row.source_trust_tier, 'official_portal')
    assert.equal(row.application_mode, 'portal')
    assert.equal(row.is_active, 1)
    assert.equal(row.application_url, 'https://www.tn.gov/collegepays.html')
  } finally {
    env.cleanup()
  }
})

test('upsertSchoolPortalAwardAsOpportunity is idempotent — second call updates instead of duplicating', async () => {
  const env = await makeDb()
  if (!env) return
  try {
    await upsertSchoolPortalAwardAsOpportunity(env.db, SAMPLE_AWARD, SAMPLE_CONNECTION)
    await upsertSchoolPortalAwardAsOpportunity(
      env.db,
      { ...SAMPLE_AWARD, description: 'Updated description for this scholarship' },
      SAMPLE_CONNECTION,
    )

    const rows = env.raw.prepare('SELECT * FROM funding_opportunities WHERE id = ?').all(SAMPLE_AWARD.id)
    assert.equal(rows.length, 1, 'must NOT duplicate the row on a second upsert')
    assert.match(rows[0].description, /Updated description/)
  } finally {
    env.cleanup()
  }
})

test('removeSchoolPortalAwardOpportunity deletes the funding_opportunities row by id', async () => {
  const env = await makeDb()
  if (!env) return
  try {
    await upsertSchoolPortalAwardAsOpportunity(env.db, SAMPLE_AWARD, SAMPLE_CONNECTION)
    const before = env.raw.prepare('SELECT 1 FROM funding_opportunities WHERE id = ?').get(SAMPLE_AWARD.id)
    assert.ok(before, 'precondition: row exists')

    const removed = await removeSchoolPortalAwardOpportunity(env.db, SAMPLE_AWARD.id)
    assert.equal(removed, true)

    const after = env.raw.prepare('SELECT 1 FROM funding_opportunities WHERE id = ?').get(SAMPLE_AWARD.id)
    assert.equal(after, undefined, 'row must be deleted')
  } finally {
    env.cleanup()
  }
})

test('removeSchoolPortalAwardOpportunity refuses to delete non-school_portal rows (safety net)', async () => {
  const env = await makeDb()
  if (!env) return
  try {
    // Insert a non-school_portal row with the same id (synthetic; should be impossible in prod
    // because IDs are namespaced, but this proves the WHERE source='school_portal' guard works).
    env.raw
      .prepare(`INSERT INTO funding_opportunities (id, title, source, record_origin, is_active) VALUES (?, ?, ?, ?, ?)`)
      .run('not_a_portal_award_xyz', 'Foundation Grant', 'foundation', 'live_crawl', 1)

    const removed = await removeSchoolPortalAwardOpportunity(env.db, 'not_a_portal_award_xyz')
    assert.equal(removed, false, 'must refuse to delete non-school_portal source rows')

    const stillThere = env.raw
      .prepare('SELECT 1 FROM funding_opportunities WHERE id = ?')
      .get('not_a_portal_award_xyz')
    assert.ok(stillThere)
  } finally {
    env.cleanup()
  }
})

test('upsertSchoolPortalAwardAsOpportunity returns false (does NOT throw) when funding_opportunities table is missing', async () => {
  let Database
  try { Database = (await import('better-sqlite3')).default } catch { return }
  const tmpPath = path.join(os.tmpdir(), `gf-school-portal-empty-${Date.now()}.sqlite`)
  const raw = new Database(tmpPath)
  // No funding_opportunities table — graceful degradation must kick in.
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        run: async (...args) => stmt.run(...args),
        get: async (...args) => stmt.get(...args),
        all: async (...args) => stmt.all(...args),
      }
    },
  }
  try {
    const ok = await upsertSchoolPortalAwardAsOpportunity(db, SAMPLE_AWARD, SAMPLE_CONNECTION)
    assert.equal(ok, false, 'must fail soft, not throw')
  } finally {
    raw.close()
    try { fs.unlinkSync(tmpPath) } catch {}
  }
})

test('upsertSchoolPortalAwardAsOpportunity short-circuits on missing required fields', async () => {
  const env = await makeDb()
  if (!env) return
  try {
    assert.equal(await upsertSchoolPortalAwardAsOpportunity(env.db, null, SAMPLE_CONNECTION), false)
    assert.equal(await upsertSchoolPortalAwardAsOpportunity(env.db, { id: 'x' }, SAMPLE_CONNECTION), false) // no title
    assert.equal(await upsertSchoolPortalAwardAsOpportunity(env.db, { title: 'x' }, SAMPLE_CONNECTION), false) // no id
  } finally {
    env.cleanup()
  }
})
