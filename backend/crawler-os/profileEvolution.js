// crawler-os/profileEvolution.js
//
// Governed learning signal for the OS crawler. This does NOT let the crawler
// ingest arbitrary web junk. It turns a run into a deterministic "coverage gap"
// signature: what kind of profile this is, what sources were tried, what was
// thin, and which verified source lanes should be considered next.

import { CRAWLER_OUTCOME } from './contract.js';
import { getSource } from './sourceRegistry.js';

const MIN_SELECTED_SOURCES = 3;

const LANE_RULES = Object.freeze([
  {
    lane_id: 'survivor_benefits',
    when: ({ needSet }) => needSet.has('survivor_benefits'),
    reason: 'Profile signals survivor or widow benefits.',
    source_types: ['Social Security survivor benefits', 'DOL/industry survivor benefits', 'state benefits portals', 'county aging and family-service directories'],
  },
  {
    lane_id: 'dementia_caregiving',
    when: ({ needSet }) => needSet.has('caregiving') || needSet.has('medical'),
    reason: 'Profile signals dementia, disability, health, or caregiving support.',
    source_types: ['federal dementia service locators', 'state aging/disability agencies', 'Medicaid waiver and long-term-care portals', 'reputable disease-specific assistance directories'],
  },
  {
    lane_id: 'veteran_entrepreneurship',
    when: ({ applicantSet, needSet }) =>
      (needSet.has('veteran_startup') || applicantSet.has('veteran') || needSet.has('veterans')) &&
      (needSet.has('startup') || needSet.has('capital') || needSet.has('operations') || needSet.has('equipment')),
    reason: 'Profile signals military background plus business startup or operations needs.',
    source_types: ['SBA veteran business resources', 'Veterans Business Outreach Centers', 'state SBDC programs', 'local economic-development partners'],
  },
  {
    lane_id: 'small_business_startup',
    when: ({ applicantSet, needSet }) =>
      applicantSet.has('business') || needSet.has('startup') || needSet.has('capital') || needSet.has('operations'),
    reason: 'Profile signals small-business startup, capital, or operating support.',
    source_types: ['SBA resource pages', 'state small-business portals', 'SBDC funding directories', 'CDFI and microenterprise directories with loan gating'],
  },
  {
    lane_id: 'state_local_benefits',
    when: ({ needSet }) => ['housing', 'food', 'energy', 'medical', 'caregiving'].some((n) => needSet.has(n)),
    reason: 'Profile signals household benefit needs that are often state, county, or local.',
    source_types: ['state benefits portals', '211 directories', 'county human-services directories', 'local nonprofit assistance directories'],
  },
]);

function sourceIsDirectory(sourceId) {
  return Boolean(getSource(sourceId)?.directory);
}

function uniq(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function sorted(values) {
  return uniq(values).sort();
}

function buildCoverageClass({ stored, storedDirect }) {
  if (stored <= 0) return 'zero';
  if (storedDirect <= 0) return 'directory_only';
  return 'direct_funder_present';
}

function recommendedLanes(thesis) {
  const applicantSet = new Set(thesis?.applicant_types ?? []);
  const needSet = new Set(thesis?.needs ?? []);
  return LANE_RULES
    .filter((rule) => rule.when({ applicantSet, needSet, thesis }))
    .map((rule) => ({
      lane_id: rule.lane_id,
      reason: rule.reason,
      source_types: rule.source_types,
      promotion_rule: 'Verify source reality, add a registry row plus adapter, add a profile regression test, then promote.',
    }));
}

/**
 * buildEvolutionSignals - summarize how this profile should teach the crawler.
 *
 * Empty profile fields remain neutral: they appear as "helpful to add" context,
 * never as negative scoring.
 */
export function buildEvolutionSignals({ thesis = {}, plan = {}, summaries = [], zeroReason = null } = {}) {
  const selected = plan.selected_source_ids ?? [];
  const storedSources = summaries.filter((s) => Number(s.stored || 0) > 0).map((s) => s.source_id);
  const storedDirectSources = storedSources.filter((id) => !sourceIsDirectory(id));
  const emptySources = summaries
    .filter((s) => s.outcome === CRAWLER_OUTCOME.EMPTY || s.reason === 'no_candidates_stored')
    .map((s) => s.source_id);
  const skippedSources = summaries
    .filter((s) => s.outcome === CRAWLER_OUTCOME.SKIPPED)
    .map((s) => ({ source_id: s.source_id, reason: s.reason }));
  const failedSources = summaries
    .filter((s) => [CRAWLER_OUTCOME.FETCH_ERROR, CRAWLER_OUTCOME.PARSE_ERROR, CRAWLER_OUTCOME.ERROR, CRAWLER_OUTCOME.BLOCKED].includes(s.outcome))
    .map((s) => ({ source_id: s.source_id, outcome: s.outcome, reason: s.reason }));

  const missingProfileFields = [];
  if (!thesis.location?.state) missingProfileFields.push('location.state');
  if (!thesis.needs?.length) missingProfileFields.push('need_categories');
  if (!thesis.applicant_types?.length) missingProfileFields.push('applicant_types');

  const coverageClass = buildCoverageClass({
    stored: storedSources.length,
    storedDirect: storedDirectSources.length,
  });

  const lanes = recommendedLanes(thesis);
  const needsReview =
    Boolean(zeroReason) ||
    selected.length < MIN_SELECTED_SOURCES ||
    (coverageClass === 'directory_only' && thesis.is_org === true);

  return {
    event_type: needsReview ? 'profile_coverage_gap' : 'profile_coverage_signal',
    learnable: needsReview || lanes.length > 0,
    profile_signature: {
      profile_id: thesis.profile_id ?? null,
      applicant_types: sorted(thesis.applicant_types ?? []),
      needs: sorted(thesis.needs ?? []),
      state: thesis.location?.state ?? null,
      is_org: Boolean(thesis.is_org),
    },
    coverage: {
      class: coverageClass,
      selected_source_count: selected.length,
      stored_source_count: storedSources.length,
      stored_direct_source_count: storedDirectSources.length,
      zero_result_reason: zeroReason,
    },
    sources: {
      selected_source_ids: selected,
      stored_source_ids: storedSources,
      stored_direct_source_ids: storedDirectSources,
      empty_source_ids: sorted(emptySources),
      skipped_sources: skippedSources,
      failed_sources: failedSources,
    },
    missing_profile_fields: missingProfileFields,
    recommended_source_lanes: lanes,
  };
}

export default { buildEvolutionSignals };
