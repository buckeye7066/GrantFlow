// Individual-assistance directory sources: Area Agencies on Aging, state
// Vocational Rehabilitation, and 211 — authoritative locators that reach
// senior/disabled/low-income INDIVIDUAL profiles the grant sources miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getSource } from '../sourceRegistry.js';
import { getAdapter, implementedAdapterIds } from '../adapters/index.js';
import { OPPORTUNITY_KIND } from '../contract.js';

const NEW_SOURCES = ['area_agency_on_aging', 'state_vocational_rehab', 'community_211'];

test('the three individual-assistance sources are registered as honest directories', () => {
  for (const id of NEW_SOURCES) {
    const src = getSource(id);
    assert.ok(src, `source row missing: ${id}`);
    assert.equal(src.directory, true, `${id} must be a directory (honest locator, not a fake grant)`);
    assert.ok(src.base_url && /^https:\/\//.test(src.base_url), `${id} needs a real https base_url`);
    assert.ok(src.resource_title && src.resource_summary, `${id} needs title + summary`);
    assert.ok(
      src.default_kinds?.includes(OPPORTUNITY_KIND.DIRECTORY),
      `${id} must default to DIRECTORY kind`,
    );
    assert.ok(src.applicant_types.includes('individual'), `${id} must serve individuals`);
    assert.ok(Array.isArray(src.need_categories) && src.need_categories.length > 0, `${id} needs need_categories`);
  }
});

test('each new source has an implemented adapter', () => {
  const implemented = new Set(implementedAdapterIds());
  for (const id of NEW_SOURCES) {
    assert.ok(implemented.has(id), `adapter not registered for ${id}`);
    const adapter = getAdapter(id);
    assert.ok(adapter && typeof adapter === 'object', `getAdapter(${id}) should return an adapter`);
  }
});

test('the sources target the right demographics (senior / disability / universal)', () => {
  assert.ok(getSource('area_agency_on_aging').need_categories.includes('aging'), 'AoA covers aging');
  assert.ok(getSource('state_vocational_rehab').need_categories.includes('disability'), 'VR covers disability');
  assert.ok(getSource('community_211').need_categories.includes('emergency'), '211 covers emergency');
});
