/**
 * Human handoffs leave a PRECISE, RESUMABLE, DURABLE state (requirement 5,
 * 2026-09-12). One test per handoff kind, asserting the durable fields the
 * map's Q4 trace names: status, next_retry_at, retry_count, last_agent_message,
 * the task event, the capture request (auth walls), and the notification.
 *
 * NOTIFICATION SHAPE (measured against the real emitters, 2026-09-12): every
 * unresolved blocker fires the Hard-Stop Resolver's dual alert (the
 * `hamilton_<category>` envelope to the owner + `hamilton_admin_*` to the
 * admin, by spec "EVERY time she pauses") AND the orchestrator's one
 * ACTIONABLE ask for the specific gate. So the owner sees two TYPES, each
 * exactly once — the bar asserted here is "the ask is present once and no
 * type is duplicated", not a literal row count of one. The identity ask is
 * keyed by profile + kind (it carries no task_id by design) and the generic
 * blocked hand-off must NOT fire beside it.
 *
 *   CAPTCHA   → waiting_for_captcha, retry in hours, capture request, ask ×1
 *   MFA (2fa) → waiting_for_2fa, retry in 15 min, capture request, ask ×1
 *   PAYMENT   → blocked, next_retry_at NULL, "payment step" ask, nothing paid
 *   LEGAL ATTESTATION → blocked, next_retry_at NULL, "legal attestation" ask
 *   APPLICANT FACTS   → waiting_for_missing_info + application_missing_info rows
 *   IDENTITY PROOF    → waiting_for_missing_info + identity_needed event + ask
 *
 * The scheduler's own selection is the resumability oracle: a parked task with
 * a FUTURE next_retry_at (or NULL) is not re-picked on the next tick.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'd'.repeat(64)

vi.mock('../services/hamilton/hamiltonAutopilotEngine.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, runAutopilot: vi.fn() }
})
vi.mock('../services/hamilton/hamiltonPreflight.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, preflightSingleSource: vi.fn(async () => ({ ok: true, blockers: [], warnings: [] })) }
})
vi.mock('../services/hamilton/hamiltonFundingSourcePolicy.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, assessHamiltonFundingSource: vi.fn(async () => ({ ok: true, reasons: [] })) }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { runAutopilot } = await import('../services/hamilton/hamiltonAutopilotEngine.js')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const { HamiltonAgentAdapter } = await import('../services/agentControl/agentAdapters/hamiltonAgentAdapter.js')
const {
  ensureApplicationTask, getApplicationTask, listTaskEvents, listMissingInfo, _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { _resetAuthSchemaCache, recordAuthorizations } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const PROFILE = 'profile-handoffs'
const OWNER = 'user-1'
const PORTAL = 'https://apply.somefunder.org/scholarship/form'

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

async function seedFixture(db) {
  await db.prepare('INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES (?, ?, ?, ?)')
    .run(PROFILE, OWNER, 'Handoff Fixture', 'individual')
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ first_name: 'Hand', last_name: 'Off', email: 'h@example.org' }))
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'automation_preferences', JSON.stringify({ automations: { hamilton_autopilot: true } }))
  await db.prepare(`INSERT INTO funding_opportunities
    (id, title, description, opportunity_kind, entity_types_allowed, application_url,
     source_url, source, record_origin, source_trust_tier, reality_status, is_active)
    VALUES (?, ?, ?, 'scholarship', ?, ?, ?, 'curated_verified', 'curated_verified', 'official', 'real', 1)`)
    .run('opp-1', 'Somefunder Scholarship', 'Apply through the portal.', JSON.stringify(['individual']), PORTAL, PORTAL)
  await db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)')
    .run('g-1', PROFILE, 'opp-1', 'Somefunder Scholarship')
  await db.prepare(`INSERT INTO profile_opportunity_matches
    (profile_id, opportunity_id, match_score, match_decision, matcher_version, updated_at, computed_at)
    VALUES (?, ?, 90, 'accept', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(PROFILE, 'opp-1')
  await recordAuthorizations(db, {
    userId: OWNER, profileId: PROFILE, scope: 'funding_source', fundingSourceIds: ['opp-1'],
    authorizationTypes: ['complete_forms', 'save_drafts', 'generate_narratives'],
    authorizationText: 'Test authorization', authorizationVersion: 'hamilton-autopilot-test-v1',
    replaceOmittedTypes: true,
  })
  return ensureApplicationTask(db, {
    profileId: PROFILE, opportunityId: 'opp-1', grantId: 'g-1', automationType: 'portal', initialStatus: 'ready_to_start',
  })
}

const runSource = (db) => automateSingleSource(db, {
  profileId: PROFILE, userId: OWNER, source: { opportunity_id: 'opp-1', grant_id: 'g-1' }, options: { autonomous: true },
})

const blocked = (kind, detail, extra = {}) => ({
  status: 'blocked', blocker_kind: kind, blocker_detail: detail,
  filled_fields: [], pages_visited: 1, trace: [{ step: 'gate', detail: { kind } }], logged_in: false, ...extra,
})

async function notificationsFor(db, taskId) {
  try {
    const rows = await db.prepare('SELECT type, title, data FROM notifications WHERE user_id = ?').all(OWNER)
    return rows.filter((r) => {
      try { return JSON.parse(r.data || '{}').task_id === taskId } catch { return false }
    })
  } catch { return [] }
}

async function ownerNoticesOfType(db, type) {
  const rows = await db.prepare('SELECT type, title, data FROM notifications WHERE user_id = ? AND type = ?').all(OWNER, type)
  return rows.map((r) => ({ ...r, data: (() => { try { return JSON.parse(r.data || '{}') } catch { return {} } })() }))
}

/** The gate's own actionable ask is present exactly once, and no type pages the owner twice. */
function expectOneAskNoDuplicates(notices, askType) {
  const asks = notices.filter((n) => (askType instanceof RegExp ? askType.test(n.type) : n.type === askType))
  expect(asks, `expected exactly one ${askType} ask, got types ${notices.map((n) => n.type).join(',')}`).toHaveLength(1)
  const types = notices.map((n) => n.type)
  expect(new Set(types).size, `duplicate notification types: ${types.join(',')}`).toBe(types.length)
  return asks[0]
}

