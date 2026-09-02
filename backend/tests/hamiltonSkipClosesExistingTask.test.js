/**
 * A pre-task-creation SKIP must CLOSE an already-existing idle task, not
 * leave it frozen. automateSingleSource's eligibility/pointer skips return
 * BEFORE ensureApplicationTask, so an existing task's updated_at never moved —
 * and the scheduler picks tasks ORDER BY updated_at ASC LIMIT 5, so the same
 * skipped tasks headed the queue on every tick forever. Measured in prod
 * 2026-08-24: the same 5 grants.gov tasks (updated_at 2026-08-03) were
 * re-picked every 5 minutes for three weeks — "tick { processed: 5 }" — while
 * 192 ready tasks behind them were never attempted once.
 *
 * The honest durable state for an existing idle task whose source the policy
 * refuses is CANCELLED with the refusal named (the eligibility gate's own
 * posture: the task IS the "In Progress" card, and an ineligible application
 * must not show). Cancelling also rotates the queue.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'c'.repeat(64)

// The skip under test fires before any pathway is reached; keep them inert.
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

// The policy verdict is the input under test — drive both skip codes.
const assessMock = vi.fn(async () => ({ ok: true }))
vi.mock('../services/hamilton/hamiltonFundingSourcePolicy.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, assessHamiltonFundingSource: (...args) => assessMock(...args) }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const {
  ensureApplicationTask, getApplicationTask, listTaskEvents, updateApplicationTask, _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')

const PROFILE = 'profile-skip-close'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, display_name TEXT
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, description TEXT,
      opportunity_kind TEXT, application_url TEXT, source_url TEXT, evidence_url TEXT
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
  return db
}

async function seedFixture(db) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
    .run(PROFILE, 'owner-1', 'Skip Close Fixture')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Skip', last_name: 'Close' }))
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')
    .run('opp-1', 'Title X Family Planning Services Grants', 'Federal NOFO.', 'https://portal.fixture.org/apply')
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')
    .run('opp-other', 'Unrelated Scholarship', 'Different source.', 'https://portal.fixture.org/other')
}

async function seedTask(db, { opportunityId = 'opp-1', status = 'ready_to_start' } = {}) {
  const task = await ensureApplicationTask(db, {
    profileId: PROFILE,
    opportunityId,
    automationType: 'portal',
    initialStatus: 'queued',
  })
  if (status !== 'queued') {
    await updateApplicationTask(db, task.id, { status })
  }
  return task
}

beforeEach(() => {
  assessMock.mockReset()
  assessMock.mockResolvedValue({ ok: true })
})

describe('a pre-task-creation skip closes the existing idle task', () => {
  it('ineligible_profile CANCELS an existing ready_to_start task and reports it', async () => {
    const db = makeDb()
    await seedFixture(db)
    const task = await seedTask(db)

    assessMock.mockResolvedValue({
      code: 'funding_source_profile_rejected',
      reasons: ['entity type mismatch: nonprofit-only NOFO'],
    })
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'owner-1',
      source: { opportunity_id: 'opp-1' },
    })

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('ineligible_profile')
    expect(result.closed_tasks).toEqual([task.id])

    const after = await getApplicationTask(db, task.id)
    expect(after.status).toBe('cancelled')
    expect(after.last_agent_message).toMatch(/closed the task|GrantFlow evidence required/i)
    const events = await listTaskEvents(db, task.id)
    expect(events.some((e) => e.event_type === 'cancelled')).toBe(true)
  })

  it('pointer_research_lead CANCELS the existing task with the research-lead message', async () => {
    const db = makeDb()
    await seedFixture(db)
    const task = await seedTask(db)

    assessMock.mockResolvedValue({
      code: 'pointer_research_lead',
      handoff: { next_step: 'research the directory' },
    })
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'owner-1',
      source: { opportunity_id: 'opp-1' },
    })

    expect(result.reason).toBe('pointer_research_lead')
    expect(result.closed_tasks).toEqual([task.id])
    const after = await getApplicationTask(db, task.id)
    expect(after.status).toBe('cancelled')
    expect(after.last_agent_message).toMatch(/research lead/i)
  })

  it('rotates the scheduler queue: a closed task no longer matches the pickable predicate', async () => {
    const db = makeDb()
    await seedFixture(db)
    const task = await seedTask(db)

    assessMock.mockResolvedValue({ code: 'funding_source_profile_rejected', reasons: [] })
    await automateSingleSource(db, { profileId: PROFILE, userId: 'owner-1', source: { opportunity_id: 'opp-1' } })

    // The adapter's selection predicate (hamiltonAgentAdapter.js) — the closed
    // task must not be re-picked on the next tick.
    const nowIso = new Date(Date.now() + 1000).toISOString()
    const picked = await db.prepare(`
      SELECT id FROM application_tasks
       WHERE (status IN ('queued','ready','analyzing','ready_to_start')
          OR (status IN ('waiting_for_login','waiting_for_2fa','waiting_for_captcha','waiting_for_email_verification','waiting_for_window')
              AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
          OR (status = 'blocked'
              AND next_retry_at IS NOT NULL AND next_retry_at <= ?))
       ORDER BY updated_at ASC
    `).all(nowIso, nowIso)
    expect(picked.map((r) => r.id)).not.toContain(task.id)
  })

  it('closes drafted waiting_for_review work when the source fails policy', async () => {
    const db = makeDb()
    await seedFixture(db)
    const task = await seedTask(db, { status: 'waiting_for_review' })

    assessMock.mockResolvedValue({ code: 'funding_source_profile_rejected', reasons: [] })
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'owner-1',
      source: { opportunity_id: 'opp-1' },
    })

    expect(result.closed_tasks).toEqual([task.id])
    const after = await getApplicationTask(db, task.id)
    expect(after.status).toBe('cancelled')
  })

  it('never touches a task for a DIFFERENT source', async () => {
    const db = makeDb()
    await seedFixture(db)
    const other = await seedTask(db, { opportunityId: 'opp-other' })

    assessMock.mockResolvedValue({ code: 'funding_source_profile_rejected', reasons: [] })
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'owner-1',
      source: { opportunity_id: 'opp-1' },
    })

    expect(result.closed_tasks).toEqual([])
    const after = await getApplicationTask(db, other.id)
    expect(after.status).toBe('ready_to_start')
  })

  it('with no existing task the skip return keeps its shape (closed_tasks empty)', async () => {
    const db = makeDb()
    await seedFixture(db)

    assessMock.mockResolvedValue({ code: 'funding_source_profile_rejected', reasons: ['r1'] })
    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'owner-1',
      source: { opportunity_id: 'opp-1' },
    })

    expect(result).toMatchObject({
      task: null,
      skipped: true,
      reason: 'ineligible_profile',
      closed_tasks: [],
    })
    expect(result.policy.code).toBe('funding_source_profile_rejected')
  })

  it('an UNRESOLVABLE source (opportunity AND grant rows purged) closes the dangling task before the 422 throw', async () => {
    // The freeze this guards against, measured in prod 2026-08-31: the 5
    // oldest-updated eligible tasks all pointed at purged source rows, the
    // throw fired before any row update, and ORDER BY updated_at ASC LIMIT 5
    // re-picked exactly those 5 on every scheduler tick — 241 eligible tasks
    // (incl. 30 past-due waiting_for_window) were never attempted.
    const db = makeDb()
    await seedFixture(db)
    const task = await seedTask(db)
    await db.prepare('DELETE FROM funding_opportunities WHERE id = ?').run('opp-1')

    let thrown = null
    try {
      await automateSingleSource(db, { profileId: PROFILE, userId: 'owner-1', source: { opportunity_id: 'opp-1' } })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeTruthy()
    expect(thrown.code).toBe('unresolvable_funding_source')
    expect(thrown.status).toBe(422)
    expect(thrown.closed_tasks).toEqual([task.id])

    const after = await getApplicationTask(db, task.id)
    expect(after.status).toBe('cancelled')
    expect(after.last_agent_message).toMatch(/no longer exists/i)

    // And the queue rotates: the cancelled task no longer matches the
    // adapter's pickable predicate.
    const nowIso = new Date(Date.now() + 1000).toISOString()
    const picked = await db.prepare(`
      SELECT id FROM application_tasks
       WHERE (status IN ('queued','ready','analyzing','ready_to_start')
          OR (status IN ('waiting_for_login','waiting_for_2fa','waiting_for_captcha','waiting_for_email_verification','waiting_for_window')
              AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
          OR (status = 'blocked'
              AND next_retry_at IS NOT NULL AND next_retry_at <= ?))
    `).all(nowIso, nowIso)
    expect(picked.map((r) => r.id)).not.toContain(task.id)
  })

  it('unresolvable-source close cancels drafted waiting_for_review work', async () => {
    const db = makeDb()
    await seedFixture(db)
    const task = await seedTask(db, { status: 'waiting_for_review' })
    await db.prepare('DELETE FROM funding_opportunities WHERE id = ?').run('opp-1')

    let thrown = null
    try {
      await automateSingleSource(db, { profileId: PROFILE, userId: 'owner-1', source: { opportunity_id: 'opp-1' } })
    } catch (err) {
      thrown = err
    }
    expect(thrown?.code).toBe('unresolvable_funding_source')
    expect(thrown?.closed_tasks).toEqual([task.id])
    const after = await getApplicationTask(db, task.id)
    expect(after.status).toBe('cancelled')
  })
})
