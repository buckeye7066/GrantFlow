// tests/hardeningRegression.test.mjs
//
// Hostile-review regression suite. These tests pin the defects found after the
// 130-test optimized crawler build: directory/program URL semantics, category
// pollution, wildcard scoring, IPv6 SSRF literals, Yana evidence requirements,
// and admin control authority.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeUrl } from '../safeUrl.js';
import { inferCandidateProfile } from '../crawlerVocabulary.js';
import { getSource } from '../sourceRegistry.js';
import { createMemoryStore } from '../store.js';
import { runDiscovery } from '../pipeline.js';
import { buildThesis } from '../profileIntelligence.js';
import { computeMatchDecision } from '../matchEngine.js';
import { enforceReality } from '../realityGate.js';
import { makeOpportunity, OPPORTUNITY_KIND, REALITY_STATUS, TRUST_TIER } from '../contract.js';
import { storage } from '../index.js';
import { makeOfflineFetcher, SAMPLE_STUDENT_PROFILE, SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';
import { createYana } from '../agents/yana.js';
import { createFleet } from '../agents/index.js';
import { createScheduler } from '../scheduler.js';
import { createAdminControl } from '../adminControl.js';

test('StudentAid.gov stores as an honest DIRECTORY, not a broken scholarship with no apply_url', async () => {
  const store = createMemoryStore();
  const fetcher = makeOfflineFetcher();
  const thesis = buildThesis(SAMPLE_STUDENT_PROFILE);
  const run = await runDiscovery({ store, fetcher }, { thesis, matchProfiles: [thesis], runId: 'student_dir' });
  const studentSource = run.sources.find((s) => s.source_id === 'studentaid_gov');
  assert.ok(studentSource, 'studentaid_gov source ran for a student profile');
  assert.equal(studentSource.outcome, 'ok');
  const stored = storage.listCatalog(store).find((o) => o.source_id === 'studentaid_gov');
  assert.ok(stored, 'student aid directory stored in catalog');
  assert.equal(stored.kind, OPPORTUNITY_KIND.DIRECTORY);
  assert.equal(stored.apply_url, null);
  assert.ok(stored.info_url.includes('studentaid.gov'));
});

test('SAM.gov PROGRAM rows with an info_url store for REVIEW instead of failing missing apply_url', async () => {
  const store = createMemoryStore();
  const samBody = {
    _embedded: {
      results: [{
        programNumber: '10.766',
        title: 'Community Facilities Direct Loan and Grant Program',
        organizationName: 'U.S. Department of Agriculture',
        objective: 'Provides affordable funding to develop essential community facilities in rural areas.',
      }],
    },
  };
  const fetcher = makeOfflineFetcher({ routes: { 'api.sam.gov': samBody } });
  const profile = {
    id: 'profile_nonprofit_1', name: 'Rural Clinic', type: 'nonprofit',
    location: { state: 'TN' }, needs: ['capital'], allow_loans: true,
  };
  const thesis = buildThesis(profile);
  const run = await runDiscovery({ store, fetcher, env: { SAM_GOV_API_KEY: 'test-key' } }, { thesis, matchProfiles: [thesis], runId: 'sam_success' });
  const sam = run.sources.find((s) => s.source_id === 'sam_gov');
  assert.ok(sam, 'sam_gov source ran');
  assert.equal(sam.outcome, 'ok');
  const row = storage.listCatalog(store).find((o) => o.source_id === 'sam_gov');
  assert.ok(row, 'SAM program stored');
  assert.equal(row.apply_url, null);
  assert.ok(row.info_url.includes('sam.gov/fal/10.766/view'));
  const match = storage.getMatchesForProfile(store, thesis.profile_id).find((m) => m.opportunity_id === row.id);
  assert.ok(match, 'SAM program was matched to profile');
  assert.equal(match.decision, 'review');
});

test('inferred concrete applicant categories do not get polluted by broad source fallback categories', () => {
  const inferred = inferCandidateProfile({
    title: 'Individual Artist Grant',
    sponsor: 'National Endowment for the Arts',
    summary: 'Funding for individual resident artists and families.',
  }, getSource('grants_gov'));
  assert.deepEqual(inferred.applicant_types, ['individual']);
  assert.equal(inferred.applicant_types.includes('vfd'), false);

  const vfdThesis = buildThesis(SAMPLE_VFD_PROFILE);
  const opp = makeOpportunity({
    source_id: 'grants_gov', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Individual Artist Grant', sponsor: 'NEA',
    applicant_types: inferred.applicant_types, need_categories: ['programs'],
    geography: { national: true }, apply_url: 'https://www.grants.gov/search-results-detail/ART',
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
  });
  const match = computeMatchDecision(opp, vfdThesis);
  assert.notEqual(match.decision, 'accept', 'individual-only grant must not become a strong VFD match');
  assert.ok(match.match_explain.warnings.some((w) => /applicant type/i.test(w)));
});

test('match engine scores concrete needs before wildcard fallback', () => {
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const opp = makeOpportunity({
    source_id: 'grants_gov', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Fire Equipment Grant', sponsor: 'FEMA',
    applicant_types: ['vfd'], need_categories: ['equipment', 'emergency', '*'],
    geography: { national: true }, apply_url: 'https://www.grants.gov/search-results-detail/FIRE',
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
  });
  const match = computeMatchDecision(opp, thesis);
  assert.equal(match.match_explain.score_breakdown.need, 25);
  assert.deepEqual(match.match_explain.matched_needs.sort(), ['emergency', 'equipment']);
});

test('safeUrl blocks bracketed IPv6 private/link-local literals', () => {
  for (const url of ['http://[::1]/x', 'http://[::]/x', 'http://[fe80::1]/x', 'http://[fd00::1]/x', 'http://[::ffff:127.0.0.1]/x']) {
    const r = isSafeUrl(url, { kind: 'fetch' });
    assert.equal(r.ok, false, `${url} should be blocked`);
    assert.equal(r.reason, 'private_host');
  }
});

test('Yana does not treat contact information as public evidence', async () => {
  const store = createMemoryStore();
  const yana = createYana({ store });
  const res = await yana.run({
    now: 8_000_000_000,
    candidates: [{
      name: 'Contact Only Org', profile_type: 'nonprofit',
      source_url: 'https://contact-only.example/about', contact: 'hello@contact-only.example',
      needs: ['operating'], evidence: null,
    }],
  });
  assert.equal(res.qualified, 0);
  assert.equal(res.rejected, 1);
  assert.ok(res.rejections.some((r) => r.reason === 'no_evidence'));
});

test('admin control must be explicitly RUNNING before a controlled scheduler cycle runs agents', async () => {
  const store = createMemoryStore();
  const fetcher = makeOfflineFetcher();
  const fleet = createFleet({ store, fetcher, env: {} });
  const control = createAdminControl({ store }); // idle by default
  const scheduler = createScheduler({ store, fleet, control });
  const report = await scheduler.runCycle({ profiles: [SAMPLE_VFD_PROFILE], now: 9_000_000_000 });
  assert.equal(report.aborted, true);
  assert.equal(report.steps.length, 0);
  assert.equal(storage.countOpportunities(store), 0);
});

test('safeUrl blocks the FULL IPv6 link-local / ULA / site-local ranges, not just fe80::', () => {
  // fe80::/10 spans fe80-febf; the first hardening pass only caught the fe80: prefix.
  for (const host of ['fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456::1']) {
    assert.equal(isSafeUrl(`http://[${host}]/x`, { kind: 'fetch' }).ok, false, `${host} must be blocked`);
  }
  // public IPv6 must still be allowed (no over-block)
  for (const host of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isSafeUrl(`https://[${host}]/x`, { kind: 'fetch' }).ok, true, `${host} must be allowed`);
  }
});

