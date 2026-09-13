// tests/webQueryPlan.test.mjs
//
// buildWebQueryPlan — the provenance-bearing planner behind buildWebQueries.
// The live web lane executes only ~6 of its 28 planned queries (44 pages at
// 8 hits/query), so the CONTRACT this file pins is about the head of the
// plan: anchors (learned-gap steering, shortfall profiles only) + the
// strongest core queries + at least one rotated breadth query, deduped by a
// normalized key, deterministic per seed, safe at tiny budgets, and never
// spending the head on one need or one family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWebQueries,
  buildWebQueryPlan,
  normalizeQueryKey,
  countyPhrase,
  PERSISTENT_QUERY_ANCHOR_COUNT,
  WEB_QUERY_HEAD_WINDOW,
} from '../webQueries.js';

const YEAR = 2026;
const INDIV = {
  applicant_types: ['individual'],
  needs: ['housing'],
  location: { state: 'TN', city: 'Cleveland', county: 'Bradley County' },
};
// A shortfall profile whose CORE alone saturates a 28-query budget: senior +
// disability + caregiver + safety-net signals all fire CORE lanes.
const SATURATED_SHORTFALL = {
  applicant_types: ['individual'],
  needs: ['housing', 'food', 'energy', 'medical', 'transportation'],
  keywords: ['senior', 'disability', 'caregiver', 'domestic violence'],
  interest_terms: ['home repair', 'utility bills', 'hearing aids'],
  occupation: ['truck_driver', 'home_health_aide'],
  geographic: ['rural', 'appalachian'],
  immigration: ['refugee'],
  education_profile: { firstGeneration: true, jobRetraining: true },
  origin_terms: ['Bradley Central High School alumni scholarship', 'Cherokee heritage scholarship'],
  financial: { householdIncome: 22000, householdSize: 3, needLevel: 'urgent' },
  location: {
    state: 'TN', city: 'Cleveland', county: 'Bradley County', zip: '37311',
    nearby_cities: [{ city: 'Charleston', state: 'TN', miles: 6 }, { city: 'Athens', state: 'TN', miles: 20 }],
  },
  learned_gaps: { classes: ['low_results', 'result_floor_shortfall'] },
};
const SIX_NEED = {
  applicant_types: ['individual'],
  needs: ['housing', 'food', 'energy', 'medical', 'transportation', 'childcare'],
  location: { state: 'TN', city: 'Cleveland', county: 'Bradley County' },
};
const STUDENT_ALL_GAPS = {
  applicant_types: ['student', 'individual'],
  is_student: true,
  needs: ['tuition', 'textbooks', 'housing'],
  schools: ['Cleveland State Community College', 'Chattanooga State Community College'],
  field_of_study: 'Paramedic',
  interest_terms: ['emergency medical services', 'nursing'],
  location: { state: 'TN', city: 'Cleveland', county: 'Bradley County' },
  learned_gaps: {
    classes: ['institution_gap', 'hyperlocal_gap', 'low_results', 'result_floor_shortfall'],
    missing_schools: ['Lee University', 'Tennessee Wesleyan University', 'Southern Adventist University'],
  },
};

const tiers = (plan) => plan.entries.map((e) => e.tier);
const head = (plan) => plan.entries.slice(0, plan.head_size);

// ── Contract shape ──────────────────────────────────────────────────────────

