// tests/robert.test.mjs
//
// Robert — funding discovery & recommendation. These tests pin the per-profile
// recommendation ROLLUP against the 2026-07-06 DATA-POINT match scale.
//
// Regression guarded here (goal drift): the rollup used to filter ACCEPT rows by
// the thesis `min_match_score`, which defaults to 55/60 — a value on the RETIRED
// 0-100 slider scale. On the data-point scale real matches run p50=8 / p90=15 /
// max~47 and ACCEPT fires around 11, so a 55/60 floor discarded effectively
// EVERY genuine recommendation for a real profile, silently emptying the rollup.
// The authoritative gate is now the canonical engine's `decision === 'accept'`,
// with no re-derived numeric floor (crawler-os is import-isolated from
// config/matchThresholds by design — see legacy-crawler-ban.test.mjs). The
// score-20 ACCEPT case below FAILS on the old `minScore: th.min_match_score`.
//
// NOTE: scale constants are written as literals on purpose — this file lives
// under backend/crawler-os/ and may not import config/matchThresholds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createFetcher } from '../fetcher.js';
import { createRobert } from '../agents/robert.js';
import { storage } from '../index.js';
import { buildThesis } from '../profileIntelligence.js';

// A fetcher that reaches "the network" but every route returns an empty body, so
// runDiscovery adds no NEW opportunities from the offline routes. (The OS
// registry/directory lanes may still synthesize their own rows; the assertions
// below are therefore membership checks over the SEEDED rows, not exact sets.)
function emptyFetcher() {
  return createFetcher({
    doFetch: async (url) => ({
      status: 200,
      ok: true,
      url,
      headers: { get: () => null },
      async text() { return '{}'; },
    }),
    resolve: async () => ['203.0.113.10'],
    rateMs: 0,
  });
}

// Minimal catalog row — getMatchesForProfile only reads these columns back.
function seedOpp(store, id, over = {}) {
  store.upsert('funding_opportunities', ['id'], {
    id,
    title: over.title ?? `Opportunity ${id}`,
    sponsor: over.sponsor ?? 'Example Funder',
    kind: over.kind ?? 'DIRECT_GRANT',
    apply_url: over.apply_url ?? `https://example.org/apply/${id}`,
    reality_status: 'verified',
  });
}

const REAL_PROFILE = { id: 'p_real', type: 'individual', state: 'TN', location: { state: 'TN' }, needs: ['housing'] };

test('Robert surfaces a real ACCEPT recommendation scored below the retired 55/60 floor', async () => {
  const store = createMemoryStore();
  const pid = buildThesis(REAL_PROFILE).profile_id;
  assert.equal(pid, 'p_real', 'buildThesis derives profile_id from profile.id');
  // Sanity: for an individual profile the thesis floor is the retired 55 value.
  assert.equal(buildThesis(REAL_PROFILE).min_match_score, 55);

  seedOpp(store, 'opp_real', { title: 'Emergency Rental Assistance' });
  // A genuine ACCEPT on the data-point scale: decision accept, score 20 — a
  // realistic real-profile match (11 ≤ 20 ≪ 55), i.e. above the ACCEPT band but
  // far below the retired slider floor.
  storage.upsertMatch(store, { profile_id: pid, opportunity_id: 'opp_real', match_score: 20, decision: 'accept' });

  const robert = createRobert({ store, fetcher: emptyFetcher(), env: {} });
  const result = await robert.run({ profiles: [REAL_PROFILE] });

  const recs = result.recommendations_by_profile?.[pid] ?? [];
  const real = recs.find((r) => r.opportunity_id === 'opp_real');
  assert.ok(real, 'the score-20 ACCEPT must appear in the rollup (fails on the old 55/60 floor)');
  assert.equal(real.title, 'Emergency Rental Assistance');
});

test('Robert rollup returns only ACCEPT-decision rows (REVIEW is never a recommendation)', async () => {
  const store = createMemoryStore();
  const pid = buildThesis(REAL_PROFILE).profile_id;

  seedOpp(store, 'opp_accept', { title: 'Real Accept' });
  seedOpp(store, 'opp_review', { title: 'Directory Locator' });

  // ACCEPT at a realistic sub-55 score → included.
  storage.upsertMatch(store, { profile_id: pid, opportunity_id: 'opp_accept', match_score: 14, decision: 'accept' });
  // REVIEW decision, even scored very high → NEVER a recommendation. This is the
  // authoritative gate: a directory locator is a pointer, not a strong match.
  storage.upsertMatch(store, { profile_id: pid, opportunity_id: 'opp_review', match_score: 100, decision: 'review' });

  const robert = createRobert({ store, fetcher: emptyFetcher(), env: {} });
  const result = await robert.run({ profiles: [REAL_PROFILE] });

  const recs = result.recommendations_by_profile?.[pid] ?? [];
  const ids = new Set(recs.map((r) => r.opportunity_id));
  assert.ok(ids.has('opp_accept'), 'the ACCEPT row is recommended');
  assert.ok(!ids.has('opp_review'), 'a REVIEW-decision row is never recommended, even at score 100');
  // Every returned row is a genuine ACCEPT with a real numeric score.
  for (const r of recs) {
    assert.equal(r.decision, 'accept');
    assert.equal(typeof r.match_score, 'number');
  }
});

test('Robert builds the universe with no profiles without throwing (no rollup, no floor drift)', async () => {
  const store = createMemoryStore();
  const robert = createRobert({ store, fetcher: emptyFetcher(), env: {} });
  const result = await robert.run({ profiles: [] });
  assert.equal(result.agent, 'robert');
  assert.ok(Number.isFinite(result.stored_total));
  assert.deepEqual(result.recommendations_by_profile, {}, 'no profiles → empty rollup');
});
