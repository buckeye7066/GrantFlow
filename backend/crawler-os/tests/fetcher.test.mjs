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

function fakeResponse(status, body = '', headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://example.org/final',
    headers: { get: (name) => normalized.get(name.toLowerCase()) ?? null },
    async text() { return body; },
  };
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
  const pass = createFetcher({ doFetch: okDoFetch('body'), resolve: async () => ['8.8.8.8'] });
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
  const f = createFetcher({ doFetch, resolve: async () => ['8.8.8.8'] });
  const r = await f.fetch('https://example.org/start');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'private_host'); // the redirect target is loopback
});

test('an idempotent transient response is retried once with deterministic telemetry', async () => {
  let calls = 0;
  let resolutions = 0;
  const delays = [];
  const f = createFetcher({
    doFetch: async () => {
      calls += 1;
      return calls === 1 ? fakeResponse(503, 'busy') : fakeResponse(200, 'recovered');
    },
    resolve: async () => { resolutions += 1; return ['8.8.8.8']; },
    rateMs: 0,
    maxRetries: 1,
    retryBaseMs: 125,
    retryMaxMs: 1000,
    sleep: async (ms) => { delays.push(ms); },
  });

  const r = await f.fetch('https://example.org/retry');
  assert.equal(r.ok, true);
  assert.equal(r.body, 'recovered');
  assert.equal(calls, 2);
  assert.equal(resolutions, 2, 'every retry must repeat the DNS-rebinding guard');
  assert.equal(r.attempts, 2);
  assert.equal(r.retries, 1);
  assert.deepEqual(r.retryDelaysMs, [125]);
  assert.deepEqual(delays, [125]);
});

test('POST failures are never replayed even when retries are configured', async () => {
  let calls = 0;
  const f = createFetcher({
    doFetch: async () => { calls += 1; return fakeResponse(503, 'busy'); },
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxRetries: 3,
    retryBaseMs: 0,
  });

  const r = await f.fetch('https://example.org/search', { method: 'POST', body: '{}' });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
  assert.equal(r.retries, 0);
  assert.equal(r.retrySuppressed, 'non_idempotent_method');
});

test('Retry-After delta-seconds is honored when it fits the bounded delay', async () => {
  let calls = 0;
  const delays = [];
  const f = createFetcher({
    doFetch: async () => {
      calls += 1;
      return calls === 1
        ? fakeResponse(429, 'slow down', { 'Retry-After': '2' })
        : fakeResponse(200, 'ok');
    },
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxRetries: 1,
    retryMaxMs: 2500,
    sleep: async (ms) => { delays.push(ms); },
  });

  const r = await f.fetch('https://example.org/rate-limited');
  assert.equal(r.ok, true);
  assert.deepEqual(delays, [2000]);
  assert.deepEqual(r.retryDelaysMs, [2000]);
});

test('Retry-After HTTP-date is parsed against the injected clock', async () => {
  const at = Date.parse('2026-08-05T12:00:00Z');
  let calls = 0;
  const delays = [];
  const f = createFetcher({
    doFetch: async () => {
      calls += 1;
      return calls === 1
        ? fakeResponse(503, 'busy', { 'retry-after': new Date(at + 3000).toUTCString() })
        : fakeResponse(200, 'ok');
    },
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxRetries: 1,
    retryMaxMs: 4000,
    clock: () => at,
    sleep: async (ms) => { delays.push(ms); },
  });

  const r = await f.fetch('https://example.org/date-retry');
  assert.equal(r.ok, true);
  assert.deepEqual(delays, [3000]);
});

test('a Retry-After beyond the local bound suppresses retry instead of retrying early', async () => {
  let calls = 0;
  const delays = [];
  const f = createFetcher({
    doFetch: async () => { calls += 1; return fakeResponse(429, 'later', { 'Retry-After': '120' }); },
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxRetries: 1,
    retryMaxMs: 5000,
    sleep: async (ms) => { delays.push(ms); },
  });

  const r = await f.fetch('https://example.org/long-retry');
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
  assert.equal(r.retryAfterMs, 120000);
  assert.equal(r.retrySuppressed, 'retry_after_exceeds_limit');
});

test('a transient network error is retried, but a timeout is not', async () => {
  let networkCalls = 0;
  const network = createFetcher({
    doFetch: async () => {
      networkCalls += 1;
      if (networkCalls === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      return fakeResponse(200, 'recovered');
    },
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxRetries: 1,
    retryBaseMs: 0,
  });
  assert.equal((await network.fetch('https://example.org/network')).ok, true);
  assert.equal(networkCalls, 2);

  let timeoutCalls = 0;
  const timeout = createFetcher({
    doFetch: async () => {
      timeoutCalls += 1;
      const error = new Error('request timed out');
      error.name = 'TimeoutError';
      throw error;
    },
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxRetries: 1,
    retryBaseMs: 0,
  });
  const timedOut = await timeout.fetch('https://example.org/timeout');
  assert.equal(timedOut.ok, false);
  assert.equal(timeoutCalls, 1, 'a 30s production timeout must not double the run budget');
  assert.equal(timedOut.reason, 'fetch_threw');
});

test('an oversized Content-Length is rejected before the body is read', async () => {
  let cancelled = false;
  let textRead = false;
  const f = createFetcher({
    doFetch: async () => ({
      ...fakeResponse(200, 'unreachable', { 'content-length': '6' }),
      body: { locked: false, async cancel() { cancelled = true; } },
      async text() { textRead = true; return 'unreachable'; },
    }),
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxResponseBytes: 5,
  });

  const r = await f.fetch('https://example.org/declared-large');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'response_too_large');
  assert.equal(r.reason, 'content_length_exceeds_limit');
  assert.equal(r.declaredResponseBytes, 6);
  assert.equal(r.responseBytes, 0);
  assert.equal(textRead, false);
  assert.equal(cancelled, true);
});

test('a streamed body is cancelled as soon as it crosses the byte limit', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('123'));
      controller.enqueue(new TextEncoder().encode('456'));
    },
    cancel() { cancelled = true; },
  });
  const f = createFetcher({
    doFetch: async () => ({ ...fakeResponse(200), body }),
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxResponseBytes: 5,
  });

  const r = await f.fetch('https://example.org/stream-large');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'response_too_large');
  assert.equal(r.reason, 'body_exceeds_limit');
  assert.equal(r.responseBytes, 6);
  assert.equal(cancelled, true);
});

test('the byte cap is UTF-8 aware and accepts a body exactly at the limit', async () => {
  const f = createFetcher({
    doFetch: okDoFetch('€a'), // 4 UTF-8 bytes, 2 JavaScript code units
    resolve: async () => ['8.8.8.8'],
    rateMs: 0,
    maxResponseBytes: 4,
  });

  const r = await f.fetch('https://example.org/unicode');
  assert.equal(r.ok, true);
  assert.equal(r.body, '€a');
  assert.equal(r.responseBytes, 4);
  assert.equal(r.maxResponseBytes, 4);
  assert.ok(r.contentHash);
});
