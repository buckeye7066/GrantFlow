// tests/orphanedLanePorts.test.mjs
//
// The 11 verified-uncovered funding lanes ported into the OS on 2026-07-07
// (owner directive: "if there are other crawler lanes that got left out like
// ECF, port them in too"):
//
//   propublica_990 (API — IRS 990 grantmakers), arc_dra, orr_refugee,
//   acf_chafee_foster, ccdf_childcare, dol_eta_workforce, nea_neh_arts,
//   usda_conservation, hrsa_health_workforce, copay_assistance_foundations,
//   va_housing_grants.
//
// Covers: registry + adapter wiring for all 11; the ProPublica adapter with a
// mocked fetch end-to-end (grantmaker entities → PROGRAM opportunity rows; a
// 404 page-overrun ends pagination cleanly, NOT as a fetch error; a real
// outage degrades honestly to FETCH_ERROR — the sbir_gov precedent); and the
// planner: a farm profile selects usda_conservation, a veteran+housing profile
// selects va_housing_grants.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getSource } from '../sourceRegistry.js';
import { getAdapter, implementedAdapterIds } from '../adapters/index.js';
import {
  createPropublica990Adapter,
  propublica990ParseCfg,
  needsToNteeGroups,
  looksLikeGrantmaker,
} from '../adapters/propublica990Adapter.js';
import { parseApiJson } from '../parsers.js';
import { buildThesis } from '../profileIntelligence.js';
import { plan } from '../planner.js';
import { runDiscovery } from '../pipeline.js';
import { createFetcher } from '../fetcher.js';
import { createMemoryStore } from '../store.js';
import { OPPORTUNITY_KIND } from '../contract.js';

const PORTED_LANES = [
  'propublica_990', 'arc_dra', 'orr_refugee', 'acf_chafee_foster',
  'ccdf_childcare', 'dol_eta_workforce', 'nea_neh_arts', 'usda_conservation',
  'hrsa_health_workforce', 'copay_assistance_foundations', 'va_housing_grants',
];

test('all 11 ported lanes have a registry row AND an implemented adapter', () => {
  const ids = implementedAdapterIds();
  for (const id of PORTED_LANES) {
    const src = getSource(id);
    assert.ok(src, `${id} source row missing`);
    assert.ok(ids.includes(id), `${id} adapter not registered (would be SKIPPED(no_adapter))`);
    assert.ok(getAdapter(id), `${id} adapter factory must build`);
  }
});

test('registry honesty: directory lanes are DIRECTORY-kind, benefit/grant lanes carry their real kind', () => {
  for (const id of ['arc_dra', 'orr_refugee', 'dol_eta_workforce', 'nea_neh_arts', 'usda_conservation', 'hrsa_health_workforce', 'copay_assistance_foundations']) {
    const src = getSource(id);
    assert.equal(src.directory, true, `${id} must be an honest directory`);
    assert.deepEqual(src.default_kinds, [OPPORTUNITY_KIND.DIRECTORY], `${id} default kind`);
  }
  assert.deepEqual(getSource('acf_chafee_foster').default_kinds, [OPPORTUNITY_KIND.BENEFIT]);
  assert.deepEqual(getSource('ccdf_childcare').default_kinds, [OPPORTUNITY_KIND.BENEFIT]);
  // SAH/SHA are real grants with a real application — a DIRECT_GRANT lane.
  assert.deepEqual(getSource('va_housing_grants').default_kinds, [OPPORTUNITY_KIND.DIRECT_GRANT]);
  assert.equal(getSource('va_housing_grants').directory, false);
  assert.equal(getSource('propublica_990').source_type, 'api');
  assert.equal(getSource('propublica_990').directory, false);
});

// ── ProPublica 990 adapter ──────────────────────────────────────────────────

const PP_SEARCH_HIT = {
  ein: 581943575,
  name: 'Bradley Community Foundation',
  city: 'Cleveland',
  state: 'TN',
  ntee_code: 'T31',
  subseccd: 3,
  score: 1.0,
};
const PP_SERVICE_ORG_HIT = {
  ein: 581111222,
  name: 'Cleveland Soup Kitchen Services',
  city: 'Cleveland',
  state: 'TN',
  ntee_code: 'K31',
  subseccd: 3,
  score: 0.7,
};

