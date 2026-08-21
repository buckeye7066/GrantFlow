/**
 * `owner.run_agent { agent: 'amy' }` must start the SAME run the nightly
 * scheduler starts (2026-08-21).
 *
 * THE DEFECT THIS CLOSES. The handler called `launchAmyRun({ db, source, logger })`
 * with NO `opts`, so `runAmyTraining` fell back to its own parameter defaults:
 *   dryRunDiscovery = true   → nothing discovered is stored in the catalog, AND
 *                              the three durable learning writes gated on
 *                              `!dryRunDiscovery` are skipped: recordFlywheelCohort,
 *                              recordProbeCoverage, and recordApprovalQueue — the
 *                              approval LEDGER, the only thing that ages a finding
 *                              or can ever CLOSE one.
 *   improve = false          → no floor sweep, no Anya→Sam chain, no lever work.
 *   targetCount = null       → one profile per category instead of the daily target.
 *
 * The handler's own comment says it "closes the create→crawl→learn→delete loop
 * on demand". It closed create → crawl → delete and dropped LEARN on the floor.
 * The same class as the Yana branch right above it, where a `mode` string was
 * passed to a function that takes no `mode`.
 *
 * The fix reads `getAmyConfig()` — the scheduler's own config — so there is ONE
 * definition of "a real Amy run" and the AMY_* env switches govern both paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ADMIN_EMAIL } from '../config/constants.js'

vi.mock('../services/amy/amyRunner.js', () => ({
  launchAmyRun: vi.fn(() => ({ run_id: 'amy-run-1', already_running: false, promise: Promise.resolve(null) })),
}))

import { invokeTool } from '../services/anyaToolRegistry.js'
import { launchAmyRun } from '../services/amy/amyRunner.js'

const ownerCtx = () => ({
  db: { prepare: () => ({ run: async () => ({}), get: async () => null, all: async () => [] }) },
  ctx: { isAdmin: true, email: ADMIN_EMAIL, userId: 'owner1' },
  user: { role: 'admin', email: ADMIN_EMAIL },
})

const lastOpts = () => launchAmyRun.mock.calls.at(-1)[0].opts

let ENV_SNAPSHOT
beforeEach(() => {
  ENV_SNAPSHOT = { ...process.env }
  vi.clearAllMocks()
  launchAmyRun.mockReturnValue({ run_id: 'amy-run-1', already_running: false, promise: Promise.resolve(null) })
})
afterEach(() => { process.env = ENV_SNAPSHOT })

describe('owner.run_agent amy — the LEARN half of the loop must actually run', () => {
  it('launches a real (non-dry) run so the ledger, cohort and probe fold are written', async () => {
    const res = await invokeTool('owner.run_agent', { agent: 'amy' }, ownerCtx())
    expect(res.output.result.run_id).toBe('amy-run-1')
    expect(launchAmyRun).toHaveBeenCalledTimes(1)
    expect(lastOpts()).toBeTruthy()
    expect(lastOpts().dryRunDiscovery).toBe(false)
  })

  it('runs the improvement loop and the daily target, like the scheduler does', async () => {
    await invokeTool('owner.run_agent', { agent: 'amy' }, ownerCtx())
    const opts = lastOpts()
    expect(opts.improve).toBe(true)
    expect(opts.targetCount).toBeGreaterThan(0)
  })

  it('honours the AMY_* switches rather than hard-coding a second definition of a run', async () => {
    process.env.AMY_PERSIST = 'false'
    process.env.AMY_IMPROVE = 'false'
    process.env.AMY_DAILY_PROFILE_TARGET = '7'
    await invokeTool('owner.run_agent', { agent: 'amy' }, ownerCtx())
    const opts = lastOpts()
    expect(opts.dryRunDiscovery).toBe(true)
    expect(opts.improve).toBe(false)
    expect(opts.targetCount).toBe(7)
  })
})
