// Benchmark-gap lanes (2026-07-13): kinship/grandfamily caregiver support,
// heirs'-property / beginning-farmer pathways, and the homeschool-family
// direct-grant anchor. These close structural gaps the 12-persona stress
// cohort surfaced — profiles whose PRIMARY funding universe had no dedicated
// registry lane (recall relied entirely on the open-web lane).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getSource } from '../sourceRegistry.js';
import { getAdapter, implementedAdapterIds } from '../adapters/index.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { plan } from '../planner.js';
import { buildThesis } from '../profileIntelligence.js';

const NEW_SOURCES = [
  'acl_family_caregiver_support',
  'gks_network',
  'farmers_gov_heirs_property',
  'farmers_gov_beginning_farmers',
  'hslda_compassion_grants',
];

test('the benchmark-gap sources are registered with honest shapes', () => {
  for (const id of NEW_SOURCES) {
    const src = getSource(id);
    assert.ok(src, `source row missing: ${id}`);
    assert.ok(src.base_url && /^https:\/\//.test(src.base_url), `${id} needs a real https base_url`);
    assert.ok(src.resource_title && src.resource_summary, `${id} needs title + summary`);
    assert.equal(src.loan_allowed, false, `${id} never surfaces loans`);
    assert.ok(Array.isArray(src.need_categories) && src.need_categories.length > 0, `${id} needs need_categories`);
  }
  // Classification honesty (registryKindTotality guards the general rule;
  // these pin the specific intent):
  assert.ok(getSource('hslda_compassion_grants').default_kinds.includes(OPPORTUNITY_KIND.DIRECT_GRANT), 'HSLDA Compassion Grants is a real direct grant');
  assert.ok(getSource('acl_family_caregiver_support').default_kinds.includes(OPPORTUNITY_KIND.BENEFIT), 'NFCSP is a benefit program');
  assert.ok(getSource('farmers_gov_heirs_property').default_kinds.includes(OPPORTUNITY_KIND.PROGRAM), 'heirs-property pathway is a standing program, not a grant');
  assert.equal(getSource('gks_network').directory, true, 'GKS network is an honest locator');
  assert.equal(getSource('farmers_gov_beginning_farmers').directory, true, 'beginning-farmer hub is an honest locator');
});

test('each benchmark-gap source has an implemented adapter (no silent SKIPPED(no_adapter))', () => {
  const implemented = new Set(implementedAdapterIds());
  for (const id of NEW_SOURCES) {
    assert.ok(implemented.has(id), `adapter not registered for ${id}`);
    assert.ok(getAdapter(id), `getAdapter(${id}) should return an adapter`);
  }
});

test('planner: a kinship-caregiver senior reaches the grandfamily lanes', () => {
  const thesis = buildThesis({
    id: 'p_gap_kinship',
    primary_type: 'senior',
    description: 'Widowed grandmother raising two grandchildren; kinship care support and utility help.',
    needs: ['housing', 'energy', 'food'],
    location: { state: 'NM', city: 'Las Cruces' },
  });
  const p = plan(thesis);
  assert.ok(p.selected_source_ids.includes('acl_family_caregiver_support'), 'NFCSP fires for a kinship caregiver');
  assert.ok(p.selected_source_ids.includes('gks_network'), 'GKS network fires for a kinship caregiver');
});

test('planner: a structurally-declared beginning farmer reaches the USDA pathway lanes', () => {
  const thesis = buildThesis({
    id: 'p_gap_farmer',
    primary_type: 'individual',
    sections: [{ section_key: 'occupation', data: { farmer: true } }],
    needs: ['agriculture', 'legal', 'equipment'],
    location: { state: 'AL', city: 'Hayneville', county: 'Lowndes County' },
  });
  const p = plan(thesis);
  assert.ok(p.selected_source_ids.includes('farmers_gov_heirs_property'), 'heirs-property pathway fires');
  assert.ok(p.selected_source_ids.includes('farmers_gov_beginning_farmers'), 'beginning-farmer hub fires');
  assert.ok(p.selected_source_ids.includes('usda_conservation'), 'NRCS conservation cost-share fires');
});

test('planner: a homeschool family reaches the homeschool direct-grant lane', () => {
  const thesis = buildThesis({
    id: 'p_gap_homeschool',
    primary_type: 'homeschool_family',
    needs: ['curriculum', 'education'],
    location: { state: 'CA', city: 'Eureka', county: 'Humboldt County' },
  });
  const p = plan(thesis);
  assert.ok(p.selected_source_ids.includes('hslda_compassion_grants'), 'HSLDA Compassion Grants fires for a homeschool family');
});

test('planner: the gap lanes never fire for an unrelated org profile', () => {
  const thesis = buildThesis({
    id: 'p_gap_org',
    profile_type: 'nonprofit',
    applicant_types: ['nonprofit'],
    needs: ['food'],
    location: { state: 'TN' },
  });
  const p = plan(thesis);
  for (const id of NEW_SOURCES) {
    assert.ok(!p.selected_source_ids.includes(id), `${id} must not fire for a food-pantry nonprofit`);
  }
});
