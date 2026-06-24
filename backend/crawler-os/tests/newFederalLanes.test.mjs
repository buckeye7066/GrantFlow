// Tests for the net-new key-free federal source lanes:
//   - federal_register (JSON API)
//   - nih_guide        (RSS via the html parser family)
//
// Verifies: registry wiring, adapter request building, parser extraction, and
// that a real candidate survives the reality gate as a PROGRAM (REVIEW) — never
// faked, never an "apply now" with an invented deadline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAdapter, implementedAdapterIds } from '../adapters/index.js';
import { getSource } from '../sourceRegistry.js';
import { parse } from '../parsers.js';
import { enforceReality } from '../realityGate.js';
import { OPPORTUNITY_KIND, REALITY_STATUS } from '../contract.js';
import {
  createFederalRegisterAdapter,
  federalRegisterParseCfg,
} from '../adapters/federalRegisterAdapter.js';
import { createAgencyRssAdapter, rssParseCfg } from '../adapters/agencyRssAdapter.js';

test('both new lanes are registered with sources + adapters', () => {
  assert.ok(getSource('federal_register'), 'federal_register source row missing');
  assert.ok(getSource('nih_guide'), 'nih_guide source row missing');
  const ids = implementedAdapterIds();
  assert.ok(ids.includes('federal_register'), 'federal_register adapter not registered');
  assert.ok(ids.includes('nih_guide'), 'nih_guide adapter not registered');
});

test('Federal Register: builds key-free GET requests with the funding term + needs', () => {
  const adapter = createFederalRegisterAdapter();
  const reqs = adapter.buildRequests({ needs: ['equipment', 'emergency'] }, getSource('federal_register'), {});
  assert.ok(reqs.length >= 1 && reqs.length <= 3);
  for (const r of reqs) {
    assert.match(r.url, /^https:\/\/www\.federalregister\.gov\/api\/v1\/documents\.json\?/);
    assert.match(r.url, /conditions(\[|%5B)term/);
    assert.equal(r.family, 'api');
  }
  // No API key required.
  assert.deepEqual(adapter.missingEnv({}), []);
});

test('Federal Register: parses results JSON and survives the reality gate as PROGRAM/REVIEW', () => {
  const body = JSON.stringify({
    count: 1,
    results: [{
      document_number: '2026-12345',
      title: 'Notice of Funding Opportunity: Rural Water Infrastructure',
      html_url: 'https://www.federalregister.gov/documents/2026/06/24/2026-12345/notice',
      abstract: 'The agency announces the availability of funds for rural water projects.',
      publication_date: '2026-06-24',
      agencies: [{ name: 'Environmental Protection Agency', raw_name: 'EPA' }],
    }],
  });
  const { candidates, error } = parse('api', body, federalRegisterParseCfg());
  assert.ok(!error, `parse error: ${error}`);
  assert.equal(candidates.length, 1);

  const adapter = createFederalRegisterAdapter();
  const cand = adapter.mapCandidate(candidates[0], { source: getSource('federal_register') });
  assert.equal(cand.kind, OPPORTUNITY_KIND.PROGRAM);
  assert.equal(cand.sponsor, 'Environmental Protection Agency');
  assert.equal(cand.apply_url, null, 'must NOT fabricate an apply_url');
  assert.match(cand.info_url, /^https:\/\/www\.federalregister\.gov\//);

  const verdict = enforceReality(cand, { thesis: { applicant_types: ['government'] }, source: getSource('federal_register') });
  assert.equal(verdict.ok, true, `reality gate rejected: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.kind, OPPORTUNITY_KIND.PROGRAM);
  // No captured evidence in this unit test → LINK_UNVERIFIED (stored for REVIEW).
  assert.equal(verdict.reality_status, REALITY_STATUS.LINK_UNVERIFIED);
});

test('Federal Register: a result with no html_url is dropped (no fake info_url)', () => {
  const adapter = createFederalRegisterAdapter();
  const cand = adapter.mapCandidate(
    { external_id: 'x', title: 'No link notice', info_url: null, agencies: [] },
    { source: getSource('federal_register') },
  );
  assert.equal(cand, null);
});

test('NIH RSS: parses <item> blocks (CDATA + entities cleaned) and survives as PROGRAM', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[PAR-26-123: Research on Community Health & Equity]]></title>
      <link>https://grants.nih.gov/grants/guide/pa-files/PAR-26-123.html</link>
      <description><![CDATA[<p>NIH invites applications for <b>community health</b> research.</p>]]></description>
      <pubDate>Tue, 24 Jun 2026 00:00:00 GMT</pubDate>
    </item>
  </channel></rss>`;
  const { candidates } = parse('html', xml, rssParseCfg());
  assert.equal(candidates.length, 1);

  const adapter = createAgencyRssAdapter();
  const cand = adapter.mapCandidate(candidates[0], { source: getSource('nih_guide') });
  assert.equal(cand.kind, OPPORTUNITY_KIND.PROGRAM);
  assert.equal(cand.sponsor, 'U.S. National Institutes of Health');
  assert.match(cand.title, /PAR-26-123/);
  assert.ok(!/&amp;|<b>|CDATA/.test(cand.title), 'title must be cleaned of entities/CDATA');
  assert.ok(!/<p>|<b>/.test(cand.summary || ''), 'summary must strip HTML tags');
  assert.equal(cand.apply_url, null);
  assert.match(cand.info_url, /^https:\/\/grants\.nih\.gov\//);

  const verdict = enforceReality(cand, { thesis: { applicant_types: ['nonprofit'] }, source: getSource('nih_guide') });
  assert.equal(verdict.ok, true, `reality gate rejected: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.kind, OPPORTUNITY_KIND.PROGRAM);
});

test('NIH RSS: an item without a link is dropped', () => {
  const adapter = createAgencyRssAdapter();
  assert.equal(adapter.mapCandidate({ title: 'x', info_url: null }, { source: getSource('nih_guide') }), null);
});
