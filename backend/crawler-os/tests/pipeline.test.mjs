// tests/pipeline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { runDiscovery } from '../pipeline.js';
import { storage } from '../index.js';
import { buildThesis } from '../profileIntelligence.js';
import { makeOpportunity, OPPORTUNITY_KIND, REALITY_STATUS, TRUST_TIER } from '../contract.js';
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

test('when every source yields nothing, a zero-result ladder explains why and what next', async () => {
  // Force grants.gov to return zero rows AND fail the directory routes.
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
  assert.equal(r.stored, 0);
  assert.ok(r.zero_result, 'a zero-result ladder must be present');
  assert.ok(typeof r.zero_result.zero_result_reason === 'string');
  assert.ok(Array.isArray(r.zero_result.next_steps) && r.zero_result.next_steps.length > 0);
  assert.ok(Array.isArray(r.zero_result.searched_sources));
  assert.ok(r.profile_evolution, 'profile evolution signal must be returned');
  assert.equal(r.profile_evolution.event_type, 'profile_coverage_gap');
  assert.ok(Array.isArray(r.profile_evolution.recommended_source_lanes));
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
  assert.equal(storage.countOpportunities(d.store), 1, 'repeat crawl must not insert a duplicate catalog row');
  assert.ok(matches.some((m) => m.opportunity_id === canonicalId), 'existing canonical row is matched for this profile');
  assert.equal(r.zero_result, null, 'matching an existing real opportunity is not a zero-result crawl');
  assert.ok(r.sources.some((s) => s.existing > 0), 'source telemetry records existing canonical rows');
});
