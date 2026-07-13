// tests/coverageMatrix.test.mjs
//
// THE need-category × US-state coverage TOTALITY GUARD (owner directive:
// "no source can serve a TN disability profile" must be a TEST FAILURE, not a
// user discovery — the class that hid the ECF CHOICES gap, where the TN
// disability lane was structurally uncrawlable after the crawler-os cutover
// and nothing failed until a real member noticed).
//
// Proves:
//   1. CELL SEMANTICS — national serves every state, state-scoped serve their
//      states, '*' need wildcard serves every need, dedicatedOnly ignores '*'.
//   2. CRITICAL GUARD — every CRITICAL need × every US state has ≥ 1 DEDICATED
//      source (a source that DECLARES the need, not a '*' wildcard). National
//      fallbacks make this pass today; this asserts it STAYS true.
//   3. SNAPSHOT GUARD — the currently-uncovered NON-critical cells (dedicated
//      tier) exactly equal DOCUMENTED_GAPS. A NEW gap fails with a message
//      naming the cell; a FIXED gap fails until it is pruned from the list.
//   4. WILDCARD-TIER NET — with '*' wildcards counted, EVERY cell in the whole
//      matrix is covered (the grants_gov/sam_gov/cof_locator national nets).
//   5. VOCABULARY HONESTY — CRITICAL_NEEDS and DOCUMENTED_GAPS only use slugs
//      and states that actually exist in the registry/axis (no invented slugs
//      silently guarding nothing).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  US_STATES,
  CRITICAL_NEEDS,
  DOCUMENTED_GAPS,
  cellKey,
  needVocabulary,
  buildCoverageMatrix,
  listUncoveredCells,
} from '../coverageMatrix.js';
import { allSources } from '../sourceRegistry.js';

// ── 1. Cell semantics ────────────────────────────────────────────────────────

const FIXTURE_SOURCES = [
  { source_id: 'nat_wild', need_categories: ['*'], geography: { national: true, states: [] } },
  { source_id: 'nat_food', need_categories: ['food'], geography: { national: true, states: [] } },
  { source_id: 'tn_disability', need_categories: ['disability'], geography: { national: false, states: ['TN'] } },
];

test('cell semantics: national/state scoping and the * need wildcard', () => {
  const m = buildCoverageMatrix({ sources: FIXTURE_SOURCES, states: ['TN', 'OH'] });
  // Vocabulary excludes '*'.
  assert.deepEqual(m.needs, ['disability', 'food']);
  // National wildcard serves every cell; national dedicated serves its need everywhere.
  assert.deepEqual(m.cells[cellKey('food', 'TN')].sort(), ['nat_food', 'nat_wild']);
  assert.deepEqual(m.cells[cellKey('food', 'OH')].sort(), ['nat_food', 'nat_wild']);
  // State-scoped serves ONLY its states.
  assert.deepEqual(m.cells[cellKey('disability', 'TN')].sort(), ['nat_wild', 'tn_disability']);
  assert.deepEqual(m.cells[cellKey('disability', 'OH')], ['nat_wild']);
  assert.equal(m.stats.total_cells, 4);
  assert.equal(m.stats.uncovered_cells, 0);

  // Dedicated tier ignores the wildcard: disability×OH is now a HOLE — the
  // exact shape of the ECF gap ("no source declares disability for this state").
  const holes = listUncoveredCells({ sources: FIXTURE_SOURCES, states: ['TN', 'OH'], dedicatedOnly: true });
  assert.deepEqual(holes, [{ need: 'disability', state: 'OH' }]);
});

test('listUncoveredCells restricts to the requested needs/states subset', () => {
  const holes = listUncoveredCells({
    sources: FIXTURE_SOURCES,
    needs: ['disability'],
    states: ['TN'],
    dedicatedOnly: true,
  });
  assert.deepEqual(holes, []);
});

// ── 2. CRITICAL GUARD — the owner directive ─────────────────────────────────

test('CRITICAL: every critical need × every US state has ≥ 1 DEDICATED source', () => {
  const holes = listUncoveredCells({ needs: [...CRITICAL_NEEDS], dedicatedOnly: true });
  const named = holes.map(({ need, state }) => `'${need}' × ${state}`);
  assert.equal(
    holes.length,
    0,
    `CRITICAL coverage hole(s): ${named.join(', ')} — a real profile with this need in this state has NO source ` +
      `that declares the need (the ECF-gap class). This is NEVER a documented-gaps entry: add a dedicated source ` +
      `(national fallback or state lane) to backend/crawler-os/sourceRegistry.js before merging.`,
  );
});

