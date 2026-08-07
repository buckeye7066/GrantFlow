// zeroFoundReasonHonesty.test.mjs
//
// A zero-found source must say WHY in a way an operator can act on.
//
// The reason string a source finishes with is what crawlerOsCoveragePersistence
// writes into crawler_source_runs.error, which is the ONLY failure text the
// admin Crawl Coverage dashboard shows. Before this guard, every zero-found
// source that was not a parse error reported the same `no_candidates_stored` —
// so the owner's "one source fails on 19 of 25 runs" (acf_chafee_foster) told
// nobody that the cause was a 404 on a dead ACF URL, and the 2026-08-06
// `bad_url` regression that zeroed 17 official lanes wore the same label.
//
// The taxonomy this pins:
//   parse_error                          — the source answered, the parser broke
//   fetch_failed:<detail>                — the source did not answer (status/err)
//   all_candidates_deduped               — real rows, already in the catalog
//   all_candidates_rejected:<reason>     — real rows, the reality gate said no
//   no_candidates_stored                 — a clean, genuinely empty answer

import test from 'node:test'
import assert from 'node:assert/strict'
import { runDiscovery } from '../pipeline.js'
import { createMemoryStore } from '../store.js'
import { buildThesis } from '../profileIntelligence.js'
import { SAMPLE_VFD_PROFILE, grantsGovBody } from './fixtures/fakeFetch.mjs'

const thesis = buildThesis(SAMPLE_VFD_PROFILE)

// An API-family source: when its fetch dies there is no registry-declared
// candidate to fall back on, so the run genuinely stores nothing — exactly the
// case that used to be laundered into `no_candidates_stored`.
const API_SOURCE_ID = 'grants_gov'

async function runOneSource(fetchImpl) {
  return runDiscovery(
    { store: createMemoryStore(), fetcher: { fetch: fetchImpl }, env: {} },
    { thesis, matchProfiles: [thesis], onlySourceIds: [API_SOURCE_ID] },
  )
}

test('a dead source URL reports the fetch failure, not "no_candidates_stored"', async () => {
  const run = await runOneSource(async () => ({ ok: false, status: 404, body: null, error: 'http_404' }))
  const summary = (run.sources ?? []).find((s) => s.source_id === API_SOURCE_ID)
  assert.ok(summary, 'expected the single planned source to be summarized')
  assert.notEqual(
    summary.reason,
    'no_candidates_stored',
    'a 404 must never be reported as "no candidates stored"',
  )
  assert.match(String(summary.reason), /^fetch_failed:/)
})

test('the fetch failure detail travels (status/error), so the dashboard names the cause', async () => {
  const run = await runOneSource(async () => ({ ok: false, status: 403, body: null, reason: 'status:403' }))
  const summary = (run.sources ?? []).find((s) => s.source_id === API_SOURCE_ID)
  assert.match(String(summary.reason), /403/)
})

test('a clean, genuinely empty answer still says no_candidates_stored', async () => {
  // An OK fetch whose parse yields nothing storable for a NON-directory family
  // is the honest empty case. api family + empty payload = zero candidates.
  const run = await runOneSource(async () => ({
    ok: true,
    status: 200,
    body: JSON.stringify(grantsGovBody([])),
    contentHash: 'h',
  }))
  const summary = (run.sources ?? []).find((s) => s.source_id === API_SOURCE_ID)
  assert.ok(summary, 'expected the single planned source to be summarized')
  assert.equal(summary.outcome, 'empty')
  assert.equal(summary.reason, 'no_candidates_stored')
})
