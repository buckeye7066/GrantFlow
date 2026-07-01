/**
 * Hamilton restart-resilience + efficiency guards:
 *
 * 1. reconcileOrphanedApplicationTasks — a Railway redeploy kills in-process
 *    autopilot work; tasks stuck in transient in-flight statuses must be
 *    requeued to ready_to_start (stale ones only — active work is never
 *    demoted), while durable waiting/blocked/terminal statuses are untouched.
 * 2. latestFinishedBlockerKind — the fast-skip evidence lookup must report the
 *    LATEST finished run's blocker (so a portal that later succeeded never
 *    fast-skips) and exclude the in-progress run.
 * 3. runWithConcurrency / resolveAutopilotConcurrency — bounded fan-out keeps
 *    input order, respects the cap, and the env knob clamps to 1..4.
 */
import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const {
  reconcileOrphanedApplicationTasks,
  IN_FLIGHT_STATUSES,
} = await import('../startup/hamiltonTaskRecovery.js')
const {
  ensureApplicationTaskSchema,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { _internal, resolveAutopilotConcurrency } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')

function makeDb() {
  _resetSchemaCache()
  return new Database(':memory:')
}

async function seedTask(db, { id, status, updatedAt }) {
  await db.prepare(`
    INSERT INTO application_tasks (id, profile_id, opportunity_id, status, updated_at)
    VALUES (?, 'p1', ?, ?, ?)
  `).run(id, `opp-${id}`, status, updatedAt)
}

const OLD = new Date(Date.now() - 60 * 60_000).toISOString()   // 1h ago
const FRESH = new Date(Date.now() - 2 * 60_000).toISOString()  // 2min ago

describe('reconcileOrphanedApplicationTasks (restart recovery)', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureApplicationTaskSchema(db)
  })

  it('requeues STALE in-flight tasks to ready_to_start and appends a recovery event', async () => {
    await seedTask(db, { id: 't1', status: 'filling_portal', updatedAt: OLD })
    await seedTask(db, { id: 't2', status: 'generating_application', updatedAt: OLD })
    const r = await reconcileOrphanedApplicationTasks(db, { staleMinutes: 15 })
    expect(r.demoted).toBe(2)
    const rows = db.prepare(`SELECT id, status FROM application_tasks ORDER BY id`).all()
    expect(rows.every((row) => row.status === 'ready_to_start')).toBe(true)
    const events = db.prepare(`SELECT task_id, step FROM application_task_events WHERE step = 'recovery'`).all()
    expect(events).toHaveLength(2)
  })

  it('never demotes FRESH in-flight work (rolling-deploy overlap safety)', async () => {
    await seedTask(db, { id: 't1', status: 'filling_portal', updatedAt: FRESH })
    const r = await reconcileOrphanedApplicationTasks(db, { staleMinutes: 15 })
    expect(r.scanned).toBe(1)
    expect(r.demoted).toBe(0)
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='t1'`).get().status).toBe('filling_portal')
  })

  it('leaves durable hand-off and terminal statuses untouched', async () => {
    for (const status of ['waiting_for_login', 'waiting_for_review', 'blocked', 'submitted', 'ready_to_start', 'queued']) {
      await seedTask(db, { id: `t-${status}`, status, updatedAt: OLD })
    }
    const r = await reconcileOrphanedApplicationTasks(db, { staleMinutes: 15 })
    expect(r.scanned).toBe(0)
    expect(r.demoted).toBe(0)
  })

  it('treats an unparseable updated_at as stale (a corrupt timestamp cannot strand a task)', async () => {
    await seedTask(db, { id: 't1', status: 'launching_portal', updatedAt: 'not-a-date' })
    const r = await reconcileOrphanedApplicationTasks(db, { staleMinutes: 15 })
    expect(r.demoted).toBe(1)
  })

  it('is idempotent and safe on a bare DB with no table', async () => {
    const bare = new Database(':memory:')
    const r = await reconcileOrphanedApplicationTasks(bare, { staleMinutes: 15 })
    expect(r).toEqual({ scanned: 0, demoted: 0, task_ids: [] })
  })

  it('covers every transient in-flight status', () => {
    expect([...IN_FLIGHT_STATUSES].sort()).toEqual([
      'filling_portal', 'generating_application', 'generating_documents',
      'in_progress', 'launching_portal', 'saving_documents', 'saving_portal_draft',
    ].sort())
  })
})

describe('latestFinishedBlockerKind (fast-skip evidence)', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await db.exec(`
      CREATE TABLE hamilton_autopilot_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        blocker_kind TEXT,
        created_at DATETIME
      )
    `)
  })

  function seedRun({ id, taskId = 't1', status, blockerKind = null, createdAt }) {
    db.prepare(`INSERT INTO hamilton_autopilot_runs (id, task_id, profile_id, status, blocker_kind, created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, taskId, 'p1', status, blockerKind, createdAt)
  }

  it('returns the latest finished run blocker kind', async () => {
    seedRun({ id: 'r1', status: 'blocked', blockerKind: 'login', createdAt: '2026-07-01T10:00:00Z' })
    const kind = await _internal.latestFinishedBlockerKind(db, { taskId: 't1' })
    expect(kind).toBe('login')
  })

  it('a later SUCCESSFUL run clears the evidence (no fast-skip after success)', async () => {
    seedRun({ id: 'r1', status: 'blocked', blockerKind: 'login', createdAt: '2026-07-01T10:00:00Z' })
    seedRun({ id: 'r2', status: 'submitted', blockerKind: null, createdAt: '2026-07-01T12:00:00Z' })
    const kind = await _internal.latestFinishedBlockerKind(db, { taskId: 't1' })
    expect(kind).toBeNull()
  })

  it('excludes the in-progress run and other tasks', async () => {
    seedRun({ id: 'current', status: 'blocked', blockerKind: 'captcha', createdAt: '2026-07-01T13:00:00Z' })
    seedRun({ id: 'other-task', taskId: 't2', status: 'blocked', blockerKind: '2fa', createdAt: '2026-07-01T14:00:00Z' })
    const kind = await _internal.latestFinishedBlockerKind(db, { taskId: 't1', excludeRunId: 'current' })
    expect(kind).toBeNull()
  })

  it('returns null on a bare DB (never blocks the launch path)', async () => {
    const bare = new Database(':memory:')
    const kind = await _internal.latestFinishedBlockerKind(bare, { taskId: 't1' })
    expect(kind).toBeNull()
  })
})

