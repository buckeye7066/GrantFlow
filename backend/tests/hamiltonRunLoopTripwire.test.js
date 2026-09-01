/**
 * Two guards against the silent-loop class measured in prod 2026-08-22:
 *
 *  1. detectAutopilotRunLoop — a task opened ≥ MAX_AUTOPILOT_RUNS_PER_DAY
 *     times in 24h with no human event since the oldest of those runs is a
 *     loop, whatever requeued it. (transportation.gov/grants: six runs, six
 *     paid proposal drafts, zero terminal records, in one afternoon.)
 *  2. persistTerminalOrFail — a terminal ledger write that throws becomes a
 *     `failed` task event + failed task, never a `.catch(() => {})` ghost.
 */
import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { _internal, MAX_AUTOPILOT_RUNS_PER_DAY } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const { ensureApplicationTaskSchema, appendTaskEvent, _resetSchemaCache } = await import('../services/hamilton/applicationTaskStore.js')
const { createAutopilotRun, _resetAuthSchemaCache } = await import('../services/hamilton/hamiltonAuthorizationStore.js')

const { detectAutopilotRunLoop, persistTerminalOrFail } = _internal

function makeDb() {
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return new Database(':memory:')
}

async function seedTask(db, id, status = 'ready_to_start') {
  await db.prepare(`
    INSERT INTO application_tasks (id, profile_id, opportunity_id, status, allow_auto_submit, auto_submit_enabled, updated_at)
    VALUES (?, 'p1', ?, ?, 1, 1, ?)
  `).run(id, `opp-${id}`, status, new Date().toISOString())
}

async function seedRuns(db, taskId, n, { ageMs = 60_000 } = {}) {
  for (let i = 0; i < n; i += 1) {
    const run = await createAutopilotRun(db, { taskId, profileId: 'p1', status: 'running' })
    // Back-date created_at so "recent" vs "old" is under test control.
    const at = new Date(Date.now() - ageMs - i * 1000).toISOString()
    db.prepare('UPDATE hamilton_autopilot_runs SET created_at = ? WHERE id = ?').run(at, run.id)
  }
}

