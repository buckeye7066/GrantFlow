import { describe, it, expect, vi } from 'vitest'

/**
 * A RETURN IS NOT WORK.
 *
 * automateSingleSource has ~15 early-return paths that never reach
 * createAutopilotRun. Each returns a truthy object, and the adapter counted any
 * non-throwing return as `processed` — so a tick that advanced NOTHING logged
 * as clean success.
 *
 * Prod 2026-08-24: every 5-minute tick reported
 * `{ attempted: 5, processed: 5, failed: 0, blocked: 0 }` while the database
 * gained ZERO autopilot runs for 32+ hours and no task changed status. The
 * adapter's own charter already says an empty queue must report as a noop with
 * a reason; a FULL queue where nothing opened a run is the same fact and was
 * the one case it did not cover.
 */

const automateSingleSource = vi.fn()
vi.mock('../services/hamilton/hamiltonAutomationOrchestrator.js', () => ({
  automateSingleSource: (...a) => automateSingleSource(...a),
  HAMILTON_INTERNAL_CALLER: Symbol('test.hamilton.internal-caller'),
  resolveAutopilotConcurrency: () => 1,
}))

const { HamiltonAgentAdapter } = await import('../services/agentControl/agentAdapters/hamiltonAgentAdapter.js')

function dbWithTasks(n) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: 'task-' + i, profile_id: 'p1', opportunity_id: 'o' + i, grant_id: null,
    automation_type: 'portal', status: 'ready_to_start',
    current_pipeline_stage: null, selected_from_stage: null,
  }))
  return {
    dialect: 'postgres',
    prepare: (sql) => ({
      all: async () => (/FROM application_tasks/i.test(sql) ? rows : []),
      get: async () => (/COUNT/i.test(sql) ? { n: rows.length } : undefined),
      run: async () => ({ rowCount: 1 }),
    }),
  }
}

describe('hamilton tick: a task that never opened a run is not "processed work"', () => {
  it('reports NOOP with reasons when no task opened an autopilot run', async () => {
    automateSingleSource.mockReset()
    // The prod shape: every call returns, none creates a run.
    automateSingleSource.mockResolvedValue({
      task: { id: 't', status: 'ready_to_start' },
      autopilot_run: null,
      reason: 'unknown_application_method',
    })
    const res = await new HamiltonAgentAdapter().start({ db: dbWithTasks(5) })
    expect(res.summary.attempted).toBe(5)
    expect(automateSingleSource.mock.calls[0][1]).toMatchObject({
      userId: null,
      internalCaller: expect.any(Symbol),
    })
    expect(res.summary.no_run).toBe(5)
    expect(res.status).toBe('noop')
    expect(res.summary.noop_reason).toMatch(/no_task_opened_a_run/)
    expect(res.summary.noop_reason).toMatch(/unknown_application_method/)
  })

  it('still reports COMPLETED when runs were genuinely opened', async () => {
    automateSingleSource.mockReset()
    automateSingleSource.mockResolvedValue({
      task: { id: 't', status: 'filling_portal' },
      autopilot_run: 'run-1',
    })
    const res = await new HamiltonAgentAdapter().start({ db: dbWithTasks(3) })
    expect(res.summary.no_run).toBe(0)
    expect(res.status).toBe('completed')
  })

  it('a MIXED tick is completed, not noop — one real run is real work', async () => {
    automateSingleSource.mockReset()
    automateSingleSource
      .mockResolvedValueOnce({ task: { id: 'a', status: 'ready_to_start' }, autopilot_run: null, reason: 'no_usable_url' })
      .mockResolvedValue({ task: { id: 'b', status: 'filling_portal' }, autopilot_run: 'run-2' })
    const res = await new HamiltonAgentAdapter().start({ db: dbWithTasks(2) })
    expect(res.summary.no_run).toBe(1)
    expect(res.status).toBe('completed')
  })

  it('an EMPTY queue keeps its original empty_queue reason', async () => {
    automateSingleSource.mockReset()
    const res = await new HamiltonAgentAdapter().start({ db: dbWithTasks(0) })
    expect(res.status).toBe('noop')
    expect(res.summary.noop_reason).toBe('empty_queue')
  })
})
