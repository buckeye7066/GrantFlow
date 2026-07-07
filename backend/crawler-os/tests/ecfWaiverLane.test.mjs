// tests/ecfWaiverLane.test.mjs
//
// The Medicaid-waiver lane ported from the legacy ecfBenefitsCrawler /
// stateWaiverBenefitsCrawler (2026-07-07). The legacy crawlers were never
// registered in the OS sourceRegistry/adapters, so after the crawler-os
// cutover the ECF CHOICES lane was structurally uncrawlable — actual TN ECF
// CHOICES members (the Gilbert/Kim class) never had their own program crawled.
//
// Pins: registry rows are valid + adapters registered; the planner selects
// tn_ecf_choices for a TN disability profile and excludes it (explainably) for
// a non-TN profile; the adapter's ported extraction is conservative (keyword
// anchors only, blocklist, absolute URLs, no invented amounts); and a tn.gov
// fetch failure degrades honestly to FETCH_ERROR (sbir_gov precedent), never
// a fabricated row.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getSource } from '../sourceRegistry.js';
import { getAdapter, implementedAdapterIds } from '../adapters/index.js';
import { createEcfChoicesAdapter, ecfLiveParseCfg } from '../adapters/ecfChoicesAdapter.js';
import { parse } from '../parsers.js';
import { plan } from '../planner.js';
import { buildThesis } from '../profileIntelligence.js';
import { explainCrawlerPlan } from '../crawlerPlanExplainer.js';
import { runDiscovery } from '../pipeline.js';
import { createMemoryStore } from '../store.js';
import { OPPORTUNITY_KIND, CRAWLER_OUTCOME } from '../contract.js';
import { makeOfflineFetcher } from './fixtures/fakeFetch.mjs';

const NEW_SOURCES = ['tn_ecf_choices', 'state_hcbs_waivers', 'ssa_disability'];

// A Gilbert-shaped thesis input: TN individual whose waiver membership derived
// disability/healthcare/employment needs (see buildProfileSignals free-text scan).
const TN_WAIVER_PROFILE = Object.freeze({
  id: 'profile_ecf_1',
  type: 'individual',
  state: 'TN',
  location: { state: 'TN', city: 'Cleveland' },
  needs: ['disability', 'healthcare', 'employment'],
  tags: ['ecf choices', 'medicaid waiver'],
});

