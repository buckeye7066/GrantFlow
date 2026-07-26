// tests/sbirGovAdapter.test.mjs
//
// SBIR.gov adapter + the research-org planner gate + the root-list parse mode.
// The live public API is intermittently disabled ("not available at this
// time"), so these tests pin the DOCUMENTED schema and the honest failure
// shape for the API-down object response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSbirGovAdapter, sbirGovParseCfg } from '../adapters/sbirGovAdapter.js';
import { getAdapter } from '../adapters/index.js';
import { parseApiJson } from '../parsers.js';
import { plan } from '../planner.js';

const RESEARCH_THESIS = {
  applicant_types: ['nonprofit', 'business'],
  is_org: true,
  is_research_org: true,
  research_topic: 'biotechnology',
  needs: ['research_funding'],
  location: { state: 'TN', city: 'Cleveland' },
  loan_allowed: false,
  cost_share_allowed: false,
};

const SAMPLE_SOLICITATION = {
  solicitation_number: 'N26A-T001',
  solicitation_title: 'Navy STTR 2026.A — Biotechnology Topics',
  program: 'STTR',
  phase: 'I',
  agency: 'Department of Defense',
  branch: 'Navy',
  open_date: '2026-06-01',
  close_date: '2026-08-15',
  current_status: 'open',
  sbir_solicitation_link: 'https://www.sbir.gov/node/1234567',
  solicitation_agency_url: 'https://www.navysbir.com/26_A/',
  solicitation_topics: [
    { topic_title: 'Synthetic biology for expeditionary medicine', topic_number: 'N26A-T001-01' },
    { topic_title: 'Field-portable genomic sequencing', topic_number: 'N26A-T001-02' },
  ],
};

test('adapter is registered for the sbir_gov source', () => {
  const adapter = getAdapter('sbir_gov');
  assert.ok(adapter, 'sbir_gov must have an adapter (no silent SKIPPED(no_adapter))');
  assert.equal(adapter.source_id, 'sbir_gov');
});

test('buildRequests searches the extracted research topic, open solicitations only', () => {
  const reqs = createSbirGovAdapter().buildRequests(RESEARCH_THESIS, {});
  assert.ok(reqs.length >= 1);
  assert.ok(reqs[0].url.includes('keyword=biotechnology'), 'topic keyword');
  assert.ok(reqs.every((r) => r.url.includes('open=1')), 'open solicitations only');
});

test('root-list parse mode: a bare-array response parses; the API-down object is an honest schema error', () => {
  const ok = parseApiJson(JSON.stringify([SAMPLE_SOLICITATION]), sbirGovParseCfg());
  assert.equal(ok.candidates.length, 1);
  assert.equal(ok.candidates[0].title, 'Navy STTR 2026.A — Biotechnology Topics');

  const down = parseApiJson(
    JSON.stringify({ Code: 'TooManyRequestsError', Message: 'The SBIR Public API is not available at this time.' }),
    sbirGovParseCfg(),
  );
  assert.equal(down.candidates.length, 0);
  assert.equal(down.error, 'schema_mismatch', 'API-down object must be an honest PARSE_ERROR, not a silent empty');
});

test('mapCandidate maps a solicitation to an actionable PROGRAM candidate', () => {
  const parsed = parseApiJson(JSON.stringify([SAMPLE_SOLICITATION]), sbirGovParseCfg());
  const c = createSbirGovAdapter().mapCandidate(parsed.candidates[0], { source: {} });
  assert.equal(c.kind, 'PROGRAM');
  assert.equal(c.external_id, 'N26A-T001');
  assert.equal(c.sponsor, 'Department of Defense (STTR Phase I)');
  assert.equal(c.deadline, '2026-08-15');
  assert.equal(c.apply_url, 'https://www.navysbir.com/26_A/');
  assert.equal(c.info_url, 'https://www.sbir.gov/node/1234567');
  assert.ok(c.summary.includes('Synthetic biology'), 'topics summarized');
  assert.equal(c.is_loan, false);
});

test('mapCandidate refuses rows with no official URL to point at', () => {
  const c = createSbirGovAdapter().mapCandidate(
    { external_id: 'X', title: 'Ghost', info_url: '', agency_url: '' },
    { source: {} },
  );
  assert.equal(c, null);
});

test('planner selects sbir_gov ONLY for research orgs (research_only gate)', () => {
  const research = plan(RESEARCH_THESIS);
  assert.ok(research.selected_source_ids.includes('sbir_gov'), 'research org gets sbir_gov');

  const pantry = plan({ applicant_types: ['nonprofit'], is_org: true, needs: ['food'], location: { state: 'TN' } });
  assert.ok(!pantry.selected_source_ids.includes('sbir_gov'), 'food pantry never searches solicitations');
  const decision = pantry.source_decisions.find((d) => d.source_id === 'sbir_gov');
  assert.ok(decision.reasons.includes('research_org_only'), 'exclusion is explainable');
});

test('the SBIR API outage banner is a BENIGN skip with an honest reason — a real 5xx stays a failure', () => {
  // The API answers EVERY request with this banner during its service-wide
  // outage (observed 2026-07-06 → 2026-07-26). "The service says it is off"
  // is a definite external state, not our fetch failing — reporting it as
  // FETCH_ERROR paged the owner nightly (per-source failure detector + Amy's
  // source_fetch_failed) about a government outage nobody can act on.
  const adapter = createSbirGovAdapter();
  const banner = JSON.stringify({ Code: 'TooManyRequestsError', Message: 'The SBIR Public API is not available at this time.' });
  assert.equal(
    adapter.benignFetchFailure({ ok: false, status: 429, body: banner }),
    'api_outage:sbir_public_api_unavailable',
  );
  // Anything else stays a genuine failure: a bare 500, an empty body, a WAF page.
  assert.equal(adapter.benignFetchFailure({ ok: false, status: 500, body: 'Internal Server Error' }), false);
  assert.equal(adapter.benignFetchFailure({ ok: false, status: 429, body: '' }), false);
  assert.equal(adapter.benignFetchFailure({ ok: false, status: 403, body: '<html>blocked</html>' }), false);
});
