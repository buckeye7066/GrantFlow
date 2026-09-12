// tests/declaredNeedSurvival.test.mjs
//
// hyperlocal-3: a DECLARED canonical need (need_categories) must survive to
// thesis.needs, because buildWebQueries reads only thesis.needs. Measured on
// the faithful Amy path 2026-09-12: community_development, environment and
// utilities were dropped between need_categories and thesis.needs, so the
// declared need never produced a query — and 'utilities' minted a phantom
// 'housing' CORE query through the housing keyword list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThesis } from '../profileIntelligence.js';
import { buildWebQueries } from '../webQueries.js';
import { CANONICAL_NEED_CATEGORIES } from '../../constants/needCategories.js';

const declared = (primary_type, needs, location = { state: 'OH', city: 'Columbus', county: 'Franklin' }) => buildThesis({
  profile_id: 'p-declared',
  primary_type,
  need_categories: needs,
  profile_route: { needs_source: 'profile_declared_or_faceted', default_needs: [] },
  location,
});

test('every canonical need id declared in need_categories survives to thesis.needs', () => {
  for (const { id } of CANONICAL_NEED_CATEGORIES) {
    const t = declared('nonprofit', [id]);
    assert.ok(t.needs.includes(id), `declared canonical need "${id}" was dropped (needs=${JSON.stringify(t.needs)})`);
    assert.equal(t.needs_defaulted, false, `"${id}" must count as a declaration, not a type default`);
  }
});

test('community_development, environment and utilities reach the query builder as needs', () => {
  const cd = declared('nonprofit', ['community_development']);
  assert.ok(cd.needs.includes('community_development'));
  assert.ok(buildWebQueries(cd, { year: 2026, max: 28, seed: 0 }).some((q) => /community development grants for nonprofit organization Columbus, OH/.test(q)));

  const env = declared('school_transportation', ['environment'], { state: 'AK', city: 'Anchorage', county: 'Anchorage' });
  assert.ok(env.needs.includes('environment'));
  assert.ok(buildWebQueries(env, { year: 2026, max: 28, seed: 0 }).some((q) => /environment grants for school Anchorage, AK/.test(q)));

  const util = declared('school', ['utilities'], { state: 'MS', city: 'Jackson', county: 'Hinds' });
  assert.ok(util.needs.includes('utilities'));
  assert.ok(util.needs.includes('energy'), 'utilities still implies the energy lane the registry sources are keyed to');
  assert.ok(!util.needs.includes('housing'), '"utilities" must not mint a phantom housing need');
  assert.ok(buildWebQueries(util, { year: 2026, max: 6, seed: 0 }).some((q) => /utilities grants for school Jackson, MS/.test(q)), 'declared need inside the six-query window');
});

test('the declared need leads the need order so it wins a CORE need slot', () => {
  const t = declared('school', ['utilities', 'education'], { state: 'MS', city: 'Jackson', county: 'Hinds' });
  assert.equal(t.needs[0], 'utilities', `declaration order preserved: ${JSON.stringify(t.needs)}`);
});

test('free-text "utilities" in prose still derives energy, never housing', () => {
  const t = buildThesis({
    profile_id: 'p-prose',
    primary_type: 'individual',
    description: 'We are behind on our utilities this winter.',
    profile_route: { needs_source: 'profile_declared_or_faceted', default_needs: [] },
    location: { state: 'TN' },
  });
  assert.ok(t.needs.includes('energy'));
  assert.ok(!t.needs.includes('housing'));
});
