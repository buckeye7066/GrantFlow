// tests/realityGate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceReality, applyGlobalRealityChecks, applyProfilePolicy } from '../realityGate.js';
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

// ---------------------------------------------------------------------------
// Split refactor (Phase 0.3): global reality checks vs profile policy.
// enforceReality() composes applyGlobalRealityChecks() + applyProfilePolicy();
// these tests lock the zero-behavior-change guarantee and the two split fns.
// ---------------------------------------------------------------------------

test('rejects a cost-share requirement the profile disallows (unchanged behavior)', () => {
  const v = enforceReality(realCandidate({ requires_cost_share: true }), { thesis: { cost_share_allowed: false }, source: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.COST_SHARE_NOT_ALLOWED);
});

test('accepts that same cost-share candidate when the profile allows matching funds', () => {
  const v = enforceReality(realCandidate({ requires_cost_share: true }), { thesis: { cost_share_allowed: true }, source: {} });
  assert.equal(v.ok, true);
});

test('rejection ORDER preserved: loan gating outranks an expired deadline', () => {
  // Both a disallowed loan AND an expired deadline. The original evaluated loan
  // before the deadline, so LOAN_NOT_ALLOWED must win — a "global checks first"
  // composition would wrongly report EXPIRED_DEADLINE here.
  const v = enforceReality(
    realCandidate({ is_loan: true, deadline: '2000-01-01' }),
    { thesis: { loan_allowed: false }, source: {} },
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.LOAN_NOT_ALLOWED);
});

test('rejection ORDER preserved: cost-share gating outranks an expired deadline', () => {
  const v = enforceReality(
    realCandidate({ requires_cost_share: true, deadline: '2000-01-01' }),
    { thesis: { cost_share_allowed: false }, source: {} },
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.COST_SHARE_NOT_ALLOWED);
});

test('rejection ORDER preserved: a global URL rejection outranks profile loan policy', () => {
  // A bad URL is checked before loan gating in the original order.
  const v = enforceReality(
    realCandidate({ is_loan: true, apply_url: 'https://www.google.com/search?q=fire+grant' }),
    { thesis: { loan_allowed: false }, source: {} },
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASON.SEARCH_URL_AS_APPLY);
});

test('applyGlobalRealityChecks is profile-INDEPENDENT: identical verdict for any thesis', () => {
  // A candidate that WOULD be rejected by profile policy (a disallowed loan)
  // must still be ACCEPTED by the global pass, and the global verdict must be
  // byte-identical no matter what thesis is supplied — that isolation is the
  // point of the split.
  const cand = realCandidate({ is_loan: true, requires_cost_share: true });
  const base = { source: { source_id: 'grants_gov' }, evidence: { url: goodApply, content_hash: 'abc123' } };
  const a = applyGlobalRealityChecks(cand, { ...base, thesis: { loan_allowed: false, cost_share_allowed: false } });
  const b = applyGlobalRealityChecks(cand, { ...base, thesis: { loan_allowed: true, cost_share_allowed: true } });
  const c = applyGlobalRealityChecks(cand, { ...base }); // no thesis at all
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(a.ok, true);
  assert.equal(a.reality_status, REALITY_STATUS.VERIFIED);
});

test('applyGlobalRealityChecks individually rejects global failures and accepts real rows', () => {
  assert.equal(applyGlobalRealityChecks(realCandidate({ summary: 'lorem ipsum' }), { source: {} }).reason, REASON.PLACEHOLDER_CONTENT);
  assert.equal(applyGlobalRealityChecks(realCandidate({ sponsor: '' }), { source: {} }).reason, REASON.NO_SPONSOR);
  assert.equal(applyGlobalRealityChecks(realCandidate({ deadline: '2000-01-01' }), { source: {} }).reason, REASON.EXPIRED_DEADLINE);
  assert.equal(applyGlobalRealityChecks(realCandidate(), { source: { source_id: 'grants_gov' } }).ok, true);
});

test('applyProfilePolicy individually gates loans and cost-share by thesis', () => {
  // Loan gating.
  assert.equal(applyProfilePolicy(realCandidate({ is_loan: true }), { thesis: { loan_allowed: false } }).reason, REASON.LOAN_NOT_ALLOWED);
  assert.equal(applyProfilePolicy(realCandidate({ is_loan: true }), { thesis: { loan_allowed: true } }), null);
  // Cost-share gating.
  assert.equal(applyProfilePolicy(realCandidate({ requires_cost_share: true }), { thesis: { cost_share_allowed: false } }).reason, REASON.COST_SHARE_NOT_ALLOWED);
  assert.equal(applyProfilePolicy(realCandidate({ requires_cost_share: true }), { thesis: { cost_share_allowed: true } }), null);
  // A candidate with no policy triggers passes regardless of thesis.
  assert.equal(applyProfilePolicy(realCandidate(), { thesis: {} }), null);
});

test('enforceReality output equals the manual composition of the two split fns', () => {
  // Cross-check the composition contract across a representative matrix: for
  // each case enforceReality must equal "pre-profile global rejection, else
  // profile rejection, else global verdict" computed independently.
  const cases = [
    { c: realCandidate(), ctx: { thesis: {}, source: { source_id: 'g' } } },
    { c: realCandidate({ is_loan: true }), ctx: { thesis: { loan_allowed: false }, source: {} } },
    { c: realCandidate({ is_loan: true }), ctx: { thesis: { loan_allowed: true }, source: {} } },
    { c: realCandidate({ requires_cost_share: true }), ctx: { thesis: { cost_share_allowed: false }, source: {} } },
    { c: realCandidate({ requires_cost_share: true }), ctx: { thesis: { cost_share_allowed: true }, source: {} } },
    { c: realCandidate({ is_loan: true, deadline: '2000-01-01' }), ctx: { thesis: { loan_allowed: false }, source: {} } },
    { c: realCandidate({ deadline: '2000-01-01' }), ctx: { thesis: {}, source: {} } },
    { c: realCandidate({ summary: 'lorem ipsum', is_loan: true }), ctx: { thesis: { loan_allowed: false }, source: {} } },
  ];
  for (const { c, ctx } of cases) {
    const global = applyGlobalRealityChecks(c, ctx);
    const profile = applyProfilePolicy(c, ctx);
    let expected;
    if (!global.ok && global.reason !== REASON.EXPIRED_DEADLINE) expected = global;
    else if (profile) expected = profile;
    else expected = global;
    assert.deepEqual(enforceReality(c, ctx), expected);
  }
});
