// Guards the 2026-08-20 "interpret-intent 429 under normal SmartMatcher use"
// incident.
//
// POST /api/matching/interpret-intent was classified into the shared 'cost'
// policy (40 req / 10 min, same bucket as every other /api/matching call).
// Browsing the matching catalog page therefore burned through the budget that
// the interpret-intent endpoint needed, so normal SmartMatcher use (type →
// submit → retry) 429'd immediately.
//
// The fix gives interpret-intent its own 'intent' policy (30 req / min) with a
// separate bucket key, so browsing matching results cannot starve
// intent-interpretation calls.
//
// These tests pin BOTH halves: the interpret-intent endpoint is now more
// generous AND still rate-limited (anonymous abuse is still bounded), AND the
// cost bucket did NOT get wider for any other matching endpoint.

import { describe, expect, it } from 'vitest'

import { classifyApiRatePolicy } from '../middleware/apiRateLimitPolicy.js'

// classifyApiRatePolicy returns null under the deterministic test harness
// unless a focused rate-limit test opts in.
const ENV = { API_RATE_LIMIT_IN_TESTS: '1', NODE_ENV: 'test' }

const classify = (method, path) => classifyApiRatePolicy({ method, path }, ENV)

describe('interpret-intent rate-limit bucket', () => {
  it('routes POST /api/matching/interpret-intent to the intent policy', () => {
    const policy = classify('POST', '/api/matching/interpret-intent')
    expect(policy?.name).toBe('intent')
  })

  it('intent policy window allows a normal authenticated UI burst (≥ 10 requests)', () => {
    // A user who types, edits, and retries a few times should never 429.
    // 30 req / min is the default; even a generous environment override must
    // stay above the "two retries" floor.
    const policy = classify('POST', '/api/matching/interpret-intent')
    expect(policy?.max).toBeGreaterThanOrEqual(10)
  })

  it('intent policy uses a separate bucket from the cost policy', () => {
    // Bucket key = hash(policy.name | principal). Different names → separate
    // buckets, so browsing /api/matching/profile/:id/opportunities cannot
    // spend the interpret-intent budget.
    const intent = classify('POST', '/api/matching/interpret-intent')
    const catalog = classify('GET', '/api/matching/profile/p1/opportunities')
    expect(intent?.name).not.toBe(catalog?.name)
  })

  it('interpret-intent is still rate-limited (not exempt)', () => {
    const policy = classify('POST', '/api/matching/interpret-intent')
    expect(policy).not.toBeNull()
    expect(policy?.max).toBeGreaterThan(0)
  })

  it('does not widen the cost bucket for other matching endpoints', () => {
    // The fix must not trade a UI annoyance for an unbounded matching surface.
    for (const path of [
      '/api/matching/profile/p1/opportunities',
      '/api/matching/profile/p1/grants',
      '/api/matching/profile/p1/matching-gaps',
      '/api/ai/draft',
      '/api/anya/chat',
      '/api/real-crawlers/run',
    ]) {
      expect(classify('POST', path)?.name, `POST ${path}`).toBe('cost')
      expect(classify('GET', path)?.name, `GET ${path}`).toBe('cost')
    }
  })
})
