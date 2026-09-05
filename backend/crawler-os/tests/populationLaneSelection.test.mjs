import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../planner.js';
import { allSources } from '../sourceRegistry.js';

// A POPULATION lane must be asked for its population. A first-year student's
// live crawl (2026-09-05) ran the Chafee foster lane, the Iraq & Afghanistan
// Service Grant, the refugee resettlement lane, the homeschool grant, SSA
// survivors, the Eldercare Locator, the NEA fellowship page and the DOL
// workforce page because each shares a coarse need token with her thesis.

const POPULATION_LANES = [
  'fc2success_scholarships', 'acf_chafee_foster', 'hslda_compassion_grants', 'orr_refugee',
  'iraq_afghanistan_service_grant', 'ssa_survivors', 'area_agency_on_aging', 'nea_neh_arts',
  'dol_eta_workforce', 'ccdf_childcare', 'nifa_extension_land_grant', 'teach_grant', 'hrsa_health_workforce',
];

function studentThesis(overrides = {}) {
  return {
    applicant_types: ['student', 'individual'],
    needs: ['education', 'scholarship', 'tuition', 'medical', 'disability', 'programs', 'employment', 'housing', 'childcare', 'agriculture', 'arts_education', 'survivor_benefits', 'aging', 'curriculum'],
    location: { state: 'TN', states: ['TN'] },
    declared_health_terms: ['disability'],
    declared_populations: [],
    ...overrides,
  };
}

function decision(result, sourceId) {
  return result.source_decisions.find((d) => d.source_id === sourceId);
}

test('every population lane in the registry declares a population list', () => {
  for (const id of POPULATION_LANES) {
    const source = allSources().find((s) => s.source_id === id);
    assert.ok(source, `${id} exists`);
    assert.ok(Array.isArray(source.populations) && source.populations.length > 0, `${id} declares populations`);
  }
});

test('a student who declares no population is not sent down any population lane', () => {
  const result = plan(studentThesis());
  for (const id of POPULATION_LANES) {
    const d = decision(result, id);
    assert.ok(d, `${id} has a decision`);
    assert.equal(d.selected, false, `${id} must not be selected`);
    assert.ok(d.reasons.includes('population_not_declared'), `${id} excluded for population: ${d.reasons.join(',')}`);
  }
});

test('a declared population opens exactly its lanes', () => {
  const foster = plan(studentThesis({ declared_populations: ['foster_youth'] }));
  assert.equal(decision(foster, 'fc2success_scholarships').selected, true);
  assert.equal(decision(foster, 'acf_chafee_foster').selected, true);
  assert.equal(decision(foster, 'orr_refugee').selected, false);
  assert.equal(decision(foster, 'ssa_survivors').selected, false);

  const medic = plan(studentThesis({ declared_populations: ['health_professions_student'] }));
  assert.equal(decision(medic, 'hrsa_health_workforce').selected, true);
  assert.equal(decision(medic, 'teach_grant').selected, false);
});

test('MISSING is neutral: a thesis without declared_populations is not gated', () => {
  const result = plan(studentThesis({ declared_populations: undefined }));
  const d = decision(result, 'fc2success_scholarships');
  assert.ok(!d.reasons.includes('population_not_declared'));
});

test('an org thesis is not population-gated (mission decides)', () => {
  const result = plan({
    applicant_types: ['nonprofit'],
    needs: ['arts_education', 'programs', 'education'],
    location: { state: 'TN', states: ['TN'] },
    declared_populations: [],
  });
  const d = decision(result, 'nea_neh_arts');
  assert.ok(!d.reasons.includes('population_not_declared'));
});
