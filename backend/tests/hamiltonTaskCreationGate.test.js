/**
 * Hamilton task-CREATION eligibility gate (2026-08-03, the Robert White class):
 * ~200 auto-populated application cards landed on a student profile, including
 * UNCF / Hispanic Scholarship Fund / Society of Women Engineers / veteran and
 * disability programs the profile's KNOWN facts exclude. The policy check ran
 * only inside the autopilot run — AFTER ensureApplicationTask — so an
 * engine-REJECTED source still became an "In Progress" card.
 *
 * Pins:
 *   1. A source whose stored (surfaced) engine verdict is REJECT is refused
 *      BEFORE a task row exists — automateSingleSource returns
 *      { skipped, reason: 'ineligible_profile' } and application_tasks stays
 *      empty.
 *   2. G4 still holds — a REVIEW verdict (or no verdict at all) ADMITS the
 *      source: missing profile facts are neutral, review is an allowed
 *      decision, and the task is created exactly as before.
 *   3. A source whose ids resolve to NOTHING is refused with
 *      code 'unresolvable_funding_source' instead of persisting a task that
 *      renders as a permanent "Untitled application" card (320 in prod).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

// Keep the post-creation pathways tame: preflight passes, the browser engine
// is a stub. The gate under test runs BEFORE either is reached.
vi.mock('../services/hamilton/hamiltonAutopilotEngine.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    runAutopilot: vi.fn(async () => ({
      status: 'completed_draft',
      filled_fields: [],
      pages_visited: 1,
      trace: [],
    })),
  }
})
vi.mock('../services/hamilton/hamiltonPreflight.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    preflightSingleSource: vi.fn(async () => ({ ok: true, blockers: [], warnings: [] })),
  }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const { _resetSchemaCache } = await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-creation-gate'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      created_by TEXT,
      display_name TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      description TEXT,
      application_url TEXT,
      source_url TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      application_url TEXT,
      status TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT,
      opportunity_id TEXT,
      match_score REAL,
      match_decision TEXT,
      match_explanation TEXT,
      matcher_version TEXT,
      updated_at DATETIME,
      computed_at DATETIME
    );
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return db
}

async function seedFixture(db) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
    .run(PROFILE, 'user-1', 'Robert Michael White')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Robert', last_name: 'White', email: 'r@example.org' }))
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')
    .run('opp-restricted', 'UNCF Scholarship', 'Apply through the portal.', 'https://portal.uncf-fixture.org/apply')
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title, application_url) VALUES (?, ?, ?, ?, ?)')
    .run('g-restricted', PROFILE, 'opp-restricted', 'UNCF Scholarship', 'https://portal.uncf-fixture.org/apply')
}

async function taskCount(db) {
  try {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM application_tasks').get()
    return Number(row?.n ?? 0)
  } catch {
    // The store creates its schema lazily on first ensureApplicationTask —
    // a refusal BEFORE any task was ever created leaves no table at all,
    // which is the strongest possible "zero tasks".
    return 0
  }
}

async function storeDecision(db, decision) {
  await db.prepare(`
    INSERT INTO profile_opportunity_matches
      (profile_id, opportunity_id, match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at)
    VALUES (?, ?, ?, ?, ?, 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(PROFILE, 'opp-restricted', decision === 'reject' ? 1 : 8, decision, 'test verdict')
}

describe('Hamilton task-creation eligibility gate', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await seedFixture(db)
  })

  it('REFUSES to create a task for a source the engine REJECTED for this profile', async () => {
    await storeDecision(db, 'reject')
    const r = await automateSingleSource(db, {
      profileId: PROFILE,
      source: { grant_id: 'g-restricted' },
    })
    expect(r.skipped).toBe(true)
    expect(r.reason).toBe('ineligible_profile')
    expect(r.task).toBeNull()
    expect(r.policy?.code).toBe('funding_source_profile_rejected')
    expect(await taskCount(db)).toBe(0)
  })

  it('still ADMITS a REVIEW verdict — missing facts stay neutral (G4)', async () => {
    await storeDecision(db, 'review')
    const r = await automateSingleSource(db, {
      profileId: PROFILE,
      source: { grant_id: 'g-restricted' },
    })
    expect(r.skipped).not.toBe(true)
    expect(r.task?.id).toBeTruthy()
    expect(await taskCount(db)).toBe(1)
  })

  it('still ADMITS a source with NO stored verdict at all', async () => {
    const r = await automateSingleSource(db, {
      profileId: PROFILE,
      source: { grant_id: 'g-restricted' },
    })
    expect(r.skipped).not.toBe(true)
    expect(r.task?.id).toBeTruthy()
    expect(await taskCount(db)).toBe(1)
  })

  it('REFUSES ids that resolve to nothing instead of minting an "Untitled application"', async () => {
    let err = null
    try {
      await automateSingleSource(db, {
        profileId: PROFILE,
        source: { grant_id: 'g-vanished', opportunity_id: 'opp-vanished' },
      })
    } catch (e) { err = e }
    expect(err?.code).toBe('unresolvable_funding_source')
    expect(err?.status).toBe(422)
    expect(await taskCount(db)).toBe(0)
  })
})