test('buildWebQueryPlan returns the documented shape and buildWebQueries is exactly plan.queries', () => {
  for (const [thesis, max] of [[INDIV, 6], [SATURATED_SHORTFALL, 28], [STUDENT_ALL_GAPS, 14], [INDIV, 0]]) {
    const plan = buildWebQueryPlan(thesis, { year: YEAR, max, seed: 3 });
    assert.ok(Array.isArray(plan.queries));
    assert.ok(Array.isArray(plan.entries));
    assert.equal(plan.entries.length, plan.queries.length, 'entries mirror queries');
    plan.entries.forEach((e, i) => {
      assert.equal(e.query, plan.queries[i], 'entries[i].query === queries[i]');
      assert.ok(['anchor', 'core', 'breadth'].includes(e.tier), `tier ${e.tier}`);
      assert.equal(typeof e.family, 'string');
      assert.ok(e.family.length > 0, 'family populated');
      assert.ok(e.gap_class === null || typeof e.gap_class === 'string');
      assert.ok(e.need === null || typeof e.need === 'string');
    });
    assert.equal(plan.planned_total, plan.queries.length);
    assert.ok(Array.isArray(plan.dropped_by_budget));
    assert.ok(Array.isArray(plan.dropped_duplicates));
    assert.equal(plan.seed, 3);
    assert.equal(plan.max, max);
    assert.equal(typeof plan.shortfall, 'boolean');
    assert.equal(plan.head_size, Math.min(max, WEB_QUERY_HEAD_WINDOW));
    assert.deepEqual(buildWebQueries(thesis, { year: YEAR, max, seed: 3 }), plan.queries, 'string contract unchanged');
    assert.equal(new Set(plan.queries.map(normalizeQueryKey)).size, plan.queries.length, 'no normalized duplicates');
  }
  assert.equal(WEB_QUERY_HEAD_WINDOW, 6, 'head window is the page-derived execution window (44 pages / 8 hits)');
});

test('dropped_by_budget accounts for every generated query the budget cut, with tier and family', () => {
  const universe = buildWebQueryPlan(INDIV, { year: YEAR, max: 10000, seed: 0 });
  const capped = buildWebQueryPlan(INDIV, { year: YEAR, max: 6, seed: 0 });
  assert.equal(capped.dropped_by_budget.length, universe.planned_total - capped.planned_total);
  for (const d of capped.dropped_by_budget) {
    assert.equal(typeof d.query, 'string');
    assert.ok(['anchor', 'core', 'breadth'].includes(d.tier));
    assert.equal(typeof d.family, 'string');
    assert.ok(!capped.queries.includes(d.query), 'a dropped query is not also emitted');
  }
  assert.deepEqual(universe.dropped_by_budget, [], 'nothing dropped at an unbounded budget');
});

test('entries carry provenance: family, need and gap_class are populated where the template has them', () => {
  const plan = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 60, seed: 0 });
  const byQuery = new Map(plan.entries.map((e) => [e.query, e]));
  const needGeo = byQuery.get('housing grants for individual Cleveland, TN');
  assert.ok(needGeo, 'need+geo core query present');
  assert.equal(needGeo.family, 'need_geo');
  assert.equal(needGeo.need, 'housing');
  const county = byQuery.get('community foundation Bradley County, TN');
  assert.ok(county);
  assert.equal(county.family, 'county');
  assert.equal(county.need, null);
  const anchor = plan.entries[0];
  assert.equal(anchor.tier, 'anchor');
  assert.equal(anchor.gap_class, 'low_results');
  assert.equal(anchor.need, 'housing');
  assert.ok(plan.entries.some((e) => e.gap_class === 'result_floor_shortfall'), 'floor-class steering is labelled');
  assert.ok(plan.entries.some((e) => e.tier === 'breadth' && e.gap_class === null), 'ordinary breadth carries no gap class');
});

// ── Zero and tiny budgets ───────────────────────────────────────────────────

test('max=0 emits nothing for every profile', () => {
  for (const thesis of [INDIV, SATURATED_SHORTFALL, STUDENT_ALL_GAPS]) {
    const plan = buildWebQueryPlan(thesis, { year: YEAR, max: 0, seed: 9 });
    assert.deepEqual(plan.queries, []);
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.head_size, 0);
    assert.deepEqual(buildWebQueries(thesis, { max: 0 }), []);
  }
});

test('max=1 emits the strongest CORE query and is seed-independent (never a rotated extra)', () => {
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 14, 1757600000000]) {
    const plan = buildWebQueryPlan(INDIV, { year: YEAR, max: 1, seed });
    assert.deepEqual(plan.queries, ['housing grants for individual Cleveland, TN'], `seed ${seed}`);
    assert.equal(plan.entries[0].tier, 'core');
  }
  // A shortfall profile at max=1 also gets a stable, non-rotating query.
  const first = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 1, seed: 0 }).queries;
  for (const seed of [1, 7, 42]) {
    assert.deepEqual(buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 1, seed }).queries, first);
  }
});

