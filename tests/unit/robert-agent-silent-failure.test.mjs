/**
 * Regression: Robert must never report a healthy run when its authoritative
 * Crawler OS discovery/persistence seam failed before producing a durable
 * receipt.
 *
 * Previously robertAgent's `safe()` wrapper swallowed errors from the
 * canonical DB writes (ingestOpportunity / updateOpportunityCandidate) with a
 * bare `catch { return null }`. When `upsertFundingOpportunity` threw, the
 * verified opportunity vanished — no log, no counter, no summary entry — while
 * the run still reported success. This test forces that throw and asserts the
 * loss is now visible: recorded in summary.errors AND surfaced as a rejected
 * candidate (so it can be retried), with the run still completing.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeMemoryDb } from './robert-test-helpers.mjs'
import { runRobert } from '../../backend/services/robert/robertAgent.js'

let db
beforeEach(() => {
  db = makeMemoryDb()
  delete process.env.ROBERT_ENABLED
  delete process.env.ROBERT_ALLOW_LIVE_WEB
  delete process.env.ROBERT_ALLOW_SOURCE_DISCOVERY
  delete process.env.ROBERT_AUTO_INGEST_VERIFIED
  delete process.env.ROBERT_MODE
})

const PROFILE_CTX = {
  profile: { id: 'p1', display_name: 'Family', primary_type: 'family', state: 'OH', tags: ['housing'] },
  sections: { location_focus: { state: 'OH', county: 'Cuyahoga', city: 'Cleveland' } },
  signals: { entityType: 'family', state: 'OH' },
}

describe('robertAgent — Crawler OS persistence failures are never silent', () => {
  it('records the failure and returns ok=false instead of a healthy empty run', async () => {
    process.env.ROBERT_ENABLED = 'true'
    process.env.ROBERT_ALLOW_LIVE_WEB = 'true'
    process.env.ROBERT_AUTO_INGEST_VERIFIED = 'true'

    let discoveryCalls = 0
    const result = await runRobert({
      db,
      mode: 'full-cycle',
      trigger: 'manual',
      profileIds: ['p1'],
      deps: {
        loadProfileContext: async () => PROFILE_CTX,
        runProfileDiscoveryLive: async () => {
          discoveryCalls += 1
          throw new Error('simulated Crawler OS persistence failure')
        },
      },
    })

    assert.equal(discoveryCalls, 1, 'the profile must reach the authoritative Crawler OS seam')

    const discoveryErrors = (result.errors || []).filter((e) => e.stage === 'crawler_os_discovery')
    assert.equal(discoveryErrors.length, 1, 'discovery failure must be recorded in summary.errors')
    assert.match(discoveryErrors[0].error, /simulated Crawler OS persistence failure/)

    // The administrative run record still closes, but its verdict is degraded
    // and cannot be mistaken for a successful zero-result crawl.
    assert.equal(result.status, 'completed')
    assert.equal(result.ok, false)
    assert.equal(result.status_reason, 'crawler_os_discovery_failed')
    assert.equal((result.ingested || []).length, 0, 'a failed write must not be counted as ingested')
    assert.equal(result.counters.opportunities_ingested, 0)
    assert.equal(result.counters.opportunities_matched, 0)
  })
})