describe('detectAutopilotRunLoop', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureApplicationTaskSchema(db)
    await seedTask(db, 't1')
  })

  it('is silent below the daily budget', async () => {
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY - 1)
    expect(await detectAutopilotRunLoop(db, { taskId: 't1' })).toBeNull()
  })

  it('trips at the budget when nobody has touched the task', async () => {
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY)
    const loop = await detectAutopilotRunLoop(db, { taskId: 't1' })
    expect(loop?.kind).toBe('run_loop')
    expect(loop.runs).toBe(MAX_AUTOPILOT_RUNS_PER_DAY)
    expect(loop.detail).toMatch(/opened this source 3 times/)
  })

  it('does not count runs older than 24 hours', async () => {
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY, { ageMs: 25 * 60 * 60_000 })
    expect(await detectAutopilotRunLoop(db, { taskId: 't1' })).toBeNull()
  })

  it('a human event AFTER the oldest recent run resets the budget', async () => {
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY, { ageMs: 120_000 })
    await appendTaskEvent(db, { taskId: 't1', eventType: 'note', status: 'ready_to_start', step: 'retry', message: 'owner retried', actorRole: 'user' })
    expect(await detectAutopilotRunLoop(db, { taskId: 't1' })).toBeNull()
  })

  it('a human event BEFORE the recent runs does not reset it', async () => {
    await appendTaskEvent(db, { taskId: 't1', eventType: 'note', status: 'ready_to_start', step: 'retry', message: 'owner retried long ago', actorRole: 'admin' })
    db.prepare(`UPDATE application_task_events SET created_at = ? WHERE task_id = 't1'`).run(new Date(Date.now() - 3 * 60 * 60_000).toISOString())
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY)
    expect((await detectAutopilotRunLoop(db, { taskId: 't1' }))?.kind).toBe('run_loop')
  })

  it('agent events never reset the budget (Hamilton cannot excuse his own loop)', async () => {
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY, { ageMs: 120_000 })
    await appendTaskEvent(db, { taskId: 't1', eventType: 'progress', status: 'filling_portal', step: 'x', message: 'still going', actorRole: 'agent' })
    expect((await detectAutopilotRunLoop(db, { taskId: 't1' }))?.kind).toBe('run_loop')
  })

  it('NAMES the repeating dead-end (2026-08-31): the tripwire carries the last run blocker instead of "the last outcome is on the task"', async () => {
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY, { ageMs: 120_000 })
    // Stamp the blocker that keeps killing the loop. It must NOT be a bounded
    // auth kind (login / 2fa / captcha / sso / email_verification): those runs
    // are deliberately excluded from the loop budget so an auth backoff can
    // never trip this wire.
    db.prepare(`UPDATE hamilton_autopilot_runs SET status='blocked', blocker_kind='no_application_form', blocker_detail='No application form found on the page' WHERE task_id='t1'`).run()
    const loop = await detectAutopilotRunLoop(db, { taskId: 't1' })
    expect(loop?.kind).toBe('run_loop')
    expect(loop.last_blocker_kind).toBe('no_application_form')
    expect(loop.last_blocker_detail).toMatch(/No application form found/)
    expect(loop.detail).toMatch(/Each attempt ended the same way: no_application_form/)
    expect(loop.detail).toMatch(/No application form found/)
  })

  it('a BOUNDED auth blocker (login) never trips the wire — the auth backoff owns those retries', async () => {
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY, { ageMs: 120_000 })
    db.prepare(`UPDATE hamilton_autopilot_runs SET status='blocked', blocker_kind='login', blocker_detail='Password input visible — login required' WHERE task_id='t1'`).run()
    expect(await detectAutopilotRunLoop(db, { taskId: 't1' })).toBeNull()
  })

  it('a loop whose runs died with NO terminal record says so (crash/redeploy signature)', async () => {
    await seedRuns(db, 't1', MAX_AUTOPILOT_RUNS_PER_DAY, { ageMs: 120_000 })
    const loop = await detectAutopilotRunLoop(db, { taskId: 't1' })
    expect(loop?.kind).toBe('run_loop')
    expect(loop.last_blocker_kind).toBeNull()
    expect(loop.detail).toMatch(/died without a terminal record/)
  })
})

describe('persistTerminalOrFail', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureApplicationTaskSchema(db)
    await seedTask(db, 't1', 'filling_portal')
  })

  it('returns true and changes nothing else when the write succeeds', async () => {
    const ok = await persistTerminalOrFail(db, { task: { id: 't1' }, run: { id: 'r1' }, userId: null, label: 'x' }, async () => {})
    expect(ok).toBe(true)
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='t1'`).get().status).toBe('filling_portal')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM application_task_events`).get().n).toBe(0)
  })

  it('a throwing write becomes a failed event + failed task that names the database error', async () => {
    const ok = await persistTerminalOrFail(
      db, { task: { id: 't1' }, run: { id: 'r1' }, userId: null, label: 'listing_task' },
      async () => { throw new Error('new row for relation "hamilton_autopilot_runs" violates check constraint "hamilton_autopilot_runs_status_check"') },
    )
    expect(ok).toBe(false)
    const task = db.prepare(`SELECT status, last_agent_message FROM application_tasks WHERE id='t1'`).get()
    expect(task.status).toBe('failed')
    expect(task.last_agent_message).toMatch(/could not record the result \(listing_task\): new row for relation/)
    const ev = db.prepare(`SELECT event_type, step, message FROM application_task_events WHERE task_id='t1'`).all()
    expect(ev).toHaveLength(1)
    expect(ev[0].event_type).toBe('failed')
    expect(ev[0].step).toBe('persist:listing_task')
    expect(ev[0].message).toMatch(/violates check constraint/)
  })
})
