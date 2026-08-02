// Lane ORDER is a claim about the profile, not a global constant.
//
// Measured read-only in prod 2026-08-02 on Anastasia White
// (`c4a92724-9cee-416f-ba30-e91b9b5cd885`), a dual-enrolled high-school senior
// whose `education.intended_major` is Forensic Science and whose
// `medical.disabilities` is literally `[]`:
//
//   plan() selected 54 of 167 sources and ordered them by `priority_score`
//   alone. Her first 22 lanes were disease/disability lanes (kidney fund,
//   autism, arthritis, HIV care, amputee, rare disease…), admitted by ONE
//   generic `disability` need token derived from a household SSDI entry, while
//   `pell_grant`, `fseog` and `studentaid_gov` ranked 23rd, 24th and 25th.
//
// After: her 9 student-aid lanes hold ranks 1–9 and `pell_grant` is #1.
// Fleet-wide across all 33 real prod profiles the SELECTED SET is byte-for-byte
// unchanged (0 differences) — this promotes, it never suppresses. And it is not
// anti-disease: Gilbert McCosh, a real disability profile, has his four
// condition-matched lanes rise to the top (autism_speaks 10 → 1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, LANE_TIER } from '../planner.js';
import { allSources } from '../sourceRegistry.js';
import { STUDENT_AID_NEED_CATEGORIES } from '../../config/stageOfLifeEligibility.js';

/** Anastasia's real thesis shape, trimmed to what the planner reads. */
function anastasiaThesis(overrides = {}) {
  return {
    applicant_types: ['student', 'individual'],
    // Her REAL prod need list — 27 entries, `disability` among them.
    needs: [
      'disability', 'education', 'transportation', 'medical', 'employment', 'technology',
      'professional_development', 'scholarship', 'tuition', 'housing', 'fafsa', 'pell',
      'first_gen', 'emergency', 'equipment', 'programs', 'economic_development',
    ],
    location: { state: 'TN', city: 'Cleveland', zip: '37312' },
    derived_facts: {
      topicalTerms: [
        { term: 'forensic science', evidence: 'education.intended_major', recallSafe: true },
        { term: 'criminal justice', evidence: 'education.interests', recallSafe: true },
      ],
      stageOfLife: { value: 'dual_enrolled_incoming_freshman', evidence: ['basic_information.academic_status.education_level'] },
    },
    ...overrides,
  };
}

const rank = (p, id) => p.selected_source_ids.indexOf(id) + 1;

test('a declared student stage puts the student-aid lanes FIRST', () => {
  const p = plan(anastasiaThesis());
  assert.ok(p.selected_source_ids.length > 40, 'the plan must still be broad');
  for (const id of ['pell_grant', 'fseog', 'studentaid_gov', 'federal_work_study']) {
    const r = rank(p, id);
    assert.ok(r > 0, `${id} must still be selected`);
    assert.ok(r <= 10, `${id} ranked ${r}; a declared student stage must reach the top ten`);
  }
  // The generic-disability lanes that used to occupy ranks 1-22 are all behind.
  for (const id of ['american_kidney_fund', 'autism_speaks_family_support', 'arthritis_foundation_help']) {
    const r = rank(p, id);
    if (r > 0) assert.ok(r > 9, `${id} ranked ${r}; a generic need must not outrank a declared stage`);
  }
});

test('SELECTION is untouched — this ranks, it never suppresses', () => {
  const thesis = anastasiaThesis();
  const withFacts = plan(thesis);
  const withoutFacts = plan({ ...thesis, derived_facts: null });
  assert.deepEqual(
    [...withFacts.selected_source_ids].sort(),
    [...withoutFacts.selected_source_ids].sort(),
    'the derived facts must change ORDER only, never membership',
  );
});

