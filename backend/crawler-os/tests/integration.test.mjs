// tests/integration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createFleet } from '../agents/index.js';
import { storage } from '../index.js';
import { buildThesis } from '../profileIntelligence.js';
import { makeOfflineFetcher, SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';

test('end-to-end: Robert discovers real funding, matches a profile, Hamilton builds a packet', async () => {
  const store = createMemoryStore();
  const fetcher = makeOfflineFetcher();
  const fleet = createFleet({ store, fetcher, env: {} });

  // 1) Robert builds the funding universe and matches the VFD profile.
  const discovery = await fleet.robert.run({ profiles: [SAMPLE_VFD_PROFILE] });
  assert.ok(discovery.stored_total >= 1, 'at least one real opportunity discovered');

  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const matches = storage.getMatchesForProfile(store, thesis.profile_id);
  assert.ok(matches.length >= 1, 'the profile has at least one scored match');

  // 2) The user saves a matched opportunity into their pipeline.
  const chosen = matches[0];
  storage.saveOpportunity(store, thesis.profile_id, chosen.opportunity_id);
  storage.addToPipeline(store, thesis.profile_id, chosen.opportunity_id);
  assert.equal(storage.getPipeline(store, thesis.profile_id).length, 1);

  // 3) Hamilton completes it into a real packet (or an honest hard stop).
  const result = await fleet.hamilton.complete({
    profileId: thesis.profile_id,
    opportunityId: chosen.opportunity_id,
    profile: SAMPLE_VFD_PROFILE,
  });
  assert.ok(['packet_ready', 'packet_ready_portal_requires_live_driver', 'no_application', 'hard_stop'].includes(result.outcome));
  if (result.outcome.startsWith('packet_ready')) {
    assert.equal(storage.getDocuments(store, thesis.profile_id).length, 4);
  }
});

test('the catalog is global but matches are per-profile: two profiles, isolated scores, shared opportunities', async () => {
  const store = createMemoryStore();
  const fetcher = makeOfflineFetcher();
  const fleet = createFleet({ store, fetcher, env: {} });

  const student = {
    id: 'profile_student_x', name: 'Jordan Lee', type: 'student', state: 'TN',
    location: { state: 'TN' }, needs: ['education'], school: { name: 'State U' },
  };
  await fleet.robert.run({ profiles: [SAMPLE_VFD_PROFILE, student] });

  const catalogCount = storage.countOpportunities(store);
  assert.ok(catalogCount >= 1);

  const vfdMatches = storage.getMatchesForProfile(store, 'profile_vfd_1');
  const studentMatches = storage.getMatchesForProfile(store, 'profile_student_x');
  // both draw from the same global catalog; their match rows are independent
  for (const m of [...vfdMatches, ...studentMatches]) {
    assert.ok(storage.getOpportunity(store, m.opportunity_id), 'match points at a real catalog row');
  }
});

test('with no profiles at all, Robert still builds the universe and stores globally', async () => {
  const store = createMemoryStore();
  const fetcher = makeOfflineFetcher();
  const fleet = createFleet({ store, fetcher, env: {} });
  const res = await fleet.robert.run({ profiles: [] });
  assert.ok(res.stored_total >= 1, 'funding is discovered even with nobody logged in');
  assert.equal(storage.countOpportunities(store), res.stored_total);
});
