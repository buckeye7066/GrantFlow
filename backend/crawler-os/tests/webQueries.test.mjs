// tests/webQueries.test.mjs
//
// buildWebQueries breadth + rotation. The open-web lane is the main breadth lever
// for student/individual profiles (grants.gov/SAM don't serve them), so these
// guard that: (1) the highest-signal CORE queries always run, (2) re-runs with a
// different seed explore NEW queries, and (3) student field-of-study interests
// surface field-specific scholarship searches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebQueries } from '../webQueries.js';

const STUDENT_THESIS = {
  applicant_types: ['student', 'individual'],
  is_student: true,
  needs: ['scholarship', 'education', 'housing', 'fafsa', 'first_gen'],
  location: { state: 'TN', city: 'Murfreesboro' },
  interest_terms: ['nursing', 'biology'],
};

test('a student profile gets scholarship-flavored queries', () => {
  const qs = buildWebQueries(STUDENT_THESIS, { year: 2026, max: 8, seed: 0 });
  assert.ok(qs.length > 0);
  assert.ok(qs.some((q) => /scholarship/i.test(q)), 'should include a scholarship query');
  assert.ok(qs.some((q) => /Murfreesboro|TN/i.test(q)), 'should be geo-aware');
});

test('CORE queries are present regardless of the rotation seed', () => {
  const core = 'scholarships for students Murfreesboro, TN 2026';
  for (const seed of [0, 1, 7, 12345, 99999]) {
    const qs = buildWebQueries(STUDENT_THESIS, { year: 2026, max: 8, seed });
    assert.ok(qs.includes(core), `seed ${seed} must keep the core scholarship query`);
  }
});

test('different seeds explore NEW queries (rotation broadens coverage)', () => {
  const a = buildWebQueries(STUDENT_THESIS, { year: 2026, max: 6, seed: 0 });
  const b = buildWebQueries(STUDENT_THESIS, { year: 2026, max: 6, seed: 5 });
  assert.deepEqual(
    buildWebQueries(STUDENT_THESIS, { year: 2026, max: 6, seed: 0 }),
    a,
    'same seed must be deterministic',
  );
  // The union across two seeds must exceed either single run — that is the whole
  // point: successive discoveries cover more ground than any one run.
  const union = new Set([...a, ...b]);
  assert.ok(union.size > a.length, 'a second seed must surface queries the first did not');
});

test('field-of-study interests produce field-specific scholarship queries', () => {
  // Use a big max so rotation cannot hide them; assert the templates exist.
  const qs = buildWebQueries(STUDENT_THESIS, { year: 2026, max: 40, seed: 0 });
  assert.ok(qs.some((q) => /nursing scholarships/i.test(q)), 'nursing interest → nursing scholarships');
  assert.ok(qs.some((q) => /biology scholarships/i.test(q)), 'biology interest → biology scholarships');
});

test('a sparse profile still returns at least one useful query', () => {
  const qs = buildWebQueries({ applicant_types: ['individual'], needs: [], location: {} }, { year: 2026, max: 6 });
  assert.ok(qs.length >= 1);
  assert.ok(qs.every((q) => typeof q === 'string' && q.length > 6));
});

test('the CORE set is never dropped even when max is small', () => {
  const qs = buildWebQueries(STUDENT_THESIS, { year: 2026, max: 2, seed: 42 });
  assert.equal(qs.length, 2);
  // First two are always core (need-specific + geo/type), never rotated extras.
  assert.ok(/grants for student|scholarships for students/i.test(qs[0]));
});

// ── Institution- / employer- / county-specific recall (the acquisition gap) ──
// Endowed/departmental/foundation scholarships and employer & hyperlocal awards
// are findable ONLY by name — generic geo/type/need queries cannot reach them.

const NAMED_STUDENT = {
  applicant_types: ['student', 'individual'],
  is_student: true,
  needs: ['tuition', 'textbooks'],
  location: { state: 'TN', city: 'Cleveland', county: 'Bradley County', zip: '37312' },
  interest_terms: ['emergency medical services'],
  schools: ['Cleveland State Community College', 'Chattanooga State Community College'],
  field_of_study: 'Paramedic',
};