test('a profile that declares NOTHING gets the old plan, byte for byte', () => {
  const thesis = anastasiaThesis({ derived_facts: null });
  const p = plan(thesis);
  // Pure priority_score order, descending, with source_id as the tiebreak.
  const byPriority = Object.fromEntries(allSources().map((s) => [s.source_id, s.priority_score ?? 0]));
  const expected = [...p.selected_source_ids].sort(
    (a, b) => (byPriority[b] - byPriority[a]) || (a < b ? -1 : a > b ? 1 : 0),
  );
  assert.deepEqual(p.selected_source_ids, expected);
  assert.ok(p.source_decisions.every((d) => d.lane_tier === null || d.lane_tier === LANE_TIER.DEFAULT));
});

test('a DECLARED topic outranks a declared stage, and the reason is recorded', () => {
  // A farmer's declared topic reaches the agriculture lanes' curated keywords.
  const farmer = {
    applicant_types: ['individual', 'farmer'],
    needs: ['agriculture', 'equipment', 'startup', 'housing', 'medical'],
    location: { state: 'AR' },
    derived_facts: {
      topicalTerms: [{ term: 'beginning farmer', evidence: 'programs_services.keywords', recallSafe: false }],
      stageOfLife: null,
    },
  };
  const p = plan(farmer);
  const topics = p.source_decisions.filter((d) => d.lane_tier === LANE_TIER.DECLARED_TOPIC);
  assert.ok(topics.length > 0, 'a declared farm topic must reach at least one curated farm lane');
  for (const d of topics) assert.ok(d.reasons.includes('serves_declared_topic'));
  // …and it leads the plan.
  assert.equal(p.source_decisions.find((d) => d.source_id === p.selected_source_ids[0]).lane_tier, LANE_TIER.DECLARED_TOPIC);
});

test('topic affinity reads the CURATED keywords only — never need_categories', () => {
  // MEASURED: with need_categories in the vocabulary this tier fired 240 times
  // across 33 real prod profiles, and its first hits were `benefits_gov` and
  // `orr_refugee` "serving" a forensic-science student, because her declared
  // interest "forensic science education programs" shares the token
  // `education` with a coarse need category. That is the #937 one-shared-word
  // floor, one level up.
  const p = plan(anastasiaThesis({
    derived_facts: {
      topicalTerms: [{ term: 'forensic science education programs', evidence: 'programs_services.interests', recallSafe: false }],
      stageOfLife: null,
    },
  }));
  const topics = p.source_decisions.filter((d) => d.lane_tier === LANE_TIER.DECLARED_TOPIC);
  assert.deepEqual(topics.map((d) => d.source_id), [], 'a coarse need token must never count as a declared topic');
});

test('a catch-all lane is never promoted as a student-aid lane', () => {
  const p = plan(anastasiaThesis());
  for (const id of ['findhelp_local_programs', 'usa_gov_local_governments', 'cof_locator']) {
    const d = p.source_decisions.find((x) => x.source_id === id);
    if (d?.selected) assert.notEqual(d.lane_tier, LANE_TIER.DECLARED_STAGE, `${id} is a '*' lane, not student aid`);
  }
});

test('an EXCLUDED source never carries a lane tier', () => {
  const p = plan(anastasiaThesis());
  for (const d of p.source_decisions) {
    if (!d.selected) assert.equal(d.lane_tier, null, `${d.source_id} was excluded but carries a rank`);
  }
});

test('the ordering is deterministic across repeated plans', () => {
  const thesis = anastasiaThesis();
  assert.deepEqual(plan(thesis).selected_source_ids, plan(thesis).selected_source_ids);
});

test('every STUDENT_AID_NEED_CATEGORY is declared by a real registry source', () => {
  const declared = new Set();
  for (const s of allSources()) for (const n of s.need_categories ?? []) declared.add(String(n).toLowerCase());
  for (const cat of STUDENT_AID_NEED_CATEGORIES) {
    assert.ok(declared.has(cat), `no registry source declares need "${cat}" — the set would select nothing`);
  }
});
