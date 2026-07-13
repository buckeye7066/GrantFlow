// tests/profileIntelligence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThesis } from '../profileIntelligence.js';
import { SAMPLE_VFD_PROFILE, SAMPLE_STUDENT_PROFILE } from './fixtures/fakeFetch.mjs';

test('buildThesis carries profile_id, location, and needs from the full profile', () => {
  const th = buildThesis(SAMPLE_VFD_PROFILE);
  assert.equal(th.profile_id, 'profile_vfd_1');
  assert.equal(th.location.state, 'TN');
  assert.ok(th.needs.length > 0, 'needs derived from profile');
});

test('loans and cost-share are OFF unless the profile explicitly opts in', () => {
  const th = buildThesis(SAMPLE_VFD_PROFILE);
  assert.equal(th.loan_allowed, false);
  assert.equal(th.cost_share_allowed, false);

  const optedIn = buildThesis({ ...SAMPLE_VFD_PROFILE, allow_loans: true, allow_cost_share: true });
  assert.equal(optedIn.loan_allowed, true);
  assert.equal(optedIn.cost_share_allowed, true);
});

test('org vs individual changes the minimum match floor', () => {
  const org = buildThesis(SAMPLE_VFD_PROFILE);
  const student = buildThesis(SAMPLE_STUDENT_PROFILE);
  assert.ok(Number.isFinite(org.min_match_score));
  assert.ok(Number.isFinite(student.min_match_score));
  // org floor is stricter (>=) than the individual floor
  assert.ok(org.min_match_score >= student.min_match_score);
});

test('a student profile is recognized as a student', () => {
  const th = buildThesis(SAMPLE_STUDENT_PROFILE);
  assert.equal(th.is_student, true);
});

test('an individual/student profile never acquires organizational applicant types from text noise', () => {
  // A high-school student whose free text mentions "community", "education",
  // "rural" must not become a government/school/farm applicant.
  const th = buildThesis({
    id: 'p_student',
    profile_type: 'high_school_student', // contains the substring "school" — must NOT be typed as an org
    applicant_types: ['high_school_student'],
    needs: ['education', 'housing'],
    sections: [{ title: 'narrative', body: 'active in her rural community; needs help with education costs' }],
    location: { state: 'TN' },
  });
  const orgTypes = ['government', 'school', 'farm', 'nonprofit', 'church', 'business', 'vfd'];
  for (const t of orgTypes) {
    assert.ok(!th.applicant_types.includes(t), `individual must not be typed as ${t} (got ${th.applicant_types.join(',')})`);
  }
  assert.equal(th.is_org, false, 'an individual profile is not an org');
  assert.ok(th.applicant_types.includes('individual') || th.applicant_types.includes('high_school_student'));
});

test('declared identity is NOT augmented by free-text — a student whose file mentions military/family is not a veteran/family applicant', () => {
  // Regression for the 2026-06-23 false-positive audit: blob-scanning added
  // "veteran" (from a parent's military service text) and "family" to a STUDENT,
  // pulling veteran-only grants into a student's pipeline.
  const th = buildThesis({
    id: 'p_student2',
    profile_type: 'student',
    applicant_types: ['student'],
    sections: [
      { title: 'family_life', body: 'her father is a military veteran and service member; lives with parents in a household' },
    ],
    location: { state: 'TN' },
  });
  assert.ok(!th.applicant_types.includes('veteran'), `student must not be typed veteran (got ${th.applicant_types.join(',')})`);
  assert.ok(!th.applicant_types.includes('family'), `student must not be typed family from text (got ${th.applicant_types.join(',')})`);
  assert.ok(th.applicant_types.includes('student'));
  assert.ok(th.applicant_types.includes('individual'), 'a person applicant is also an individual applicant');
});

test('an organization (church/nonprofit) is not over-broadened to farm/government/school by mission text', () => {
  // Regression: a church whose mission mentions education/community/family was
  // typed as farm/government/school/individual, matching Coral-Reef/Lunar grants.
  const th = buildThesis({
    id: 'p_church',
    profile_type: 'nonprofit',
    applicant_types: ['nonprofit', '501c3'],
    sections: [{ title: 'mission', body: 'education and community outreach to rural families; government partnerships; farm-area ministry' }],
    location: { state: 'OH' },
  });
  for (const t of ['farm', 'government', 'school', 'individual', 'family', 'veteran', 'student']) {
    assert.ok(!th.applicant_types.includes(t), `church must not be typed ${t} from text (got ${th.applicant_types.join(',')})`);
  }
  assert.ok(th.applicant_types.includes('nonprofit'));
  assert.equal(th.is_org, true);
});

test('an organization profile (VFD) still keeps its organizational applicant types', () => {
  const th = buildThesis({ id: 'p_vfd', type: 'vfd', state: 'TN', mission: 'rural community fire response' });
  assert.ok(th.applicant_types.includes('vfd'), 'explicit org type retained');
  assert.equal(th.is_org, true);
});

