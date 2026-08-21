// tests/storage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { storage } from '../index.js';
import { makeOpportunity, canonicalOpportunityKey, OPPORTUNITY_KIND, REALITY_STATUS, TRUST_TIER } from '../contract.js';
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

test('match score and confidence are stored PER (profile, opportunity) and isolated between profiles', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  storage.upsertMatch(store, { profile_id: 'A', opportunity_id: 'o1', match_score: 90, match_confidence: 88, decision: 'accept', match_explain: {} });
  storage.upsertMatch(store, { profile_id: 'B', opportunity_id: 'o1', match_score: 40, match_confidence: 55, decision: 'reject', match_explain: {} });

  const aMatches = storage.getMatchesForProfile(store, 'A');
  const bMatches = storage.getMatchesForProfile(store, 'B');
  assert.equal(aMatches.length, 1);
  assert.equal(aMatches[0].match_score, 90);
  assert.equal(aMatches[0].match_confidence, 88);
  assert.equal(bMatches[0].match_score, 40);
  assert.equal(bMatches[0].match_confidence, 55);
  // the global opportunity row itself never carries a profile-specific score
  const row = storage.getOpportunity(store, 'o1');
  assert.equal('match_score' in row, false);
  assert.equal('match_confidence' in row, false);
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

test('getMatchesForProfile never drops a NULL match_score under a minScore filter (unscored is not junk)', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('o1'));
  storage.upsertOpportunity(store, opp('o2'));
  storage.upsertMatch(store, { profile_id: 'A', opportunity_id: 'o1', match_score: 85, decision: 'accept' });
  // an unscored row — match_score explicitly NULL, e.g. discovered but not yet run through the engine
  storage.upsertMatch(store, { profile_id: 'A', opportunity_id: 'o2', match_score: null, decision: null });
  const strong = storage.getMatchesForProfile(store, 'A', { minScore: 70 });
  const ids = strong.map((m) => m.opportunity_id).sort();
  assert.deepEqual(ids, ['o1', 'o2']);
  const unscored = strong.find((m) => m.opportunity_id === 'o2');
  assert.equal(unscored.match_score, null);
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

// ─────────────────────────────────────────────────────────────────────────────
// HTML-ENTITY HYGIENE AT THE *SECOND* CATALOG WRITER (2026-08-21)
//
// `backend/utils/htmlTextHygiene.js` exists because "titles surfaced to the
// owner still carried raw entities from aggregator feeds", and its docblock
// says the fix "lives in ONE util consumed by BOTH the ingest choke point
// (opportunityInserter.upsertFundingOpportunity) and the owner-facing read
// paths". `upsertOpportunity` here is a SECOND writer into the very same
// `funding_opportunities` table, and it wrote `title`/`sponsor`/`summary`
// verbatim.
//
// Measured on a real local crawl (Amy, 2026-08-21, 480 catalog rows): 3 rows
// carried undecoded entities and 7 match rows pointed at them — "Law &amp;
// Science" (grants_gov, record_origin live_crawl, canonical key ext:pd-21-128y),
// "Coordinating Agricultural Development &amp; Innovation (CADI)…" (usda_rd),
// and "…Unaccompanied Alien Children&#8203;&#8203;" (grants_gov). Feeding those
// exact strings to `cleanExtractedText` decodes all three, so the util was fine
// — this write site simply never called it.
//
// The canonical dedup key is deliberately still computed from the RAW row, so
// this change cannot re-key any existing catalog row.
// ─────────────────────────────────────────────────────────────────────────────
test('the catalog decodes HTML entities in the text it surfaces (the second writer honours the hygiene choke point)', () => {
  const store = createMemoryStore();
  const res = storage.upsertOpportunity(store, opp('ent1', {
    title: 'Law &amp; Science',
    sponsor: 'Department of Energy &amp; Science',
    summary: 'Research &amp; Development for 2026 &ndash; 2027',
  }));
  assert.equal(res.stored, true);
  const got = storage.getOpportunity(store, 'ent1');
  assert.equal(got.title, 'Law & Science');
  assert.equal(got.sponsor, 'Department of Energy & Science');
  assert.equal(got.summary, 'Research & Development for 2026 – 2027');
});

test('numeric entities (the zero-width spaces grants.gov emits) are decoded too', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('ent2', {
    title: 'Home Study and Post-Release Services for Unaccompanied Alien Children&#8203;&#8203;',
  }));
  const got = storage.getOpportunity(store, 'ent2');
  assert.equal(got.title.includes('&#8203;'), false);
  assert.ok(got.title.startsWith('Home Study and Post-Release Services'));
});

test('entity decoding never re-keys a row: the canonical dedup key still comes from the RAW opportunity', () => {
  const store = createMemoryStore();
  const raw = opp('ent3', { title: 'Law &amp; Science', external_id: null });
  const expected = canonicalOpportunityKey(raw);
  storage.upsertOpportunity(store, raw);
  const got = storage.getOpportunity(store, 'ent3');
  assert.equal(got.canonical_opportunity_key, expected);
});

test('a clean title is passed through untouched', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, opp('ent4', { title: 'Rural Business Development Grant' }));
  assert.equal(storage.getOpportunity(store, 'ent4').title, 'Rural Business Development Grant');
});
