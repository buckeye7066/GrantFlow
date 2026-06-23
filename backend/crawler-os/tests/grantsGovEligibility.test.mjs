// tests/grantsGovEligibility.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibilitiesFor } from '../adapters/grantsGovAdapter.js';

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
