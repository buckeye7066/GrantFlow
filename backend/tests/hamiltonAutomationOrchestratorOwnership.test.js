/**
 * Cross-tenant ownership gate on automateSingleSource() — the third such gap
 * found this session. loadProfileBundle() is a bare `WHERE id = ?` with no
 * user_id check, and automateSingleSource() received a `userId` parameter but
 * never used it for authorization before creating an application_tasks row
 * (and, downstream, generating PII-carrying application packets). Any caller
 * that reaches this function with an attacker-controlled { userId, profileId }
 * pair — bypassing whatever route-level check exists elsewhere — could create
 * tasks and packets for a profile it does not own.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'c'.repeat(64)

// Keep the post-gate pathways tame, mirroring hamiltonTaskCreationGate.test.js
// — the gate under test runs BEFORE either is reached.
vi.mock('../services/hamilton/hamiltonAutopilotEngine.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    runAutopilot: vi.fn(async () => ({
      status: 'completed_draft', filled_fields: [], pages_visited: 1, trace: [],
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

// The ownership boundary is the subject of this suite. Four-truth policy has
// its own functional tests and is admitted here only after ownership succeeds.
vi.mock('../services/hamilton/hamiltonFundingSourcePolicy.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    assessHamiltonFundingSource: vi.fn(async () => ({ ok: true, reasons: [] })),
  }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  automateSingleSource,
  HAMILTON_INTERNAL_CALLER,
} = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const { _resetSchemaCache } = await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-ownership-gate'
const OWNER_USER_ID = 'owner-user-1'
const STRANGER_USER_ID = 'stranger-user-2'
const ADMIN_USER_ID = 'admin-user-3'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, display_name TEXT, primary_type TEXT
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, description TEXT,
      opportunity_kind TEXT, application_url TEXT, source_url TEXT, evidence_url TEXT,
      entity_types_allowed TEXT, source TEXT, record_origin TEXT,
      source_trust_tier TEXT, reality_status TEXT, is_active INTEGER
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,
      application_url TEXT, status TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT,
      match_explanation TEXT, matcher_version TEXT, updated_at DATETIME, computed_at DATETIME
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0);
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return db
}

async function seedFixture(db) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES (?, ?, ?, ?)')
    .run(PROFILE, OWNER_USER_ID, 'Someone Else Entirely', 'college_student')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Someone', last_name: 'Else', email: 'owner@example.org', profile_category: 'college_student' }))
  await db.prepare(`INSERT INTO funding_opportunities
    (id, title, description, opportunity_kind, application_url, source_url,
     entity_types_allowed, source, record_origin, source_trust_tier, reality_status, is_active)
    VALUES (?, ?, ?, 'direct_grant', ?, ?, ?, 'curated_verified', 'curated_verified', 'official', 'real', 1)`)
    .run(
      'opp-1',
      'Test Scholarship',
      'Apply through the portal.',
      'https://www.mtsu.edu/scholarships/apply',
      'https://www.mtsu.edu/scholarships/apply',
      JSON.stringify(['student', 'individual']),
    )
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title, application_url) VALUES (?, ?, ?, ?, ?)')
    .run('g-1', PROFILE, 'opp-1', 'Test Scholarship', 'https://www.mtsu.edu/scholarships/apply')
  await db.prepare(`INSERT INTO profile_opportunity_matches
    (profile_id, opportunity_id, match_score, match_decision, matcher_version, updated_at, computed_at)
    VALUES (?, ?, 90, 'accept', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .run(PROFILE, 'opp-1')
  await db.prepare('INSERT INTO users (id, is_admin) VALUES (?, ?)').run(ADMIN_USER_ID, 1)
  await db.prepare('INSERT INTO users (id, is_admin) VALUES (?, ?)').run(STRANGER_USER_ID, 0)
}

async function taskCount(db) {
  try {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM application_tasks').get()
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

describe('automateSingleSource — cross-tenant ownership gate', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await seedFixture(db)
  })

  it('REFUSES a userId that does not own, create, or share an email with the profile', async () => {
    let err = null
    try {
      await automateSingleSource(db, {
        profileId: PROFILE,
        userId: STRANGER_USER_ID,
        source: { grant_id: 'g-1' },
      })
    } catch (e) { err = e }

    expect(err).toBeTruthy()
    expect(err.status).toBe(403)
    expect(err.code).toBe('profile_access_denied')
    // No task, and no PII packet pathway, was ever reached for the stranger.
    expect(await taskCount(db)).toBe(0)
  })

  it('ADMITS the profile owner', async () => {
    const r = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: OWNER_USER_ID,
      source: { grant_id: 'g-1' },
    })
    expect(r.skipped).not.toBe(true)
    expect(r.task?.id).toBeTruthy()
    expect(await taskCount(db)).toBe(1)
  })

  it('ADMITS a DB-confirmed admin even though they do not own the profile', async () => {
    const r = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: ADMIN_USER_ID,
      source: { grant_id: 'g-1' },
    })
    expect(r.skipped).not.toBe(true)
    expect(r.task?.id).toBeTruthy()
    expect(await taskCount(db)).toBe(1)
  })

  it('REFUSES a missing user without the in-process adapter capability', async () => {
    await expect(automateSingleSource(db, {
      profileId: PROFILE,
      userId: null,
      source: { grant_id: 'g-1' },
    })).rejects.toMatchObject({
      status: 403,
      code: 'profile_access_denied',
    })
    expect(await taskCount(db)).toBe(0)
  })

  it('ADMITS the scheduler/adapter only with its unforgeable in-process capability', async () => {
    const r = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: null,
      internalCaller: HAMILTON_INTERNAL_CALLER,
      source: { grant_id: 'g-1' },
    })
    expect(r.skipped).not.toBe(true)
    expect(r.task?.id).toBeTruthy()
  })
})