test('needsToNteeGroups always searches grantmakers (group 7) first, then need-derived groups, bounded', () => {
  const groups = needsToNteeGroups(['housing', 'food', 'education', 'medical']);
  assert.equal(groups[0], 7, 'group 7 (T = Philanthropy/Grantmaking) always first');
  assert.ok(groups.length <= 3, 'bounded');
  assert.ok(groups.includes(5), 'housing (L) maps into group 5');
  // Unknown needs add nothing (no throw, no junk).
  assert.deepEqual(needsToNteeGroups(['not_a_need']), [7]);
});

test('buildRequests drives NTEE groups + state from the thesis with bracket-style params and bounded pages', () => {
  const adapter = createPropublica990Adapter();
  const reqs = adapter.buildRequests(
    { needs: ['housing'], location: { state: 'tn' } },
    getSource('propublica_990'),
    {},
  );
  assert.ok(reqs.length >= 2 && reqs.length <= 6, `bounded request set, got ${reqs.length}`);
  for (const r of reqs) {
    assert.match(r.url, /^https:\/\/projects\.propublica\.org\/nonprofits\/api\/v2\/search\.json\?/);
    assert.match(r.url, /ntee%5Bid%5D=\d+/, 'ntee[id] filter (encoded brackets)');
    assert.match(r.url, /state%5Bid%5D=TN/, 'state[id] filter uppercased');
    assert.equal(r.family, 'api');
    assert.ok(Number.isInteger(r.meta?.pp_page), 'page recorded for overrun detection');
  }
  // No API key required.
  assert.deepEqual(adapter.missingEnv({}), []);
});

test('grantmaker entities map to apply-direct PROGRAM rows; service orgs and junk rows do not', () => {
  const adapter = createPropublica990Adapter();
  const parsed = parseApiJson(
    JSON.stringify({ total_results: 2, organizations: [PP_SEARCH_HIT, PP_SERVICE_ORG_HIT] }),
    propublica990ParseCfg(),
  );
  assert.ok(!parsed.error, `parse error: ${parsed.error}`);
  assert.equal(parsed.candidates.length, 2);

  const src = getSource('propublica_990');
  const funder = adapter.mapCandidate(parsed.candidates[0], { source: src });
  assert.ok(funder, 'NTEE T org is a grantmaker');
  assert.equal(funder.kind, OPPORTUNITY_KIND.PROGRAM);
  assert.equal(funder.external_id, '581943575');
  assert.equal(funder.sponsor, 'Bradley Community Foundation');
  assert.equal(funder.title, 'Bradley Community Foundation — Foundation/Grantmaker');
  assert.equal(funder.apply_url, null, 'must NOT fabricate an apply_url');
  assert.equal(funder.deadline, null, 'must NOT fabricate a deadline');
  assert.equal(funder.info_url, 'https://projects.propublica.org/nonprofits/organizations/581943575');
  assert.deepEqual(funder.geography, { national: false, states: ['TN'] }, 'scoped to the filing state');

  // A service nonprofit (NTEE K, no foundation name) is NOT presented as a funder.
  assert.equal(adapter.mapCandidate(parsed.candidates[1], { source: src }), null);
  assert.equal(looksLikeGrantmaker({ name: 'Smith Family Charitable Trust', ntee_code: 'B82' }), true, 'foundation-shaped names count');
  // Rows without a valid EIN are dropped (no stable identity → no row).
  assert.equal(adapter.mapCandidate({ external_id: '123', name: 'Bad EIN Foundation', ntee_code: 'T20' }, { source: src }), null);
});

test('API schema drift is an honest PARSE_ERROR, never a silent empty (sbir_gov precedent)', () => {
  const drift = parseApiJson(JSON.stringify({ error: 'unavailable' }), propublica990ParseCfg());
  assert.equal(drift.candidates.length, 0);
  assert.equal(drift.error, 'schema_mismatch');
});

// End-to-end through the REAL pipeline with a mocked network.
function ppDeps(routeFn) {
  return {
    store: createMemoryStore(),
    fetcher: createFetcher({
      doFetch: async (url) => routeFn(url),
      resolve: async () => ['203.0.113.10'], // public TEST-NET-3 — SSRF guard exercised, no DNS
      rateMs: 0,
    }),
    env: {},
    clock: () => Date.now(),
  };
}

function jsonResp(status, body, url) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: () => null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

const PP_THESIS = {
  profile_id: 'profile_np_1',
  applicant_types: ['nonprofit'],
  is_org: true,
  needs: ['housing'],
  location: { state: 'TN' },
  loan_allowed: false,
  cost_share_allowed: false,
};

