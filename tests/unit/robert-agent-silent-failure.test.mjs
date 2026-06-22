// CUTOVER (Crawler OS): this file exercises the legacy crawler route/engine that
// is now a superseded no-op shim (backend/services/legacyCrawlSuperseded.js). The
// discovery/matching invariants it checked are owned + tested by the Crawler OS
// (backend/crawler-os/tests, 149 tests). Skipped pending a re-point to the OS pipeline.

/**
 * Regression: Robert must NEVER silently drop a verified opportunity.
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

describe.skip('robertAgent — verified opportunities are never silently lost', () => {
  it('records ingest failures in summary.errors + rejected instead of swallowing them', async () => {
    process.env.ROBERT_ENABLED = 'true'
    process.env.ROBERT_ALLOW_LIVE_WEB = 'true'
    process.env.ROBERT_AUTO_INGEST_VERIFIED = 'true'

    let upsertCalls = 0
    const result = await runRobert({
      db,
      mode: 'full-cycle',
      trigger: 'manual',
      profileIds: ['p1'],
      deps: {
        loadProfileContext: async () => PROFILE_CTX,
        // A real, verifiable opportunity that passes the canonical gates...
        opportunityAdapter: async () => ([
          {
            title: 'Real Grant',
            sponsor: 'FEMA',
            application_url: 'https://www.fema.gov/apply',
            source_url: 'https://www.fema.gov/x',
            deadline: '2099-09-01',
            deadline_type: 'fixed',
          },
        ]),
        seedSources: [{ id: 's1', source_url: 'https://www.fema.gov/grants', source_type: 'fire_department_grants' }],
        // ...but the canonical writer throws. This must NOT be swallowed silently.
        upsertFundingOpportunity: async () => {
          upsertCalls += 1
          throw new Error('simulated DB write failure')
        },
      },
    })

    assert.equal(upsertCalls, 1, 'the verified opportunity must reach the inserter')

    // The failure is recorded in the run summary's errors (no longer silent).
    const ingestErrors = (result.errors || []).filter((e) => e.stage === 'ingest_opportunity')
    assert.ok(ingestErrors.length >= 1, 'ingest failure must be recorded in summary.errors')
    assert.match(ingestErrors[0].error, /simulated DB write failure/)

    // And it is surfaced as a rejected candidate so it is not silently dropped.
    const ingestRejects = (result.rejected || []).filter((r) => r.reason === 'ingest_error')
    assert.ok(ingestRejects.length >= 1, 'failed ingest must surface as a rejected candidate')

    // The run still completes — one bad write does not crash the agent.
    assert.ok(result.ok, 'run should still complete')
    // It must NOT falsely report the opportunity as ingested.
    assert.equal((result.ingested || []).length, 0, 'a failed write must not be counted as ingested')
  })
})
