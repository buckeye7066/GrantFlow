// tests/safeUrl.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeUrl, isPrivateHost } from '../safeUrl.js';

test('isSafeUrl accepts a normal https apply URL', () => {
  const r = isSafeUrl('https://www.grants.gov/search-results-detail/123', { kind: 'apply' });
  assert.equal(r.ok, true);
  assert.equal(r.host, 'www.grants.gov');
});

test('isSafeUrl rejects http for an apply URL (https required)', () => {
  const r = isSafeUrl('http://example.org/apply', { kind: 'apply' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'apply_url_not_https');
});

test('isSafeUrl rejects a search-engine result URL presented as apply', () => {
  const r = isSafeUrl('https://www.google.com/search?q=grants', { kind: 'apply' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'search_url_as_apply');
});

test('isSafeUrl rejects embedded credentials', () => {
  const r = isSafeUrl('https://user:pass@example.org/apply', { kind: 'apply' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'embedded_credentials');
});

test('isSafeUrl rejects unparseable and empty input', () => {
  assert.equal(isSafeUrl('not a url', { kind: 'apply' }).ok, false);
  assert.equal(isSafeUrl('', { kind: 'apply' }).ok, false);
  assert.equal(isSafeUrl(null, { kind: 'apply' }).ok, false);
});

test('isSafeUrl rejects non-http(s) protocols', () => {
  assert.equal(isSafeUrl('ftp://example.org/file', { kind: 'apply' }).reason.startsWith('bad_protocol'), true);
  assert.equal(isSafeUrl('javascript:alert(1)', { kind: 'apply' }).ok, false);
});

test('isSafeUrl blocks SSRF to private / loopback / metadata hosts', () => {
  for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '192.168.1.1', '172.16.0.9', '169.254.169.254']) {
    const r = isSafeUrl(`https://${host}/apply`, { kind: 'apply' });
    assert.equal(r.ok, false, `${host} should be blocked`);
  }
});

test('isPrivateHost recognizes the full 172.16–172.31 range and public hosts', () => {
  assert.equal(isPrivateHost('172.16.0.1'), true);
  assert.equal(isPrivateHost('172.31.255.255'), true);
  assert.equal(isPrivateHost('172.32.0.1'), false); // outside private block
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('grants.gov'), false);
});