test('the TN disability cell specifically is served by real dedicated lanes', () => {
  // The literal owner sentence, kept as its own assertion so the failure reads
  // exactly like the directive if it ever regresses.
  const m = buildCoverageMatrix({ needs: ['disability'], states: ['TN'], dedicatedOnly: true });
  const ids = m.cells[cellKey('disability', 'TN')];
  assert.ok(ids.length >= 1, 'no source can serve a TN disability profile — the ECF gap is back');
  assert.ok(ids.includes('tn_ecf_choices'), 'the TN ECF CHOICES lane must stay registered for TN disability');
});

// ── 3. SNAPSHOT GUARD — non-critical gaps are explicit, never silent ────────

test('uncovered non-critical cells (dedicated tier) exactly match DOCUMENTED_GAPS', () => {
  const critical = new Set(CRITICAL_NEEDS);
  const actual = listUncoveredCells({ dedicatedOnly: true }).filter(({ need }) => !critical.has(need));
  const actualKeys = new Set(actual.map(({ need, state }) => cellKey(need, state)));
  const documentedKeys = new Set(DOCUMENTED_GAPS.map(({ need, state }) => cellKey(need, state)));

  const undocumented = [...actualKeys].filter((k) => !documentedKeys.has(k));
  const stale = [...documentedKeys].filter((k) => !actualKeys.has(k));

  const describeCell = (k) => {
    const [need, state] = k.split('|');
    return `need '${need}' × ${state} has no source`;
  };
  assert.equal(
    undocumented.length,
    0,
    `NEW registry coverage gap(s): ${undocumented.map(describeCell).join('; ')} — add a source covering the need ` +
      `(national fallback preferred) to backend/crawler-os/sourceRegistry.js, or add the cell to DOCUMENTED_GAPS in ` +
      `backend/crawler-os/coverageMatrix.js with a reason (that list is the adapter-wishlist backlog, not accepted forever).`,
  );
  assert.equal(
    stale.length,
    0,
    `Stale DOCUMENTED_GAPS entr(y/ies) now covered: ${stale.join(', ')} — prune them from ` +
      `backend/crawler-os/coverageMatrix.js so the backlog stays honest.`,
  );
});

// ── 4. Wildcard-tier net ─────────────────────────────────────────────────────

test('with wildcards counted, the ENTIRE matrix is covered (national nets hold)', () => {
  const m = buildCoverageMatrix();
  assert.equal(
    m.stats.uncovered_cells,
    0,
    `Even the '*'-need national nets (grants_gov / sam_gov / cof_locator) no longer cover: ` +
      Object.entries(m.stats.per_need)
        .filter(([, v]) => v.uncovered_states.length)
        .map(([need, v]) => `'${need}' × ${v.uncovered_states.join(',')}`)
        .join('; '),
  );
  assert.equal(m.stats.total_cells, m.needs.length * US_STATES.length);
});

// ── 5. Vocabulary honesty ────────────────────────────────────────────────────

test('CRITICAL_NEEDS and DOCUMENTED_GAPS use only real registry slugs and real US states', () => {
  const vocab = new Set(needVocabulary());
  for (const need of CRITICAL_NEEDS) {
    assert.ok(
      vocab.has(need),
      `CRITICAL_NEEDS slug '${need}' is not in the registry's need vocabulary — a guard on a nonexistent slug guards nothing. ` +
        `Fix the slug in backend/crawler-os/coverageMatrix.js (or restore the registry lane that carried it).`,
    );
  }
  const stateSet = new Set(US_STATES);
  for (const gap of DOCUMENTED_GAPS) {
    assert.ok(vocab.has(gap.need), `DOCUMENTED_GAPS entry uses unknown need slug '${gap.need}'`);
    assert.ok(stateSet.has(gap.state), `DOCUMENTED_GAPS entry uses unknown state '${gap.state}'`);
    assert.ok(gap.reason && String(gap.reason).trim().length > 0, `DOCUMENTED_GAPS ${gap.need}×${gap.state} needs a reason`);
  }
  // Axis sanity: 50 states + DC + PR, no dupes.
  assert.equal(US_STATES.length, 52);
  assert.equal(new Set(US_STATES).size, 52);
  // Every state-scoped registry source's states are on the axis (a source
  // scoped to an off-axis region would silently drop out of the matrix).
  for (const s of allSources()) {
    if (s.geography?.national) continue;
    for (const st of s.geography?.states || []) {
      assert.ok(stateSet.has(st), `source ${s.source_id} is scoped to '${st}', which is not on the US_STATES axis`);
    }
  }
});