test('max=2: strongest core + one rotating query; under shortfall: one anchor + the strongest core', () => {
  const seen = new Set();
  for (const seed of [0, 1, 2, 3, 4]) {
    const plan = buildWebQueryPlan(INDIV, { year: YEAR, max: 2, seed });
    assert.equal(plan.queries.length, 2);
    assert.equal(plan.queries[0], 'housing grants for individual Cleveland, TN');
    assert.deepEqual(tiers(plan), ['core', 'breadth']);
    seen.add(plan.queries[1]);
  }
  assert.ok(seen.size > 1, 'the second slot rotates with the seed');

  const a = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 2, seed: 0 });
  assert.deepEqual(tiers(a), ['anchor', 'core']);
  assert.equal(a.entries[0].gap_class, 'low_results');
  assert.equal(a.entries[1].gap_class, null, 'the core slot is a profile-own query, not more steering');
  for (const seed of [1, 5, 9]) {
    assert.deepEqual(buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 2, seed }).queries, a.queries, 'anchor + core are seed-stable');
  }
});

test('max=3 keeps at most the anchor budget and still reaches a rotating query', () => {
  const plain = buildWebQueryPlan(INDIV, { year: YEAR, max: 3, seed: 2 });
  assert.equal(plain.queries.length, 3);
  assert.equal(plain.queries[0], 'housing grants for individual Cleveland, TN');
  assert.ok(tiers(plain).includes('breadth'), 'a breadth query is inside a 3-query plan');
  assert.ok(!tiers(plain).includes('anchor'), 'no anchors without a learned shortfall');

  const short = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 3, seed: 2 });
  assert.equal(short.queries.length, 3);
  assert.ok(tiers(short).filter((t) => t === 'anchor').length <= PERSISTENT_QUERY_ANCHOR_COUNT);
  assert.equal(short.entries[0].tier, 'anchor');
  assert.ok(tiers(short).includes('core'), 'a profile-own core query survives at max=3');
  assert.ok(tiers(short).includes('breadth'), 'rotation is not starved at max=3');
});

// ── Head guarantee ──────────────────────────────────────────────────────────

test('HEAD GUARANTEE (shortfall, saturated core): every anchor, the strongest core, and one rotated breadth query sit in the first six', () => {
  const universe = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 10000, seed: 0 });
  const coreCount = universe.entries.filter((e) => e.tier === 'core' && e.gap_class === null).length;
  assert.ok(coreCount >= 28, `fixture must saturate the live budget with core alone (got ${coreCount})`);

  const heads = [];
  for (const seed of [0, 1, 7, 14, 1757600000000]) {
    const plan = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 28, seed });
    assert.equal(plan.shortfall, true);
    assert.equal(plan.queries.length, 28);
    const h = head(plan);
    assert.equal(h.length, 6);
    const anchors = h.filter((e) => e.tier === 'anchor');
    assert.ok(anchors.length >= 1 && anchors.length <= PERSISTENT_QUERY_ANCHOR_COUNT, 'bounded anchors in the head');
    assert.equal(plan.entries.filter((e) => e.tier === 'anchor').length, anchors.length, 'every anchor is inside the head');
    assert.ok(h.some((e) => e.tier === 'core' && e.gap_class === null), 'a profile-own core query is inside the head');
    assert.ok(h.some((e) => e.tier === 'breadth'), 'a rotated breadth query is inside the head');
    heads.push(h);
  }
  const fixedOf = (h) => h.filter((e) => e.tier !== 'breadth').map((e) => e.query);
  for (const h of heads.slice(1)) assert.deepEqual(fixedOf(h), fixedOf(heads[0]), 'anchors + core in the head are seed-stable');
  const breadthUnion = new Set(heads.flatMap((h) => h.filter((e) => e.tier === 'breadth').map((e) => e.query)));
  assert.ok(breadthUnion.size > 1, 'different seeds put DIFFERENT breadth queries in the head');
});

