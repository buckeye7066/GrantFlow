// tests/agencyRssAdapter.test.mjs
//
// The NIH Guide RSS lane (nih_guide) went silently dark: NIH's feed emits its
// item <link>s as `http://grants.nih.gov/...`, and the reality gate hard-rejects
// any http URL as BAD_URL (a no-downgrade security floor, realityGate.js). So
// every NIH candidate was rejected `all_candidates_rejected:bad_url` for every
// research-leaning profile (Axiom BioLabs, live 2026-08-22). The adapter now
// scheme-normalizes the extracted info_url to https; the gate's http rejection
// stays intact (we fix the untrusted source, never loosen the invariant).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgencyRssAdapter } from '../adapters/agencyRssAdapter.js';
import { getSource } from '../sourceRegistry.js';
import { getAdapter, implementedAdapterIds } from '../adapters/index.js';

const adapter = createAgencyRssAdapter();
const src = { sponsor_name: 'U.S. National Institutes of Health' };

test('nih_guide adapter is registered and its registry row is valid', () => {
  assert.ok(implementedAdapterIds().includes('nih_guide'), 'nih_guide adapter must be registered');
  const row = getSource('nih_guide');
  assert.equal(row?.source_id, 'nih_guide');
  assert.ok(String(row?.feed_url || row?.base_url || '').startsWith('https://'), 'feed_url must be https');
  assert.ok(getAdapter('nih_guide'), 'adapter must resolve from the registry');
});

test('an http:// feed link is upgraded to https on info_url AND external_id', () => {
  const c = adapter.mapCandidate(
    { title: 'Notice of Special Interest: Bioengineering', info_url: 'http://grants.nih.gov/grants/guide/notice-files/NOT-DK-27-402.html' },
    { source: src },
  );
  assert.ok(c, 'candidate must not be dropped');
  assert.equal(c.info_url, 'https://grants.nih.gov/grants/guide/notice-files/NOT-DK-27-402.html');
  assert.equal(c.apply_url, null, 'PROGRAM notice carries no apply_url');
  assert.equal(c.external_id, c.info_url, 'external_id keys off the normalized url');
  // The load-bearing assertion: the gate rejects http, so a passing candidate must be https.
  assert.ok(/^https:\/\//i.test(c.info_url), 'info_url must be https so the reality gate does not reject it as bad_url');
});

test('an already-https feed link is left untouched', () => {
  const url = 'https://grants.nih.gov/grants/guide/notice-files/NOT-GM-26-015.html';
  const c = adapter.mapCandidate({ title: 'T32 Training', info_url: url }, { source: src });
  assert.equal(c.info_url, url);
});

test('a candidate with no link is still dropped (title alone is not an opportunity)', () => {
  assert.equal(adapter.mapCandidate({ title: 'Webinar', info_url: '' }, { source: src }), null);
  assert.equal(adapter.mapCandidate({ title: '', info_url: 'http://grants.nih.gov/x.html' }, { source: src }), null);
});