test('the three waiver-lane sources are registered with honest shapes', () => {
  for (const id of NEW_SOURCES) {
    const src = getSource(id);
    assert.ok(src, `source row missing: ${id}`);
    assert.ok(src.base_url && /^https:\/\//.test(src.base_url), `${id} needs a real https base_url`);
    assert.ok(src.resource_title && src.resource_summary, `${id} needs title + summary`);
    assert.ok(src.applicant_types.includes('individual'), `${id} must serve individuals`);
    assert.ok(src.need_categories.includes('disability'), `${id} must cover disability`);
    assert.equal(src.loan_allowed, false, `${id} never surfaces loans`);
  }
  const ecf = getSource('tn_ecf_choices');
  assert.equal(ecf.directory, false, 'ECF CHOICES is a real program page, not a locator');
  assert.deepEqual(ecf.geography, { national: false, states: ['TN'] }, 'ECF CHOICES is TN-only');
  assert.ok(ecf.default_kinds.includes(OPPORTUNITY_KIND.BENEFIT));
  assert.ok(ecf.need_categories.includes('employment'), 'Employment and Community First covers employment');

  const hcbs = getSource('state_hcbs_waivers');
  assert.equal(hcbs.directory, true, 'the national HCBS index is an honest DIRECTORY');
  assert.equal(hcbs.geography.national, true);

  const ssa = getSource('ssa_disability');
  assert.equal(ssa.directory, true, 'SSA disability is a locator (survives the known ssa.gov 403 honestly)');
  assert.equal(ssa.geography.national, true);
});

test('each waiver-lane source has an implemented adapter (no silent SKIPPED(no_adapter))', () => {
  const implemented = new Set(implementedAdapterIds());
  for (const id of NEW_SOURCES) {
    assert.ok(implemented.has(id), `adapter not registered for ${id}`);
    const adapter = getAdapter(id);
    assert.ok(adapter && typeof adapter === 'object', `getAdapter(${id}) should return an adapter`);
    assert.equal(adapter.source_id, id);
  }
});

test('planner: a TN disability profile selects tn_ecf_choices; a non-TN profile is excluded explainably', () => {
  const tn = plan(buildThesis(TN_WAIVER_PROFILE));
  assert.ok(tn.selected_source_ids.includes('tn_ecf_choices'), 'TN disability profile gets the ECF lane');
  assert.ok(tn.selected_source_ids.includes('state_hcbs_waivers'), 'national HCBS index also fires');
  assert.ok(tn.selected_source_ids.includes('ssa_disability'), 'SSA disability lane also fires');

  const oh = plan(buildThesis({ ...TN_WAIVER_PROFILE, id: 'profile_oh_1', state: 'OH', location: { state: 'OH' } }));
  assert.ok(!oh.selected_source_ids.includes('tn_ecf_choices'), 'ECF CHOICES never fires outside TN');
  const decision = oh.source_decisions.find((d) => d.source_id === 'tn_ecf_choices');
  assert.ok(decision.reasons.includes('geography_out_of_scope'), 'exclusion is explainable');
  assert.ok(oh.selected_source_ids.includes('state_hcbs_waivers'), 'a non-TN waiver profile still reaches its own state via the HCBS index');
});

test('plan explainer: tn_ecf_choices appears in selected_sources for TN and excluded_sources for OH', () => {
  const tnPlan = explainCrawlerPlan(TN_WAIVER_PROFILE);
  assert.ok(tnPlan.selected_sources.some((s) => s.source_id === 'tn_ecf_choices'));

  const ohPlan = explainCrawlerPlan({ ...TN_WAIVER_PROFILE, id: 'profile_oh_2', state: 'OH', location: { state: 'OH' } });
  const excluded = ohPlan.excluded_sources.find((s) => s.source_id === 'tn_ecf_choices');
  assert.ok(excluded, 'exclusion is surfaced');
  assert.ok(
    excluded.reasons.some((r) => /geographically out of scope/i.test(r)),
    'humanized geography reason present',
  );
});

test('adapter builds two honest requests: the program itself + conservative live discovery', () => {
  const source = getSource('tn_ecf_choices');
  const reqs = createEcfChoicesAdapter().buildRequests(buildThesis(TN_WAIVER_PROFILE), source);
  assert.equal(reqs.length, 2);
  const [program, live] = reqs;
  assert.equal(program.family, 'directory');
  assert.equal(program.parseCfg.directoryCandidate.kind, OPPORTUNITY_KIND.BENEFIT,
    'program candidate is a BENEFIT (not DIRECTORY) so a failed fetch is an honest fetch_error, never an emitted row');
  assert.equal(program.parseCfg.directoryCandidate.sponsor, 'TennCare');
  assert.equal(live.family, 'html');
  assert.ok(live.parseCfg.rowPattern, 'live pass parses anchors');
  for (const r of reqs) assert.ok(r.url.startsWith('https://www.tn.gov/'), 'both requests hit the official page');
});

test('ported live extraction is conservative: program-keyword anchors only, blocklist, absolute URLs, loans flagged', () => {
  const source = getSource('tn_ecf_choices');
  const adapter = createEcfChoicesAdapter();
  const html = `
    <html><body>
      <a href="/tenncare/essential-family-supports.html">Essential Family Supports program</a>
      <a href="https://www.tn.gov/didd/waiver-services.html">Waiver reimbursement for providers</a>
      <a href="/tenncare/contact-us.html">Contact program office</a>
      <a href="/about/program-history.html">About our program</a>
      <a href="/tenncare/board-minutes.html">Board meeting minutes</a>
      <a href="mailto:ecf@tn.gov">Email the benefit team</a>
      <a href="/loans/home-repair.html">Home repair loan assistance</a>
    </body></html>`;
  const parsed = parse('html', html, ecfLiveParseCfg());
  assert.ok(parsed.candidates.length >= 5, 'anchor rows extracted');
  const mapped = parsed.candidates
    .map((raw) => adapter.mapCandidate(raw, { source }))
    .filter(Boolean);
  const titles = mapped.map((c) => c.title);
  assert.ok(titles.includes('Essential Family Supports program'), 'relative href kept');
  assert.ok(titles.includes('Waiver reimbursement for providers'), 'absolute href kept');
  assert.ok(!titles.some((t) => /contact/i.test(t)), 'nav/contact links blocklisted');
  assert.ok(!titles.some((t) => /about our/i.test(t)), '/about links blocklisted');
  assert.ok(!titles.some((t) => /board meeting/i.test(t)), 'non-program anchor text dropped (no keyword)');
  assert.ok(!titles.some((t) => /email the/i.test(t)), 'mailto blocklisted');
  for (const c of mapped) {
    assert.ok(/^https:\/\/www\.tn\.gov\//.test(c.apply_url), `URL resolved absolute: ${c.apply_url}`);
    assert.equal(c.deadline, null, 'no invented deadlines');
  }
  const loan = mapped.find((c) => /loan/i.test(c.title));
  assert.ok(loan, 'loan-looking link still surfaced as a candidate...');
  assert.equal(loan.is_loan, true, '...but flagged is_loan so the reality gate applies the profile preference');
});

test('curated program candidate is honest: kind BENEFIT, rolling enrollment, official URL, no amounts', () => {
  const source = getSource('tn_ecf_choices');
  const adapter = createEcfChoicesAdapter();
  const req = adapter.buildRequests({}, source)[0];
  const parsed = parse('directory', '', req.parseCfg);
  assert.equal(parsed.candidates.length, 1);
  const c = adapter.mapCandidate(parsed.candidates[0], { source });
  assert.equal(c.kind, OPPORTUNITY_KIND.BENEFIT);
  assert.equal(c.is_directory, false);
  assert.equal(c.is_rolling, true, 'ECF enrollment is ongoing');
  assert.equal(c.sponsor, 'TennCare');
  assert.equal(c.apply_url, source.base_url);
  assert.equal(c.is_loan, false);
  assert.deepEqual(c.geography, { national: false, states: ['TN'] });
});

test('honest degrade: a tn.gov fetch failure surfaces as FETCH_ERROR with nothing stored for the source', async () => {
  const store = createMemoryStore();
  const fetcher = makeOfflineFetcher({ fail: new Set(['tn.gov']) });
  const res = await runDiscovery({ store, fetcher, env: {} }, { profile: TN_WAIVER_PROFILE });
  const summary = res.sources.find((s) => s.source_id === 'tn_ecf_choices');
  assert.ok(summary, 'the ECF source ran (it was planned)');
  assert.equal(summary.outcome, CRAWLER_OUTCOME.FETCH_ERROR, 'failure is an honest fetch_error');
  assert.equal(summary.stored, 0, 'nothing fabricated on fetch failure');
  assert.equal(summary.parsed, 0);
});

test('happy path: with the page reachable, the ECF program row is stored for a TN waiver profile', async () => {
  const store = createMemoryStore();
  const html = `
    <html><body>
      <a href="/tenncare/essential-family-supports.html">Essential Family Supports program</a>
    </body></html>`;
  const fetcher = makeOfflineFetcher({ routes: { 'tn.gov': html } });
  const res = await runDiscovery({ store, fetcher, env: {} }, { profile: TN_WAIVER_PROFILE });
  const summary = res.sources.find((s) => s.source_id === 'tn_ecf_choices');
  assert.ok(summary, 'the ECF source ran');
  assert.equal(summary.outcome, CRAWLER_OUTCOME.OK);
  assert.ok(summary.stored >= 2, 'program row + live-discovered row stored');
});
