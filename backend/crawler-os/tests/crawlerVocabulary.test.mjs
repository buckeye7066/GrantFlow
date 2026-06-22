// tests/crawlerVocabulary.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agencyLooksLike, buildCrawlerQueries, inferCandidateProfile, inferFundingFlags,
} from '../crawlerVocabulary.js';
import { buildThesis } from '../profileIntelligence.js';
import { getSource } from '../sourceRegistry.js';
import { SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';

test('buildCrawlerQueries expands a profile thesis into multiple focused source queries', () => {
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const source = getSource('fema_afg');
  const queries = buildCrawlerQueries(thesis, source, { limit: 4 });
  assert.ok(queries.length > 1, 'crawler should not depend on one brittle keyword string');
  assert.ok(queries.some((q) => /firefighter|firefighters|SAFER|Assistance to Firefighters/i.test(q)));
  assert.ok(queries.some((q) => /equipment|emergency/i.test(q)));
});

test('inferCandidateProfile extracts needs and applicant types from source row text', () => {
  const inferred = inferCandidateProfile({
    title: 'Volunteer Fire Equipment and Rescue Apparatus Grant',
    sponsor: 'FEMA',
    summary: 'Funding for fire departments and first responders.',
  }, getSource('grants_gov'));
  assert.ok(inferred.need_categories.includes('equipment'));
  assert.ok(inferred.need_categories.includes('emergency'));
  assert.ok(inferred.applicant_types.includes('vfd'));
});

test('inferCandidateProfile falls back to source taxonomy when a row is too sparse', () => {
  const inferred = inferCandidateProfile({ title: 'Federal Opportunity' }, getSource('fema_afg'));
  assert.ok(inferred.need_categories.includes('equipment'));
  assert.ok(inferred.applicant_types.includes('vfd'));
});

test('inferFundingFlags flags a loan-PRIMARY instrument (loan named in title, no grant)', () => {
  const flags = inferFundingFlags({ title: 'Business & Industry Guaranteed Loan Program' });
  assert.equal(flags.is_loan, true);
});

test('inferFundingFlags does NOT flag a combined "Loan and Grant" program as a loan (a grant is available)', () => {
  // Flagging this as a loan would hard-reject it for default profiles and hide a
  // grant the applicant can actually pursue.
  const flags = inferFundingFlags({
    title: 'Community Facilities Direct Loan and Grant Program',
    summary: 'Applicants must provide matching funds / local match.',
  });
  assert.equal(flags.is_loan, false);
});

test('inferFundingFlags never turns a passing mention of "loan" into a rejection (recall guard)', () => {
  // Regression: a real grant whose summary merely references a loan must stay a grant.
  const flags = inferFundingFlags({
    title: 'Community Arts Grant',
    summary: 'Unlike a loan, this grant requires no repayment.',
  });
  assert.equal(flags.is_loan, false);
});

test('inferFundingFlags does NOT infer cost-share from unreliable prose (recall guard)', () => {
  // "encouraged where possible" and "no match required" are NOT requirements.
  assert.equal(inferFundingFlags({ title: 'Rural Health Outreach Grant', summary: 'Applicants are encouraged to leverage matching funds where possible.' }).requires_cost_share, false);
  assert.equal(inferFundingFlags({ title: 'Volunteer Fire Equipment Grant', summary: 'Supports turnout gear and apparatus; no match required.' }).requires_cost_share, false);
});

test('inferFundingFlags honors an explicit/structured cost-share flag from defaults', () => {
  // A production adapter that reads the structured Grants.gov field can still set it.
  assert.equal(inferFundingFlags({ title: 'X Grant' }, { requires_cost_share: true }).requires_cost_share, true);
  assert.equal(inferFundingFlags({ title: 'X Loan' }, { is_loan: true }).is_loan, true);
});

test('agencyLooksLike can match agencyCode/title signals, not just sponsor text', () => {
  const ok = agencyLooksLike({ title: 'Assistance to Firefighters Grant', agency_code: 'DHS-FEMA', sponsor: 'Department of Homeland Security' }, [/\bFEMA\b/i, /assistance to firefighters/i]);
  assert.equal(ok, true);
});
