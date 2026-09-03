// tests/planner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../planner.js';
import { buildThesis } from '../profileIntelligence.js';
import { SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';

test('plan returns selected source ids plus a per-source decision with reasons', () => {
  const p = plan(buildThesis(SAMPLE_VFD_PROFILE));
  assert.ok(Array.isArray(p.selected_source_ids));
  assert.ok(Array.isArray(p.source_decisions));
  assert.ok(p.source_decisions.length > 0);
  for (const d of p.source_decisions) {
    assert.ok('source_id' in d);
    assert.equal(typeof d.selected, 'boolean');
    assert.ok(Array.isArray(d.reasons));
  }
});

test('a VFD in TN selects at least one real source and explains every exclusion', () => {
  const p = plan(buildThesis(SAMPLE_VFD_PROFILE));
  assert.ok(p.selected_source_ids.length >= 1);
  const excluded = p.source_decisions.filter((d) => !d.selected);
  for (const d of excluded) {
    assert.ok(d.reasons.length > 0, `excluded source ${d.source_id} must say why`);
  }
});

test('a broad thesis (applicant "*", no needs) selects all in-scope sources', () => {
  const broad = {
    profile_id: null, applicant_types: ['*'], needs: [],
    location: { state: null }, loan_allowed: false, cost_share_allowed: false,
    min_match_score: 55, keywords: ['grant'], raw_profile_present: false,
  };
  const p = plan(broad);
  assert.ok(p.selected_source_ids.length >= 1, 'broad thesis must not exclude everything');
});

test('selected sources carry a "selected" reason marker', () => {
  const p = plan(buildThesis(SAMPLE_VFD_PROFILE));
  const sel = p.source_decisions.find((d) => d.selected);
  assert.ok(sel, 'at least one selected source');
  assert.ok(sel.reasons.includes('selected'));
});

test('an explicitly disabled profile runs SSA disability before bounded lower-signal lanes', () => {
  const p = plan({
    profile_id: 'disabled-profile',
    applicant_types: ['individual'],
    needs: ['disability', 'medical'],
    needs_defaulted: false,
    location: { state: 'TN' },
    loan_allowed: false,
    cost_share_allowed: false,
  });
  const ssa = p.source_decisions.find((d) => d.source_id === 'ssa_disability');
  assert.equal(ssa?.selected, true);
  assert.ok(ssa.reasons.includes('serves_declared_critical_need'));
  assert.equal(p.selected_source_ids[0], 'ssa_disability');
});

test('critical-need promotion requires explicit need provenance', () => {
  const p = plan({
    profile_id: 'unprovenanced-profile',
    applicant_types: ['individual'],
    needs: ['disability', 'medical'],
    location: { state: 'TN' },
    loan_allowed: false,
    cost_share_allowed: false,
  });
  const ssa = p.source_decisions.find((d) => d.source_id === 'ssa_disability');
  assert.equal(ssa?.selected, true);
  assert.equal(ssa?.lane_tier, 2);
  assert.equal(ssa.reasons.includes('serves_declared_critical_need'), false);
});
