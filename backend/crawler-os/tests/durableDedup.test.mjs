// crawler-os/tests/durableDedup.test.mjs
//
// Requirement D — durable cross-source / cross-run dedup. The run-local Map in
// pipeline.js collapses duplicates WITHIN a run; these tests prove the store is
// the permanent authority that keeps the catalog and recommendation list from
// inflating ACROSS runs, and that provenance (which crawlers found it) survives.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../store.js';
import { upsertOpportunity, countOpportunities } from '../storage.js';
import { makeOpportunity, deterministicOpportunityId, canonicalOpportunityKey, TRUST_TIER } from '../contract.js';

// Build the same real-world opportunity (same apply_url) as seen by two
// different sources. The id folds in source_id, so the ids differ — exactly the
// case that would have produced two catalog rows before durable dedup.
function sameGrantFrom(sourceId) {
  const apply_url = 'https://www.grants.gov/web/grants/view-opportunity.html?oppId=ABC-123';
  const id = deterministicOpportunityId({ source_id: sourceId, apply_url, title: 'Rural Water Grant' });
  return makeOpportunity({
    id,
    source_id: sourceId,
    apply_url,
    title: 'Rural Water Grant',
    sponsor: 'USDA',
    
    trust_tier: TRUST_TIER.OFFICIAL_API,
    reality_status: 'verified',
    funding: { amount_min: 1000, amount_max: 50000 },
    evidence: { url: apply_url, content_hash: 'abc', fetched_at: '2026-06-22T00:00:00.000Z' },
  });
}

test('same real opportunity from two sources has different id but same canonical key', () => {
  const a = sameGrantFrom('grants_gov');
  const b = sameGrantFrom('fema_afg');
  assert.notEqual(a.id, b.id, 'ids fold in source_id and must differ');
  assert.equal(canonicalOpportunityKey(a), canonicalOpportunityKey(b), 'canonical key is source-independent');
});

test('same opportunity found by two sources in DIFFERENT runs stores exactly once', () => {
  const store = createMemoryStore();

  // Run 1: grants_gov stores it.
  const r1 = upsertOpportunity(store, sameGrantFrom('grants_gov'));
  assert.equal(r1.stored, true);

  // Run 2 (fresh pipeline, run-local Map empty): fema_afg re-finds the same grant.
  const r2 = upsertOpportunity(store, sameGrantFrom('fema_afg'));
  assert.equal(r2.stored, false, 'second source must not create a second catalog row');
  assert.equal(r2.deduped, true, 'it is a durable dedup, not a rejection');

  assert.equal(countOpportunities(store), 1, 'catalog holds exactly one row across runs');
});

test('dedup preserves provenance of every source that found the opportunity', () => {
  const store = createMemoryStore();
  const first = sameGrantFrom('grants_gov');
  upsertOpportunity(store, first);
  const r2 = upsertOpportunity(store, sameGrantFrom('fema_afg'));

  const sources = store.all('opportunity_sources', { opportunity_id: first.id });
  const sourceIds = sources.map((s) => s.source_id).sort();
  assert.deepEqual(sourceIds, ['fema_afg', 'grants_gov'], 'both finders recorded against the canonical row');
  assert.equal(r2.canonical_id, first.id, 'dedup reports the canonical row it collapsed into');
});

test('distinct opportunities are NOT merged (no false dedup)', () => {
  const store = createMemoryStore();
  upsertOpportunity(store, sameGrantFrom('grants_gov'));
  const other = makeOpportunity({
    id: deterministicOpportunityId({ source_id: 'grants_gov', apply_url: 'https://example.gov/other', title: 'Other' }),
    source_id: 'grants_gov',
    apply_url: 'https://example.gov/other',
    title: 'Other', sponsor: 'X', 
    trust_tier: TRUST_TIER.OFFICIAL_API, reality_status: 'verified',
    funding: { amount_min: 0, amount_max: 0 },
  });
  const r = upsertOpportunity(store, other);
  assert.equal(r.stored, true);
  assert.equal(countOpportunities(store), 2, 'different real opportunities remain distinct');
});
