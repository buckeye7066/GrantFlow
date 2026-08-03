// tests/pipeline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { runDiscovery } from '../pipeline.js';
import { storage } from '../index.js';
import { buildThesis } from '../profileIntelligence.js';
import { makeOpportunity, OPPORTUNITY_KIND, REALITY_STATUS, TRUST_TIER, canonicalOpportunityKey } from '../contract.js';
import { makeOfflineFetcher, grantsGovBody, SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';

function deps(fetchOpts = {}) {
  return {
    store: createMemoryStore(),
    fetcher: makeOfflineFetcher(fetchOpts),
    env: {},
    clock: () => Date.now(),
  };
}

test('discovery stores at least one REAL opportunity end-to-end (no network, no mocks in catalog)', async () => {
  const d = deps();
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const r = await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run1' });
  assert.ok(r.stored >= 1, `expected >=1 stored, got ${r.stored}`);
  assert.equal(storage.countOpportunities(d.store), r.stored);
  // every stored row has a real sponsor and an acceptable reality status
  for (const o of storage.listCatalog(d.store)) {
    assert.ok(o.sponsor && o.sponsor.length > 1);
    assert.notEqual(o.reality_status, 'rejected');
  }
});

test('discovery produces per-profile matches for a matched profile', async () => {
  const d = deps();
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run1' });
  const matches = storage.getMatchesForProfile(d.store, thesis.profile_id);
  assert.ok(matches.length >= 1);
  for (const m of matches) assert.ok(['accept', 'review', 'reject'].includes(m.decision));
  // Crawler-doctor provenance: adapter-lane matches record the SOURCE that
  // produced them (no query string exists for API adapters — that stays null).
  for (const m of matches) {
    assert.ok(typeof m.discovered_via === 'string' && m.discovered_via.length > 0);
    assert.equal(m.source_query, null);
  }
});

test('a placeholder candidate is rejected by the reality gate and never enters the catalog', async () => {
  // Inject a grants.gov body whose only row is lorem-ipsum placeholder content.
  const d = deps({
    grantsGov: [{ title: 'lorem ipsum placeholder', agency: 'Test', closeDate: '12/31/2026' }],
  });
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const r = await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run1' });
  // the placeholder must be rejected; catalog stays clean of it
  for (const o of storage.listCatalog(d.store)) {
    assert.ok(!/lorem ipsum/i.test(o.title ?? ''));
  }
  assert.ok(r.rejected >= 1 || r.stored === 0);
});

test('failed directory fetches still surface honest registry-built rows (fetch failure ≠ zero results)', async () => {
  // grants.gov empty AND every fetch fails. Registry-declared candidates
  // (parseCfg.directoryCandidate) are built entirely from curated registry
  // config (parseDirectory ignores the body), so a transient fetch failure —
  // a site hiccup, a WAF 403, or a CI runner whose egress to those sites is
  // blocked — must not erase the honest rows a sparse profile depends on.
  // This was zeroing the discover-local-funding release gate in CI
  // (2026-07-01). Survival is kind-agnostic (a real BENEFIT program is not
  // relabeled "directory" to stay resilient), but TRUTH is preserved: a row
  // stored without a fetched body must never claim VERIFIED/ROLLING reality.
  const d = deps({ grantsGov: [], fail: new Set([
    'cof.org',
    'benefits.gov',
    'api.grants.gov',
    'api.sam.gov',
    'federalregister.gov',
    'fema.gov',
    'rd.usda.gov',
    'dhs.gov',
    'cops.usdoj.gov',
  ]) });
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const r = await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run0' });
  assert.ok(r.stored >= 1, `registry-built rows must survive fetch failures (stored=${r.stored})`);
  for (const o of storage.listCatalog(d.store)) {
    assert.ok(
      [REALITY_STATUS.DIRECTORY, REALITY_STATUS.LINK_UNVERIFIED].includes(o.reality_status),
      `a row stored without a fetched body must be honestly unverified (directory or link_unverified), got reality_status=${o.reality_status} kind=${o.kind} for "${o.title}"`,
    );
  }
  assert.ok(!r.zero_result, 'no zero-result ladder when honest rows stored');
});

test('when a run truly stores nothing, the zero-result ladder explains why and what next', async () => {
  // Honest DIRECTORY locators now survive fetch failures, so an organic
  // all-sources zero is unreachable for any thesis whose plan includes a
  // directory source — the ladder remains the safety net for the paths that
  // can still zero (no sources selected, every candidate gate-rejected).
  // Unit-test the builder directly with a realistic failed-run shape.
  const { _internal } = await import('../pipeline.js');
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const thePlan = { selected_source_ids: ['grants_gov', 'sam_gov'], source_decisions: [] };
  const summaries = [
    { source_id: 'grants_gov', outcome: 'error', reason: 'fetch_failed', fetched: 1, parsed: 0, rejected: 0, stored: 0, existing: 0, deduped: 0, queries: [] },
    { source_id: 'sam_gov', outcome: 'error', reason: 'fetch_failed', fetched: 1, parsed: 0, rejected: 0, stored: 0, existing: 0, deduped: 0, queries: [] },
  ];
  const ladder = _internal.buildLadder(thesis, thePlan, summaries, 'all_sources_failed');
  assert.ok(ladder, 'a zero-result ladder must be present');
  assert.ok(typeof ladder.zero_result_reason === 'string');
  assert.ok(Array.isArray(ladder.next_steps) && ladder.next_steps.length > 0);
  assert.ok(Array.isArray(ladder.searched_sources));
});

test('telemetry records the run and its source outcomes (nothing fails silently)', async () => {
  const d = deps();
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'runT' });
  const run = storage.getRun(d.store, 'runT');
  assert.ok(run, 'crawler_runs row persisted');
  assert.equal(run.run_id, 'runT');
});

