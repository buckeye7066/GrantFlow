// tests/matchEngine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMatchDecision, WEIGHTS } from '../matchEngine.js';
import { matchOpportunity } from '../matcher.js';
import { makeOpportunity, MATCH_DECISION, OPPORTUNITY_KIND, TRUST_TIER, REALITY_STATUS } from '../contract.js';
import { buildThesis } from '../profileIntelligence.js';
import { SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';

const thesis = buildThesis(SAMPLE_VFD_PROFILE);

function strongOpp(over = {}) {
  return makeOpportunity({
    source_id: 'fema_afg', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Assistance to Firefighters Grant', sponsor: 'FEMA',
    applicant_types: ['vfd'], need_categories: ['equipment', 'emergency'],
    geography: { national: true },
    funding: { amount_max: 50000 },
    deadline: new Date(Date.now() + 20 * 86400000).toISOString(),
    apply_url: 'https://www.fema.gov/grants/afg/apply',
    trust_tier: TRUST_TIER.OFFICIAL_API, reality_status: REALITY_STATUS.VERIFIED,
    ...over,
  });
}

test('the decision triad is exactly accept / review / reject (lowercase)', () => {
  assert.deepEqual(MATCH_DECISION, { ACCEPT: 'accept', REVIEW: 'review', REJECT: 'reject' });
});

test('a strong, well-matched grant ACCEPTs with a high score', () => {
  const m = computeMatchDecision(strongOpp(), thesis);
  assert.equal(m.decision, MATCH_DECISION.ACCEPT);
  assert.ok(m.match_score >= 70, `expected >=70, got ${m.match_score}`);
  assert.equal(m.opportunity_id, strongOpp().id);
  assert.equal(m.profile_id, thesis.profile_id);
});

test('the result carries an explainable breakdown and reasons', () => {
  const m = computeMatchDecision(strongOpp(), thesis);
  assert.ok(m.match_explain);
  assert.ok(m.match_explain.score_breakdown);
  assert.ok(typeof m.match_explain.why === 'string');
  assert.equal(m.match_explain.matched_profile_type, true);
});

test('a directory is never an ACCEPT — it goes to REVIEW', () => {
  const dir = makeOpportunity({
    source_id: 'cof_locator', kind: OPPORTUNITY_KIND.DIRECTORY,
    title: 'Foundation Locator', sponsor: 'COF', geography: { national: true },
    info_url: 'https://cof.org/locator', reality_status: REALITY_STATUS.DIRECTORY,
  });
  const m = computeMatchDecision(dir, thesis);
  assert.equal(m.decision, MATCH_DECISION.REVIEW);
});

test('a loan the profile disallows is downgraded to REVIEW (warned), never silently ACCEPTed', () => {
  const m = computeMatchDecision(strongOpp({ funding: { amount_max: 50000, is_loan: true } }), thesis);
  assert.notEqual(m.decision, MATCH_DECISION.ACCEPT);
  assert.ok(m.match_explain.warnings.some((w) => /loan/i.test(w)));
});

test('a below-floor opportunity REJECTs', () => {
  const weak = makeOpportunity({
    source_id: 'x', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Unrelated Arts Microgrant', sponsor: 'Some Council',
    applicant_types: ['individual'], need_categories: ['arts'],
    geography: { national: false, states: ['CA'] },
    apply_url: 'https://example.org/apply', trust_tier: TRUST_TIER.UNVERIFIED,
    reality_status: REALITY_STATUS.LINK_UNVERIFIED,
  });
  const m = computeMatchDecision(weak, thesis);
  assert.equal(m.decision, MATCH_DECISION.REJECT);
});

test('an explicit floor override is honored', () => {
  const m = computeMatchDecision(strongOpp(), thesis, { floor: 99 });
  assert.equal(m.match_explain.floor, 99);
});

test('matcher.matchOpportunity IS the canonical engine (single authority, identity)', () => {
  assert.equal(matchOpportunity, computeMatchDecision);
});

test('weights are frozen and sum to 100', () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
  assert.throws(() => { WEIGHTS.need = 999; }, TypeError);
});
