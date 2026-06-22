// tests/fetcher.test.mjs
//
// Direct coverage for the SSRF-safe fetcher. Before this file the fetcher was
// only exercised indirectly through the pipeline, which is how a change to its
// default DNS resolver could silently couple the "offline" suite to live DNS.
// These tests pin both the security behavior (DNS-rebinding guard) and the
// hermetic offline helper so neither can regress unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetcher } from '../fetcher.js';
import { makeOfflineFetcher } from './fixtures/fakeFetch.mjs';

function okDoFetch(body = 'ok') {
  return async (url) => ({ status: 200, ok: true, url, headers: { get: () => null }, async text() { return body; } });
}

test('makeOfflineFetcher is hermetic: it reaches the fake body with no live DNS', async () => {
  const f = makeOfflineFetcher();
  const r = await f.fetch('https://api.grants.gov/v1/api/search2', { method: 'POST', body: '{}' });
  assert.equal(r.ok, true);
  assert.ok(r.body && r.body.length > 0);
  assert.ok(r.contentHash, 'evidence hash is captured');
});

test('the injected resolver is actually consulted (regression guard for the DNS coupling)', async () => {
  // a resolver returning a public IP -> guard passes, fetch proceeds
  const pass = createFetcher({ doFetch: okDoFetch('body'), resolve: async () => ['203.0.113.10'] });
  assert.equal((await pass.fetch('https://example.org/x')).ok, true);

  // a resolver returning a PRIVATE IP -> DNS-rebinding guard blocks before fetch
  const block = createFetcher({ doFetch: okDoFetch('body'), resolve: async () => ['10.0.0.5'] });
  const r = await block.fetch('https://example.org/x');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ssrf_guard');
  assert.equal(r.reason, 'dns_resolves_private');
});

test('a DNS error from the resolver blocks the fetch (air-gapped CI behavior is explicit, not a crash)', async () => {
  const f = createFetcher({ doFetch: okDoFetch('body'), resolve: async () => { throw new Error('no dns'); } });
  const r = await f.fetch('https://example.org/x');
  assert.equal(r.ok, false);
  assert.match(r.reason, /dns_error/);
});

test('an unsafe URL is rejected before any network call', async () => {
  let called = false;
  const f = createFetcher({ doFetch: async () => { called = true; return { status: 200, ok: true, text: async () => '' }; } });
  const r = await f.fetch('https://user:pass@example.org/x'); // embedded credentials
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unsafe_url');
  assert.equal(called, false, 'doFetch must not run for an unsafe URL');
});

test('a redirect to an unsafe location is re-validated and blocked', async () => {
  const doFetch = async (url) => {
    if (url.includes('start')) {
      return { status: 302, ok: false, url, headers: { get: (h) => (h.toLowerCase() === 'location' ? 'https://127.0.0.1/secret' : null) }, async text() { return ''; } };
    }
    return { status: 200, ok: true, url, headers: { get: () => null }, async text() { return 'should not reach'; } };
  };
  const f = createFetcher({ doFetch, resolve: async () => ['203.0.113.10'] });
  const r = await f.fetch('https://example.org/start');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'private_host'); // the redirect target is loopback
});
