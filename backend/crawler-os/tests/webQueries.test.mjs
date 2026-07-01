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
