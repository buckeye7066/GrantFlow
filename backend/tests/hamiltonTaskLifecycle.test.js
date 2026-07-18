/**
 * Hamilton task-lifecycle regression tests:
 *
 *   1. Scheduler re-pick: the HamiltonAgentAdapter due-task query also re-picks
 *      'blocked' tasks that recorded an intent to retry (next_retry_at set and
 *      due) — a blocked task with NO next_retry_at is a human hand-off and is
 *      never re-picked.
 *   2. Retry accounting: POST /tasks/:taskId/retry increments retry_count and
 *      appends a manual_retry audit event, so backoff accounting stays truthful
 *      even when the re-run fails again.
 *   3. Hard-stop dedup at the insert choke point: recordBlocker touches an
 *      identical OPEN blocker (same task + type + field/key) instead of
 *      stacking a duplicate row.
 *   4. Admin hard-stops filter: listOpenAdminBlockers / GET /admin/hard-stops
 *      accept an optional profile_id and scope the list to that profile.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

// Mock ONLY automateSingleSource (the retry route + agent adapter both invoke
// it); everything else in the orchestrator stays real.
vi.mock('../services/hamilton/hamiltonAutomationOrchestrator.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    automateSingleSource: vi.fn(async () => ({ task: { status: 'completed' } })),
  }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const hamiltonRouter = (await import('../routes/hamiltonAutomation.js')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const {
  ensureApplicationTaskSchema,
  ensureApplicationTask,
  updateApplicationTask,
  getApplicationTask,
  listTaskEvents,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { recordBlocker, listOpenAdminBlockers, blockerDedupeKey } = await import('../services/hamilton/hamiltonBlockerStore.js')
const { HamiltonAgentAdapter } = await import('../services/agentControl/agentAdapters/hamiltonAgentAdapter.js')

function createApp(db, user = { role: 'admin', id: 'admin-1' }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = user
    next()
  })
  // Mirror production: routes now authorize against the DB-backed req.ctx that
  // attachRequestContext resolves (admin gates read req.ctx.isAdmin).
  app.use(attachRequestContext())
  app.use('/api/hamilton/automation', hamiltonRouter)
  return app
}

async function makeDb() {
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
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  await ensureApplicationTaskSchema(db)
  return db
}

const pastIso = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()
const futureIso = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()

const inertSignal = {
  shouldStop: () => false,
  shouldPause: () => false,
  isEmergency: () => false,
  heartbeat: async () => {},
  recordEvent: async () => {},
}

beforeEach(() => {
  automateSingleSource.mockClear()
})

describe('HamiltonAgentAdapter — due-task re-pick', () => {
  it('re-picks blocked tasks with a DUE next_retry_at, never blocked hand-offs without one', async () => {
    const db = await makeDb()
    const mk = async (grantId, status, nextRetryAt) => {
      const t = await ensureApplicationTask(db, {
        profileId: 'p-adapter', grantId, automationType: 'portal', initialStatus: 'queued',
      })
      await updateApplicationTask(db, t.id, { status, nextRetryAt })
      return t
    }
    const blockedDue = await mk('g-blocked-due', 'blocked', pastIso())
    const blockedNoRetry = await mk('g-blocked-none', 'blocked', null)
    const blockedFuture = await mk('g-blocked-future', 'blocked', futureIso())
    const loginDue = await mk('g-login-due', 'waiting_for_login', pastIso())
    const queued = await mk('g-queued', 'queued', null)

    const adapter = new HamiltonAgentAdapter()
    const result = await adapter.start({
      db,
      controlRunId: null,
      stepId: null,
      options: { allow_hamilton_autopilot: true, hamilton_batch_size: 25 },
      signal: inertSignal,
    })

    expect(result.ok).toBe(true)
    const attemptedIds = result.summary.results.map((r) => r.task_id)
    expect(attemptedIds).toContain(blockedDue.id)
    expect(attemptedIds).toContain(loginDue.id)
    expect(attemptedIds).toContain(queued.id)
    expect(attemptedIds).not.toContain(blockedNoRetry.id)
    expect(attemptedIds).not.toContain(blockedFuture.id)
    expect(automateSingleSource).toHaveBeenCalledTimes(3)
  })
})

describe('POST /tasks/:taskId/retry — truthful retry accounting', () => {
  it('increments retry_count on every manual retry and appends a manual_retry event', async () => {
    const db = await makeDb()
    db.raw.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-retry', 'Robert White')
    const task = await ensureApplicationTask(db, {
      profileId: 'p-retry', grantId: 'g-retry', automationType: 'portal', initialStatus: 'queued',
    })
    await updateApplicationTask(db, task.id, { status: 'blocked', lastAgentMessage: 'stopped' })
    expect((await getApplicationTask(db, task.id)).retry_count).toBe(0)

    const app = createApp(db)
    const first = await request(app).post(`/api/hamilton/automation/tasks/${task.id}/retry`)
    expect(first.status).toBe(202)
    expect((await getApplicationTask(db, task.id)).retry_count).toBe(1)

    const second = await request(app).post(`/api/hamilton/automation/tasks/${task.id}/retry`)
    expect(second.status).toBe(202)
    expect((await getApplicationTask(db, task.id)).retry_count).toBe(2)

    const events = await listTaskEvents(db, task.id)
    const retryEvents = events.filter((e) => e.step === 'manual_retry')
    expect(retryEvents.length).toBe(2)
    expect(retryEvents[1].details.retry_count).toBe(2)
  })
})

describe('recordBlocker — open-duplicate dedup at the insert choke point', () => {
  it('touches the existing OPEN blocker instead of inserting an identical duplicate', async () => {
    const db = await makeDb()
    const taskId = crypto.randomUUID()
    const first = await recordBlocker(db, {
      taskId, profileId: 'p-dup', blockerType: 'unknown_application_method',
      blockerText: 'no signup form found', metadata: { key: 'application_method' },
    })
    const second = await recordBlocker(db, {
      taskId, profileId: 'p-dup', blockerType: 'unknown_application_method',
      blockerText: 'no signup form found (retry)', metadata: { key: 'application_method' },
    })
    expect(second.id).toBe(first.id)
    expect(second.blocker_text).toBe('no signup form found (retry)') // touched/refreshed

    const rows = await db.prepare('SELECT * FROM hamilton_blockers WHERE task_id = ?').all(taskId)
    expect(rows.length).toBe(1)
  })

  it('still inserts when the type matches but the field/key differs, or when the old one is resolved', async () => {
    const db = await makeDb()
    const taskId = crypto.randomUUID()
    const a = await recordBlocker(db, {
      taskId, profileId: 'p-dup', blockerType: 'missing_required_information',
      blockerText: 'Profile is missing first name', metadata: { key: 'first_name' },
    })
    const b = await recordBlocker(db, {
      taskId, profileId: 'p-dup', blockerType: 'missing_required_information',
      blockerText: 'Profile is missing email', metadata: { key: 'email' },
    })
    expect(b.id).not.toBe(a.id)

    // Resolve the first — the same stop recurring later is a NEW open row.
    await db.prepare('UPDATE hamilton_blockers SET resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run(a.id)
    const c = await recordBlocker(db, {
      taskId, profileId: 'p-dup', blockerType: 'missing_required_information',
      blockerText: 'Profile is missing first name', metadata: { key: 'first_name' },
    })
    expect(c.id).not.toBe(a.id)
    const rows = await db.prepare('SELECT * FROM hamilton_blockers WHERE task_id = ?').all(taskId)
    expect(rows.length).toBe(3)
  })

  it('blockerDedupeKey prefers the metadata field key, falls back to text', () => {
    expect(blockerDedupeKey({ metadata: { key: 'First_Name' } })).toBe('k:first_name')
    expect(blockerDedupeKey({ metadata_json: JSON.stringify({ key: 'first_name' }) })).toBe('k:first_name')
    expect(blockerDedupeKey({ blocker_text: 'Some Stop' })).toBe('t:some stop')
    expect(blockerDedupeKey({})).toBe('')
  })
})

describe('GET /admin/hard-stops — optional profile filter', () => {
  it('scopes the checklist to one profile when ?profile_id= is supplied', async () => {
    const db = await makeDb()
    await recordBlocker(db, {
      taskId: crypto.randomUUID(), profileId: 'p-one', blockerType: 'login_required',
      blockerText: 'sign in needed', metadata: { key: 'login' },
    })
    await recordBlocker(db, {
      taskId: crypto.randomUUID(), profileId: 'p-two', blockerType: 'captcha_required',
      blockerText: 'captcha wall', metadata: { key: 'captcha' },
    })

    const app = createApp(db)
    const all = await request(app).get('/api/hamilton/automation/admin/hard-stops')
    expect(all.status).toBe(200)
    expect(all.body.blockers.length).toBe(2)

    const scoped = await request(app).get('/api/hamilton/automation/admin/hard-stops?profile_id=p-one')
    expect(scoped.status).toBe(200)
    expect(scoped.body.blockers.length).toBe(1)
    expect(scoped.body.blockers[0].profile_id).toBe('p-one')

    // Store-level contract too (the route is a thin pass-through).
    const storeScoped = await listOpenAdminBlockers(db, { profileId: 'p-two' })
    expect(storeScoped.length).toBe(1)
    expect(storeScoped[0].profile_id).toBe('p-two')
  })
})
