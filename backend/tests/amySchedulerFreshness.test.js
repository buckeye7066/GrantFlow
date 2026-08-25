import { describe, expect, it, vi } from 'vitest'

vi.mock('../services/amy/amyRunner.js', () => ({ launchAmyRun: vi.fn() }))
vi.mock('../services/amy/amyReportStore.js', () => ({ readLatestAmyReport: vi.fn() }))

const {
  AMY_REPORT_FUTURE_TOLERANCE_MS,
  isAmyReportDue,
} = await import('../services/amy/amyScheduler.js')

describe('Amy scheduler report freshness', () => {
  const nowMs = Date.parse('2026-08-25T12:00:00.000Z')

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