describe('bounded concurrency', () => {
  it('preserves input order and completes every item', async () => {
    const items = Array.from({ length: 9 }, (_, i) => i)
    const out = await _internal.runWithConcurrency(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, (9 - n) * 2)) // later items finish first
      return n * 10
    })
    expect(out).toEqual(items.map((n) => n * 10))
  })

  it('never exceeds the cap', async () => {
    let inFlight = 0
    let peak = 0
    await _internal.runWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 2, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('resolveAutopilotConcurrency defaults to 2 and clamps to 1..4', () => {
    expect(resolveAutopilotConcurrency({})).toBe(2)
    expect(resolveAutopilotConcurrency({ HAMILTON_AUTOPILOT_CONCURRENCY: '1' })).toBe(1)
    expect(resolveAutopilotConcurrency({ HAMILTON_AUTOPILOT_CONCURRENCY: '3' })).toBe(3)
    expect(resolveAutopilotConcurrency({ HAMILTON_AUTOPILOT_CONCURRENCY: '99' })).toBe(4)
    expect(resolveAutopilotConcurrency({ HAMILTON_AUTOPILOT_CONCURRENCY: '0' })).toBe(2)
    expect(resolveAutopilotConcurrency({ HAMILTON_AUTOPILOT_CONCURRENCY: 'nope' })).toBe(2)
  })
})
