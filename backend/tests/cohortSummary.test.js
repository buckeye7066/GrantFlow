import { describe, expect, it } from 'vitest'
import { cohortCounts, cohortSummary } from '../services/amy/cohortSummary.js'
import { summarizeAmyFlywheel } from '../services/anya/anyaDailyOwnerReport.js'

describe('cohort reporting uses observed profiles, not the target shortfall', () => {
  it('reconciles the reported 50 issues across only 26 evaluations', () => {
    const day = {day: '2026-09-08', target: 50, clean: 0, evaluated: 26, issues: 50}
    expect(cohortCounts(day)).toMatchObject({evaluatedIssues: 26, unevaluated: 24})
    expect(cohortSummary(day)).toContain('26 evaluated with issues; 24 not evaluated')
  })
  it('uses the same calculation in the owner report', () => {
    const cohort = {day:'2026-09-08', target:50, clean:1, evaluated:48, issues:49,
      run_receipts:[{recorded_at:'2026-09-08T08:00:00Z'}]}
    expect(summarizeAmyFlywheel({cohort}, {now:new Date('2026-09-08T09:00:00Z')}).cohortLine)
      .toContain('47 evaluated with issues; 2 not evaluated')
  })
  it('names inconsistent legacy counts instead of declaring completion', () => {
    expect(cohortSummary({target:50, evaluated:26, clean:50})).toContain('inconsistent cohort receipt')
  })
})