async function schedulerSelects(db) {
  const res = await new HamiltonAgentAdapter().start({
    db, controlRunId: null, stepId: null,
    options: { allow_hamilton_autopilot: true, hamilton_batch_size: 5 },
    signal: { shouldStop: () => false, shouldPause: () => false, isEmergency: () => false, heartbeat: async () => {}, recordEvent: async () => {} },
  })
  return res.summary.queue_selected
}

const savedEnv = {}
beforeEach(() => {
  runAutopilot.mockReset()
  savedEnv.enabled = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  savedEnv.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  savedEnv.gate = process.env.HAMILTON_TAILORED_APPROVAL_GATE
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
  process.env.HAMILTON_TAILORED_APPROVAL_GATE = '0'
  return () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = savedEnv.enabled
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = savedEnv.allow
    if (savedEnv.gate === undefined) delete process.env.HAMILTON_TAILORED_APPROVAL_GATE
    else process.env.HAMILTON_TAILORED_APPROVAL_GATE = savedEnv.gate
  }
})

describe('handoff: CAPTCHA', () => {
  it('parks at waiting_for_captcha with a retry hours out, a capture request, retry_count 1, and ONE notification', async () => {
    const db = makeDb()
    const task = await seedFixture(db)
    runAutopilot.mockResolvedValue(blocked('captcha', 'CAPTCHA challenge present on the login page.'))

    const before = Date.now()
    const result = await runSource(db)
    const t = await getApplicationTask(db, task.id)
    expect(result.autopilot_run).toBeTruthy()
    expect(t.status).toBe('waiting_for_captcha')
    expect(t.retry_count).toBe(1)
    expect(Date.parse(t.next_retry_at)).toBeGreaterThanOrEqual(before + 3 * 60 * 60_000)
    expect(t.last_agent_message).toMatch(/captcha/i)
    const ev = (await listTaskEvents(db, task.id)).find((e) => e.details?.blocker_kind === 'captcha' && e.details?.next_retry_at)
    expect(ev).toBeTruthy()
    expect(ev.details.retry_count).toBe(1)
    const capture = await db.prepare("SELECT status, portal_host FROM hamilton_session_capture_requests WHERE profile_id = ? AND status IN ('pending','launched')").all(PROFILE)
    expect(capture).toHaveLength(1)
    expect(capture[0].portal_host).toMatch(/somefunder\.org$/)
    // No saved credential for this host → the ladder's ask is "add a login";
    // it carries the retry plan so the owner sees WHEN Hamilton comes back.
    const ask = expectOneAskNoDuplicates(await notificationsFor(db, task.id), 'hamilton_missing_credential')
    expect(JSON.parse(ask.data).auto_retry).toBe(true)
    expect(JSON.parse(ask.data).next_retry_at).toBe(t.next_retry_at)
    expect(await schedulerSelects(db)).toBe(0) // not re-picked before next_retry_at
  })
})

describe('handoff: MFA / 2FA', () => {
  it('parks at waiting_for_2fa with the 15-minute first retry, a capture request, and ONE notification', async () => {
    const db = makeDb()
    const task = await seedFixture(db)
    runAutopilot.mockResolvedValue(blocked('2fa', 'One-time code requested; no code source configured.'))

    const before = Date.now()
    await runSource(db)
    const t = await getApplicationTask(db, task.id)
    expect(t.status).toBe('waiting_for_2fa')
    expect(t.retry_count).toBe(1)
    const delta = Date.parse(t.next_retry_at) - before
    expect(delta).toBeGreaterThanOrEqual(14 * 60_000)
    expect(delta).toBeLessThanOrEqual(16 * 60_000)
    const capture = await db.prepare("SELECT 1 FROM hamilton_session_capture_requests WHERE profile_id = ? AND status IN ('pending','launched')").all(PROFILE)
    expect(capture).toHaveLength(1)
    expectOneAskNoDuplicates(await notificationsFor(db, task.id), /^hamilton_(2fa_required|missing_credential)$/)
    expect(await schedulerSelects(db)).toBe(0)
  })
})

