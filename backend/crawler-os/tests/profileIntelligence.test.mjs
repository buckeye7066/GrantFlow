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

test('an empty profile still yields a usable, safe thesis (no crash)', () => {
  const th = buildThesis({});
  assert.equal(th.loan_allowed, false);
  assert.ok(Array.isArray(th.applicant_types));
  assert.ok(Array.isArray(th.needs));
  assert.equal(th.raw_profile_present, false);
});
