// tests/hamilton.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createHamilton } from '../agents/hamilton.js';
import { storage } from '../index.js';
import { makeOpportunity, OPPORTUNITY_KIND, REALITY_STATUS, TRUST_TIER } from '../contract.js';

const VFD_PROFILE = {
  name: 'Cleveland Volunteer Fire Department',
  location: { city: 'Cleveland', state: 'TN' },
  mission: 'Protect our rural community with reliable fire and emergency response.',
  needs: ['equipment', 'emergency'],
};

function seedOpp(store, over = {}) {
  const opp = makeOpportunity({
    id: 'opp_afg', source_id: 'fema_afg', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Assistance to Firefighters Grant', sponsor: 'FEMA',
    need_categories: ['equipment'], applicant_types: ['vfd'],
    geography: { national: true }, funding: { amount_max: 50000 },
    deadline: new Date(Date.now() + 30 * 86400000).toISOString(),
    apply_url: 'https://www.fema.gov/grants/afg/apply',
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
    ...over,
  });
  storage.upsertOpportunity(store, opp);
  return opp;
}

test('Hamilton generates a complete, real application packet saved to the profile', async () => {
  const store = createMemoryStore();
  const opp = seedOpp(store);
  const hamilton = createHamilton({ store });
  const res = await hamilton.complete({ profileId: 'A', opportunityId: opp.id, profile: VFD_PROFILE });

  assert.equal(res.outcome, 'packet_ready');
  assert.equal(res.documents.length, 4);
  const docs = storage.getDocuments(store, 'A');
  assert.equal(docs.length, 4);
  const kinds = docs.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['budget', 'checklist', 'cover_letter', 'narrative']);
  // documents contain real, non-placeholder prose
  const narrative = docs.find((d) => d.kind === 'narrative');
  assert.match(narrative.content, /Cleveland Volunteer Fire Department/);
  assert.match(narrative.content, /FEMA/);
});

test('Hamilton records an application row for the profile', async () => {
  const store = createMemoryStore();
  const opp = seedOpp(store);
  const hamilton = createHamilton({ store });
  await hamilton.complete({ profileId: 'A', opportunityId: opp.id, profile: VFD_PROFILE });
  const apps = storage.getApplications(store, 'A');
  assert.equal(apps.length, 1);
  assert.equal(apps[0].opportunity_id, opp.id);
});

test('Hamilton hard-stops on an expired deadline (cannot un-expire)', async () => {
  const store = createMemoryStore();
  // store with a future deadline (passes the catalog gate) then test an opp whose
  // deadline is in the past at completion time via a manual past-deadline row.
  const opp = makeOpportunity({
    id: 'opp_exp', source_id: 'grants_gov', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Expired Program', sponsor: 'USDA', applicant_types: ['vfd'],
    geography: { national: true }, apply_url: 'https://www.grants.gov/d/exp',
    deadline: '2000-01-01', reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
  });
  // bypass catalog deadline rules: write the row directly so Hamilton sees it
  storage.upsertOpportunity(store, opp);
  const hamilton = createHamilton({ store });
  const res = await hamilton.complete({ profileId: 'A', opportunityId: 'opp_exp', profile: VFD_PROFILE });
  assert.equal(res.outcome, 'hard_stop');
  assert.ok(res.hard_stops.some((h) => h.category === hamilton.HARD_STOP.EXPIRED));
});

test('Hamilton hard-stops (resumably) when required applicant info is missing', async () => {
  const store = createMemoryStore();
  const opp = seedOpp(store);
  const hamilton = createHamilton({ store });
  const res = await hamilton.complete({ profileId: 'A', opportunityId: opp.id, profile: { /* empty */ } });
  assert.equal(res.outcome, 'hard_stop');
  assert.ok(res.hard_stops.some((h) => h.category === hamilton.HARD_STOP.MISSING_INFO));
  assert.equal(storage.getDocuments(store, 'A').length, 0);
});

test('a directory/intel opportunity has no single application to complete', async () => {
  const store = createMemoryStore();
  const dir = makeOpportunity({
    id: 'opp_dir', source_id: 'cof_locator', kind: OPPORTUNITY_KIND.DIRECTORY,
    title: 'Foundation Locator', sponsor: 'Council on Foundations',
    info_url: 'https://cof.org/locator', reality_status: REALITY_STATUS.DIRECTORY, trust_tier: TRUST_TIER.AGGREGATOR,
  });
  storage.upsertOpportunity(store, dir);
  const hamilton = createHamilton({ store });
  const res = await hamilton.complete({ profileId: 'A', opportunityId: 'opp_dir', profile: VFD_PROFILE });
  assert.equal(res.outcome, 'no_application');
  assert.equal(res.pathway, hamilton.PATHWAY.NO_APPLICATION);
});

test('portal submission is honestly gated: without a live driver the packet is prepared, not "submitted"', async () => {
  const store = createMemoryStore();
  const opp = seedOpp(store);
  const hamilton = createHamilton({ store }); // no portalDriver
  const res = await hamilton.complete({
    profileId: 'A', opportunityId: opp.id, profile: VFD_PROFILE,
    authorize: { portal_submit: true },
  });
  assert.equal(res.pathway, hamilton.PATHWAY.PORTAL);
  assert.equal(res.outcome, 'packet_ready_portal_requires_live_driver');
  assert.ok(res.documents.length === 4, 'packet is still fully prepared');
  assert.ok(res.hard_stops.some((h) => h.category === hamilton.HARD_STOP.LOGIN));
});

test('with an authorized live driver, Hamilton forwards the prepared packet for submission', async () => {
  const store = createMemoryStore();
  const opp = seedOpp(store);
  const portalDriver = { submit: async () => ({ submitted: true }) };
  const hamilton = createHamilton({ store, portalDriver });
  const res = await hamilton.complete({
    profileId: 'A', opportunityId: opp.id, profile: VFD_PROFILE,
    authorize: { portal_submit: true },
  });
  assert.equal(res.outcome, 'portal_submitted');
});

test('Hamilton never invents financial amounts in the budget', async () => {
  const store = createMemoryStore();
  const opp = seedOpp(store, { funding: { amount_max: null, amount_min: null } });
  const hamilton = createHamilton({ store });
  const res = await hamilton.complete({ profileId: 'A', opportunityId: opp.id, profile: VFD_PROFILE });
  const budget = storage.getDocuments(store, 'A').find((d) => d.kind === 'budget');
  assert.match(budget.content, /to complete/i);
  assert.match(budget.content, /does not invent financial amounts/i);
});
