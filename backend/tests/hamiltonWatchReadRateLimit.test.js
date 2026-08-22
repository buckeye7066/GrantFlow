/**
 * The automation WATCH window polls GET /api/hamilton/automation/tasks on a live
 * cadence. Those reads must NOT spend the 25-per-10-min 'automation' budget that
 * exists to throttle the expensive POST which launches a run — otherwise the
 * live view 429s with rate_limit_exceeded after ~25 polls (the owner hit this on
 * a real run, 2026-08-21). GET Hamilton/application-task status reads go on the
 * ordinary 'standard' read budget; POSTs that drive a run stay on 'automation'.
 */
import { describe, expect, it } from 'vitest'
import { classifyApiRatePolicy } from '../middleware/apiRateLimitPolicy.js'

const ENV = { API_RATE_LIMIT_IN_TESTS: '1', NODE_ENV: 'test' }
const classify = (method, path) => classifyApiRatePolicy({ method, path }, ENV)

describe('Hamilton watch reads do not spend the run-start budget', () => {
  it('GET automation/tasks (the watch poll) is on the standard read budget, not automation', () => {
    const p = classify('GET', '/api/hamilton/automation/tasks')
    expect(p?.name).toBe('standard')
    expect(p?.max).toBe(600)
  })

  it('other Hamilton status reads are also standard', () => {
    for (const path of [
      '/api/hamilton/automation/authorizations',
      '/api/hamilton/automation/full-automation',
      '/api/hamilton/readiness',
      '/api/application-tasks',
    ]) {
      expect(classify('GET', path)?.name).toBe('standard')
    }
  })

  it('POSTs that actually drive a run STAY on the throttled automation budget', () => {
    for (const path of ['/api/hamilton/automation/start', '/api/hamilton/automation/start-autopilot']) {
      const p = classify('POST', path)
      expect(p?.name).toBe('automation')
      expect(p?.max).toBe(25)
    }
  })
})