test('HEAD GUARANTEE (no learned shortfall): rotation reaches the six-query execution window for every profile (webq-2)', () => {
  const executed = new Set();
  let fixed = null;
  for (const seed of [0, 1, 7, 14, 1757600000000]) {
    const plan = buildWebQueryPlan(INDIV, { year: YEAR, max: 28, seed });
    assert.equal(plan.shortfall, false);
    const h = head(plan);
    assert.equal(h.length, 6);
    assert.ok(!h.some((e) => e.tier === 'anchor'));
    assert.equal(h[0].query, 'housing grants for individual Cleveland, TN', 'strongest core leads');
    assert.ok(h.some((e) => e.tier === 'breadth'), 'one rotated slot inside the window');
    const f = h.filter((e) => e.tier === 'core').map((e) => e.query);
    if (fixed) assert.deepEqual(f, fixed, 'core head is seed-stable');
    fixed = f;
    for (const e of h) executed.add(e.query);
  }
  assert.ok(executed.size > 6, `five seeds must execute more than one window's worth of distinct queries (got ${executed.size})`);
});

test('learned-gap steering is never rotated out behind other forced queries at the live budget (webq-5)', () => {
  const universe = buildWebQueryPlan(STUDENT_ALL_GAPS, { year: YEAR, max: 10000, seed: 0 });
  const forced = universe.entries.filter((e) => e.gap_class !== null).map((e) => e.query);
  assert.ok(forced.length >= 15, `fixture must carry many forced queries (got ${forced.length})`);
  for (const seed of [0, 5, 9, 14]) {
    const plan = buildWebQueryPlan(STUDENT_ALL_GAPS, { year: YEAR, max: 28, seed });
    const present = plan.queries.filter((q) => forced.includes(q));
    assert.equal(present.length, forced.length, `seed ${seed}: every learned-gap query survives the budget`);
    assert.ok(plan.entries.filter((e) => e.tier === 'breadth').length >= Math.floor(28 / 4), 'at least a quarter of the budget still rotates');
    assert.ok(head(plan).some((e) => e.tier === 'core' && e.gap_class === null), "the profile's own strongest query is not displaced from the head");
  }
});

test('repeated runs explore different breadth without ever losing the anchors', () => {
  const breadthSeen = new Set();
  let anchors = null;
  for (let seed = 0; seed < 10; seed += 1) {
    const plan = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 6, seed });
    const a = plan.entries.filter((e) => e.tier === 'anchor').map((e) => e.query);
    assert.ok(a.length >= 1);
    if (anchors) assert.deepEqual(a, anchors, `seed ${seed} keeps the anchors`);
    anchors = a;
    for (const e of plan.entries) if (e.tier === 'breadth') breadthSeen.add(e.query);
  }
  assert.ok(breadthSeen.size >= 5, `ten runs at max=6 must visit several breadth queries (got ${breadthSeen.size})`);
});

test('same seed → identical plan; different seeds → identical anchors/core, different breadth', () => {
  const a = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 28, seed: 11 });
  const b = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 28, seed: 11 });
  assert.deepEqual(a, b);
  const c = buildWebQueryPlan(SATURATED_SHORTFALL, { year: YEAR, max: 28, seed: 12 });
  const fixed = (p) => p.entries.filter((e) => e.tier !== 'breadth').map((e) => e.query);
  assert.deepEqual(fixed(c), fixed(a));
  const breadth = (p) => p.entries.filter((e) => e.tier === 'breadth').map((e) => e.query);
  assert.notDeepEqual(breadth(c), breadth(a));
});

// ── Per-need / per-family share of the head ─────────────────────────────────

