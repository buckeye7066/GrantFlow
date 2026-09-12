/**
 * anyaDigestGapTaxonomy.test.js — digest-1: three unrelated "gap class"
 * taxonomies used to render under one phrase. Each surface must now name its
 * taxonomy, its population and its window, and the point-in-time scoreboard
 * must say it cannot close the 7-day live-crawl window.
 */
import { describe, it, expect } from 'vitest'
import { summarizeCoverageGaps, summarizeAmyFlywheel } from '../services/anya/anyaDailyOwnerReport.js'

describe('digest-1 — every gap-class surface names its taxonomy + population + window', () => {
  it('the scoreboard headline is labelled as the source-plan (planner) taxonomy, point-in-time, with skipped profiles named', () => {
    const gs = summarizeCoverageGaps({
      scoreboard: { generated_at: '2026-09-12T05:10:00.000Z', scan_limit: 100, profiles_scanned: 24, profiles_skipped: 2, gaps: [], adapter_wishlist: [] },
      events: [],
    })
    expect(gs.headline).toMatch(/source-plan gap classes/i)
    expect(gs.headline).toMatch(/planner taxonomy/i)
    expect(gs.headline).toMatch(/point-in-time/i)
    expect(gs.headline).toMatch(/0 coverage gap class\(es\) across 24 scanned profile\(s\)/)
    expect(gs.headline).toMatch(/2 skipped/)
    expect(gs.headline).toMatch(/not the 7-day live-crawl/i)
    expect(gs.headline).toMatch(/cannot close/i)
  })

  it('a scoreboard without a skipped count says so rather than implying zero', () => {
    const gs = summarizeCoverageGaps({
      scoreboard: { generated_at: '2026-09-12T05:10:00.000Z', profiles_scanned: 12, gaps: [], adapter_wishlist: [] },
      events: [],
    })
    expect(gs.headline).toMatch(/skipped count not recorded/i)
  })

  it('the Amy flywheel "open gap classes" line names the synthetic-cohort taxonomy and the latest-ET-day window', () => {
    const out = summarizeAmyFlywheel({
      cohort: {
        day: '2026-09-11', target: 50, evaluated: 50, clean: 0, issues: 50,
        finding_types: { hyperlocal_recall_miss: 50 },
        run_receipts: [{ recorded_at: new Date().toISOString() }],
      },
      report: null,
    })
    const line = out.couldNot.find((l) => /hyperlocal_recall_miss/.test(l))
    expect(line).toBeTruthy()
    expect(line).toMatch(/synthetic-cohort finding types/i)
    expect(line).toMatch(/latest ET day/i)
    expect(line).toMatch(/50 evaluated/)
    expect(line).not.toMatch(/^Open gap classes the loop has not closed yet:/)
  })
})
