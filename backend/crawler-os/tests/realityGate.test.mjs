// tests/realityGate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceReality } from '../realityGate.js';
import { REALITY_STATUS, REASON, OPPORTUNITY_KIND } from '../contract.js';

const goodApply = 'https://www.grants.gov/search-results-detail/ABC-123';

function realCandidate(over = {}) {
  return {
    title: 'Rural Fire Equipment Grant',
    sponsor: 'FEMA',
    summary: 'Funds protective equipment for volunteer fire departments.',
    apply_url: goodApply,
    kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    deadline: new Date(Date.now() + 60 * 86400000).toISOString(),
    ...over,
  };
}

test('rejects placeholder/lorem content', () => {
  const v = enforceReality(realCandidate({ summary: 'lorem ipsum dolor sit amet' }), { thesis: {}, source: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.PLACEHOLDER_CONTENT);
  assert.equal(v.reality_status, REALITY_STATUS.REJECTED);
});

test('rejects a candidate with no sponsor', () => {
  const v = enforceReality(realCandidate({ sponsor: '' }), { thesis: {}, source: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.NO_SPONSOR);
});

test('rejects an applicable opportunity whose apply_url is a search URL', () => {
  const v = enforceReality(realCandidate({ apply_url: 'https://www.google.com/search?q=fire+grant' }), { thesis: {}, source: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.SEARCH_URL_AS_APPLY);
});

test('rejects a loan when the profile does not allow loans', () => {
  const v = enforceReality(realCandidate({ is_loan: true }), { thesis: { loan_allowed: false }, source: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.LOAN_NOT_ALLOWED);
});

test('accepts that same loan when the profile explicitly allows loans', () => {
  const v = enforceReality(realCandidate({ is_loan: true }), { thesis: { loan_allowed: true }, source: {} });
  assert.equal(v.ok, true);
});

test('rejects an expired deadline', () => {
  const v = enforceReality(realCandidate({ deadline: '2000-01-01' }), { thesis: {}, source: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.EXPIRED_DEADLINE);
});

test('accepts a real opportunity and tags it VERIFIED when evidence is present', () => {
  const v = enforceReality(realCandidate(), {
    thesis: {}, source: { source_id: 'grants_gov' },
    evidence: { url: goodApply, content_hash: 'abc123' },
  });
  assert.equal(v.ok, true);
  assert.equal(v.reality_status, REALITY_STATUS.VERIFIED);
  assert.ok(v.trust_score > 0);
  assert.ok(typeof v.dedup_key === 'string' && v.dedup_key.length > 0);
});

test('accepts a real opportunity as LINK_UNVERIFIED when no evidence hash yet', () => {
  const v = enforceReality(realCandidate(), { thesis: {}, source: { source_id: 'grants_gov' } });
  assert.equal(v.ok, true);
  assert.equal(v.reality_status, REALITY_STATUS.LINK_UNVERIFIED);
});

test('classifies a directory honestly (not an apply-now), with no apply_url required', () => {
  const v = enforceReality(
    { title: 'Community Foundation Locator', sponsor: 'Council on Foundations', kind: OPPORTUNITY_KIND.DIRECTORY, info_url: 'https://cof.org/locator' },
    { thesis: {}, source: { source_id: 'cof_locator', directory: true } },
  );
  assert.equal(v.ok, true);
  assert.equal(v.reality_status, REALITY_STATUS.DIRECTORY);
  assert.equal(v.kind, OPPORTUNITY_KIND.DIRECTORY);
});
