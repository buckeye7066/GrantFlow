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

// ── Place validity (hyperlocal-1, 2026-09-12) ────────────────────────────────
// The `zipcodes` dataset names unique/business/PO-box ZIPs after their holder
// ("City National Bank", "Tn Dept Of Human Svc", "Amsouth Bank", "Nashvl") and
// the ring also crosses into Canada from Detroit. The query builder promotes
// the NEAREST ring entry to two CORE queries, so a bank was taking two of the
// six queries the live lane actually executes.
const NON_PLACE = /\b(bank|dept|svc|svcs|inc|corp|co|llc|ins|assc|natl|bureau|lottery|univ|annex|firm|zip|brm|afb|institute|service|medical center|navy yard)\b/i;

test('nearby towns are populated places, never the holder of a unique/business ZIP', () => {
  const cases = [
    ['43215', 'Columbus', ['Grove City', 'Hilliard']],
    ['37203', 'Nashville', ['Brentwood', 'Antioch']],
    ['35203', 'Birmingham', ['Fultondale', 'Fairfield']],
    ['85003', 'Phoenix', ['Glendale', 'Tempe']],
    ['96813', 'Honolulu', ['Aiea', 'Kaneohe']],
    ['20001', 'Washington', ['Arlington', 'Hyattsville']],
    ['83702', 'Boise', ['Garden City', 'Meridian']],
    ['19801', 'Wilmington', ['Claymont']],
    ['50309', 'Des Moines', ['West Des Moines', 'Urbandale']],
    ['02108', 'Boston', ['Somerville', 'Chelsea']],
  ];
  for (const [zip, home, realTowns] of cases) {
    const towns = nearbyCities(zip, { excludeCity: home, max: 8 });
    assert.ok(towns.length >= 2, `${home}: ring still has real neighbours`);
    for (const t of towns) {
      assert.ok(!NON_PLACE.test(t.city), `${home}: non-place ZIP holder leaked as a town: "${t.city}"`);
      assert.ok(!/\d|\(|\)|\//.test(t.city), `${home}: malformed town name "${t.city}"`);
      assert.ok(!/(^|\s)[A-Za-z](\s[A-Za-z])+(\s|$)/.test(t.city), `${home}: initials cluster is not a town: "${t.city}"`);
    }
    for (const real of realTowns) {
      assert.ok(towns.some((t) => t.city === real), `${home}: real neighbour ${real} must survive the filter (got ${towns.map((t) => t.city).join(', ')})`);
    }
  }
});

test('abbreviations of the home city are not neighbouring towns', () => {
  assert.ok(!nearbyCities('37203', { excludeCity: 'Nashville', max: 8 }).some((t) => t.city === 'Nashvl'));
  assert.ok(!nearbyCities('35203', { excludeCity: 'Birmingham', max: 8 }).some((t) => t.city === 'Bham'));
  assert.ok(!nearbyCities('96813', { excludeCity: 'Honolulu', max: 8 }).some((t) => t.city === 'Hon'));
});

test('the ring never crosses the border: every town carries a US state or territory code', () => {
  const towns = nearbyCities('48226', { excludeCity: 'Detroit', max: 8 });
  assert.ok(towns.length >= 1, 'Detroit has US neighbours');
  for (const t of towns) {
    assert.notEqual(t.state, 'ON', `Canadian entry leaked: ${t.city}`);
    assert.ok(/^[A-Z]{2}$/.test(t.state));
    assert.ok(!/windsor/i.test(t.city), `${t.city}`);
  }
  assert.ok(towns.some((t) => t.city === 'Hamtramck'));
});

test('a real small town with a single ZIP is kept (the filter is about names, not ZIP counts)', () => {
  const towns = nearbyCities('99501', { excludeCity: 'Anchorage', max: 4 });
  assert.ok(towns.some((t) => t.city === 'Eagle River'));
  assert.ok(towns.some((t) => t.city === 'Chugiak'));
});

test('a real town whose name carries a business-like token survives when its ZIP carries a county', () => {
  // The artifact ZIPs (43265 "City National Bank", 37237 "Amsouth Bank") carry
  // NO county in zipcodes-nrviens; these towns do — that is the corroborator.
  const cases = [
    ['97116', 'Forest Grove', 'Banks'],
    ['99133', 'Grand Coulee', 'Electric City'],
    ['61356', 'Princeton', 'Bureau'],
    // Red Bank owns a NEARER no-county secondary ZIP (07709) than its county
    // ZIP (07701); the town must still be kept through the county-bearing one.
    ['07740', 'Long Branch', 'Red Bank'],
  ];
  for (const [zip, home, real] of cases) {
    const towns = nearbyCities(zip, { excludeCity: home, max: 60 });
    assert.ok(towns.some((t) => t.city === real), `${home}: real town ${real} must survive (got ${towns.map((t) => t.city).join(', ')})`);
  }
  assert.ok(!nearbyCities('43215', { excludeCity: 'Columbus', max: 8 }).some((t) => /bank/i.test(t.city)), 'the bank ZIP artifact still drops');
  assert.ok(!nearbyCities('37203', { excludeCity: 'Nashville', max: 8 }).some((t) => /bank/i.test(t.city)), 'the Amsouth Bank ZIP artifact still drops');
});