test('grantsGovBody helper shapes a realistic Search2 payload', () => {
  const body = grantsGovBody([{ title: 'X', agency: 'USDA' }]);
  assert.ok(Array.isArray(body.data.oppHits));
  assert.equal(body.data.oppHits[0].title, 'X');
});

test('multi-query API crawlers dedupe repeated rows within the same source run', async () => {
  const d = deps();
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const r = await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run_multi' });
  const grants = r.sources.find((s) => s.source_id === 'grants_gov');
  assert.ok(grants.fetched > 1, 'grants.gov should now run multiple focused queries');
  assert.equal(grants.stored, 2, 'duplicate rows from multiple queries count once per source run');
  assert.equal(r.recommendations.length, new Set(r.recommendations.map((x) => x.opportunity_id)).size, 'recommendations are deduped too');
});

test('required API schema drift is surfaced as PARSE_ERROR, not a misleading empty source', async () => {
  const d = deps({ routes: { 'api.grants.gov': { data: { unexpectedKey: [] } } } });
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const r = await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run_schema_drift' });
  const apiSources = r.sources.filter((s) => ['grants_gov', 'fema_afg', 'usda_rd'].includes(s.source_id));
  assert.ok(apiSources.length >= 1);
  assert.ok(apiSources.every((s) => s.outcome === 'parse_error'));
  assert.ok(apiSources.every((s) => s.reason === 'parse_error'));
});

test('the same real grant found by multiple crawlers is stored ONCE (cross-source dedup)', async () => {
  // grants_gov is a catch-all; usda_rd / fema_afg re-surface some of the same
  // grants.gov opportunities. The catalog must collapse them to one row each, so
  // the user never sees a duplicate and stored/recommendation counts stay honest.
  const d = deps();
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const r = await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run_xsrc_dedup' });

  const rows = storage.listCatalog(d.store);
  const realIds = new Set(rows.map((o) => `${(o.apply_url || o.info_url || '').toLowerCase()}|${o.external_id ?? ''}`));
  assert.equal(rows.length, realIds.size, 'no real-world opportunity is stored under two different catalog ids');
  assert.equal(storage.countOpportunities(d.store), realIds.size, 'catalog count equals distinct real opportunities');

  // recommendations are unique per opportunity too (no inflation from dedup sources)
  const recIds = r.recommendations.map((x) => x.opportunity_id);
  assert.equal(recIds.length, new Set(recIds).size, 'recommendations carry no duplicate opportunity');

  // at least one specialized adapter reports a dedup against the catch-all
  const deduped = r.sources.reduce((n, s) => n + (s.deduped ?? 0), 0);
  assert.ok(deduped >= 1, 'specialized agency adapters dedup against the grants_gov catch-all');
});

