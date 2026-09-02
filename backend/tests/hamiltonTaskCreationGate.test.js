/**
 * Hamilton task-CREATION positive-proof gate.
 *
 * Pins the production contract at the point where an application task would
 * otherwise become an owner-visible "In Progress" card:
 *   1. REJECT, REVIEW, unknown, and missing canonical decisions create no task.
 *   2. A stored ACCEPT creates a task only when applicant type is explicitly
 *      supported by the source.
 *   3. Unresolvable and pointer-only sources create no task.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

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
      display_name TEXT,
      primary_type TEXT
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
      opportunity_kind TEXT,
      application_url TEXT,
      source_url TEXT,
      evidence_url TEXT,
      entity_types_allowed TEXT
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
  await db.prepare('INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES (?, ?, ?, ?)')
    .run(PROFILE, 'user-1', 'Robert Michael White', 'college_student')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Robert', last_name: 'White', email: 'r@example.org' }))
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url, entity_types_allowed) VALUES (?, ?, ?, ?, ?)')
    .run('opp-restricted', 'UNCF Scholarship', 'Apply through the portal.', 'https://portal.uncf-fixture.org/apply', JSON.stringify(['student', 'individual']))
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title, application_url) VALUES (?, ?, ?, ?, ?)')
    .run('g-restricted', PROFILE, 'opp-restricted', 'UNCF Scholarship', 'https://portal.uncf-fixture.org/apply')
}

async function taskCount(db) {
  try {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM application_tasks').get()
    return Number(row?.n ?? 0)
  } catch {
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

  it('refuses a canonical REJECT before a task row exists', async () => {
    await storeDecision(db, 'reject')
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      source: { grant_id: 'g-restricted' },
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('ineligible_profile')
    expect(result.task).toBeNull()
    expect(result.policy?.code).toBe('funding_source_profile_rejected')
    expect(await taskCount(db)).toBe(0)
  })

  it('refuses a REVIEW because uncertainty is not qualification', async () => {
    await storeDecision(db, 'review')
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      source: { grant_id: 'g-restricted' },
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('funding_source_profile_not_accepted')
    expect(result.task).toBeNull()
    expect(await taskCount(db)).toBe(0)
  })

  it('refuses a source with no stored or live ACCEPT', async () => {
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      source: { grant_id: 'g-restricted' },
    })
    expect(result.skipped).toBe(true)
    expect(result.task).toBeNull()
    expect(await taskCount(db)).toBe(0)
  })

  it('admits a stored ACCEPT when applicant type is positively supported', async () => {
    await storeDecision(db, 'accept')
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      source: { grant_id: 'g-restricted' },
    })
    expect(result.skipped).not.toBe(true)
    expect(result.task?.id).toBeTruthy()
    expect(await taskCount(db)).toBe(1)
  })

  it('refuses ids that resolve to nothing instead of minting an Untitled application', async () => {
    let error = null
    try {
      await automateSingleSource(db, {
        profileId: PROFILE,
        source: { grant_id: 'g-vanished', opportunity_id: 'opp-vanished' },
      })
    } catch (caught) { error = caught }
    expect(error?.code).toBe('unresolvable_funding_source')
    expect(error?.status).toBe(422)
    expect(await taskCount(db)).toBe(0)
  })

  it('returns a research handoff for a URL-less pointer without creating a task', async () => {
    await db.prepare(
      `INSERT INTO funding_opportunities (id, title, description, opportunity_kind)
       VALUES (?, ?, ?, ?)`,
    ).run('opp-pointer', 'County Assistance Directory', 'Research programs listed by the county.', 'directory')
    await db.prepare(
      `INSERT INTO grants (id, profile_id, funding_opportunity_id, title)
       VALUES (?, ?, ?, ?)`,
    ).run('g-pointer', PROFILE, 'opp-pointer', 'County Assistance Directory')

    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      source: { grant_id: 'g-pointer' },
    })

    expect(result).toMatchObject({
      skipped: true,
      reason: 'pointer_research_lead',
      task: null,
      policy: { code: 'pointer_research_lead' },
    })
    expect(result.manual_handoff?.instructions).toMatch(/directory/i)
    expect(result.policy?.handoff?.instructions).toBe(result.manual_handoff?.instructions)
    expect(await taskCount(db)).toBe(0)
  })
})