test('a named school produces institution-specific scholarship queries (CORE)', () => {
  const qs = buildWebQueries(NAMED_STUDENT, { year: 2026, max: 14, seed: 0 });
  assert.ok(qs.includes('Cleveland State Community College scholarships'), 'school scholarships query');
  assert.ok(
    qs.includes('Cleveland State Community College Paramedic scholarship'),
    'primary school + field-of-study (departmental endowment) query',
  );
  assert.ok(
    qs.includes('Cleveland State Community College foundation scholarships'),
    'university foundation (where named endowments live) query',
  );
  // A second declared school is also searched.
  assert.ok(qs.includes('Chattanooga State Community College scholarships'), 'second school searched');
});

test('institution queries survive even at a small max (they are CORE, not rotated)', () => {
  const qs = buildWebQueries(NAMED_STUDENT, { year: 2026, max: 3, seed: 777 });
  // The exact-name form is QUOTED (deliberate, #1089: defeats SERP drift) —
  // strip quotes before asserting the primary institution leads CORE.
  assert.ok(qs[0].replace(/"/g, '').startsWith('Cleveland State Community College'), 'primary institution leads CORE');
});

test('county-level hyperlocal queries are emitted from the county signal', () => {
  const qs = buildWebQueries(NAMED_STUDENT, { year: 2026, max: 14, seed: 0 });
  assert.ok(qs.includes('scholarships Bradley County, TN'), 'county scholarship query');
  assert.ok(qs.includes('community foundation Bradley County, TN'), 'county community foundation query');
});

test('a bare county string is normalized to "<County> County"', () => {
  const qs = buildWebQueries(
    { ...NAMED_STUDENT, location: { state: 'TN', county: 'Bradley' } },
    { year: 2026, max: 14, seed: 0 },
  );
  assert.ok(qs.some((q) => /Bradley County, TN/.test(q)), 'bare county gets a "County" suffix');
});

test('a declared employer produces employer education-program queries', () => {
  const worker = {
    applicant_types: ['individual'],
    needs: ['tuition'],
    location: { state: 'TN', city: 'Cleveland' },
    employer: 'Bradley County EMS',
  };
  const qs = buildWebQueries(worker, { year: 2026, max: 14, seed: 0 });
  assert.ok(qs.includes('Bradley County EMS scholarship'), 'employer scholarship query');
  assert.ok(qs.includes('Bradley County EMS tuition assistance'), 'employer tuition-assistance query');
});

// ── 25-mile-radius town queries + student state-aid CORE (2026-07-05 QA) ────

test('nearby_cities produce radius-town queries (nearest is CORE)', () => {
  const thesis = {
    ...NAMED_STUDENT,
    location: {
      ...NAMED_STUDENT.location,
      nearby_cities: [
        { city: 'Charleston', state: 'TN', miles: 6 },
        { city: 'Georgetown', state: 'TN', miles: 7 },
      ],
    },
  };
  const qs = buildWebQueries(thesis, { year: 2026, max: 40, seed: 0 });
  assert.ok(qs.includes('scholarships Charleston, TN'), 'nearest town is a CORE student query');
  assert.ok(qs.includes('community foundation Charleston, TN'), 'nearest town community foundation is CORE');
  assert.ok(
    qs.some((q) => /Georgetown, TN/.test(q)),
    'further towns appear in the broadened pool',
  );
});

test('non-students get assistance-program queries for the nearest radius town', () => {
  const thesis = {
    applicant_types: ['individual'],
    needs: ['medical bills'],
    location: {
      state: 'TN', city: 'Cleveland', county: 'Bradley County', zip: '37323',
      nearby_cities: [{ city: 'Charleston', state: 'TN', miles: 6 }],
    },
  };
  const qs = buildWebQueries(thesis, { year: 2026, max: 40, seed: 0 });
  assert.ok(
    qs.some((q) => /Charleston, TN/.test(q)),
    'radius town reached for individuals too',
  );
});

test('state scholarship programs query is CORE for students (never rotated out)', () => {
  // Small max + varying seeds: a CORE query must survive every rotation.
  for (const seed of [0, 3, 7, 11]) {
    const qs = buildWebQueries(NAMED_STUDENT, { year: 2026, max: 14, seed });
    assert.ok(
      qs.includes('TN state scholarship programs'),
      `state-aid query present at seed ${seed}`,
    );
  }
});

test('primary school gets an endowed-scholarships query (CORE)', () => {
  const qs = buildWebQueries(NAMED_STUDENT, { year: 2026, max: 40, seed: 0 });
  assert.ok(qs.includes('Cleveland State Community College endowed scholarships'));
});

// ── Research-org lane (the Axiom BioLabs archetype, 2026-07-06) ──────────────
const RESEARCH_ORG_THESIS = {
  applicant_types: ['nonprofit', 'business'],
  is_org: true,
  is_research_org: true,
  needs: ['research_funding'],
  location: { state: 'TN', city: 'Cleveland' },
  interest_terms: ['biotechnology research', 'genetic engineering', 'bioinformatics'],
};

test('a research org gets SBIR/STTR queries keyed to its top interest (CORE, seed-stable)', () => {
  for (const seed of [0, 3, 11]) {
    const qs = buildWebQueries(RESEARCH_ORG_THESIS, { year: 2026, max: 12, seed });
    assert.ok(
      qs.includes('SBIR STTR biotechnology research solicitation 2026'),
      `SBIR core query present at seed ${seed}`,
    );
    assert.ok(
      qs.includes('TN SBIR matching funds program'),
      `state matching-funds query present at seed ${seed}`,
    );
  }
});

test('a non-research org gets NO SBIR queries', () => {
  const qs = buildWebQueries(
    { applicant_types: ['nonprofit'], is_org: true, needs: ['food'], location: { state: 'TN' } },
    { year: 2026, max: 40, seed: 0 },
  );
  assert.ok(!qs.some((q) => /sbir/i.test(q)), 'no SBIR queries for a food pantry');
});

test('persistent org archetype misses get class-specific hyperlocal CORE queries', () => {
  const cases = [
    {
      label: 'business',
      thesis: { applicant_types: ['business'], is_org: true, needs: ['capital'], location: { state: 'MT', county: 'Yellowstone' } },
      expected: 'small business economic development grants Yellowstone County, MT',
    },
    {
      label: 'nonprofit',
      thesis: { applicant_types: ['nonprofit'], is_org: true, needs: ['capacity building'], location: { state: 'IN', county: 'Howard' } },
      expected: 'nonprofit capacity building grants Howard County, IN',
    },
    {
      label: 'school district',
      thesis: { applicant_types: ['school', 'government'], is_org: true, needs: ['education'], location: { state: 'WV', county: 'Raleigh' } },
      expected: 'school district STEM literacy grants Raleigh County, WV',
    },
    {
      label: 'college / university',
      thesis: { applicant_types: ['school'], is_org: true, needs: ['research'], location: { state: 'NM', county: 'McKinley' } },
      expected: 'higher education research student access grants McKinley County, NM',
    },
  ];

  for (const { label, thesis, expected } of cases) {
    for (const seed of [0, 7]) {
      const qs = buildWebQueries(thesis, { year: 2026, max: 14, seed });
      assert.ok(qs.includes(expected), `${label} class-specific query survives seed ${seed}`);
    }
  }
});

test('SBIR topic prefers thesis.research_topic and never uses a bookkeeping tag', () => {
  const qs = buildWebQueries(
    { ...RESEARCH_ORG_THESIS, research_topic: 'genomics', interest_terms: ['designated', 'source-safe'] },
    { year: 2026, max: 12, seed: 0 },
  );
  assert.ok(qs.includes('SBIR STTR genomics solicitation 2026'), 'topic from research_topic');
  assert.ok(!qs.some((q) => /designated|source-safe/i.test(q)), 'no bookkeeping-tag queries');
});

// ── Territory query language (2026-07-13, fifty-state-assumption fix) ────────
// A Puerto Rico profile's queries must speak search language: "PR" as a bare
// token reads as "public relations", "Ponce Municipio County" is not a place,
// and Spanish-only territorial programs are unreachable by English-only queries.
const PR_ORG_THESIS = {
  applicant_types: ['business'],
  is_org: true,
  needs: ['disaster_recovery', 'childcare'],
  location: { state: 'PR', city: 'Ponce', county: 'Ponce Municipio' },
};

test('a Puerto Rico profile gets full-territory-name query language, never a bare PR token', () => {
  const qs = buildWebQueries(PR_ORG_THESIS, { year: 2026, max: 40, seed: 0 });
  assert.ok(qs.length > 0, 'queries emitted for a PR profile');
  assert.ok(
    qs.some((q) => q.includes('Ponce, Puerto Rico')),
    `geo phrase expands the territory name (got: ${qs.join(' | ')})`,
  );
  assert.ok(
    !qs.some((q) => /(^|\s)PR(\s|$)/.test(q)),
    'no query carries the ambiguous bare "PR" token',
  );
});

test('municipio county-equivalents never get a "County" suffix bolted on', () => {
  const qs = buildWebQueries(PR_ORG_THESIS, { year: 2026, max: 40, seed: 0 });
  assert.ok(!qs.some((q) => /Municipio County/i.test(q)), 'no "Ponce Municipio County" phrases');
  assert.ok(
    qs.some((q) => q.includes('Ponce Municipio, Puerto Rico')),
    'the municipio phrase is used for hyperlocal queries',
  );
});

test('a Puerto Rico profile gets a Spanish-language assistance query (CORE, seed-stable)', () => {
  for (const seed of [0, 5]) {
    const qs = buildWebQueries(PR_ORG_THESIS, { year: 2026, max: 12, seed });
    assert.ok(
      qs.some((q) => q.startsWith('programas de ayuda')),
      `Spanish core query present at seed ${seed}`,
    );
  }
});

test('a territory student reaches territory scholarship programs without the "state" misnomer', () => {
  const qs = buildWebQueries(
    { applicant_types: ['student', 'individual'], is_student: true, needs: ['education'], location: { state: 'PR', city: 'San Juan' } },
    { year: 2026, max: 20, seed: 0 },
  );
  assert.ok(qs.includes('Puerto Rico scholarship programs'), 'territory scholarship query present');
  assert.ok(!qs.includes('PR state scholarship programs'), 'no code-plus-state phrasing');
});

test('fifty-state profiles keep their existing query language (no churn)', () => {
  const qs = buildWebQueries(
    { applicant_types: ['student', 'individual'], is_student: true, needs: ['education'], location: { state: 'TN', city: 'Cleveland' } },
    { year: 2026, max: 20, seed: 0 },
  );
  assert.ok(qs.includes('TN state scholarship programs'), 'state phrasing unchanged for TN');
  assert.ok(!qs.some((q) => /programas de ayuda/.test(q)), 'no Spanish lane outside PR');
});

// September 6 report: the same rotation seed applied twice permanently skipped
// candidates. Test reachability of the COMPLETE query inventory, not just that
// two seeds happen to differ. No network or admission/scoring changes.
test('one complete seed cycle reaches every budgeted query without double-rotation starvation', () => {
  const profiles = [
    { applicant_types: ['individual'], needs: ['food', 'housing', 'transportation', 'medical'], location: { city: 'Fresno', state: 'CA' }, interest_terms: ['biology'] },
    { ...NAMED_STUDENT, learned_gaps: { classes: ['low_results', 'hyperlocal_gap', 'result_floor_shortfall'] } },
    { applicant_types: ['business'], is_org: true, needs: ['capital', 'equipment'], location: { city: 'Raleigh', state: 'NC' }, learned_gaps: { classes: ['hyperlocal_gap', 'low_results'] } },
  ];
  for (const thesis of profiles) {
    const inventory = buildWebQueries(thesis, { year: 2026, max: 10000, seed: 0 });
    for (const max of [1, 6, 8, 14]) {
      const observed = new Set();
      for (let seed = 0; seed < inventory.length; seed += 1) {
        const queries = buildWebQueries(thesis, { year: 2026, max, seed });
        assert.ok(queries.length <= max);
        assert.equal(new Set(queries.map((q) => q.toLowerCase())).size, queries.length);
        for (const q of queries) observed.add(q);
      }
      assert.deepEqual([...observed].sort(), [...inventory].sort(), `complete recall at budget ${max}`);
    }
  }
});

test('city-only learned gaps retain the business, nonprofit, university, and student search intent', () => {
  for (const [types, city, state, isStudent] of [
    [['business'], 'Raleigh', 'NC', false],
    [['nonprofit'], 'Erie', 'PA', false],
    [['school'], 'Fresno', 'CA', false],
    [['student', 'individual'], 'Fresno', 'CA', true],
  ]) {
    const thesis = { applicant_types: types, is_org: !isStudent, is_student: isStudent, needs: ['education'], location: { city, state }, learned_gaps: { classes: ['hyperlocal_gap', 'low_results'] } };
    for (const seed of [0, 7, 29]) {
      const queries = buildWebQueries(thesis, { year: 2026, max: 14, seed });
      assert.match(queries[0], new RegExp(city));
      assert.match(queries[0], isStudent ? /local scholarships/ : /grants application/);
      if (!isStudent) {
        assert.ok(!queries.some((q) => /emergency assistance fund|church assistance programs/.test(q)));
        assert.ok(queries.some((q) => q.includes(`${state} grant programs for`)));
      }
    }
  }
});

test('a zero query budget emits no queries', () => {
  assert.deepEqual(buildWebQueries(NAMED_STUDENT, { max: 0 }), []);
});
