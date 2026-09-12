/**
 * Scheduler early returns must leave a DURABLE, NAMED trace and must rotate the
 * queue (hamilton-submit-4 / -5 / -6, 2026-09-12).
 *
 * Production (2026-09-12 baseline): 2,246 'completed' + 168 'deferred'
 * autopilot runs, 183 ready_to_start tasks never attempted, and the only
 * per-tick telemetry was a log line. Three early returns in the portal path
 * were silent or starving:
 *
 *   -4  the per-profile `hamilton_autopilot` OFF check ran AFTER a run row was
 *       created, so every scheduler pick minted a 'deferred' run and reset the
 *       task to ready_to_start — re-picked next tick, forever.
 *   -5  `complete_forms` not granted reset the task to ready_to_start with NO
 *       reason on the return (the adapter logged `no_run_created`) and paged the
 *       owner with hamilton_task_started on EVERY pass.
 *   -6  a 503 from the funding-source policy threw without touching the task,
 *       so the same ≤5 tasks headed the ORDER BY updated_at queue on every tick
 *       and everything behind them starved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'c'.repeat(64)

vi.mock('../services/hamilton/hamiltonAutopilotEngine.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    runAutopilot: vi.fn(async () => ({ status: 'completed_draft', filled_fields: [], pages_visited: 1, trace: [] })),
  }
})
vi.mock('../services/hamilton/hamiltonPreflight.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, preflightSingleSource: vi.fn(async () => ({ ok: true, blockers: [], warnings: [] })) }
})
const assessMock = vi.fn(async () => ({ ok: true, reasons: [] }))
vi.mock('../services/hamilton/hamiltonFundingSourcePolicy.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, assessHamiltonFundingSource: (...args) => assessMock(...args) }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { runAutopilot } = await import('../services/hamilton/hamiltonAutopilotEngine.js')
const { HamiltonAgentAdapter } = await import('../services/agentControl/agentAdapters/hamiltonAgentAdapter.js')
const {
  ensureApplicationTask, getApplicationTask, listTaskEvents, _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache, recordAuthorizations } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-no-run-accounting'
const OWNER = 'owner-1'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, display_name TEXT, primary_type TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, description TEXT,
      opportunity_kind TEXT, entity_types_allowed TEXT,
      application_url TEXT, source_url TEXT, source TEXT, record_origin TEXT,
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
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), user_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL, data TEXT, read INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP
    );
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return db
}

async function seedProfile(db, { hamiltonAutopilot = true } = {}) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES (?, ?, ?, ?)')
    .run(PROFILE, OWNER, 'Queue Fixture', 'nonprofit')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Queue', last_name: 'Fixture', email: 'q@example.org' }))
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'automation_preferences', JSON.stringify({ automations: { hamilton_autopilot: hamiltonAutopilot } }))
}

async function seedOpportunity(db, id, title = `Portal grant ${id}`) {
  await db.prepare(`INSERT INTO funding_opportunities
    (id, title, description, opportunity_kind, entity_types_allowed, application_url,
     source_url, source, record_origin, source_trust_tier, reality_status, is_active)
    VALUES (?, ?, ?, 'direct_grant', ?, ?, ?, 'curated_verified', 'curated_verified', 'official', 'real', 1)`)
    .run(id, title, 'Apply through the portal.', JSON.stringify(['nonprofit']),
      `https://hamilton-submit-fixture.invalid/apply/${id}`, `https://hamilton-submit-fixture.invalid/apply/${id}`)
}

async function seedTask(db, opportunityId, { updatedAt = null } = {}) {
  const task = await ensureApplicationTask(db, {
    profileId: PROFILE, opportunityId, automationType: 'portal', initialStatus: 'ready_to_start',
  })
  if (updatedAt) await db.prepare('UPDATE application_tasks SET updated_at = ? WHERE id = ?').run(updatedAt, task.id)
  return task
}

async function grantCompleteForms(db) {
  await recordAuthorizations(db, {
    userId: OWNER, profileId: PROFILE, scope: 'profile',
    authorizationTypes: ['complete_forms'],
    authorizationText: 'Test authorization', authorizationVersion: 'hamilton-autopilot-test-v1',
  })
}

const inertSignal = {
  shouldStop: () => false, shouldPause: () => false, isEmergency: () => false,
  heartbeat: async () => {}, recordEvent: async () => {},
}

async function tick(db, batch = 5) {
  return new HamiltonAgentAdapter().start({
    db, controlRunId: null, stepId: null,
    options: { allow_hamilton_autopilot: true, hamilton_batch_size: batch },
    signal: inertSignal,
  })
}

async function runCount(db, taskId) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM hamilton_autopilot_runs WHERE task_id = ?').get(taskId)
  return Number(row?.n) || 0
}

const savedEnv = {}
beforeEach(() => {
  runAutopilot.mockClear()
  assessMock.mockReset()
  assessMock.mockResolvedValue({ ok: true, reasons: [] })
  savedEnv.enabled = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  savedEnv.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
  return () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = savedEnv.enabled
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = savedEnv.allow
  }
})

describe('hamilton-submit-4: a profile with hamilton_autopilot OFF mints no run rows and leaves the immediate-pick set', () => {
  it('two scheduler ticks → 0 autopilot runs, a named no_run reason, and a parked task with a future retry', async () => {
    const db = makeDb()
    await seedProfile(db, { hamiltonAutopilot: false })
    await seedOpportunity(db, 'opp-off')
    await grantCompleteForms(db)
    const task = await seedTask(db, 'opp-off')

    const first = await tick(db)
    expect(first.summary.queue_selected).toBe(1)
    expect(first.summary.no_run).toBe(1)
    expect(first.summary.no_run_reasons).toMatch(/hamilton_autopilot_disabled/)
    expect(await runCount(db, task.id)).toBe(0)
    expect(runAutopilot).not.toHaveBeenCalled()

    const parked = await getApplicationTask(db, task.id)
    expect(parked.status).toBe('waiting_for_user')
    expect(parked.next_retry_at).toBeTruthy()
    expect(Date.parse(parked.next_retry_at)).toBeGreaterThan(Date.now())
    expect(parked.last_agent_message).toMatch(/turned off|disabled/i)
    const events = await listTaskEvents(db, task.id)
    expect(events.find((e) => e.step === 'automation_disabled')).toBeTruthy()

    const second = await tick(db)
    expect(second.summary.queue_selected).toBe(0) // rotated out of the queue
    expect(await runCount(db, task.id)).toBe(0)
  })
})

describe('hamilton-submit-5: complete_forms not granted is a NAMED no_run with ONE notification', () => {
  it('two ticks → reason complete_forms_not_granted, exactly one hamilton_task_started notice, task parked (not re-picked)', async () => {
    const db = makeDb()
    await seedProfile(db)
    await seedOpportunity(db, 'opp-unauth')
    const task = await seedTask(db, 'opp-unauth')

    const first = await tick(db)
    expect(first.summary.no_run).toBe(1)
    expect(first.summary.no_run_reasons).toMatch(/complete_forms_not_granted/)
    expect(await runCount(db, task.id)).toBe(0)

    const second = await tick(db)
    expect(second.summary.queue_selected).toBe(0)

    const notices = await db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE type = 'hamilton_task_started' AND user_id = ?",
    ).get(OWNER)
    expect(Number(notices.n)).toBe(1)

    const parked = await getApplicationTask(db, task.id)
    expect(parked.status).toBe('waiting_for_user')
    expect(parked.current_step).toBe('awaiting_authorization')
    expect(Date.parse(parked.next_retry_at)).toBeGreaterThan(Date.now())
    const events = await listTaskEvents(db, task.id)
    expect(events.find((e) => e.step === 'awaiting_authorization')).toBeTruthy()
  })
})

describe('hamilton-submit-6: a funding-source policy outage defers the task durably instead of freezing the queue head', () => {
  it('five policy-unavailable tasks at the head of the queue do not starve the sixth on the next tick', async () => {
    const db = makeDb()
    await seedProfile(db)
    const ids = ['opp-a', 'opp-b', 'opp-c', 'opp-d', 'opp-e', 'opp-f']
    const tasks = {}
    for (let i = 0; i < ids.length; i += 1) {
      await seedOpportunity(db, ids[i])
      tasks[ids[i]] = await seedTask(db, ids[i], { updatedAt: `2026-01-0${i + 1}T00:00:00.000Z` })
    }
    assessMock.mockImplementation(async (_db, { opportunity } = {}) => (
      opportunity?.id === 'opp-f'
        ? { ok: true, reasons: [] }
        : { unavailable: true, code: 'funding_source_policy_unavailable', message: 'Hamilton funding policy is temporarily unavailable.' }
    ))

    const first = await tick(db, 5)
    const firstIds = first.summary.results.map((r) => r.task_id)
    expect(firstIds).not.toContain(tasks['opp-f'].id)
    expect(first.summary.failed).toBe(5)
    expect(first.summary.failed_reasons).toMatch(/funding_source_policy_unavailable/)

    // Every refused-by-outage task is DEFERRED with a durable reason, never frozen.
    for (const id of ['opp-a', 'opp-b', 'opp-c', 'opp-d', 'opp-e']) {
      const t = await getApplicationTask(db, tasks[id].id)
      expect(t.status).toBe('waiting_for_window')
      expect(Date.parse(t.next_retry_at)).toBeGreaterThan(Date.now())
      expect(t.last_agent_message).toMatch(/temporarily unavailable/i)
      const events = await listTaskEvents(db, tasks[id].id)
      expect(events.find((e) => e.step === 'policy_unavailable')).toBeTruthy()
    }

    const second = await tick(db, 5)
    const secondIds = second.summary.results.map((r) => r.task_id)
    expect(secondIds).toContain(tasks['opp-f'].id)
  })
})
