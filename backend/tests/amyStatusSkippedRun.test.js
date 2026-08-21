/**
 * GET /api/amy/status must expose the last run's SUMMARY so a run deduped by
 * the scheduler lock (state.ok=true, summary={skipped:true, reason:'lock_held'})
 * is distinguishable from a real training run — previously both looked like
 * last_run_ok:true and admins/panels could not tell them apart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../services/amy/amyReportStore.js', () => ({
  readLatestAmyReport: vi.fn(async () => null),
  readAmyHistory: vi.fn(async () => []),
  readAmyApprovalQueue: vi.fn(async () => ({ queue: [] })),
}))
vi.mock('../services/amy/amyScheduler.js', () => ({
  getAmyConfig: vi.fn(() => ({ enabled: true, runOnSchedule: false, dailyTarget: 12 })),
}))
vi.mock('../services/amy/amyRunner.js', () => ({
  launchAmyRun: vi.fn(),
  getAmyRunState: vi.fn(),
}))

import amyRouter from '../routes/amy.js'
import { getAmyRunState, launchAmyRun } from '../services/amy/amyRunner.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.ctx = { isAdmin: true, email: 'admin@example.com', userId: 'u1' }
    req.db = {}
    next()
  })
  app.use('/api/amy', amyRouter)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/amy/status skipped-run honesty', () => {
  it('exposes a lock-deduped run as skipped (summary + skip reason)', async () => {
    getAmyRunState.mockReturnValue({
      running: false,
      run_id: 'run-1',
      source: 'admin',
      started_at: '2026-07-02T05:00:00.000Z',
      finished_at: '2026-07-02T05:00:01.000Z',
      ok: true,
      error: null,
      summary: { skipped: true, reason: 'lock_held' },
    })
    const res = await request(makeApp()).get('/api/amy/status')
    expect(res.status).toBe(200)
    expect(res.body.status.last_run_ok).toBe(true)
    expect(res.body.status.last_run_skipped).toBe(true)
    expect(res.body.status.last_run_skip_reason).toBe('lock_held')
    expect(res.body.status.last_run_summary).toEqual({ skipped: true, reason: 'lock_held' })
    expect(res.body.status.last_run_finished_at).toBe('2026-07-02T05:00:01.000Z')
  })

  it('reports a real training run as not skipped, with its summary', async () => {
    getAmyRunState.mockReturnValue({
      running: false,
      run_id: 'run-2',
      source: 'scheduler',
      started_at: '2026-07-02T05:00:00.000Z',
      finished_at: '2026-07-02T05:20:00.000Z',
      ok: true,
      error: null,
      summary: { profiles: 12, crawled: 12 },
    })
    const res = await request(makeApp()).get('/api/amy/status')
    expect(res.status).toBe(200)
    expect(res.body.status.last_run_skipped).toBe(false)
    expect(res.body.status.last_run_skip_reason).toBe(null)
    expect(res.body.status.last_run_summary).toEqual({ profiles: 12, crawled: 12 })
  })

  it('tolerates a null summary (no run yet)', async () => {
    getAmyRunState.mockReturnValue({
      running: false, run_id: null, source: null, started_at: null,
      finished_at: null, ok: null, error: null, summary: null,
    })
    const res = await request(makeApp()).get('/api/amy/status')
    expect(res.status).toBe(200)
    expect(res.body.status.last_run_summary).toBe(null)
    expect(res.body.status.last_run_skipped).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AN OWNER-TRIGGERED RUN IS A REAL RUN (2026-08-21)
//
// `runAmyTraining` gates THREE durable learning writes on `!dryRunDiscovery`:
// `recordFlywheelCohort` (system_kv amy_flywheel_cohort),
// `recordProbeCoverage` (amy_probe_coverage) and `recordApprovalQueue`
// (amy_approval_ledger — the ONLY thing that ages a finding and can ever CLOSE
// one). This route computed `dryRunDiscovery: body.persist !== true`, and the
// admin console's Run-now button sends `{ count, improve, applyTuning,
// applyWeights, applyCoverage }` and NO `persist`
// (src/components/admin/AdminAmyConsole.jsx). So every owner-triggered run paid
// the full cost — creating profiles, crawling them live, running the
// improvement loop (`improve` already defaults to TRUE right here) — and then
// threw the learning away: no cohort row, no probe fold, no ledger entry, so
// nothing could age and nothing could close. Only the nightly scheduler, which
// passes `dryRunDiscovery: !cfg.persist` with AMY_PERSIST defaulting to true,
// ever learned anything.
//
// It is also a dry-run default sitting in owner tooling, which this repo's
// standing rule forbids outright. `persist` stays an EXPLICIT opt-out
// (`persist: false`) for anyone who genuinely wants a measurement-only pass.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/amy/run — owner runs are real runs, not dry runs', () => {
  const optsOf = () => launchAmyRun.mock.calls.at(-1)[0].opts

  beforeEach(() => {
    launchAmyRun.mockReturnValue({ run_id: 'run-x', already_running: false, promise: Promise.resolve(null) })
  })

  it('a body with no `persist` still records the learning artifacts', async () => {
    const res = await request(makeApp()).post('/api/amy/run').send({ count: 12, improve: true })
    expect(res.status).toBe(202)
    expect(optsOf().dryRunDiscovery).toBe(false)
  })

  it('the admin console payload (no `persist` key at all) is a real run', async () => {
    // Verbatim shape from AdminAmyConsole.jsx runNow().
    const res = await request(makeApp()).post('/api/amy/run').send({
      count: 12, improve: true, applyTuning: false, applyWeights: false, applyCoverage: false,
    })
    expect(res.status).toBe(202)
    expect(optsOf().dryRunDiscovery).toBe(false)
  })

  it('persist:false is still honoured as an EXPLICIT measurement-only opt-out', async () => {
    const res = await request(makeApp()).post('/api/amy/run').send({ count: 4, persist: false })
    expect(res.status).toBe(202)
    expect(optsOf().dryRunDiscovery).toBe(true)
  })

  it('persist:true is unchanged', async () => {
    const res = await request(makeApp()).post('/api/amy/run').send({ count: 4, persist: true })
    expect(res.status).toBe(202)
    expect(optsOf().dryRunDiscovery).toBe(false)
  })
})