test('an empty profile still yields a usable, safe thesis (no crash)', () => {
  const th = buildThesis({});
  assert.equal(th.loan_allowed, false);
  assert.ok(Array.isArray(th.applicant_types));
  assert.ok(Array.isArray(th.needs));
  assert.equal(th.raw_profile_present, false);
});

test('needs are derived from whole-word evidence only — fragments cannot fabricate needs', () => {
  // Regression (2026-07-06): substring scanning fabricated phantom needs —
  // 'rent' ⊂ "parents"/"current" → housing, 'ets' ⊂ "targets"/"assets" →
  // military_transition, 'sud' ⊂ "sudden" → substance_recovery, 'coa' ⊂
  // "coach" → tuition. On the need-anchored scale phantom needs dilute the
  // coverage denominator AND spawn junk web queries.
  const th = buildThesis({
    id: 'p_org_fragments',
    profile_type: 'nonprofit',
    applicant_types: ['nonprofit'],
    sections: [{
      title: 'about',
      body: 'We coach mentors for parents in our community. Our current strategy sets targets, manages assets, and plans for sudden growth.',
    }],
    location: { state: 'TN' },
  });
  for (const junk of ['housing', 'military_transition', 'substance_recovery', 'tuition', 'medical', 'mental_health']) {
    assert.ok(!th.needs.includes(junk), `fragment must not derive need '${junk}' (got ${th.needs.join(',')})`);
  }
});

test('real whole-word need evidence still derives needs (recall preserved, incl. plurals)', () => {
  const th = buildThesis({
    id: 'p_real_needs',
    profile_type: 'individual',
    applicant_types: ['individual'],
    sections: [{
      title: 'situation',
      body: 'Behind on rent and utilities; needs food assistance, gas cards, and help with prescriptions.',
    }],
    location: { state: 'TN' },
  });
  for (const need of ['housing', 'energy', 'food', 'transportation', 'medication']) {
    assert.ok(th.needs.includes(need), `whole-word evidence must derive '${need}' (got ${th.needs.join(',')})`);
  }
});

test('bookkeeping tags in explicit needs/need_categories never seed the need scan', () => {
  const th = buildThesis({
    id: 'p_reserved_tags',
    profile_type: 'nonprofit',
    applicant_types: ['nonprofit'],
    needs: ['designated', 'synthetic', 'food assistance'],
    need_categories: ['individual'],
    location: { state: 'TN' },
  });
  assert.ok(th.needs.includes('food'), `explicit real need survives (got ${th.needs.join(',')})`);
  assert.ok(!th.needs.includes('designated'), 'reserved tag is not a need');
  assert.ok(!th.needs.includes('synthetic'), 'reserved tag is not a need');
});

test('a structurally-declared farmer (occupation.farmer flag) keeps the farm bucket through the person-identity guard', () => {
  // The Lowndes-County beginning-farmer class: an INDIVIDUAL whose occupation
  // section deliberately declares farmer=true is an agricultural producer —
  // stripping 'farm' planner-excluded USDA conservation/RD lanes entirely.
  const th = buildThesis({
    id: 'p_farmer_flag',
    primary_type: 'individual',
    sections: [{ section_key: 'occupation', data: { farmer: true, small_business_owner: true } }],
    needs: ['agriculture', 'legal'],
    location: { state: 'AL', city: 'Hayneville', county: 'Lowndes County' },
  });
  assert.ok(th.applicant_types.includes('individual'), 'still an individual');
  assert.ok(th.applicant_types.includes('farm'), `farm bucket preserved (got ${th.applicant_types.join(',')})`);
});

test('the farm bucket comes ONLY from the structured flag — free-text farm words never promote an individual', () => {
  const th = buildThesis({
    id: 'p_farm_text_only',
    primary_type: 'individual',
    mission: 'I volunteer at the farmers market and love agriculture.',
    needs: ['food'],
    location: { state: 'AL' },
  });
  assert.ok(!th.applicant_types.includes('farm'), 'no farm bucket from prose');
});

test('kinship/grandfamily language derives the caregiving need (the grandfamilies class)', () => {
  const th = buildThesis({
    id: 'p_kinship',
    primary_type: 'senior',
    description: 'Widowed grandmother raising two grandchildren; seeking kinship care support.',
    location: { state: 'NM', city: 'Las Cruces' },
  });
  assert.ok(th.needs.includes('caregiving'), `kinship text derives caregiving (got ${th.needs.join(',')})`);
});

test('exact-mapped declared types are authoritative — the synonym pass never widens them by substring', () => {
  // 'homeschool_family' ⊃ "school" was promoting a homeschool FAMILY into the
  // org school bucket (classroom-teacher funding like DonorsChoose surfaced
  // for a family that can never use it).
  const th = buildThesis({
    id: 'p_homeschool_types',
    primary_type: 'homeschool_family',
    needs: ['curriculum'],
    location: { state: 'CA', city: 'Eureka' },
  });
  assert.ok(th.applicant_types.includes('family'), 'family bucket present');
  assert.ok(th.applicant_types.includes('individual'), 'individual bucket present');
  assert.ok(!th.applicant_types.includes('school'), `no org school bucket from a substring (got ${th.applicant_types.join(',')})`);
});
