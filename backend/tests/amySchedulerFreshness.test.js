import { describe, expect, it, vi } from 'vitest'

vi.mock('../services/amy/amyRunner.js', () => ({ launchAmyRun: vi.fn() }))
vi.mock('../services/amy/amyReportStore.js', () => ({ readLatestAmyReport: vi.fn() }))
vi.mock('../services/amy/amyRunCheckpoint.js', () => ({ readAmyRunCheckpoint: vi.fn() }))
const { readLatestAmyReport } = await import('../services/amy/amyReportStore.js')
const { readAmyRunCheckpoint } = await import('../services/amy/amyRunCheckpoint.js')
const { launchAmyRun } = await import('../services/amy/amyRunner.js')

const {
  AMY_REPORT_FUTURE_TOLERANCE_MS,
  isAmyReportDue,
  runAmyFreshnessCheck,
} = await import('../services/amy/amyScheduler.js')

describe('Amy scheduler report freshness', () => {
  const nowMs = Date.parse('2026-08-25T12:00:00.000Z')

  it('resumes unfinished work even when a partial report was saved recently', async () => {
    readLatestAmyReport.mockResolvedValue({ completed_at: new Date(nowMs).toISOString() })
    readAmyRunCheckpoint.mockResolvedValue({ value: { run_id: 'unfinished-run' } })
    const result = await runAmyFreshnessCheck({ db: {}, nowMs })
    expect(result).toMatchObject({ triggered: true, reason: 'unfinished_run' })
    expect(launchAmyRun).toHaveBeenCalled()
  })

  it('tolerates bounded forward clock skew', () => {
    const completedAt = new Date(nowMs + AMY_REPORT_FUTURE_TOLERANCE_MS / 2).toISOString()
    expect(isAmyReportDue({ completed_at: completedAt }, { nowMs })).toBe(false)
  })

  it('treats an implausibly future completion timestamp as due', () => {
    const completedAt = new Date(nowMs + AMY_REPORT_FUTURE_TOLERANCE_MS + 1).toISOString()
    expect(isAmyReportDue({ completed_at: completedAt }, { nowMs })).toBe(true)
  })

  it('keeps missing, invalid, and normally overdue reports due', () => {
    expect(isAmyReportDue(null, { nowMs })).toBe(true)
    expect(isAmyReportDue({ completed_at: 'not-a-date' }, { nowMs })).toBe(true)
    expect(isAmyReportDue({ completed_at: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString() }, { nowMs })).toBe(true)
  })
})
