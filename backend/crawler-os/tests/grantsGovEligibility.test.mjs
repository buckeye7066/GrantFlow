// tests/grantsGovEligibility.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFemaAfgAdapter } from '../adapters/femaAfgAdapter.js';
import { createGrantsGovAdapter, eligibilitiesFor } from '../adapters/grantsGovAdapter.js';
import { createUsdaRdAdapter } from '../adapters/usdaRdAdapter.js';

test('individual/unknown profiles get NO eligibility filter (preserve recall)', () => {
  assert.equal(eligibilitiesFor({}), '');
  assert.equal(eligibilitiesFor({ applicant_types: [] }), '');
  assert.equal(eligibilitiesFor({ applicant_types: ['*'] }), '');
});

test('a nonprofit maps to 501c3 codes + unrestricted, PIPE-delimited (comma returns 0 hits on the live API)', () => {
  const e = eligibilitiesFor({ applicant_types: ['nonprofit'] });
  assert.ok(e.includes('|'), `must be pipe-delimited, got "${e}"`);
  assert.ok(!e.includes(','), 'must not use comma (the API treats it as one invalid token -> 0 hits)');
  const codes = new Set(e.split('|'));
  assert.ok(codes.has('12') && codes.has('13'), 'nonprofit 501c3/non-501c3 codes');
  assert.ok(codes.has('99'), 'always include unrestricted');
});

test('a church is scoped to nonprofit codes — NOT school-district/IHE codes (kills the OESE false positive)', () => {
  const codes = new Set(eligibilitiesFor({ applicant_types: ['church', 'nonprofit'] }).split('|'));
  for (const schoolOnly of ['05', '06', '20']) {
    assert.ok(!codes.has(schoolOnly), `church must not request school/IHE-only code ${schoolOnly}`);
  }
});

test('a school IS scoped to school-district/IHE codes', () => {
  const codes = new Set(eligibilitiesFor({ applicant_types: ['school'] }).split('|'));
  assert.ok(codes.has('05') || codes.has('06') || codes.has('20'));
});

test('all Grants.gov-derived adapters use the public number as source identity and the internal id only for the detail URL', () => {
  const source = { geography: { national: true, states: [] } };
  const assertIdentity = (specialized, raw) => {
    const catchAll = createGrantsGovAdapter().mapCandidate(raw, { source });
    const focused = specialized.mapCandidate(raw, { source });
    assert.ok(catchAll && focused, 'both adapters must accept the authoritative row');
    assert.equal(catchAll.external_id, 'PUBLIC-2026-77');
    assert.equal(focused.external_id, catchAll.external_id);
    assert.equal(catchAll.apply_url, 'https://www.grants.gov/search-results-detail/98765');
    assert.equal(focused.apply_url, catchAll.apply_url);
  };

  assertIdentity(createFemaAfgAdapter(), {
    external_id: 98765,
    number: 'PUBLIC-2026-77',
    title: 'FEMA Assistance to Firefighters Grant',
    sponsor: 'Federal Emergency Management Agency',
  });
  assertIdentity(createUsdaRdAdapter(), {
    external_id: 98765,
    number: 'PUBLIC-2026-77',
    title: 'USDA Rural Development Community Facilities Grant',
    sponsor: 'U.S. Department of Agriculture',
  });
});
