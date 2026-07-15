// County & city programs lane + 2026-07-08 adapter-wishlist sources.
//
// Sam's fleet coverage-gap scoreboard hit 100% of scanned profiles on ONE
// statement: "No county & city programs source adapters exist in the source
// registry yet." These tests pin the fix: the county_city lane has real,
// geo-aware locator sources; OH/WA get state-programs sources; mobility
// impairment + neurodivergent get disease-specific lanes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getSource } from '../sourceRegistry.js';
import { getAdapter, implementedAdapterIds } from '../adapters/index.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { createCountyCityDirectoryAdapter } from '../adapters/countyCityDirectoryAdapter.js';
import { enforceReality } from '../realityGate.js';
import { normalize } from '../normalizer.js';
import { computeMatchDecision, isRecommendable } from '../matchEngine.js';
import { MATCH_DECISION } from '../contract.js';

const COUNTY_CITY = ['usa_gov_local_governments', 'hud_resource_locator', 'findhelp_local_programs'];
const STATE_ROWS = [
  ['oh_benefits', 'OH'],
  ['oh_college_opportunity_grant', 'OH'],
  ['wa_connection_benefits', 'WA'],
  ['wa_college_grant', 'WA'],
];
const DISEASE = [
  'reeve_foundation_paralysis', 'autism_speaks_family_support',
  // adapter wishlist 2026-07-11
  'arthritis_foundation_help', 'samhsa_findtreatment', 'american_kidney_fund', 'needymeds_diagnosis_assistance',
];

test('every new source is registered with an implemented adapter', () => {
  const implemented = new Set(implementedAdapterIds());
  for (const id of [...COUNTY_CITY, ...STATE_ROWS.map(([s]) => s), ...DISEASE]) {
    assert.ok(getSource(id), `source row missing: ${id}`);
    assert.ok(implemented.has(id), `adapter not registered for ${id}`);
    assert.ok(getAdapter(id), `getAdapter(${id}) should return an adapter`);
  }
});

