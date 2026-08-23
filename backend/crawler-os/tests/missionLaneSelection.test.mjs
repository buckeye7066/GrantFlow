// A MISSION LANE MUST BE ASKED FOR ITS MISSION.
//
// Measured on the four REAL prod profiles 2026-08-22: "PetSmart Charities
// grant programs" was rank 7 in AXIOM BIOLABS' — a biotech lab's — top 10,
// and the planner also selected petco_love_grants, aspca_grants, the three
// sacred-places/preservation lanes, native_american_ag_fund, ovw_grants,
// bja_second_chance and lsc_grants for it. The same verbatim junk the
// 2026-08-02 audit named for a church roof. Every one arrived through generic
// `nonprofit` + ONE coarse shared org need (`equipment`, `capacity_building`,
// `programs`, `operations`, `capital`) — the #937 one-shared-word floor from
// the ORG side. The registry and both admission doors live in
// config/sourceLanes.js (MISSION_SPECIFIC_SOURCE_REQUIREMENTS /
// sourceServesDeclaredMission); the planner gate mirrors
// servesDeclaredCondition.

import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../planner.js';
import { getSource } from '../sourceRegistry.js';
import {
  MISSION_SPECIFIC_SOURCE_REQUIREMENTS,
  GENERIC_MISSION_APPLICANT_TYPES,
  sourceServesDeclaredMission,
} from '../../config/sourceLanes.js';

const MISSION_IDS = Object.keys(MISSION_SPECIFIC_SOURCE_REQUIREMENTS);

/** Axiom BioLabs' thesis shape, trimmed to what the planner reads. */
function biolabThesis(overrides = {}) {
  return {
    applicant_types: ['nonprofit', 'business'],
    needs: ['research', 'equipment', 'capacity_building', 'operations', 'programs', 'capital'],
    location: { state: 'OH', city: 'Cleveland', zip: '44101' },
    is_org: true,
    is_research_org: true,
    ...overrides,
  };
}

const decisionOf = (p, id) => p.source_decisions.find((d) => d.source_id === id);

test('registry totality: every mission-specific id exists in the source registry and its required categories sit on that source', () => {
  for (const [id, required] of Object.entries(MISSION_SPECIFIC_SOURCE_REQUIREMENTS)) {
    const src = getSource(id);
    assert.ok(src, `${id} is not in the source registry — the gate would silently never fire for it`);
    for (const cat of required) {
      assert.ok(
        (src.need_categories ?? []).includes(cat),
        `${id} does not declare its own required mission category '${cat}' — the registry entry and the requirement drifted`,
      );
    }
    // The gate exists because generic tokens admitted these lanes; if a lane
    // stops listing any generic type the gate is dead weight for it.
    assert.ok(
      (src.applicant_types ?? []).some((t) => GENERIC_MISSION_APPLICANT_TYPES.has(t)),
      `${id} lists no generic applicant type — re-check whether it still needs the mission gate`,
    );
  }
});

test('a biotech lab (generic nonprofit, coarse org needs) is excluded from EVERY mission lane, explainably', () => {
  const p = plan(biolabThesis());
  for (const id of MISSION_IDS) {
    const d = decisionOf(p, id);
    assert.ok(d, `${id} has a decision`);
    assert.equal(d.selected, false, `${id} must not be selected for a biolab`);
    assert.ok(
      d.reasons.includes('mission_not_declared'),
      `${id} exclusion must name mission_not_declared (got: ${d.reasons.join(',')})`,
    );
  }
  // The gate suppresses nothing else: the lab keeps a broad plan.
  assert.ok(p.selected_source_ids.length > 10, 'the plan is still broad');
});

test('a congregation keeps the sacred-places lanes through its DISTINCTIVE church identity — and still never gets the pet charities', () => {
  const p = plan({
    applicant_types: ['church', 'ministry', 'nonprofit'],
    needs: ['capital', 'operations', 'programs'],
    location: { state: 'OH' },
    is_org: true,
  });
  for (const id of ['national_fund_sacred_places', 'partners_sacred_places', 'nthp_preservation_grants']) {
    const d = decisionOf(p, id);
    assert.equal(d.selected, true, `${id} must stay selected for a church (the failing-roof persona)`);
  }
  for (const id of ['petsmart_charities_grants', 'petco_love_grants', 'aspca_grants']) {
    const d = decisionOf(p, id);
    assert.equal(d.selected, false, `${id} must not reach a church (the 2026-08-02 church-roof verbatim)`);
    assert.ok(d.reasons.includes('mission_not_declared'));
  }
});

test('an animal rescue keeps its lanes through its needs — its type-derived set names the mission', () => {
  // deriveNeeds' type default for animal_rescue is
  // ['animal_welfare','capacity_building','equipment'] — the mission category
  // reaches a defaulted set ONLY through a mission-declaring type, which IS a
  // declaration (see MISSION_SPECIFIC_SOURCE_REQUIREMENTS).
  const p = plan({
    applicant_types: ['nonprofit'],
    needs: ['animal_welfare', 'capacity_building', 'equipment'],
    location: { state: 'TN' },
    is_org: true,
  });
  for (const id of ['petsmart_charities_grants', 'petco_love_grants', 'aspca_grants']) {
    const d = decisionOf(p, id);
    assert.equal(d.selected, true, `${id} must stay selected for an animal rescue`);
  }
});

test('MISSING = NEUTRAL: a thesis with no needs ARRAY never supplied the facts, and the gate stays quiet', () => {
  const stub = { applicant_types: ['*'] }; // hand-built / cross-profile stub
  const p = plan(stub);
  for (const id of MISSION_IDS) {
    const d = decisionOf(p, id);
    assert.ok(
      !d.reasons.includes('mission_not_declared'),
      `${id} must not be mission-gated on a thesis that supplied no needs`,
    );
  }
});

test('the shared rule itself: generic tokens never satisfy identity; a declared mission need always does', () => {
  const petsmart = getSource('petsmart_charities_grants');
  assert.equal(
    sourceServesDeclaredMission(petsmart, { needs: ['equipment', 'programs'], applicant_types: ['nonprofit', 'government'] }),
    false,
    'generic nonprofit + coarse shared needs is exactly the defect',
  );
  assert.equal(
    sourceServesDeclaredMission(petsmart, { needs: ['animal_welfare'], applicant_types: [] }),
    true,
    'a declared mission need admits with no identity at all',
  );
  const sacred = getSource('national_fund_sacred_places');
  assert.equal(
    sourceServesDeclaredMission(sacred, { needs: ['capital'], applicant_types: ['church'] }),
    true,
    'a distinctive identity admits without the mission need',
  );
  const nonMission = getSource('tn_ecf_choices');
  assert.equal(
    sourceServesDeclaredMission(nonMission, { needs: [], applicant_types: [] }),
    true,
    'a non-mission lane is untouched by this gate',
  );
});