test('a six-need profile does not spend the head on one need or one family', () => {
  for (const seed of [0, 3, 9]) {
    const plan = buildWebQueryPlan(SIX_NEED, { year: YEAR, max: 6, seed });
    const h = head(plan);
    const perNeed = new Map();
    const perFamily = new Map();
    for (const e of h) {
      if (e.need) perNeed.set(e.need, (perNeed.get(e.need) ?? 0) + 1);
      perFamily.set(e.family, (perFamily.get(e.family) ?? 0) + 1);
    }
    for (const [need, n] of perNeed) assert.ok(n <= 2, `seed ${seed}: need ${need} holds ${n} of 6 head slots`);
    for (const [family, n] of perFamily) assert.ok(n <= 3, `seed ${seed}: family ${family} holds ${n} of 6 head slots`);
    assert.ok(perFamily.size >= 3, `seed ${seed}: the head spans at least three families`);
  }
  // Over a cycle of seeds the rotating slot walks the remaining needs.
  const needsSeen = new Set();
  for (let seed = 0; seed < 12; seed += 1) {
    for (const e of head(buildWebQueryPlan(SIX_NEED, { year: YEAR, max: 6, seed }))) if (e.need) needsSeen.add(e.need);
  }
  assert.ok(needsSeen.size >= 4, `rotation must surface needs beyond the first two (got ${[...needsSeen].join(',')})`);
});

// ── Normalized dedup ────────────────────────────────────────────────────────

test('normalizeQueryKey collapses case, whitespace and punctuation but keeps exact-phrase quotes distinct', () => {
  const k = normalizeQueryKey('housing grants for individual Cleveland, TN');
  assert.equal(normalizeQueryKey('HOUSING GRANTS FOR INDIVIDUAL CLEVELAND, TN'), k);
  assert.equal(normalizeQueryKey('  housing   grants for\tindividual Cleveland TN. '), k);
  assert.equal(normalizeQueryKey('housing-grants for individual Cleveland, TN'), k);
  assert.notEqual(normalizeQueryKey('"Lee University" scholarships'), normalizeQueryKey('Lee University scholarships'));
  assert.equal(normalizeQueryKey(null), '');
  assert.equal(normalizeQueryKey('  '), '');
});

test('duplicate normalized queries are emitted once and recorded in dropped_duplicates', () => {
  const thesis = {
    ...INDIV,
    // origin_terms are emitted verbatim as CORE — inject variants of a query
    // the builder already produces from the need + geo template.
    origin_terms: ['Housing   grants for individual Cleveland TN.', 'HOUSING GRANTS FOR INDIVIDUAL CLEVELAND, TN', 'Bradley County alumni scholarship'],
  };
  const plan = buildWebQueryPlan(thesis, { year: YEAR, max: 40, seed: 0 });
  const keys = plan.queries.map(normalizeQueryKey);
  assert.equal(new Set(keys).size, keys.length, 'no two emitted queries share a normalized key');
  assert.equal(plan.queries.filter((q) => normalizeQueryKey(q) === normalizeQueryKey('housing grants for individual Cleveland, TN')).length, 1);
  assert.ok(plan.dropped_duplicates.length >= 2, 'both variants are reported');
  for (const d of plan.dropped_duplicates) {
    assert.equal(typeof d.query, 'string');
    assert.equal(typeof d.duplicate_of, 'string');
    assert.equal(normalizeQueryKey(d.query), normalizeQueryKey(d.duplicate_of));
    assert.ok(plan.queries.includes(d.duplicate_of) || plan.dropped_by_budget.some((x) => x.query === d.duplicate_of));
  }
  assert.ok(plan.queries.includes('Bradley County alumni scholarship'), 'a genuinely new origin term still runs');
});

// ── Geography formatting ────────────────────────────────────────────────────

