/**
 * Unit tests for the active search-provider health probe
 * (services/searchProviderHealth.js) — the autonomous "crawler doctor" lane.
 *
 * All network is injected via fetchImpl; the live probe is never hit (and the
 * service itself refuses to go live under GRANTFLOW_TEST_RUNNER without an
 * injected fetch).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { probeSearchProviderHealth, _resetSearchProviderHealthForTests } from '../services/searchProviderHealth.js'

function jsonResponse(status, body) {
  return { status, json: async () => body }
}

function searxngBody({ engines = ['bing'], unresponsive = [], count = 5 } = {}) {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      url: `https://example.org/${i}`,
      title: `result ${i}`,
      content: 'snippet',
      engines,
    })),
    unresponsive_engines: unresponsive,
  }
}

const HEALTHY_UNRESPONSIVE = []
const COLLAPSED_UNRESPONSIVE = [
  ['brave', 'Suspended: too many requests'],
  ['google cse', 'Suspended: too many requests'],
  ['startpage', 'Suspended: CAPTCHA'],
  ['qwant', 'CAPTCHA'],
]

beforeEach(() => {
  _resetSearchProviderHealthForTests()
  process.env.SEARXNG_URL = 'https://searx.example.com'
  process.env.BRAVE_SEARCH_API_KEY = 'test-key'
})

afterEach(() => {
  delete process.env.SEARXNG_URL
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.SEARXNG_FALLBACK_ENGINES
  _resetSearchProviderHealthForTests()
})

describe('probeSearchProviderHealth', () => {
  it('reports healthy when the default engine set answers with a diverse fleet', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('brave.com')) return jsonResponse(200, { web: { results: [] } })
      return jsonResponse(200, searxngBody({ engines: ['bing', 'yandex', 'startpage'], unresponsive: HEALTHY_UNRESPONSIVE }))
    })
    const health = await probeSearchProviderHealth({ fetchImpl, cacheTtlMs: 0 })
    expect(health.verdict).toBe('healthy')
    expect(health.searxng.bing_only).toBe(false)
    expect(health.brave.ok).toBe(true)
  })

  it('reports degraded with the exact suspension reasons on the 2026-07-28 state (bing-only + Brave 402)', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('brave.com')) return jsonResponse(402, {})
      if (u.includes('engines=')) return jsonResponse(200, searxngBody({ engines: ['yandex'], unresponsive: [] }))
      return jsonResponse(200, searxngBody({ engines: ['bing'], unresponsive: COLLAPSED_UNRESPONSIVE }))
    })
    const health = await probeSearchProviderHealth({ fetchImpl, cacheTtlMs: 0 })
    expect(health.verdict).toBe('degraded')
    expect(health.searxng.bing_only).toBe(true)
    expect(health.searxng.suspended_engines.map((u) => u.engine)).toContain('brave')
    expect(health.brave.ok).toBe(false)
    expect(health.brave.status).toBe(402)
    expect(health.detail).toMatch(/bing-only/)
    expect(health.detail).toMatch(/402/)
  })

  it('reports down when nothing answers anywhere', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('brave.com')) return jsonResponse(402, {})
      return jsonResponse(200, searxngBody({ engines: [], unresponsive: COLLAPSED_UNRESPONSIVE, count: 0 }))
    })
    const health = await probeSearchProviderHealth({ fetchImpl, cacheTtlMs: 0 })
    expect(health.verdict).toBe('down')
  })

  it('a fetch throw is contained (never throws) and reads as unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const health = await probeSearchProviderHealth({ fetchImpl, cacheTtlMs: 0 })
    expect(health.verdict).toBe('down')
    expect(health.searxng.reachable).toBe(false)
  })

  it('caches the probe so several Sam checks in one sweep share one network pass', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('brave.com')) return jsonResponse(200, {})
      return jsonResponse(200, searxngBody({ engines: ['bing', 'yandex'] }))
    })
    let clock = 1_000_000
    const now = () => clock
    const first = await probeSearchProviderHealth({ fetchImpl, now })
    const callsAfterFirst = fetchImpl.mock.calls.length
    const second = await probeSearchProviderHealth({ fetchImpl, now })
    expect(second).toBe(first)
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst)
    // TTL expiry re-probes.
    clock += 11 * 60 * 1000
    await probeSearchProviderHealth({ fetchImpl, now })
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('refuses to probe the live web from the unit-test runner without an injected fetch', async () => {
    const health = await probeSearchProviderHealth()
    expect(health.skipped).toBe(true)
    expect(health.verdict).toBe('unknown')
  })

  it('reports unconfigured as a FINDING (not a skip) when neither provider has config', async () => {
    // Regression guard: `unconfigured` MUST NOT be `skipped`, or the
    // crawler.searchProviderHealth Sam check (which returns green on skipped)
    // reports the dark open-web lane as healthy and the owner is never told to
    // set a key. The only true skip is the test-runner `unknown` path.
    delete process.env.SEARXNG_URL
    delete process.env.BRAVE_SEARCH_API_KEY
    const health = await probeSearchProviderHealth({ fetchImpl: vi.fn(), cacheTtlMs: 0 })
    expect(health.skipped).toBe(false)
    expect(health.verdict).toBe('unconfigured')
    expect(health.detail).toMatch(/SEARXNG_URL|BRAVE_SEARCH_API_KEY/)
  })
})