describe('handoff: PAYMENT', () => {
  it('parks BLOCKED with next_retry_at NULL, names the payment step, pays nothing, and notifies once', async () => {
    const db = makeDb()
    const task = await seedFixture(db)
    runAutopilot.mockResolvedValue(blocked('payment', `Payment step at ${PORTAL}: the portal asks for a payment of $25 (card number field shown). Hamilton never pays; open the link, complete the payment, and Hamilton will continue on the next run.`))

    await runSource(db)
    const t = await getApplicationTask(db, task.id)
    expect(t.status).toBe('blocked')
    expect(t.next_retry_at).toBeNull()
    expect(t.last_agent_message).toMatch(/payment/i)
    const events = await listTaskEvents(db, task.id)
    expect(events.find((e) => e.event_type === 'blocked' && e.details?.blocker_kind === 'payment')).toBeTruthy()
    expect(events.find((e) => e.event_type === 'submitted')).toBeFalsy()
    const ask = expectOneAskNoDuplicates(await notificationsFor(db, task.id), 'hamilton_task_blocked')
    expect(ask.title).toMatch(/payment step/i)
    expect(JSON.parse(ask.data).blocker_kind).toBe('payment')
    expect(await schedulerSelects(db)).toBe(0) // a NULL retry is a human hand-off, never auto-retried
  })
})

describe('handoff: LEGAL ATTESTATION (no standing authorization)', () => {
  it('parks BLOCKED with next_retry_at NULL and a "legal attestation" notice; nothing is ticked on the applicant\'s behalf', async () => {
    const db = makeDb()
    const task = await seedFixture(db)
    runAutopilot.mockResolvedValue(blocked('attestation', 'Legal attestation present (no standing authorization): "I certify under penalty of perjury…"'))

    await runSource(db)
    const t = await getApplicationTask(db, task.id)
    expect(t.status).toBe('blocked')
    expect(t.next_retry_at).toBeNull()
    expect(t.last_agent_message).toMatch(/attestation/i)
    const ask = expectOneAskNoDuplicates(await notificationsFor(db, task.id), 'hamilton_task_blocked')
    expect(ask.title).toMatch(/legal attestation/i)
    expect(JSON.parse(ask.data).blocker_kind).toBe('attestation')
    expect(await schedulerSelects(db)).toBe(0)
  })
})

describe('handoff: APPLICANT-SUPPLIED FACTS (required question not in the profile)', () => {
  it('routes the ask to application_missing_info and parks at waiting_for_missing_info with the ask named', async () => {
    const db = makeDb()
    const task = await seedFixture(db)
    runAutopilot.mockResolvedValue({
      status: 'completed_draft',
      filled_fields: [{ key: 'first_name', fid: 'f1', value: 'Hand' }],
      unanswered_required_fields: [{ label: 'Nominator name', type: 'text' }],
      pages_visited: 1, trace: [], logged_in: true,
    })

    await runSource(db)
    const t = await getApplicationTask(db, task.id)
    expect(t.status).toBe('waiting_for_missing_info')
    expect(t.last_agent_message).toMatch(/Nominator name/)
    const asks = await listMissingInfo(db, task.id, { includeResolved: false })
    expect(asks.some((a) => a.kind === 'field' && /Nominator name/i.test(a.label))).toBe(true)
    expect(await schedulerSelects(db)).toBe(0)
  })
})

describe('handoff: IDENTITY PROOF (SSN not in the vault)', () => {
  it('asks by KIND, records identity_needed, parks at waiting_for_missing_info, and notifies once', async () => {
    const db = makeDb()
    const task = await seedFixture(db)
    runAutopilot.mockResolvedValue(blocked('identity_proof', 'The portal requires an SSN that is not on file.', { missing_identity_kinds: ['ssn'] }))

    await runSource(db)
    const t = await getApplicationTask(db, task.id)
    expect(t.status).toBe('waiting_for_missing_info')
    expect(t.last_agent_message).toMatch(/ssn/i)
    const events = await listTaskEvents(db, task.id)
    const ev = events.find((e) => e.step === 'identity_needed')
    expect(ev).toBeTruthy()
    expect(ev.details?.missing_identity_kinds).toEqual(['ssn'])
    // The identity ask is keyed by profile + KIND (never a value, no task_id).
    const asks = await ownerNoticesOfType(db, 'hamilton_identity_needed')
    expect(asks).toHaveLength(1)
    expect(asks[0].data.kinds).toEqual(['ssn'])
    expect(asks[0].data.profile_id).toBe(PROFILE)
    // The generic blocked hand-off must NOT overwrite the named ask (a second
    // "Hamilton Autopilot stopped: identity_proof" notice was the pre-fix shape).
    expect((await notificationsFor(db, task.id)).filter((n) => n.type === 'hamilton_task_blocked')).toHaveLength(0)
    expect(await schedulerSelects(db)).toBe(0)
  })
})
