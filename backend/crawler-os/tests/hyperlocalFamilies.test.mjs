// tests/hyperlocalFamilies.test.mjs
//
// Hyperlocal query families must express the applicant TYPE and the declared
// NEED, use only geography the thesis already carries, and never cross lanes:
// organizations must not consume individual safety-net slots and individuals
// must not receive institutional grant noise. Amy hyperlocal_recall_miss
// (50/50 in the 2026-09-12 baseline) is the signal these pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebQueries, buildWebQueryPlan } from '../webQueries.js';
import { buildThesis } from '../profileIntelligence.js';

const YEAR = 2026;
const all = (thesis) => buildWebQueries(thesis, { year: YEAR, max: 10000, seed: 0 });
const head6 = (thesis) => buildWebQueries(thesis, { year: YEAR, max: 6, seed: 0 });
const SAFETY_NET = /benefits\.gov|211 community resources|churches that help|emergency assistance fund|Salvation Army|food pantry|Area Agency on Aging|vocational rehabilitation|LIHEAP|Medicaid application|SNAP food assistance|community action agency/i;
const INSTITUTIONAL = /capacity building|small business economic development|school district|SBIR|Assistance to Firefighters|community development block grant|USDA rural development|HRSA|chamber of commerce|education foundation institutional|WIOA/i;

// ── Applicant type expression (hyperlocal-4) ────────────────────────────────

test('person buckets without a noun no longer read as "organization" in hyperlocal queries', () => {
  const teacher = buildWebQueries(
    { applicant_types: ['teacher', 'individual'], needs: ['classroom_supplies'], location: { city: 'Nashville', state: 'TN', county: 'Davidson' } },
    { year: YEAR, max: 10, seed: 0 },
  );
  assert.ok(!teacher.some((q) => /\borganization\b/.test(q)), `teacher searched as an organization: ${teacher.join(' | ')}`);
  assert.ok(teacher.some((q) => /grants for teacher Davidson County, TN/.test(q)), 'county query names the teacher');

  const spouse = all({ applicant_types: ['military_spouse', 'family', 'individual'], needs: ['education'], location: { city: 'Clarksville', state: 'TN', county: 'Montgomery' } });
  assert.ok(!spouse.some((q) => /\borganization\b/.test(q)));
  assert.ok(spouse.some((q) => /military spouse/.test(q)), 'military spouse noun reaches the query text');

  const guard = all({ applicant_types: ['guard_reserve', 'individual'], needs: ['housing'], location: { state: 'TN', county: 'Knox' } });
  assert.ok(!guard.some((q) => /\borganization\b/.test(q)));
});

// ── Neighboring-town family expresses grant intent for organizations (hyperlocal-6) ──

test('an organization searches its nearest town for GRANTS, an individual for assistance programs', () => {
  const school = buildWebQueries(
    { applicant_types: ['school'], is_org: true, needs: ['education'], location: { city: 'Jackson', state: 'MS', county: 'Hinds', nearby_cities: [{ city: 'Richland', state: 'MS', miles: 5 }] } },
    { year: YEAR, max: 40, seed: 0 },
  );
  assert.ok(!school.some((q) => /assistance programs Richland/.test(q)), 'individual safety-net phrasing on an org');
  assert.ok(school.some((q) => q === 'school grants Richland, MS'), 'org nearest-town query states grant intent');
  assert.ok(school.some((q) => q === 'community foundation Richland, MS'));

  const individual = buildWebQueries(
    { applicant_types: ['individual'], needs: ['medical bills'], location: { state: 'TN', city: 'Cleveland', county: 'Bradley County', nearby_cities: [{ city: 'Charleston', state: 'TN', miles: 6 }] } },
    { year: YEAR, max: 40, seed: 0 },
  );
  assert.ok(individual.some((q) => q === 'individual assistance programs Charleston, TN'), 'individual phrasing untouched');
});

// ── School-district family keyed to the declared need (hyperlocal-8) ────────

