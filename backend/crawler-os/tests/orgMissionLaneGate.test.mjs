import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../planner.js';

// An ORG identity lane must be asked for its mission. Measured 2026-09-05 on
// a rural church and a biotech research org: both were sent down the Native
// American programs, the library/museum agency, the refugee office, the NEA,
// the DOL workforce page, farm credit, homeless assistance, SAMHSA, DOJ, EPA
// water and the NIH guide on generic `nonprofit`/`business` tokens.

const GATED = [
  'ana_grants', 'first_nations_dev_institute', 'imls_library_museum', 'orr_refugee', 'nea_neh_arts',
  'dol_eta_workforce', 'hrsa_health_workforce', 'farm_credit_young_beginning_small', 'broadband_grants',
  'hud_homeless_assistance', 'samhsa_grants', 'cdc_grants', 'doj_grants', 'epa_water_infrastructure', 'nih_guide',
];

function orgThesis(overrides = {}) {
  return {
    applicant_types: ['nonprofit', 'business'],
    needs: ['disability', 'education', 'emergency', 'capital', 'programs', 'medical'],
    location: { state: 'OH', states: ['OH'] },
    declared_health_terms: [],
    declared_populations: [],
    ...overrides,
  };
}

function decision(result, id) {
  return result.source_decisions.find((d) => d.source_id === id);
}

test('a church with facility/emergency/program needs is not sent down any org identity lane', () => {
  const result = plan(orgThesis());
  for (const id of GATED) {
    const d = decision(result, id);
    assert.ok(d, `${id} decided`);
    assert.equal(d.selected, false, `${id} must not be selected (${d.reasons.join(',')})`);
    assert.ok(d.reasons.includes('mission_not_declared'), `${id} excluded for mission: ${d.reasons.join(',')}`);
  }
  // Lanes the church CAN use stay open.
  assert.equal(decision(result, 'grants_gov').selected, true);
  assert.equal(decision(result, 'fema_hazard_mitigation').selected, true);
});

test('a declared mission opens exactly its lane', () => {
  const research = plan(orgThesis({ needs: ['medical', 'research_funding', 'equipment', 'capital', 'programs', 'education'] }));
  assert.equal(decision(research, 'nih_guide').selected, true);
  assert.equal(decision(research, 'cdc_grants').selected, true);
  assert.equal(decision(research, 'nea_neh_arts').selected, false);
  assert.equal(decision(research, 'orr_refugee').selected, false);

  const arts = plan(orgThesis({ needs: ['arts_education', 'programs'] }));
  assert.equal(decision(arts, 'nea_neh_arts').selected, true);
  assert.equal(decision(arts, 'nih_guide').selected, false);

  const tribal = plan(orgThesis({ applicant_types: ['tribal', 'government'], needs: ['programs', 'capital'] }));
  assert.equal(decision(tribal, 'ana_grants').selected, true);
  assert.equal(decision(tribal, 'first_nations_dev_institute').selected, true);
});