test('existing canonical rows are still matched on a later crawl (no false zero)', async () => {
  const d = deps({
    grantsGov: [{
      id: 'OPP-7777',
      title: 'Volunteer Fire Equipment Grant',
      agency: 'FEMA',
      agencyCode: 'DHS-FEMA',
      summary: 'Funding for volunteer fire department emergency equipment.',
      closeDate: '12/31/2026',
    }],
    fail: new Set(['cof.org', 'benefits.gov', 'sam.gov', 'federalregister.gov', 'grants.nih.gov']),
  });
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const canonicalId = 'seeded-canonical-fema';
  const applyUrl = 'https://www.grants.gov/search-results-detail/OPP-7777';

  storage.upsertOpportunity(d.store, makeOpportunity({
    id: canonicalId,
    source_id: 'seeded_catalog',
    external_id: 'OPP-7777',
    kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Volunteer Fire Equipment Grant',
    sponsor: 'FEMA',
    summary: 'Funding for volunteer fire department emergency equipment.',
    apply_url: applyUrl,
    info_url: applyUrl,
    applicant_types: ['vfd'],
    need_categories: ['equipment', 'emergency'],
    geography: { national: true, states: [] },
    funding: { amount_max: 50000 },
    reality_status: REALITY_STATUS.VERIFIED,
    trust_tier: TRUST_TIER.OFFICIAL_API,
  }));

  const r = await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run_existing_canonical' });
  const matches = storage.getMatchesForProfile(d.store, thesis.profile_id);

  // Dedup invariant: the fresh crawl re-found OPP-7777 via grants.gov but must
  // NOT insert a SECOND row for it — it folds into the seeded canonical row.
  // (Other distinct directory resources a VFD profile legitimately surfaces —
  // e.g. DHS/FEMA program directories — are not duplicates, so we assert on the
  // canonical opportunity specifically, not the whole-catalog count.)
  const canonicalKey = canonicalOpportunityKey({ apply_url: applyUrl, external_id: 'OPP-7777' });
  const canonicalDupes = storage.listCatalog(d.store).filter((o) => o.canonical_opportunity_key === canonicalKey);
  assert.equal(canonicalDupes.length, 1, 'repeat crawl must not insert a duplicate of the seeded canonical opportunity');
  assert.equal(canonicalDupes[0].id, canonicalId, 'the crawl folds into the existing canonical row (keeps its id)');

  const grants = r.sources.find((s) => s.source_id === 'grants_gov');
  assert.equal(grants.stored, 0, 'grants.gov re-find of the seeded opportunity stores no new catalog row');
  assert.ok(grants.existing >= 1, 'grants.gov telemetry records the existing canonical row it matched');

  assert.ok(matches.some((m) => m.opportunity_id === canonicalId), 'existing canonical row is matched for this profile');
  assert.equal(r.zero_result, null, 'matching an existing real opportunity is not a zero-result crawl');
  assert.ok(r.sources.some((s) => s.existing > 0), 'source telemetry records existing canonical rows');
});

test('recommendations carry the DESCRIPTION — the text the generic-only cap evaluated (Amy reads the same text)', async () => {
  // The engine's generic-only ACCEPT cap tests isGenericOnly(title + description);
  // Amy's false_positive detector must evaluate the SAME text. If the rec row
  // drops the description, Amy degrades to title-only and re-flags rows the cap
  // deliberately rescued via a concrete description anchor (the El Paso County
  // General Assistance shape, 2026-08-02).
  const d = deps();
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const r = await runDiscovery(d, { thesis, matchProfiles: [thesis], runId: 'run_desc' });
  assert.ok(r.recommendations.length >= 1, 'fixture run must recommend something for this guard to bite');
  for (const rec of r.recommendations) {
    assert.ok('description' in rec, `recommendation "${rec.title}" must carry a description field (may be null, never absent)`);
  }
});
