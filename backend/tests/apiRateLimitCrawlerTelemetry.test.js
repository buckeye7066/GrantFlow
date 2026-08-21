// Guards the 2026-08-06 "429 with nobody touching anything" incident.
//
// The per-user rate-limit bucket key is hash(`${policy.name}|${principal}`) —
// it deliberately ignores METHOD and PATH, so every request classified into the
// same policy shares ONE budget. The 'cost' policy is only 40 requests per 10
// minutes, and it matched `/api/crawlers` by prefix, so the Automation page's
// read-only dashboard polling of GET /api/crawlers/jobs spent the very budget
// the operator needs to START a crawl. An admin page left open therefore made
// the next real "Run now" POST come back 429.
//
// The fix moves ONLY the read-only telemetry GET to the ordinary read budget.
// These tests pin both halves: the read is cheap now, and the expensive lane
// did NOT get wider — that second half is the one that matters, because
// "fixing" a 429 by loosening the cost bucket would trade a UI annoyance for an
// uncapped crawl-spend surface.

import { describe, expect, it } from 'vitest'

import { classifyApiRatePolicy } from '../middleware/apiRateLimitPolicy.js'

// classifyApiRatePolicy returns null under the deterministic test harness
// unless a focused rate-limit test opts in, which is exactly what this is.
const ENV = { API_RATE_LIMIT_IN_TESTS: '1', NODE_ENV: 'test' }

const classify = (method, path) => classifyApiRatePolicy({ method, path }, ENV)

describe('crawler telemetry reads do not spend the crawl-start budget', () => {
  it('routes GET /api/crawlers/jobs to the ordinary read budget', () => {
    const policy = classify('GET', '/api/crawlers/jobs')
    expect(policy?.name).toBe('standard')
    // The read budget must be materially larger than the cost budget, or the
    // reclassification buys nothing.
    expect(policy.max).toBeGreaterThan(classify('POST', '/api/crawlers/jobs').max)
  })

  it('keeps the crawl-STARTING POST on the expensive budget', () => {
    // The whole point of the incident fix is that this stays costly.
    expect(classify('POST', '/api/crawlers/jobs')?.name).toBe('cost')
  })

  it('does not widen the expensive lane for any other crawler/AI surface', () => {
    for (const path of [
      '/api/crawlers',
      '/api/crawlers/run',
      '/api/real-crawlers/run',
      '/api/ai/draft',
      '/api/anya/chat',
      '/api/matching/profile/p1/opportunities',
      '/api/geo-crawl/start',
    ]) {
      expect(classify('GET', path)?.name, `GET ${path}`).toBe('cost')
      expect(classify('POST', path)?.name, `POST ${path}`).toBe('cost')
    }
  })

  it('keeps SmartMatcher interpret-intent on an isolated cost-limited budget', () => {
    expect(classify('POST', '/api/matching/interpret-intent')).toMatchObject({
      name: 'intent_cost', max: 40, requiredShared: true,
    })
    expect(classify('POST', '/api/matching/profile/p1/opportunities')?.name).toBe('cost')
  })

  it('separates the two budgets so a dashboard poll cannot starve a crawl start', () => {
    // Same principal, same path — ONLY the method differs. Because the bucket
    // key is derived from the policy NAME, different names are what guarantees
    // separate budgets; identical names would share one.
    const read = classify('GET', '/api/crawlers/jobs')
    const start = classify('POST', '/api/crawlers/jobs')
    expect(read?.name).not.toBe(start?.name)
  })

  it('only the jobs telemetry route is reclassified, not all crawler GETs', () => {
    // A blanket "GET /api/crawlers/* is cheap" rule would let an unbounded
    // read-triggered crawl surface escape the cost bucket.
    expect(classify('GET', '/api/crawlers/metrics')?.name).toBe('cost')
  })
})
