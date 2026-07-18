// tests/pageFactProvenance.test.mjs
//
// Phase 0.1 web-lane de-contamination — durable page-fact provenance is
// ADDITIVE, NULL-default plumbing. These tests pin two facts:
//   1. an opportunity that sets NONE of the new fields is shaped IDENTICALLY to
//      before (the new fields default null/empty and nothing else moves), and
//   2. when the fields ARE provided they round-trip write->read through the
//      canonical contract shape and the storage layer faithfully — proving the
//      plumbing a later profile-blind extractor will populate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { storage } from '../index.js';
import { makeOpportunity, OPPORTUNITY_KIND, REALITY_STATUS, TRUST_TIER } from '../contract.js';
import { computeMatchDecision } from '../matchEngine.js';
import { buildThesis } from '../profileIntelligence.js';
import { SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';

function baseInput(over = {}) {
  return {
    id: 'pf-1', source_id: 'grants_gov', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Rural Facilities Grant', sponsor: 'USDA',
    apply_url: 'https://www.grants.gov/d/pf-1',
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
    ...over,
  };
}

test('makeOpportunity: page-fact fields default null/empty when unset', () => {
  const opp = makeOpportunity(baseInput());
  assert.equal(opp.eligibility_text, null);
  assert.deepEqual(opp.eligibility_bullets, []);
  assert.equal(opp.page_fact_schema_version, null);
  assert.equal(opp.field_provenance, null);
  // The rest of the canonical shape is unchanged — the booleans still coalesce.
  assert.equal(opp.funding.is_loan, false);
  assert.equal(opp.funding.requires_cost_share, false);
  assert.equal(opp.geography.national, false);
});

test('makeOpportunity: page-fact fields are carried when provided', () => {
  const provenance = {
    is_loan: { value: false, evidence_snippet: 'This is a grant, not a loan.', source: 'https://x/1' },
    national: { value: true, evidence_snippet: 'Open to applicants nationwide.', source: 'https://x/1' },
    eligibility_text: { value: '501(c)(3) nonprofits in rural counties.', evidence_snippet: 'Who may apply: 501(c)(3)…', source: 'https://x/1' },
  };
  const opp = makeOpportunity(baseInput({
    eligibility_text: '501(c)(3) nonprofits in rural counties.',
    eligibility_bullets: ['Must be a 501(c)(3)', 'Rural county'],
    page_fact_schema_version: 1,
    field_provenance: provenance,
  }));
  assert.equal(opp.eligibility_text, '501(c)(3) nonprofits in rural counties.');
  assert.deepEqual(opp.eligibility_bullets, ['Must be a 501(c)(3)', 'Rural county']);
  assert.equal(opp.page_fact_schema_version, 1);
  assert.deepEqual(opp.field_provenance, provenance);
  // Tri-state: an ABSENT key in field_provenance means "not stated"; a present
  // key with value:false means stated-false — distinct facts.
  assert.equal(opp.field_provenance.is_loan.value, false);
  assert.equal('requires_cost_share' in opp.field_provenance, false);
});

test('storage round-trip: unset page-fact fields persist as null/empty', () => {
  const store = createMemoryStore();
  assert.equal(storage.upsertOpportunity(store, makeOpportunity(baseInput())).stored, true);
  const row = storage.getOpportunity(store, 'pf-1');
  assert.equal(row.eligibility_text, null);
  assert.equal(row.eligibility_bullets_json, '[]');
  assert.equal(row.page_fact_schema_version, null);
  assert.equal(row.field_provenance_json, null);
});

test('storage round-trip: provided page-fact fields survive write->read', () => {
  const store = createMemoryStore();
  const provenance = { national: { value: true, evidence_snippet: 'nationwide', source: 'https://x/1' } };
  storage.upsertOpportunity(store, makeOpportunity(baseInput({
    eligibility_text: 'Nonprofits only.',
    eligibility_bullets: ['Must be a nonprofit'],
    page_fact_schema_version: 2,
    field_provenance: provenance,
  })));
  const row = storage.getOpportunity(store, 'pf-1');
  assert.equal(row.eligibility_text, 'Nonprofits only.');
  assert.deepEqual(JSON.parse(row.eligibility_bullets_json), ['Must be a nonprofit']);
  assert.equal(row.page_fact_schema_version, 2);
  assert.deepEqual(JSON.parse(row.field_provenance_json), provenance);
});

test('matchEngine facade: page-fact fields change NO score or decision', () => {
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const strong = {
    source_id: 'fema_afg', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Assistance to Firefighters Grant', sponsor: 'FEMA',
    applicant_types: ['vfd'], need_categories: ['equipment', 'emergency'],
    geography: { national: true }, funding: { amount_max: 50000 },
    deadline: new Date(Date.now() + 20 * 86400000).toISOString(),
    apply_url: 'https://www.fema.gov/grants/afg/apply',
    trust_tier: TRUST_TIER.OFFICIAL_API, reality_status: REALITY_STATUS.VERIFIED,
  };
  const withoutFacts = computeMatchDecision(makeOpportunity(strong), thesis);
  const withFacts = computeMatchDecision(makeOpportunity({
    ...strong,
    eligibility_text: 'Volunteer fire departments may apply.',
    eligibility_bullets: ['Must be a recognized VFD'],
    page_fact_schema_version: 1,
    field_provenance: {
      is_loan: { value: false, evidence_snippet: 'grant', source: 'https://x' },
      national: { value: true, evidence_snippet: 'nationwide', source: 'https://x' },
    },
  }), thesis);
  assert.equal(withFacts.match_score, withoutFacts.match_score);
  assert.equal(withFacts.decision, withoutFacts.decision);
});
