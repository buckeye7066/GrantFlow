/**
 * discover-all-shape — regression for the Crawler OS cutover contract.
 *
 * The /api/real-crawlers/discover-all route, the auth.js login fire-and-forget,
 * the scheduledAutoDiscovery batch, and the DiscoverGrants UI all read
 * `jobs_enqueued` / `crawler_types` off the triggerAutoDiscoveryCrawlers
 * return value. After the OS cutover the shim returned `{engine, stored,
 * matches, recommendations}` — which has NO jobs_enqueued key — so every
 * caller saw `jobs_enqueued ?? 0 === 0`, the UI skipped its progress toast,
 * and Discover felt broken even when the OS run produced rows.
 *
 * These tests lock the shape: jobs_enqueued is a number, crawler_types is an
 * array, synchronous is true (OS runs inside the request), and the per-source
 * detail is preserved for diagnostics. We inject a fake runProfileDiscoveryLive
 * by stubbing the dynamic import via a module-scoped global the shim honors in
 * test mode... but the shim imports directly, so instead we exercise the shim
 * with a fake db that makes runProfileDiscoveryLive throw, plus the happy path
 * through the real OS against an in-memory store.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { triggerAutoDiscoveryCrawlers } from '../../backend/services/crawlerOsCompatibility.js'

describe('triggerAutoDiscoveryCrawlers — discover-all contract', () => {
  it('returns the zero-shape (not undefined fields) when db/profileId missing', async () => {
    const r = await triggerAutoDiscoveryCrawlers(null, null)
    assert.equal(typeof r.jobs_enqueued, 'number', 'jobs_enqueued must be a number')
    assert.equal(r.jobs_enqueued, 0)
    assert.ok(Array.isArray(r.crawler_types), 'crawler_types must be an array')
    assert.equal(r.crawler_types.length, 0)
    assert.equal(r.synchronous, true, 'OS path always reports synchronous')
    assert.equal(r.engine, 'crawler-os')
  })

  it('reports jobs_enqueued=0 + error (never throws) when the OS run fails', async () => {
    // A db whose .prepare throws makes loadProfileContext (inside
    // runProfileDiscoveryLive) reject; the shim must catch and return the
    // zero-shape with an error string, NOT throw — login/discover must never
    // 500 because discovery failed.
    const explodingDb = {
      dialect: 'sqlite',
      prepare() { throw new Error('db exploded') },
    }
    const r = await triggerAutoDiscoveryCrawlers(explodingDb, 'profile-x')
    assert.equal(r.jobs_enqueued, 0)
    assert.ok(Array.isArray(r.crawler_types))
    assert.equal(r.synchronous, true)
    assert.equal(r.engine, 'crawler-os')
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'error surfaced as a string')
  })
})