test('a profile with NO location emits no empty-geo noise queries (webq-8)', () => {
  const plan = buildWebQueryPlan(
    { applicant_types: ['student', 'individual'], is_student: true, needs: ['tuition'], location: {} },
    { year: YEAR, max: 60, seed: 0 },
  );
  const bare = ['Rotary Club scholarship', 'Lions Club scholarship', 'church scholarships', 'local scholarships', 'need-based scholarships', 'community foundation scholarships', 'college grants for students', 'community foundation grants'];
  for (const q of plan.queries) {
    assert.ok(!bare.includes(q), `unanchored place-keyed template leaked: "${q}"`);
    assert.ok(!/\s{2,}/.test(q) && q === q.trim(), `malformed query "${q}"`);
    assert.ok(!/ for $| in $/.test(q), `dangling preposition "${q}"`);
  }
  assert.ok(plan.queries.includes('merit scholarships 2026'), 'intentionally national templates remain');
  assert.ok(plan.queries.length >= 3, 'a location-less student still gets a useful plan');

  const org = buildWebQueryPlan({ applicant_types: ['nonprofit'], is_org: true, needs: ['food'], location: {} }, { year: YEAR, max: 60, seed: 0 });
  for (const q of org.queries) assert.ok(!/\s{2,}/.test(q) && !/ for $/.test(q), `malformed org query "${q}"`);
});

test('county and territory formatting never invents a jurisdiction (hyperlocal-2)', () => {
  assert.equal(countyPhrase({ county: 'Bradley', state: 'TN' }), 'Bradley County, TN');
  assert.equal(countyPhrase({ county: 'Bradley County', state: 'TN' }), 'Bradley County, TN');
  assert.equal(countyPhrase({ county: 'Anchorage', state: 'AK' }), 'Municipality of Anchorage, AK');
  assert.equal(countyPhrase({ county: 'Juneau', state: 'AK' }), 'City and Borough of Juneau, AK');
  assert.equal(countyPhrase({ county: 'Fairbanks North Star', state: 'AK' }), 'Fairbanks North Star Borough, AK');
  assert.equal(countyPhrase({ county: 'Bethel', state: 'AK' }), 'Bethel Census Area, AK');
  assert.equal(countyPhrase({ county: 'Matanuska-Susitna Borough', state: 'AK' }), 'Matanuska-Susitna Borough, AK');
  assert.equal(countyPhrase({ county: 'Unmapped Place', state: 'AK' }), 'Unmapped Place, AK', 'unknown Alaska name stays a bare place');
  assert.equal(countyPhrase({ county: 'Bossier', state: 'LA' }), 'Bossier Parish, LA');
  assert.equal(countyPhrase({ county: 'Caddo Parish', state: 'LA' }), 'Caddo Parish, LA');
  assert.equal(countyPhrase({ county: 'Ponce', state: 'PR' }), 'Ponce Municipio, Puerto Rico');
  assert.equal(countyPhrase({ county: 'Ponce Municipio', state: 'PR' }), 'Ponce Municipio, Puerto Rico');
  assert.equal(countyPhrase({ county: 'St. Thomas', state: 'VI' }), 'St. Thomas, U.S. Virgin Islands');
  assert.equal(countyPhrase({ county: 'Guam', state: 'GU' }), '', 'a county equal to its territory adds nothing');
  assert.equal(countyPhrase({ county: 'Richmond city', state: 'VA' }), 'Richmond city, VA', 'independent cities pass through');
  assert.equal(countyPhrase({ county: 'District of Columbia', state: 'DC' }), 'District of Columbia');
  assert.equal(countyPhrase({}), '');

  const ak = buildWebQueryPlan(
    { applicant_types: ['school', 'government'], is_org: true, needs: ['education'], location: { city: 'Anchorage', state: 'AK', county: 'Anchorage' } },
    { year: YEAR, max: 40, seed: 0 },
  );
  assert.ok(!ak.queries.some((q) => /Anchorage County/.test(q)), 'no invented "Anchorage County"');
  assert.ok(ak.queries.some((q) => /Municipality of Anchorage, AK/.test(q)));
  const la = buildWebQueryPlan(
    { applicant_types: ['individual'], needs: ['housing'], location: { city: 'Shreveport', state: 'LA', county: 'Bossier' } },
    { year: YEAR, max: 6, seed: 0 },
  );
  assert.ok(la.queries.some((q) => /Bossier Parish, LA/.test(q)) && !la.queries.some((q) => /Bossier County/.test(q)));
});