test('a school district searches its declared need, not a fixed STEM phrase; plain K-12 schools get a district/education-foundation family', () => {
  const transport = buildWebQueries(
    { applicant_types: ['school', 'government'], is_org: true, needs: ['school_transportation', 'transportation'], location: { city: 'Anchorage', county: 'Anchorage', state: 'AK' } },
    { year: YEAR, max: 14, seed: 0 },
  );
  assert.ok(transport.some((q) => /^school district .*transportation grants Municipality of Anchorage, AK$/.test(q)), `district query keyed to need: ${transport.join(' | ')}`);
  assert.ok(!transport.some((q) => /STEM literacy/.test(q)), 'no STEM literacy phrase for a transportation department');

  const generic = buildWebQueries(
    { applicant_types: ['school', 'government'], is_org: true, needs: ['education'], location: { state: 'WV', county: 'Raleigh' } },
    { year: YEAR, max: 14, seed: 0 },
  );
  assert.ok(generic.includes('school district STEM literacy grants Raleigh County, WV'), 'generic education need keeps the Amy-learned STEM literacy family');

  const k12 = head6({ applicant_types: ['school'], is_org: true, needs: ['education'], location: { city: 'Jackson', state: 'MS', county: 'Hinds' } });
  assert.ok(k12.includes('Hinds County, MS education foundation'), `education-foundation family inside the six-query window: ${k12.join(' | ')}`);
  const cityOnly = all({ applicant_types: ['school'], is_org: true, needs: ['education'], location: { city: 'Fresno', state: 'CA' } });
  assert.ok(cityOnly.some((q) => /Fresno, CA school district education foundation/.test(q)), 'city-only school still reaches a district education foundation');
});

// ── Higher-education family keyed to identity (hyperlocal-7) ────────────────

test('a higher-education institution gets the higher-ed family on identity, and no K-12 teacher lane', () => {
  const uni = all({ applicant_types: ['school'], is_org: true, is_higher_ed: true, needs: ['capital'], location: { city: 'Fresno', state: 'CA', county: 'Fresno' } });
  assert.ok(uni.some((q) => /higher education/.test(q)), 'higher-ed institutional query present on identity alone');
  assert.ok(!uni.some((q) => /teacher classroom grants/.test(q)), 'no K-12 teacher lane for a university');
  const k12 = all({ applicant_types: ['school'], is_org: true, needs: ['capital'], location: { city: 'Fresno', state: 'CA', county: 'Fresno' } });
  assert.ok(k12.some((q) => /teacher classroom grants/.test(q)), 'a K-12 school keeps the teacher lane');
  assert.ok(!k12.some((q) => /higher education/.test(q)), 'no higher-ed query for a K-12 school without the need text');
});

test('buildThesis raises is_higher_ed from a DECLARED institution type, never from a student or a K-12 school', () => {
  const route = { needs_source: 'profile_declared_or_faceted', default_needs: [] };
  const loc = { city: 'Fresno', state: 'CA', county: 'Fresno' };
  for (const primary of ['university', 'college', 'community_college', 'technical_college']) {
    const t = buildThesis({ profile_id: `p-${primary}`, primary_type: primary, need_categories: ['capital'], profile_route: route, location: loc });
    assert.ok(t.applicant_types.includes('school'), `${primary} maps to the school bucket (got ${t.applicant_types})`);
    assert.equal(t.is_org, true, `${primary} is an organization`);
    assert.equal(t.is_higher_ed, true, `${primary} is a higher-education institution`);
    const qs = buildWebQueries(t, { year: YEAR, max: 10000, seed: 0 });
    assert.ok(qs.some((q) => /higher education/.test(q)), `${primary}: higher-ed institutional family present`);
    assert.ok(!qs.some((q) => /teacher classroom grants/.test(q)), `${primary}: no K-12 teacher lane`);
  }
  const student = buildThesis({ profile_id: 'p-cs', primary_type: 'college_student', need_categories: ['tuition'], profile_route: route, location: loc });
  assert.equal(student.is_higher_ed, false, 'a student AT a college is not the institution');
  assert.equal(student.is_student, true);
  const k12 = buildThesis({ profile_id: 'p-k12', primary_type: 'school', need_categories: ['education'], profile_route: route, location: loc });
  assert.equal(k12.is_higher_ed, false, 'a K-12 school is not higher education');
  const district = buildThesis({ profile_id: 'p-sd', primary_type: 'school_district', need_categories: ['education'], profile_route: route, location: loc });
  assert.equal(district.is_higher_ed, false);
});

// ── Students with declared crisis needs (hyperlocal-9) ──────────────────────

