// tests/blindFactsMapper.test.mjs
//
// Phase 1a — the PROFILE-BLIND mapper. These pin: applicant_types is ALWAYS
// empty (never profile-stamped), unstated geography/needs stay neutral (never
// fabricated), page/source provenance rides in non-scoring metadata, and the
// page-fact columns pass through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBlindFactsToCandidate } from '../blindFactsMapper.js';

const FACTS = {
  title: 'Example Foundation Scholarship',
  sponsor: 'Example Foundation',
  summary: 'Supports first-generation college students.',
  eligibility_text: 'Applicants must reside in Ohio.',
  eligibility_bullets: ['reside in Ohio'],
  need_categories: ['education'],
  geography: { national: false, states: ['OH'] },
  amount_min: 1000,
  amount_max: 5000,
  is_loan: false,
  requires_cost_share: false,
  page_url: 'https://foundation.example.org/scholarship',
  info_url: 'https://foundation.example.org/faq',
  apply_url: 'https://foundation.example.org/apply-online',
  field_provenance: { eligibility: { value: 'Applicants must reside in Ohio.', evidence_snippet: 'reside in Ohio', source: 'x' } },
  page_fact_schema_version: 1,
  extractor_version: 'blind-v1',
};

test('applicant_types is ALWAYS empty — never profile-stamped', () => {
  const c = mapBlindFactsToCandidate(FACTS);
  assert.deepEqual(c.applicant_types, []);
});

test('page-supported geography and needs carry through; provenance is non-scoring', () => {
  const c = mapBlindFactsToCandidate(FACTS);
  assert.deepEqual(c.geography, { national: false, states: ['OH'] });
  assert.deepEqual(c.need_categories, ['education']);
  assert.equal(c.apply_url, 'https://foundation.example.org/apply-online');
  assert.equal(c.eligibility_text, 'Applicants must reside in Ohio.');
  assert.ok(c.field_provenance.eligibility, 'provenance preserved');
  assert.equal(c.raw.blind_extraction, true);
  assert.equal(c.raw.page_url, 'https://foundation.example.org/scholarship');
});

test('unstated fields stay EMPTY/neutral — never fabricated', () => {
  const sparse = { title: 'Bare Program', sponsor: 'Some Funder' };
  const c = mapBlindFactsToCandidate(sparse);
  assert.deepEqual(c.applicant_types, []);
  assert.deepEqual(c.need_categories, []);
  assert.deepEqual(c.geography, { national: false, states: [] });
  assert.equal(c.amount_min, null);
  assert.equal(c.amount_max, null);
  assert.equal(c.eligibility_text, null);
  assert.deepEqual(c.eligibility_bullets, []);
  assert.equal(c.field_provenance, null);
  // fallback info_url is the page (never invented)
  assert.equal(c.apply_url, null);
});

test('national scope clears states (mutually consistent geography)', () => {
  const c = mapBlindFactsToCandidate({ ...FACTS, geography: { national: true, states: ['OH'] } });
  assert.equal(c.geography.national, true);
  assert.deepEqual(c.geography.states, []);
});

test('returns null without a concrete title + sponsor', () => {
  assert.equal(mapBlindFactsToCandidate({ title: '', sponsor: 'X' }), null);
  assert.equal(mapBlindFactsToCandidate({ title: 'X', sponsor: '' }), null);
  assert.equal(mapBlindFactsToCandidate(null), null);
});
