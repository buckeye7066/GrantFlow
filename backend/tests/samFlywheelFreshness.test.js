import { describe, expect, it } from 'vitest'

import {
  DIAGNOSTIC_CHECKS,
  FLYWHEEL_COHORT_STALE_MS,
  flywheelCohortAgeMs,
} from '../services/sam/samRegistry.js'

function dbWithStore(store) {
  return {
    prepare() {
      return {
        // getFlywheelCohort performs its idempotent CREATE before reading the
        // KV row. The freshness test double must model both statement shapes;
        // a get-only stub made the setup throw and accidentally tested Sam's
        // fail-open module/store path instead of stale cohort behavior.
        run: async () => ({ changes: 0 }),
        get: async () => ({ value: JSON.stringify(store) }),
      }
    },
  }
}

describe('Amy flywheel evidence freshness', () => {
  it('computes age from the latest isolated receipt, not merely a day label', () => {
    const day = {
      day: '2026-08-24',
      run_receipts: [
        { recorded_at: '2026-08-24T01:00:00.000Z' },
        { recorded_at: '2026-08-24T12:00:00.000Z' },
      ],
    }
    expect(flywheelCohortAgeMs(day, new Date('2026-08-24T13:00:00.000Z'))).toBe(60 * 60 * 1000)
    expect(flywheelCohortAgeMs({ day: '2026-08-24' }, new Date())).toBe(Number.POSITIVE_INFINITY)
  })

  it('reports scheduler freshness instead of recycling stale gap counts', async () => {
    const day = {
      day: '2026-08-22',
      clean: 18,
      evaluated: 50,
      target: 50,
      issues: 32,
      finding_types: { weak_match: 30 },
      latest_run_id: 'amy-old',
      run_receipts: [{ run_id: 'amy-old', recorded_at: '2026-08-22T08:00:00.000Z' }],
    }
    const check = DIAGNOSTIC_CHECKS.find((candidate) => candidate.id === 'amy.flywheelCohort')
    const result = await check.run({
      db: dbWithStore({ days: { [day.day]: day } }),
      now: new Date('2026-08-25T09:00:00.000Z'),
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/execution is STALE/i)
    expect(result.summary).toMatch(/not re-reported as current crawler defects/i)
    expect(result.summary).not.toMatch(/weak_match|32 of 50/)
    expect(result.evidence.stale_after_ms).toBe(FLYWHEEL_COHORT_STALE_MS)
  })

  it('still reports a fresh current cohort issue with its real class', async () => {
    const day = {
      day: '2026-08-25', clean: 49, evaluated: 50, target: 50, issues: 1,
      finding_types: { amount_recall_miss: 1 },
      run_receipts: [{ recorded_at: '2026-08-25T08:00:00.000Z' }],
    }
    const check = DIAGNOSTIC_CHECKS.find((candidate) => candidate.id === 'amy.flywheelCohort')
    const result = await check.run({
      db: dbWithStore({ days: { [day.day]: day } }),
      now: new Date('2026-08-25T09:00:00.000Z'),
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/amount_recall_miss/)
    expect(result.summary).not.toMatch(/STALE/)
  })
})
