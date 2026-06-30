/**
 * Unit tests for backend/services/sam/samDailyCodeSweep.js
 *
 * Proves the 05:00 ET heavy sweep:
 *   - runs Sam in advise mode with the heavy code/function checks forced ON,
 *     read-only (dryRun), persisted
 *   - returns a compact summary incl. the run id (the Anya handoff pointer)
 *   - respects the enable flag
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { runSamDailyCodeSweep, isSamDailyCodeSweepEnabled } from '../services/sam/samDailyCodeSweep.js'

const DB = { prepare: () => ({ get: async () => null, run: async () => ({}), all: async () => [] }) }

const SAVED = process.env.SAM_DAILY_CODE_SWEEP_ENABLED
afterEach(() => {
  if (SAVED === undefined) delete process.env.SAM_DAILY_CODE_SWEEP_ENABLED
  else process.env.SAM_DAILY_CODE_SWEEP_ENABLED = SAVED
})

describe('isSamDailyCodeSweepEnabled', () => {
  it('defaults on; explicit false disables', () => {
    delete process.env.SAM_DAILY_CODE_SWEEP_ENABLED
    expect(isSamDailyCodeSweepEnabled()).toBe(true)
    process.env.SAM_DAILY_CODE_SWEEP_ENABLED = 'false'
    expect(isSamDailyCodeSweepEnabled()).toBe(false)
  })
})

describe('runSamDailyCodeSweep', () => {
  it('runs Sam advise + heavy, read-only, and summarizes', async () => {
    const runSam = vi.fn().mockResolvedValue({
      run_id: 'sam-zzz',
      status: 'completed',
      health_score: 80,
      production_ready: true,
      findings: [
        { id: '1', severity: 'high', title: 'x' },
        { id: '2', severity: 'low', title: 'y', safe_auto_fix_available: true },
        { id: '3', severity: 'info', title: 'z' },
      ],
    })
    const res = await runSamDailyCodeSweep(DB, { runSam })
    expect(runSam).toHaveBeenCalledTimes(1)
    const args = runSam.mock.calls[0][0]
    expect(args.mode).toBe('advise')
    expect(args.includeHeavy).toBe(true)
    expect(args.dryRun).toBe(true)
    expect(args.persist).toBe(true)
    // Sam must NOT email directly — Anya's 09:00 digest is the single owner email.
    expect(args.emailReport).toBe(false)
    expect(res).toMatchObject({
      ran: true,
      run_id: 'sam-zzz',
      findings_total: 3,
      auto_fixable: 1,
    })
    expect(res.by_severity).toMatchObject({ high: 1, low: 1, info: 1 })
  })

  it('returns disabled without calling Sam when turned off', async () => {
    process.env.SAM_DAILY_CODE_SWEEP_ENABLED = 'false'
    const runSam = vi.fn()
    const res = await runSamDailyCodeSweep(DB, { runSam })
    expect(res).toEqual({ ran: false, reason: 'disabled' })
    expect(runSam).not.toHaveBeenCalled()
  })

  it('is best-effort if Sam throws', async () => {
    const runSam = vi.fn().mockRejectedValue(new Error('boom'))
    const res = await runSamDailyCodeSweep(DB, { runSam })
    expect(res.ran).toBe(false)
    expect(res.reason).toBe('exception')
  })
})
