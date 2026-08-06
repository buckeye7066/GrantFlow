/**
 * Draft-packet → portal bridge (owner directive 2026-08-03): internally
 * drafted application packets ("Start Proposal" → Auto-populate →
 * applications/application_sections) must be carried into each EXTERNAL
 * portal's application form by Hamilton — globally (any profile, any portal),
 * keyed only by the task's funding source.
 *
 * Pins:
 *   1. RESOLUTION — loadDraftPacketForTask finds the packet by grant_id or
 *      via opportunity_id→grants.funding_opportunity_id, PROFILE-SCOPED
 *      (another profile's grant never leaks), and never throws when the
 *      apply-engine tables don't exist.
 *   2. MAPPING — buildPortalAnswersFromDraftPacket maps drafted sections onto
 *      ONLY the engine's long-form allow-list keys (essay/goals), records the
 *      exact source section_keys, and never types placeholder text.
 *   3. WIRING — the autopilot pathway feeds the draft content to the engine
 *      as the fill source, records draft_packet_bridge / draft_packet_filled
 *      audit events plus a draft_packet_fill summary on the run record, and
 *      NEVER widens submission authority (allowAutoSubmit stays false; the
 *      task stages as waiting_for_review, filled-not-submitted).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

// Mock the browser engine — the bridge's job ends at handing the engine the
// right narrativeAnswers; no chromium in unit tests.
vi.mock('../services/hamilton/hamiltonAutopilotEngine.js', () => ({
  runAutopilot: vi.fn(async () => ({
    status: 'completed_draft',
    filled_fields: [
      { key: 'first_name', fid: 'f0', value: 'Robert' },
      { key: 'essay', fid: 'f1', value: 'A rigorous, evidence-led statement of need…' },
    ],
    pages_visited: 1,
    trace: [],
  })),
}))

// Preflight is pinned by its own suite; here it must simply pass so the run
// reaches the engine.
vi.mock('../services/hamilton/hamiltonPreflight.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    preflightSingleSource: vi.fn(async () => ({ ok: true, blockers: [], warnings: [] })),
  }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  loadDraftPacketForTask,
  buildPortalAnswersFromDraftPacket,
  summarizeDraftFill,
} = await import('../services/hamilton/draftPacketPortalBridge.js')
const { runAutopilot } = await import('../services/hamilton/hamiltonAutopilotEngine.js')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const { listTaskEvents, _resetSchemaCache } = await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache, recordAuthorizations } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-draft-bridge'
const OTHER_PROFILE = 'profile-someone-else'

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
    CREATE TABLE applications (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      organization_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE application_sections (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      title TEXT,
      content TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return db
}

async function seedProfile(db, profileId = PROFILE) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
    .run(profileId, 'user-1', 'Demo College Student Persona')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(profileId, 'basic_information', JSON.stringify({
      first_name: 'Robert', last_name: 'White', email: 'r@example.com',
    }))
}

async function seedDraftPacket(db, {
  grantId = 'g-1',
  profileId = PROFILE,
  opportunityId = 'opp-1',
  applicationId = 'app-1',
  sections = [
    { key: 'cover_letter', title: 'Cover Letter', content: 'Dear Committee — a drafted cover letter.' },
    { key: 'needs_statement', title: 'Statement of Need', content: 'A rigorous, evidence-led statement of need.' },
    { key: 'project_narrative', title: 'Project Narrative', content: 'A grounded project narrative.' },
    { key: 'budget_justification', title: 'Budget Justification', content: '$500 for testing supplies.' },
    { key: 'submission_instructions', title: 'Submission Instructions', content: 'Submit online.' },
  ],
} = {}) {
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)')
    .run(grantId, profileId, opportunityId, 'Test Grant')
  await db.prepare('INSERT INTO applications (id, grant_id, organization_id) VALUES (?, ?, ?)')
    .run(applicationId, grantId, 'org-1')
  for (const s of sections) {
    await db.prepare('INSERT INTO application_sections (id, application_id, section_key, title, content) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), applicationId, s.key, s.title, s.content)
  }
  return { grantId, applicationId }
}

beforeEach(() => {
  runAutopilot.mockClear()
})

// ── 1. RESOLUTION ────────────────────────────────────────────────────────────

describe('loadDraftPacketForTask', () => {
  it('finds the packet by grant_id, profile-scoped', async () => {
    const db = makeDb()
    await seedDraftPacket(db)
    const packet = await loadDraftPacketForTask(db, { profileId: PROFILE, grantId: 'g-1' })
    expect(packet).not.toBeNull()
    expect(packet.application_id).toBe('app-1')
    expect(packet.sections.map((s) => s.section_key)).toContain('needs_statement')
  })

  it('never returns another profile\'s packet', async () => {
    const db = makeDb()
    await seedDraftPacket(db, { profileId: OTHER_PROFILE })
    expect(await loadDraftPacketForTask(db, { profileId: PROFILE, grantId: 'g-1' })).toBeNull()
  })

  it('resolves through opportunity_id → grants.funding_opportunity_id when the task carries no grant_id', async () => {
    const db = makeDb()
    await seedDraftPacket(db)
    const packet = await loadDraftPacketForTask(db, { profileId: PROFILE, opportunityId: 'opp-1' })
    expect(packet?.application_id).toBe('app-1')
  })

  it('returns null when the packet has no non-empty sections', async () => {
    const db = makeDb()
    await seedDraftPacket(db, { sections: [{ key: 'cover_letter', title: 'Cover Letter', content: '   ' }] })
    expect(await loadDraftPacketForTask(db, { profileId: PROFILE, grantId: 'g-1' })).toBeNull()
  })

  it('never throws when the apply-engine tables do not exist', async () => {
    const sqlite = new Database(':memory:')
    const db = wrapSqlite(sqlite)
    expect(await loadDraftPacketForTask(db, { profileId: PROFILE, grantId: 'g-1' })).toBeNull()
  })
})

// ── 2. MAPPING ───────────────────────────────────────────────────────────────

describe('buildPortalAnswersFromDraftPacket', () => {
  it('composes the essay from needs_statement + project_narrative and records the sources', () => {
    const { answers, sources } = buildPortalAnswersFromDraftPacket([
      { section_key: 'needs_statement', content: 'Need text.' },
      { section_key: 'project_narrative', content: 'Narrative text.' },
      { section_key: 'budget_justification', content: '$500.' },
    ])
    expect(answers.essay).toBe('Need text.\n\nNarrative text.')
    expect(sources.essay).toEqual(['needs_statement', 'project_narrative'])
    expect(answers.goals).toBeUndefined()
  })

  it('prefers a purpose-written personal_statement over the composed narrative', () => {
    const { answers, sources } = buildPortalAnswersFromDraftPacket([
      { section_key: 'personal_statement', content: 'My own statement.' },
      { section_key: 'needs_statement', content: 'Need text.' },
    ])
    expect(answers.essay).toBe('My own statement.')
    expect(sources.essay).toEqual(['personal_statement'])
  })

  it('maps a goals-shaped section onto the goals key', () => {
    const { answers, sources } = buildPortalAnswersFromDraftPacket([
      { section_key: 'career_goals', content: 'Become an EMS educator.' },
    ])
    expect(answers.goals).toBe('Become an EMS educator.')
    expect(sources.goals).toEqual(['career_goals'])
  })

  it('never maps short factual keys — only the engine long-form allow-list', () => {
    const { answers } = buildPortalAnswersFromDraftPacket([
      { section_key: 'budget_justification', content: '$500.' },
      { section_key: 'submission_instructions', content: 'Mail it.' },
    ])
    expect(answers).toEqual({})
  })

  it('never types placeholder text into a live portal', () => {
    const { answers } = buildPortalAnswersFromDraftPacket([
      { section_key: 'personal_statement', content: 'Dear [INSERT NAME], …' },
      { section_key: 'needs_statement', content: 'Needs [ EVIDENCE NEEDED: income ] here.' },
      { section_key: 'project_narrative', content: 'Clean narrative.' },
    ])
    // placeholder sections are skipped; the clean one still flows.
    expect(answers.essay).toBe('Clean narrative.')
  })

  it('returns empty maps for missing/empty input', () => {
    expect(buildPortalAnswersFromDraftPacket(null).answers).toEqual({})
    expect(buildPortalAnswersFromDraftPacket([]).answers).toEqual({})
  })
})

describe('summarizeDraftFill', () => {
  it('reports only the keys the engine actually wrote, and written never reads as sent', () => {
    const summary = summarizeDraftFill({
      applicationId: 'app-1',
      sources: { essay: ['needs_statement', 'project_narrative'], goals: ['career_goals'] },
      engineResult: { status: 'completed_draft', filled_fields: [{ key: 'essay' }, { key: 'first_name' }] },
    })
    expect(summary.filled_from_draft).toEqual([
      { key: 'essay', draft_sections: ['needs_statement', 'project_narrative'] },
    ])
    expect(summary.submitted).toBe(false)
  })

  it('marks submitted true only on a real engine submission', () => {
    const summary = summarizeDraftFill({
      applicationId: 'app-1',
      sources: { essay: ['needs_statement'] },
      engineResult: { status: 'submitted', filled_fields: [{ key: 'essay' }] },
    })
    expect(summary.submitted).toBe(true)
  })
})

// ── 3. WIRING through the autopilot pathway ──────────────────────────────────

const OPPORTUNITY = {
  id: 'opp-1',
  title: 'Bridge Test Scholarship',
  description: 'Apply through the portal.',
  application_url: 'https://hamilton-submit-fixture.invalid/apply',
}

async function seedOpportunity(db, opp = OPPORTUNITY) {
  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')
    .run(opp.id, opp.title, opp.description, opp.application_url)
}

async function authorizeFormCompletion(db) {
  await recordAuthorizations(db, {
    userId: 'user-1',
    profileId: PROFILE,
    scope: 'funding_source',
    fundingSourceIds: ['opp-1'],
    authorizationTypes: ['complete_forms'],
    authorizationText: 'Test form-completion authorization',
    authorizationVersion: 'hamilton-autopilot-test-v1',
    replaceOmittedTypes: true,
  })
}

const savedEnv = {}
beforeEach(() => {
  savedEnv.enabled = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  savedEnv.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
  return () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = savedEnv.enabled
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = savedEnv.allow
  }
})

describe('autopilot pathway — draft packet is the fill source', () => {
  it('feeds the drafted content to the engine, audits it, and stays filled-not-submitted', async () => {
    const db = makeDb()
    await seedProfile(db)
    await seedOpportunity(db)
    await authorizeFormCompletion(db)
    await seedDraftPacket(db)

    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: { opportunity_id: 'opp-1', grant_id: 'g-1' },
      options: {},
    })

    // The engine ran once, with the draft packet as the essay fill source.
    expect(runAutopilot).toHaveBeenCalledTimes(1)
    const engineArgs = runAutopilot.mock.calls[0][0]
    expect(engineArgs.narrativeAnswers?.essay)
      .toBe('A rigorous, evidence-led statement of need.\n\nA grounded project narrative.')
    // Submission authority is NOT widened by the bridge.
    expect(engineArgs.allowAutoSubmit).toBe(false)
    expect(result.task.status).toBe('waiting_for_review')

    // Audit trail: the bridge event says what will be used; the fill event says
    // what was actually written — and that written ≠ sent.
    const events = await listTaskEvents(db, result.task.id)
    const bridgeEvent = events.find((e) => e.step === 'draft_packet_bridge')
    expect(bridgeEvent).toBeTruthy()
    expect(bridgeEvent.details?.application_id).toBe('app-1')
    expect(bridgeEvent.details?.answer_sources?.essay).toEqual(['needs_statement', 'project_narrative'])
    const filledEvent = events.find((e) => e.step === 'draft_packet_filled')
    expect(filledEvent).toBeTruthy()
    expect(filledEvent.message).toMatch(/not submitted/i)

    // Run record: draft_packet_fill is auditable on the persisted result.
    const runRow = await db.prepare('SELECT result_json FROM hamilton_autopilot_runs WHERE id = ?')
      .get(result.autopilot_run)
    const runResult = JSON.parse(runRow.result_json)
    expect(runResult.draft_packet_fill).toEqual({
      application_id: 'app-1',
      filled_from_draft: [{ key: 'essay', draft_sections: ['needs_statement', 'project_narrative'] }],
      submitted: false,
    })
  })

  it('leaves behavior unchanged when no draft packet exists', async () => {
    const db = makeDb()
    await seedProfile(db)
    await seedOpportunity(db)
    await authorizeFormCompletion(db)
    // grant exists but no applications/application_sections rows
    await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)')
      .run('g-1', PROFILE, 'opp-1', 'Test Grant')

    const result = await automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: { opportunity_id: 'opp-1', grant_id: 'g-1' },
      options: {},
    })

    expect(runAutopilot).toHaveBeenCalledTimes(1)
    expect(runAutopilot.mock.calls[0][0].narrativeAnswers).toBeNull()
    const events = await listTaskEvents(db, result.task.id)
    expect(events.find((e) => e.step === 'draft_packet_bridge')).toBeUndefined()
    expect(events.find((e) => e.step === 'draft_packet_filled')).toBeUndefined()
  })

  it('rejects another profile\'s grant before its draft or automation can be reached', async () => {
    const db = makeDb()
    await seedProfile(db)
    await seedOpportunity(db)
    await authorizeFormCompletion(db)
    await seedDraftPacket(db, { profileId: OTHER_PROFILE })

    await expect(automateSingleSource(db, {
      profileId: PROFILE,
      userId: 'user-1',
      source: { opportunity_id: 'opp-1', grant_id: 'g-1' },
      options: {},
    })).rejects.toMatchObject({
      code: 'application_task_source_scope_mismatch',
      status: 403,
    })

    expect(runAutopilot).not.toHaveBeenCalled()
  })
})