test('createSqlStore validates identifiers: legit names work, injected table/column names throw', async () => {
  const { createSqlStore } = await import('../store.js');
  const calls = [];
  const fakedb = { prepare: (sql) => { calls.push(sql); return { run: () => ({ changes: 1 }), get: () => null, all: () => [] }; } };
  const sql = createSqlStore(fakedb);
  sql.insert('funding_opportunities', { id: 'o1', title: 't' }); // safe path works
  assert.ok(calls[0].startsWith('INSERT INTO funding_opportunities'));
  assert.throws(() => sql.insert('opps; DROP TABLE opps;--', { id: 1 }), /unsafe SQL table/);
  assert.throws(() => sql.get('opps', { 'id=1 OR 1=1;--': 1 }), /unsafe SQL column/);
  assert.throws(() => sql.update('opps', { id: 1 }, { 'x);DROP TABLE y;--': 1 }), /unsafe SQL column/);
  assert.throws(() => sql.all('opps WHERE 1=1', {}), /unsafe SQL table/);
});


test('an applicable PROGRAM info_url must be https (no http downgrade)', () => {
  const httpCand = {
    source_id: 'sam_gov', kind: OPPORTUNITY_KIND.PROGRAM, title: 'Standing Program',
    sponsor: 'U.S. Federal Agency', apply_url: null, info_url: 'http://sam.gov/fal/10.123/view',
    is_rolling: true,
  };
  const httpsCand = { ...httpCand, info_url: 'https://sam.gov/fal/10.123/view' };
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const ev = { url: 'https://sam.gov/fal/10.123/view', content_hash: 'h', fetched_at: new Date().toISOString() };
  assert.equal(enforceReality(httpCand, { thesis, source: getSource('sam_gov'), evidence: ev }).ok, false);
  assert.equal(enforceReality(httpsCand, { thesis, source: getSource('sam_gov'), evidence: ev }).ok, true);
});