test('a student who declares housing/utilities reaches local safety-net ENTITIES in the pool without displacing scholarship core', () => {
  const thesis = {
    applicant_types: ['student', 'individual'], is_student: true,
    needs: ['scholarship', 'housing', 'utilities'], keywords: ['rent', 'utilities'],
    schools: ['Jackson State University'],
    location: { city: 'Jackson', state: 'MS', county: 'Hinds' },
  };
  const universe = all(thesis);
  assert.ok(universe.some((q) => /churches that help with housing Jackson, MS/.test(q)), 'church assistance entity');
  assert.ok(universe.some((q) => /Hinds County, MS emergency assistance fund/.test(q)), 'county emergency fund');
  assert.ok(universe.some((q) => /utility bill assistance Jackson, MS/.test(q)), 'utility fund');
  assert.ok(!universe.some((q) => /benefits\.gov|Area Agency on Aging|vocational rehabilitation|211 community resources/i.test(q)), 'benefit locators stay out of the student lane');

  const plan = buildWebQueryPlan(thesis, { year: YEAR, max: 14, seed: 0 });
  const fixed = plan.entries.filter((e) => e.tier !== 'breadth').map((e) => e.query);
  assert.ok(!fixed.some((q) => /churches that help|emergency assistance fund|utility bill assistance/.test(q)), 'entity queries broaden; they never take a scholarship core slot');
  assert.ok(fixed.some((q) => /Jackson State University/.test(q)) && fixed.some((q) => /scholarships/.test(q)), 'scholarship core intact');

  const noCrisis = all({ ...thesis, needs: ['scholarship'], keywords: [] });
  assert.ok(!noCrisis.some((q) => /churches that help|emergency assistance fund|utility bill assistance/.test(q)), 'no crisis need → no safety-net entities');
});

// ── Cross-consumption proof (Q2) ────────────────────────────────────────────

test('organization profiles never consume individual safety-net slots; individuals never receive institutional grant noise', () => {
  const orgs = [
    { applicant_types: ['nonprofit'], is_org: true, needs: ['food', 'housing', 'medical', 'energy'], keywords: ['senior', 'disability', 'rent'], location: { city: 'Columbus', state: 'OH', county: 'Franklin' } },
    { applicant_types: ['business'], is_org: true, needs: ['capital', 'housing'], location: { city: 'Columbus', state: 'OH', county: 'Franklin' } },
    { applicant_types: ['school'], is_org: true, needs: ['education', 'utilities'], location: { city: 'Jackson', state: 'MS', county: 'Hinds' } },
    { applicant_types: ['school', 'government'], is_org: true, needs: ['school_transportation'], location: { city: 'Anchorage', state: 'AK', county: 'Anchorage' } },
  ];
  for (const thesis of orgs) {
    const qs = all(thesis);
    const leak = qs.filter((q) => SAFETY_NET.test(q));
    assert.deepEqual(leak, [], `${thesis.applicant_types.join('+')} leaked individual safety-net queries`);
  }
  const people = [
    { applicant_types: ['individual'], needs: ['housing', 'food'], location: { city: 'Columbus', state: 'OH', county: 'Franklin' } },
    { applicant_types: ['family', 'individual'], needs: ['childcare', 'energy'], location: { city: 'Jackson', state: 'MS', county: 'Hinds' } },
    { applicant_types: ['teacher', 'individual'], needs: ['classroom_supplies'], location: { city: 'Nashville', state: 'TN', county: 'Davidson' } },
  ];
  for (const thesis of people) {
    const qs = all(thesis);
    const noise = qs.filter((q) => INSTITUTIONAL.test(q));
    assert.deepEqual(noise, [], `${thesis.applicant_types.join('+')} received institutional grant noise`);
  }
});

// ── Declared need reaches the plan for every applicant class ────────────────

test('a declared need yields a need-bearing query inside the live budget for org and individual alike', () => {
  const cases = [
    [{ applicant_types: ['nonprofit'], is_org: true, needs: ['community_development'], location: { city: 'Columbus', state: 'OH', county: 'Franklin' } }, /community development grants for nonprofit organization Columbus, OH/],
    [{ applicant_types: ['school'], is_org: true, needs: ['utilities'], location: { city: 'Jackson', state: 'MS', county: 'Hinds' } }, /utilities grants for school Jackson, MS/],
    [{ applicant_types: ['school', 'government'], is_org: true, needs: ['environment'], location: { city: 'Anchorage', state: 'AK', county: 'Anchorage' } }, /environment grants for school Anchorage, AK/],
    [{ applicant_types: ['individual'], needs: ['utilities'], location: { city: 'Jackson', state: 'MS', county: 'Hinds' } }, /utilities (grants for individual|assistance programs)/],
  ];
  for (const [thesis, rx] of cases) {
    const live = buildWebQueries(thesis, { year: YEAR, max: 28, seed: 0 });
    assert.ok(live.some((q) => rx.test(q)), `${thesis.needs[0]} for ${thesis.applicant_types.join('+')}: ${live.slice(0, 8).join(' | ')}`);
    assert.ok(live.slice(0, 6).some((q) => rx.test(q)), `${thesis.needs[0]} is inside the six-query window`);
  }
});