test('pipeline run: page-0 grantmakers stored, page-overrun 404 ends pagination cleanly (outcome OK, no fetch_failed)', async () => {
  const d = ppDeps((url) => {
    if (!url.includes('projects.propublica.org')) return jsonResp(200, '', url);
    if (/page=0/.test(url)) {
      return jsonResp(200, { total_results: 1, num_pages: 1, cur_page: 0, organizations: [PP_SEARCH_HIT] }, url);
    }
    // The documented quirk: cur_page beyond num_pages → HTTP 404 with an
    // empty-organizations body. Must be treated as end-of-pages, not an error.
    return jsonResp(404, { status: 404, organizations: [] }, url);
  });
  const r = await runDiscovery(d, { thesis: PP_THESIS, matchProfiles: [PP_THESIS], runId: 'run_pp_ok' });
  const pp = r.sources.find((s) => s.source_id === 'propublica_990');
  assert.ok(pp, 'propublica_990 planned and ran for a nonprofit thesis');
  assert.equal(pp.outcome, 'ok', `overrun 404 must not degrade the outcome; got ${pp.outcome} (${pp.reason})`);
  assert.ok(pp.stored >= 1, 'grantmaker stored as a catalog row');
  const rejections = d.store.all('crawler_rejections').filter((x) => x.source_id === 'propublica_990');
  assert.ok(
    !rejections.some((x) => x.reason === 'fetch_failed'),
    `page-overrun 404 must not record fetch_failed; got ${JSON.stringify(rejections)}`,
  );
});

test('pipeline run: a real outage degrades honestly to FETCH_ERROR (no faked emptiness)', async () => {
  const d = ppDeps((url) => {
    if (!url.includes('projects.propublica.org')) return jsonResp(200, '', url);
    return jsonResp(500, 'upstream exploded', url);
  });
  const r = await runDiscovery(d, { thesis: PP_THESIS, matchProfiles: [PP_THESIS], runId: 'run_pp_down' });
  const pp = r.sources.find((s) => s.source_id === 'propublica_990');
  assert.ok(pp, 'propublica_990 ran');
  assert.equal(pp.outcome, 'fetch_error', 'a 500 outage is a FETCH_ERROR, never a silent empty');
  assert.equal(pp.stored, 0);
});

test('a page-0 404 is NOT benign (only overruns past page 0 are the documented quirk)', () => {
  const adapter = createPropublica990Adapter();
  assert.equal(
    adapter.benignFetchFailure({ status: 404, body: '{"organizations":[]}' }, { meta: { pp_page: 0 } }),
    false,
    'page 0 has no pages to overrun — a 404 there is a real failure',
  );
  assert.equal(
    adapter.benignFetchFailure({ status: 404, body: JSON.stringify({ organizations: [PP_SEARCH_HIT] }) }, { meta: { pp_page: 1 } }),
    false,
    'a 404 that still carries organizations would lose data — real failure',
  );
  assert.equal(
    adapter.benignFetchFailure({ status: 404, body: '<html>Not Found</html>' }, { meta: { pp_page: 1 } }),
    true,
    'non-JSON 404 body on page>0 is the overrun quirk',
  );
});

// ── Planner coverage for the ported lanes ───────────────────────────────────

test('planner: a farm profile selects usda_conservation', () => {
  const thesis = buildThesis({
    id: 'farm-oh',
    profile_type: 'farmer',
    location: { state: 'OH' },
    needs: ['conservation of soil and water on the farm', 'agriculture operations'],
  });
  const p = plan(thesis);
  assert.ok(
    p.selected_source_ids.includes('usda_conservation'),
    `farm profile must select usda_conservation; got ${p.selected_source_ids.join(', ')}`,
  );
});

test('planner: a veteran with a housing need selects va_housing_grants', () => {
  const thesis = buildThesis({
    id: 'vet-tn',
    profile_type: 'veteran',
    location: { state: 'TN' },
    needs: ['housing adaptation for my disability'],
  });
  const p = plan(thesis);
  assert.ok(
    p.selected_source_ids.includes('va_housing_grants'),
    `veteran+housing profile must select va_housing_grants; got ${p.selected_source_ids.join(', ')}`,
  );
  // Precision: the 990 grantmaker lane is org-facing — never for an individual.
  assert.ok(
    !p.selected_source_ids.includes('propublica_990'),
    'propublica_990 must not fire for a person/household profile',
  );
});
