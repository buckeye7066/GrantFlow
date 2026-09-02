/**
 * Hamilton task-CREATION positive-proof gate.
 *
 * Pins the production contract at the point where an application task would
 * otherwise become an owner-visible "In Progress" card:
 *   1. REJECT, REVIEW, unknown, and missing canonical decisions create no task.
 *   2. A live ACCEPT creates a task only after all four positive proofs pass;
 *      the stored match is evidence history, never an authorization shortcut.
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
      entity_types_allowed TEXT,
      categories TEXT,
      need_types_supported TEXT,
      link_status TEXT,
      last_verified_at DATETIME,
      source TEXT,
      record_origin TEXT,
      source_trust_tier TEXT,
      reality_status TEXT,
      is_active INTEGER,
      is_national INTEGER
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
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'financial_information', JSON.stringify({ needs: ['education'] }))
  await db.prepare(`INSERT INTO funding_opportunities
    (id, title, description, opportunity_kind, application_url, source_url,
     entity_types_allowed, categories, need_types_supported, link_status,
     last_verified_at, source, record_origin, source_trust_tier, reality_status, is_active,
     is_national)
    VALUES (?, ?, ?, 'direct_grant', ?, ?, ?, ?, ?, 'ok', CURRENT_TIMESTAMP,
            'curated', 'curated_verified', 'official', 'real', 1, 1)`)
    .run(
      'opp-restricted',
      'Federal Pell Grant',
      'Federal need-based education grant for eligible undergraduate students.',
      'https://studentaid.gov/understand-aid/types/grants/pell',
      'https://studentaid.gov/understand-aid/types/grants/pell',
      JSON.stringify(['student', 'family']),
      JSON.stringify(['education']),
      JSON.stringify(['education']),
    )
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title, application_url) VALUES (?, ?, ?, ?, ?)')
    .run('g-restricted', PROFILE, 'opp-restricted', 'Federal Pell Grant', 'https://studentaid.gov/understand-aid/types/grants/pell')
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
    await db.prepare('UPDATE funding_opportunities SET entity_types_allowed = ? WHERE id = ?')
      .run(JSON.stringify(['nonprofit']), 'opp-restricted')
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
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
    await db.prepare(`UPDATE funding_opportunities
      SET title = 'Community Support Award', description = 'Apply through the portal.',
          categories = '[]', need_types_supported = '[]'
      WHERE id = ?`).run('opp-restricted')
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: { grant_id: 'g-restricted' },
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('funding_source_profile_not_accepted')
    expect(result.task).toBeNull()
    expect(await taskCount(db)).toBe(0)
  })

  it('refuses a source with no stored or live ACCEPT', async () => {
    await db.prepare(`UPDATE funding_opportunities
      SET title = 'Community Support Award', description = 'Apply through the portal.',
          categories = '[]', need_types_supported = '[]'
      WHERE id = ?`).run('opp-restricted')
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: { grant_id: 'g-restricted' },
    })
    expect(result.skipped).toBe(true)
    expect(result.task).toBeNull()
    expect(await taskCount(db)).toBe(0)
  })

  it('admits a live ACCEPT only when applicant type, need, and reality proofs are positive', async () => {
    await storeDecision(db, 'accept')
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
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
        userId: 'user-1',
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
      userId: 'user-1',
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
