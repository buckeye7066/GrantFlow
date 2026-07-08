// County & city programs lane + 2026-07-08 adapter-wishlist sources.
//
// Sam's fleet coverage-gap scoreboard hit 100% of scanned profiles on ONE
// statement: "No county & city programs source adapters exist in the source
// registry yet." These tests pin the fix: the county_city lane has real,
// geo-aware locator sources; OH/WA get state-programs sources; mobility
// impairment + neurodivergent get disease-specific lanes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getSource } from '../sourceRegistry.js';
import { getAdapter, implementedAdapterIds } from '../adapters/index.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { createCountyCityDirectoryAdapter } from '../adapters/countyCityDirectoryAdapter.js';

const COUNTY_CITY = ['usa_gov_local_governments', 'hud_resource_locator', 'findhelp_local_programs'];
const STATE_ROWS = [
  ['oh_benefits', 'OH'],
  ['oh_college_opportunity_grant', 'OH'],
  ['wa_connection_benefits', 'WA'],
  ['wa_college_grant', 'WA'],
];
const DISEASE = ['reeve_foundation_paralysis', 'autism_speaks_family_support'];

test('every new source is registered with an implemented adapter', () => {
  const implemented = new Set(implementedAdapterIds());
  for (const id of [...COUNTY_CITY, ...STATE_ROWS.map(([s]) => s), ...DISEASE]) {
    assert.ok(getSource(id), `source row missing: ${id}`);
    assert.ok(implemented.has(id), `adapter not registered for ${id}`);
    assert.ok(getAdapter(id), `getAdapter(${id}) should return an adapter`);
  }
});

test('county_city sources are honest national locators', () => {
  for (const id of COUNTY_CITY) {
    const src = getSource(id);
    assert.equal(src.directory, true, `${id} must be a directory (locator, not a fake grant)`);
    assert.ok(/^https:\/\//.test(src.base_url), `${id} needs a real https base_url`);
    assert.equal(src.geography?.national, true, `${id} must be nationally applicable`);
    assert.ok(src.default_kinds?.includes(OPPORTUNITY_KIND.DIRECTORY), `${id} defaults to DIRECTORY`);
  }
});

test('state rows are scoped to their state (planner geography gate)', () => {
  for (const [id, st] of STATE_ROWS) {
    const src = getSource(id);
    assert.equal(src.geography?.national, false, `${id} must NOT be national`);
    assert.deepEqual(src.geography?.states, [st], `${id} must be scoped to ${st}`);
  }
});

test('disease rows carry the condition keywords the gap detector matches on', () => {
  const hay = (src) => [...(src.keywords ?? []), src.source_id, src.name].join(' ').toLowerCase();
  assert.ok(hay(getSource('reeve_foundation_paralysis')).includes('mobility'), 'reeve covers mobility (impairment)');
  assert.ok(hay(getSource('autism_speaks_family_support')).includes('neurodivergent'), 'autism source covers neurodivergent');
});

test('countyCityDirectoryAdapter personalizes the candidate to the profile place', () => {
  const adapter = createCountyCityDirectoryAdapter('findhelp_local_programs');
  const source = getSource('findhelp_local_programs');
  const thesis = { location: { county: 'Whatcom', state: 'WA', zip: '98225', city: 'Bellingham' } };

  const reqs = adapter.buildRequests(thesis, source, {});
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].url, 'https://www.findhelp.org/search_results/98225', 'ZIP deep-link via url_template');
  const cand = reqs[0].parseCfg.directoryCandidate;
  assert.match(cand.title, /Whatcom County, WA/, 'candidate title names the profile county (hyperlocal recall)');
  assert.equal(cand.kind, OPPORTUNITY_KIND.DIRECTORY);
  assert.equal(cand.apply_url, null, 'a locator never fakes an apply URL');

  const mapped = adapter.mapCandidate(cand, { thesis, source });
  assert.equal(mapped.source_id, 'findhelp_local_programs');
  assert.equal(mapped.is_directory, true);
  assert.match(mapped.title, /Whatcom County, WA/);
});

test('countyCityDirectoryAdapter degrades honestly with no location', () => {
  const adapter = createCountyCityDirectoryAdapter('usa_gov_local_governments');
  const source = getSource('usa_gov_local_governments');

  const reqs = adapter.buildRequests({}, source, {});
  assert.equal(reqs[0].url, source.base_url, 'no ZIP → plain base_url, nothing invented');
  const cand = reqs[0].parseCfg.directoryCandidate;
  assert.equal(cand.title, source.resource_title, 'no place → generic honest title');
});

test('countyCityDirectoryAdapter never substitutes a malformed ZIP', () => {
  const adapter = createCountyCityDirectoryAdapter('findhelp_local_programs');
  const source = getSource('findhelp_local_programs');
  const reqs = adapter.buildRequests({ location: { zip: 'not-a-zip', state: 'WA' } }, source, {});
  assert.equal(reqs[0].url, source.base_url, 'bad ZIP falls back to base_url');
});
