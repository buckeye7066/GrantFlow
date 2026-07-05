// Tests for geoRadius — the ZIP → 25-mile nearby-towns expansion that gives
// "local" discovery its actual radius (city/county tokens alone cannot reach
// the next town over or across a county/state line).
import test from 'node:test';
import assert from 'node:assert/strict';

import { nearbyCities, DEFAULT_RADIUS_MILES } from '../geoRadius.js';

test('default radius is the product rule: 25 miles', () => {
  assert.equal(DEFAULT_RADIUS_MILES, 25);
});

test('returns distinct nearby towns, nearest first, excluding the home city', () => {
  const towns = nearbyCities('37312', { excludeCity: 'Cleveland' });
  assert.ok(towns.length >= 2, 'Cleveland TN has neighbors within 25 miles');
  for (const t of towns) {
    assert.ok(t.city && t.state, 'every entry has city+state');
    assert.notEqual(t.city.toLowerCase(), 'cleveland', 'home city excluded');
    assert.ok(t.miles == null || t.miles <= 25, 'within the radius');
  }
  const sorted = [...towns].sort((a, b) => (a.miles ?? 999) - (b.miles ?? 999));
  assert.deepEqual(towns, sorted, 'nearest first');
  const keys = towns.map((t) => `${t.city}|${t.state}`.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, 'no duplicate towns');
});

test('tolerates ZIP+4 and rejects garbage', () => {
  assert.ok(nearbyCities('37323-4033', { max: 2 }).length > 0, 'ZIP+4 truncates to ZIP5');
  assert.deepEqual(nearbyCities('abcde'), []);
  assert.deepEqual(nearbyCities(''), []);
  assert.deepEqual(nearbyCities(null), []);
  assert.deepEqual(nearbyCities('00000'), []);
});

test('max caps the list', () => {
  assert.ok(nearbyCities('37312', { max: 1 }).length <= 1);
  assert.deepEqual(nearbyCities('37312', { max: 0 }), []);
});
