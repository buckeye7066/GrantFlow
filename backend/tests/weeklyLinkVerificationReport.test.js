import { describe, expect, it } from 'vitest'
import {
  addLinkVerificationPassStats,
  buildWeeklyLinkVerificationReport,
} from '../services/weeklyLinkVerificationReport.js'

describe('weekly link verification operator report', () => {
  it('accounts for every verdict and does not label the all-row census as backlog', () => {
    const stats = addLinkVerificationPassStats(
      { checked: 200, ok: 180, suspicious: 2 },
      { checked: 100, ok: 90, broken: 7, redirect: 2, skipped: 1 },
    )
    const text = buildWeeklyLinkVerificationReport({
      weekKey: '2026-09-14',
      passStats: stats,
      byStatus: { broken: 524, unverified: 3524 },
      releaseCatalog: {
        denominator_total: 26663, verified_fresh: 23831, unverified_or_stale: 2832,
        verified_pct: 89.4, target_pct: 95,
        visible_direct: { total: 18338, verified_fresh: 18338 },
        visible_pointer: { total: 8325, verified_fresh: 5493 },
      },
    })

    expect(stats).toMatchObject({ checked: 300, ok: 270, broken: 7, suspicious: 2, redirect: 2, skipped: 1 })
    expect(text).toContain('23831/26663 (89.4%; target 95%), 2832 unverified or stale')
    expect(text).toContain('includes inactive, hidden, expired, and retired history; not the actionable backlog')
    expect(text).toContain('at least every 3h')
    expect(text).not.toContain('every 6h')
  })
})