test('county_city sources are honest national locators', () => {
  for (const id of COUNTY_CITY) {
    const src = getSource(id);
    assert.equal(src.directory, true, `${id} must be a directory (locator, not a fake grant)`);
    assert.ok(/^https:\/\//.test(src.base_url), `${id} needs a real https base_url`);
    assert.equal(src.geography?.national, true, `${id} must be nationally applicable`);
    assert.ok(src.default_kinds?.includes(OPPORTUNITY_KIND.DIRECTORY), `${id} defaults to DIRECTORY`);
  }
});

test('state rows are scoped to their state (planner geography gate)', () => {
  for (const [id, st] of STATE_ROWS) {
    const src = getSource(id);
    assert.equal(src.geography?.national, false, `${id} must NOT be national`);
    assert.deepEqual(src.geography?.states, [st], `${id} must be scoped to ${st}`);
  }
});

test('disease rows carry the condition keywords the gap detector matches on', () => {
  const hay = (src) => [...(src.keywords ?? []), src.source_id, src.name].join(' ').toLowerCase();
  assert.ok(hay(getSource('reeve_foundation_paralysis')).includes('mobility'), 'reeve covers mobility (impairment)');
  assert.ok(hay(getSource('autism_speaks_family_support')).includes('neurodivergent'), 'autism source covers neurodivergent');
  // adapter wishlist 2026-07-11: the exact condition strings Amy reported.
  assert.ok(hay(getSource('arthritis_foundation_help')).includes('hip replacement'), 'arthritis source covers hip replacement');
  assert.ok(hay(getSource('samhsa_findtreatment')).includes('ptsd'), 'samhsa source covers ptsd');
  assert.ok(hay(getSource('american_kidney_fund')).includes('chronic kidney disease'), 'kidney fund covers chronic kidney disease');
  assert.ok(hay(getSource('needymeds_diagnosis_assistance')).includes('hypertension'), 'needymeds covers hypertension');
});

// ── The 2026-07-12 regression: a DIRECTORY locator (apply_url null BY DESIGN)
//    must be able to reach an ACCEPT match decision. The #886 no-apply-url
//    demotion held EVERY locator at REVIEW, so the county lane's candidates
//    never entered recommendations and Amy reported hyperlocal_recall_miss on
//    all 50 synthetic profiles every day. ──
const RICH_THESIS = {
  profile_id: 'p-recall-test',
  applicant_types: ['individual', 'family'],
  needs: ['housing', 'food', 'medical', 'utility_assistance'],
  is_student: false,
  location: { state: 'TN', county: 'Davidson County', city: 'Nashville', zip: '37203' },
  loan_allowed: false,
  cost_share_allowed: false,
};

function decisionForCountySource(sourceId, thesis) {
  const source = getSource(sourceId);
  const adapter = createCountyCityDirectoryAdapter(sourceId);
  const req = adapter.buildRequests(thesis, source, {})[0];
  const cand = adapter.mapCandidate(req.parseCfg.directoryCandidate, { thesis, source });
  const evidence = { url: req.url, content_hash: null, fetched_at: null };
  const verdict = enforceReality(cand, { thesis, source, evidence });
  assert.ok(verdict.ok, `${sourceId} locator must clear the reality gate`);
  const opp = normalize(cand, verdict, { source, evidence });
  return { opp, decision: computeMatchDecision(opp, thesis, { floor: 8 }) };
}

// The #886 guard, restated against the rule that now carries it. A locator's
// reachability is owned by isRecommendable(), NOT by it claiming ACCEPT: a
// pointer is admitted to the recommendation list at REVIEW. Asserting ACCEPT
// here is what previously forced locators to over-claim to stay visible
// (Amy false_positive x56) — the guard is that the locator stays RECOMMENDABLE.
test('a county DIRECTORY locator with no apply_url stays recommendation-eligible', () => {
  const { opp, decision } = decisionForCountySource('hud_resource_locator', RICH_THESIS);
  assert.equal(opp.apply_url, null, 'locator honesty: apply_url stays null');
  assert.ok(isRecommendable(opp, decision.decision),
    'locator must remain recommendation-eligible (hyperlocal fleet reachability)');
  assert.ok(
    !decision.match_explain.warnings.some((w) => /no direct application URL/i.test(w)),
    'a locator is never demoted for its by-design missing apply URL',
  );
  assert.match(opp.title, /Davidson County, TN/, 'title carries the county (hyperlocal recall)');
});

test('a DIRECTORY locator is never labelled a strong match (ACCEPT)', () => {
  const { opp, decision } = decisionForCountySource('hud_resource_locator', RICH_THESIS);
  assert.equal(opp.kind, OPPORTUNITY_KIND.DIRECTORY);
  assert.notEqual(decision.decision, MATCH_DECISION.ACCEPT,
    'a pointer must not claim "eligibility and location check out" — it states neither');
  assert.ok(decision.match_explain.warnings.some((w) => /pointer to look through/i.test(w)));
});

test('a PROGRAM row with no apply_url is still held at REVIEW (the #886 guard stands)', () => {
  const { opp } = decisionForCountySource('hud_resource_locator', RICH_THESIS);
  // Same strong-fit opportunity re-shaped as a PROGRAM without an apply URL.
  // Unconditional: gating this on the locator's own decision made the assertion
  // vacuous the moment locators stopped reaching ACCEPT.
  const program = { ...opp, kind: 'PROGRAM', apply_url: null };
  const d = computeMatchDecision(program, RICH_THESIS, { floor: 8 });
  assert.equal(d.decision, MATCH_DECISION.REVIEW,
    'non-locator rows without an apply target must still demote to REVIEW');
  assert.ok(d.match_explain.warnings.some((w) => /no direct application URL/i.test(w)));
  assert.ok(!isRecommendable(program, d.decision),
    'a PROGRAM held at REVIEW is NOT recommendable — only locators are admitted at REVIEW');
});

test('countyCityDirectoryAdapter personalizes the candidate to the profile place', () => {
  const adapter = createCountyCityDirectoryAdapter('findhelp_local_programs');
  const source = getSource('findhelp_local_programs');
  const thesis = { location: { county: 'Whatcom', state: 'WA', zip: '98225', city: 'Bellingham' } };

  const reqs = adapter.buildRequests(thesis, source, {});
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].url, 'https://www.findhelp.org/search_results/98225', 'ZIP deep-link via url_template');
  const cand = reqs[0].parseCfg.directoryCandidate;
  assert.match(cand.title, /Whatcom County, WA/, 'candidate title names the profile county (hyperlocal recall)');
  assert.equal(cand.kind, OPPORTUNITY_KIND.DIRECTORY);
  assert.equal(cand.apply_url, null, 'a locator never fakes an apply URL');

  const mapped = adapter.mapCandidate(cand, { thesis, source });
  assert.equal(mapped.source_id, 'findhelp_local_programs');
  assert.equal(mapped.is_directory, true);
  assert.match(mapped.title, /Whatcom County, WA/);
});

test('countyCityDirectoryAdapter degrades honestly with no location', () => {
  const adapter = createCountyCityDirectoryAdapter('usa_gov_local_governments');
  const source = getSource('usa_gov_local_governments');

  const reqs = adapter.buildRequests({}, source, {});
  assert.equal(reqs[0].url, source.base_url, 'no ZIP → plain base_url, nothing invented');
  const cand = reqs[0].parseCfg.directoryCandidate;
  assert.equal(cand.title, source.resource_title, 'no place → generic honest title');
});

test('countyCityDirectoryAdapter never substitutes a malformed ZIP', () => {
  const adapter = createCountyCityDirectoryAdapter('findhelp_local_programs');
  const source = getSource('findhelp_local_programs');
  const reqs = adapter.buildRequests({ location: { zip: 'not-a-zip', state: 'WA' } }, source, {});
  assert.equal(reqs[0].url, source.base_url, 'bad ZIP falls back to base_url');
});
