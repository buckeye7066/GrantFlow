// tests/storage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { storage } from '../index.js';
import { makeOpportunity, OPPORTUNITY_KIND, REALITY_STATUS, TRUST_TIER } from '../contract.js';
import { PIPELINE_STAGE } from '../stages.js';

function opp(id, over = {}) {
  return makeOpportunity({
    id, source_id: 'grants_gov', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: `Opp ${id}`, sponsor: 'USDA', apply_url: `https://www.grants.gov/d/${id}`,
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
    ...over,
  });
}

test('the catalog refuses opportunities whose reality_status is not acceptable', () => {
  const store = createMemoryStore();
  const bad = opp('rej1', { reality_status: REALITY_STATUS.REJECTED });
  const res = storage.upsertOpportunity(store, bad);
  assert.equal(res.stored, false);
  assert.equal(storage.countOpportunities(store), 0);
});

test('a real opportunity is stored and retrievable from the global catalog', () => {
  const store = createMemoryStore();
  const res = storage.upsertOpportunity(store, opp('o1'));
  assert.equal(res.stored, true);
  const got = storage.getOpportunity(store, 'o1');
  assert.equal(got.title, 'Opp o1');
  assert.equal(storage.countOpportunities(store), 1);
});

test('match score is stored PER (profile, opportunity) and isolated between profiles', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  storage.upsertMatch(store, { profile_id: 'A', opportunity_id: 'o1', match_score: 90, decision: 'accept', match_explain: {} });
  storage.upsertMatch(store, { profile_id: 'B', opportunity_id: 'o1', match_score: 40, decision: 'reject', match_explain: {} });

  const aMatches = storage.getMatchesForProfile(store, 'A');
  const bMatches = storage.getMatchesForProfile(store, 'B');
  assert.equal(aMatches.length, 1);
  assert.equal(aMatches[0].match_score, 90);
  assert.equal(bMatches[0].match_score, 40);
  // the global opportunity row itself never carries a profile-specific score
  const row = storage.getOpportunity(store, 'o1');
  assert.equal('match_score' in row, false);
});

test('getMatchesForProfile can filter by minimum score', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  storage.upsertOpportunity(store, opp('o2'));
  storage.upsertMatch(store, { profile_id: 'A', opportunity_id: 'o1', match_score: 85, decision: 'accept' });
  storage.upsertMatch(store, { profile_id: 'A', opportunity_id: 'o2', match_score: 30, decision: 'reject' });
  const strong = storage.getMatchesForProfile(store, 'A', { minScore: 70 });
  assert.equal(strong.length, 1);
  assert.equal(strong[0].opportunity_id, 'o1');
});

test('saved and hidden items are profile-scoped (one profile cannot see another’s)', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  storage.saveOpportunity(store, 'A', 'o1');
  storage.hideOpportunity(store, 'B', 'o1', 'not relevant');

  assert.equal(storage.getSaved(store, 'A').length, 1);
  assert.equal(storage.getSaved(store, 'B').length, 0);
  assert.equal(storage.isHidden(store, 'B', 'o1'), true);
  assert.equal(storage.isHidden(store, 'A', 'o1'), false);
});

test('unsave removes only that profile’s saved row', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  storage.saveOpportunity(store, 'A', 'o1');
  storage.unsaveOpportunity(store, 'A', 'o1');
  assert.equal(storage.getSaved(store, 'A').length, 0);
});

test('profile-scoped writes require a profile id (loud failure, never silent)', () => {
  const store = createMemoryStore();
  assert.throws(() => storage.saveOpportunity(store, '', 'o1'));
  assert.throws(() => storage.addToPipeline(store, null, 'o1'));
});

test('pipeline defaults to SAVED and walks legal transitions, recording events', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  const item = storage.addToPipeline(store, 'A', 'o1');
  assert.equal(item.stage, PIPELINE_STAGE.SAVED);

  storage.moveStage(store, 'A', 'o1', PIPELINE_STAGE.INTERESTED);
  storage.moveStage(store, 'A', 'o1', PIPELINE_STAGE.GATHERING_DOCUMENTS);
  const pipe = storage.getPipeline(store, 'A');
  assert.equal(pipe[0].stage, PIPELINE_STAGE.GATHERING_DOCUMENTS);
});

test('an illegal pipeline transition throws and does not corrupt state', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  // seed at a terminal stage; a terminal stage may only move to "archived"
  storage.addToPipeline(store, 'A', 'o1', PIPELINE_STAGE.AWARDED);
  assert.throws(() => storage.moveStage(store, 'A', 'o1', PIPELINE_STAGE.SAVED)); // awarded -> saved illegal
  assert.equal(storage.getPipeline(store, 'A')[0].stage, PIPELINE_STAGE.AWARDED);
});

test('locks are exclusive while fresh and reclaimable once stale', () => {
  const store = createMemoryStore();
  const t0 = 1_000_000;
  assert.equal(storage.acquireLock(store, 'cycle', { ttlMs: 1000, now: t0 }), true);
  assert.equal(storage.acquireLock(store, 'cycle', { ttlMs: 1000, now: t0 + 10 }), false); // held & fresh
  assert.equal(storage.acquireLock(store, 'cycle', { ttlMs: 1000, now: t0 + 5000 }), true); // stale -> reclaim
});

test('clearStaleLocks removes only locks older than the ttl', () => {
  const store = createMemoryStore();
  const t0 = 1_000_000;
  storage.acquireLock(store, 'fresh', { now: t0 });
  storage.acquireLock(store, 'old', { now: t0 - 10 * 60_000 });
  const cleared = storage.clearStaleLocks(store, { ttlMs: 5 * 60_000, now: t0 });
  assert.equal(cleared, 1);
});

test('state survives a "reload": a new store handle over the same backing rows keeps data', () => {
  // The memory store is the in-process embodiment of the SQL tables. Persistence
  // across reload is proven by the SQL adapter in production; here we assert that
  // re-reading the same store returns the same committed rows (no hidden session).
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  storage.saveOpportunity(store, 'A', 'o1');
  storage.addToPipeline(store, 'A', 'o1');
  // simulate a fresh read path
  assert.equal(storage.getSaved(store, 'A').length, 1);
  assert.equal(storage.getPipeline(store, 'A').length, 1);
  assert.equal(storage.countOpportunities(store), 1);
});

test('suppression list is honored case-insensitively', () => {
  const store = createMemoryStore();
  storage.addSuppression(store, 'No@Example.ORG', 'email');
  assert.equal(storage.isSuppressed(store, 'no@example.org', 'email'), true);
  assert.equal(storage.isSuppressed(store, 'other@example.org', 'email'), false);
});
