// tests/matchEngine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeMatchDecision, MATCHER_VERSION, WEIGHTS } from '../matchEngine.js';
import { matchOpportunity } from '../matcher.js';
import { makeOpportunity, MATCH_DECISION, OPPORTUNITY_KIND, TRUST_TIER, REALITY_STATUS } from '../contract.js';
import { buildThesis } from '../profileIntelligence.js';
import { SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';
import { computeMatchDecision as canonicalComputeMatchDecision, MATCHER_VERSION as CANONICAL_MATCHER_VERSION } from '../../services/matchEngine.js';

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

test('a topically-irrelevant grant (no specific need overlap) is capped at REVIEW, never ACCEPT', () => {
  // Open to the profile's applicant type, national, official, funded — but its
  // only need overlap is the catch-all 'programs'. A VFD needing equipment/
  // emergency should NOT see this as an apply-now ACCEPT.
  const offTopic = strongOpp({
    title: 'U.S. Mission Cultural Exchange Program',
    need_categories: ['programs'],
  });
  const m = computeMatchDecision(offTopic, thesis);
  assert.notEqual(m.decision, MATCH_DECISION.ACCEPT, `off-topic grant must not ACCEPT (got ${m.decision} @ ${m.match_score})`);
  assert.ok(m.match_score < 70, `off-topic grant must stay below ACCEPT territory, got ${m.match_score}`);
  assert.ok(m.match_explain.warnings.length >= 1, 'canonical warnings should explain the downgrade');
});

test('a multi-need profile is NOT penalized for a focused grant — one real specific-need match scores well', () => {
  // Regression for the 2026-06-23 false-NEGATIVE: need = matched/total meant a
  // profile listing 4 needs that matched a grant on exactly ONE got 1/4 credit
  // and the genuinely-relevant grant was REJECTED. Full credit comes at
  // NEED_FULL_CREDIT_HITS specific overlaps, so one strong specific match alone
  // earns at least half of the need weight (not a quarter).
  const multiNeed = buildThesis({
    id: 'p_multi', profile_type: 'nonprofit', applicant_types: ['nonprofit'],
    needs: ['capital', 'operations', 'programs', 'education'],
    location: { state: 'TN' },
  });
  const focused = strongOpp({
    source_id: 'community_foundation',
    title: 'Community Capital Facilities Grant', sponsor: 'Community Foundation',
    applicant_types: ['nonprofit'],
    need_categories: ['capital'], geography: { states: ['TN'] },
    apply_url: 'https://example.org/community-capital-facilities',
  });
  const m = computeMatchDecision(focused, multiNeed);
  assert.ok(m.match_explain.matched_needs.includes('capital'), 'focused grant should name the matched profile need');
  assert.ok(m.match_score >= 70, `focused grant should still score strongly, got ${m.match_score}`);
  assert.notEqual(m.decision, MATCH_DECISION.REJECT, `a real specific-need match must not be rejected (got ${m.decision} @ ${m.match_score})`);
});

test('the result carries an explainable breakdown and reasons', () => {
  const m = computeMatchDecision(strongOpp(), thesis);
  assert.ok(m.match_explain);
  assert.ok(m.match_explain.score_breakdown);
  assert.ok(typeof m.match_explain.why === 'string');
  assert.equal(m.match_explain.matched_profile_type, true);
  assert.equal(m.match_explain.matcher_version, CANONICAL_MATCHER_VERSION);
  assert.ok(Array.isArray(m.match_explain.matched_profile_facts));
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

test('an unrelated opportunity stays low and never ACCEPTs', () => {
  const weak = makeOpportunity({
    source_id: 'x', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Unrelated Arts Microgrant', sponsor: 'Some Council',
    applicant_types: ['individual'], need_categories: ['arts'],
    geography: { national: false, states: ['CA'] },
    apply_url: 'https://example.org/apply', trust_tier: TRUST_TIER.UNVERIFIED,
    reality_status: REALITY_STATUS.LINK_UNVERIFIED,
  });
  const m = computeMatchDecision(weak, thesis);
  assert.notEqual(m.decision, MATCH_DECISION.ACCEPT);
  assert.ok(m.match_score < 50, `expected a low score for unrelated opportunity, got ${m.match_score}`);
});

test('an explicit floor override is honored', () => {
  const m = computeMatchDecision(strongOpp(), thesis, { floor: 99 });
  assert.equal(m.match_explain.matcher_version, CANONICAL_MATCHER_VERSION);
  assert.equal(m.decision, MATCH_DECISION.ACCEPT, 'OS floor is a display/filter concern; canonical thresholds decide');
});

test('wildcard applicant markers stay neutral, not a fake applicant identity', () => {
  const broadThesis = {
    profile_id: 'p_broad',
    applicant_types: ['*'],
    needs: ['equipment'],
    location: {},
    loan_allowed: false,
    cost_share_allowed: false,
  };
  const nonprofitOnly = strongOpp({
    title: 'Equipment Grant for Nonprofits',
    sponsor: 'Community Foundation',
    applicant_types: ['nonprofit'],
    need_categories: ['equipment'],
  });
  const m = computeMatchDecision(nonprofitOnly, broadThesis);
  assert.equal(m.decision, MATCH_DECISION.REVIEW);
  assert.equal(m.match_explain.matched_profile_type, false);
  assert.equal(m.match_explain.score_breakdown.applicant_type, 0);
  assert.ok(m.match_explain.missing_eligibility_fields.includes('entity_type'));
  assert.ok(m.match_explain.missing_eligibility_fields.includes('nonprofit_status'));
  assert.ok(!m.match_explain.warnings.some((w) => /\*/.test(w) || /profile is \*/i.test(w)));
  assert.ok(!m.match_explain.matched_profile_facts.some((fact) => /\*/.test(fact)));
});

test('matcher.matchOpportunity uses the OS facade, which delegates to the canonical engine', () => {
  assert.equal(matchOpportunity, computeMatchDecision);
  assert.equal(MATCHER_VERSION, CANONICAL_MATCHER_VERSION);
  assert.equal(computeMatchDecision(strongOpp(), thesis).match_explain.matcher_version, CANONICAL_MATCHER_VERSION);
});

test('OS facade and canonical engine agree on score and decision after shape mapping', () => {
  const opp = strongOpp();
  const osDecision = computeMatchDecision(opp, thesis);
  const canonicalDecision = canonicalComputeMatchDecision({
    id: thesis.profile_id,
    applicant_type: 'volunteer_fire_department',
    primary_type: 'volunteer_fire_department',
    type: 'volunteer_fire_department',
    applicantTypes: new Set(['volunteer_fire_department', 'vfd', 'government', 'nonprofit', 'organization']),
    needs: thesis.needs,
    need_categories: thesis.needs,
    state: thesis.location.state,
    zip: thesis.location.zip,
    county: thesis.location.county,
    location: thesis.location,
    tags: [...thesis.needs, ...thesis.applicant_types],
  }, {
    id: opp.id,
    title: opp.title,
    sponsor: opp.sponsor,
    funder: opp.sponsor,
    description: [
      opp.summary,
      `Eligible applicants: ${opp.applicant_types.join(', ')}`,
      `Funding needs: ${opp.need_categories.join(', ')}`,
    ].filter(Boolean).join('\n'),
    entity_types_allowed: ['nonprofit', 'organization'],
    need_types_supported: opp.need_categories,
    categories: [...opp.need_categories, 'nonprofit', 'organization', ...opp.applicant_types],
    eligibility_bullets: ['Eligible applicants: vfd, nonprofit, organization'],
    keywords: [...opp.need_categories, ...opp.applicant_types, 'nonprofit', 'organization', opp.source_id, opp.kind, opp.sponsor],
    state: 'nationwide',
    is_national: true,
    amount_min: null,
    amount_max: opp.funding.amount_max,
    is_loan: false,
    requires_match: false,
    deadline: opp.deadline,
    deadline_type: null,
    application_url: opp.apply_url,
    apply_url: opp.apply_url,
    source_url: opp.apply_url,
    url: opp.apply_url,
    type: opp.kind,
    opportunity_type: 'grant',
    source: opp.source_id,
    record_origin: 'crawler_os',
    trust_tier: opp.trust_tier,
    reality_status: opp.reality_status,
  });
  assert.equal(osDecision.match_score, canonicalDecision.score);
  assert.equal(osDecision.decision.toUpperCase(), canonicalDecision.decision);
});

test('OS matcher source contains no standalone scoring weights or decide function', () => {
  const source = fs.readFileSync(path.resolve('backend/crawler-os/matchEngine.js'), 'utf8');
  assert.doesNotMatch(source, /function\s+decide\s*\(/);
  assert.doesNotMatch(source, /WEIGHTS\s*=\s*Object\.freeze\(\s*\{\s*need\s*:/);
  assert.match(source, /computeCanonicalMatchDecision/);
});

test('weights facade is frozen and points at the canonical matcher', () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
  assert.equal(WEIGHTS.canonical_match_engine, 100);
  assert.throws(() => { WEIGHTS.canonical_match_engine = 999; }, TypeError);
});
