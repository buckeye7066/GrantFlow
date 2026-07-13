// crawler-os/matchEngine.js
//
// Compatibility facade for Crawler OS callers.
//
// Doctrine rule: backend/services/matchEngine.js is the only place allowed to
// make ACCEPT / REVIEW / REJECT decisions. Crawler OS still persists its own
// profile_opportunity_matches rows and uses lower-case OS decision tokens, so
// this module adapts the OS thesis/opportunity shapes into the canonical engine
// and maps the canonical output back to the OS storage contract.

import {
  computeMatchDecision as computeCanonicalMatchDecision,
  MATCHER_VERSION,
} from '../services/matchEngine.js';
import { MATCH_DECISION, OPPORTUNITY_KIND } from './contract.js';

export { MATCHER_VERSION };

export const WEIGHTS = Object.freeze({
  canonical_match_engine: 100,
});

const APPLICANT_TYPE_TO_PROFILE_TYPE = Object.freeze({
  vfd: 'volunteer_fire_department',
  church: 'church',
  ministry: 'ministry',
  nonprofit: 'nonprofit',
  school: 'school',
  government: 'government',
  business: 'business',
  farm: 'business',
  student: 'student',
  veteran: 'veteran',
  family: 'family',
  individual: 'individual',
});

const APPLICANT_TYPE_TO_CANONICAL_ALLOWED = Object.freeze({
  vfd: ['nonprofit', 'organization'],
  church: ['nonprofit', 'organization'],
  ministry: ['nonprofit', 'organization'],
  nonprofit: ['nonprofit', 'organization'],
  school: ['organization'],
  government: ['organization'],
  business: ['business'],
  farm: ['business'],
  student: ['student', 'individual'],
  veteran: ['veteran', 'individual'],
  family: ['individual'],
  individual: ['individual'],
});

// OPPORTUNITY-side applicant-type → allowed entity types. This map must be
// RESTRICTIVE, unlike the profile-side map above: profile-side, "a veteran IS
// an individual" correctly widens what a veteran can apply to; opportunity-side
// the same expansion means "a veterans-only program allows any individual" —
// which is how DOL TAP / Boots to Business surfaced as ACCEPT for an 18-year-old
// non-military student. Military-affiliation buckets all collapse to 'veteran'
// so the normalizer's requiresVeteran gate can fire; population buckets that
// merely DESCRIBE the audience (senior, caregiver) stay reachable as
// individuals — relevance is the scorer's job, eligibility is this map's.
const OPPORTUNITY_APPLICANT_TYPE_TO_ALLOWED = Object.freeze({
  vfd: ['nonprofit', 'organization'],
  church: ['nonprofit', 'organization'],
  ministry: ['nonprofit', 'organization'],
  nonprofit: ['nonprofit', 'organization'],
  school: ['organization'],
  government: ['organization'],
  business: ['business'],
  farm: ['business'],
  student: ['student'],
  veteran: ['veteran'],
  active_duty: ['veteran'],
  guard_reserve: ['veteran'],
  transitioning_service_member: ['veteran'],
  military_spouse: ['veteran'],
  military: ['veteran'],
  family: ['individual'],
  individual: ['individual'],
  senior: ['individual'],
  caregiver: ['individual'],
});

/**
 * Score an OS-normalized opportunity against one OS thesis using the canonical
 * GrantFlow matcher.
 *
 * @param {object} opportunity Crawler OS canonical Opportunity
 * @param {object} thesis      profileIntelligence.buildThesis output
 * @param {object} [opts]
 * @returns {{ profile_id:string|null, opportunity_id:string, match_score:number,
 *   decision:string, match_explain:object }}
 */
export function computeMatchDecision(opportunity, thesis = {}, opts = {}) {
  const profile = thesisToCanonicalProfile(thesis, opts);
  const opp = opportunityToCanonicalOpportunity(opportunity);
  const canonical = computeCanonicalMatchDecision(profile, opp, {
    profileSections: opts.profileSections ?? opts.sections ?? null,
    signals: opts.signals ?? null,
    preferenceSignals: opts.preferenceSignals,
  });

  const score = Number.isFinite(Number(canonical?.score)) ? Math.round(Number(canonical.score)) : 0;
  let decision = toCrawlerDecision(canonical?.decision);
  const warnings = collectWarnings(canonical);
  // A PROGRAM/listing row with no direct apply_url cannot be applied to as-is:
  // the reality gate stores such rows for REVIEW, and the match decision must
  // not out-promote the row's own lifecycle — however strong the topical fit,
  // a human (or the URL-rescue lane) has to produce an application target
  // before this can be an apply-now ACCEPT.
  //
  // DIRECTORY locators are exempt: a locator's contract IS its info link —
  // every directory adapter sets apply_url null BY DESIGN (honesty rule: a
  // pointer, not an application). Demoting them here locked the whole locator
  // fleet (county_city, 211, state portals, disease-support) out of the
  // recommendation list from #886 onward — the 07-08 county lane shipped
  // structurally unreachable (Amy hyperlocal_recall_miss ×50/day).
  const hasApplyUrl = Boolean(opportunity?.apply_url ?? opportunity?.application_url);
  const isDirectoryLocator = String(opportunity?.kind ?? '').toUpperCase() === OPPORTUNITY_KIND.DIRECTORY;
  if (!hasApplyUrl && !isDirectoryLocator && decision === 'accept') {
    decision = 'review';
    warnings.push('no direct application URL — strong fit held at REVIEW until an apply target is known');
  }

  return {
    profile_id: thesis?.profile_id ?? profile?.id ?? null,
    opportunity_id: opportunity?.id ?? opp?.id ?? null,
    match_score: score,
    decision,
    match_explain: {
      matched_profile_type: Boolean(canonical?.match_explain?.matchedSignals?.includes?.('applicant_type')),
      matched_location: describeLocationMatch(canonical),
      eligibility_fit: canonical?.eligible ?? 'maybe',
      why: canonical?.explanation ?? `Canonical ${MATCHER_VERSION} decision: ${String(canonical?.decision ?? 'REVIEW')}`,
      warnings,
      matched_needs: canonical?.matchedNeeds ?? [],
      matched_profile_facts: canonical?.matched_profile_facts ?? [],
      missing_eligibility_fields: canonical?.missingEligibilityFields ?? [],
      score_breakdown: canonical?.match_explain?.scoreBreakdown ?? canonical?.match_explain?.score_breakdown ?? {},
      canonical_decision: canonical?.decision ?? 'REVIEW',
      canonical_score: score,
      matcher_version: canonical?.matcherVersion ?? MATCHER_VERSION,
      evaluated_at: canonical?.evaluatedAt ?? null,
    },
  };
}

function thesisToCanonicalProfile(thesis = {}, opts = {}) {
  const applicantTypes = stripWildcard(uniqueStrings(thesis.applicant_types));
  const primary = choosePrimaryApplicantType(applicantTypes);
  const profileType = primary ? (APPLICANT_TYPE_TO_PROFILE_TYPE[primary] ?? primary) : null;
  const canonicalApplicantTypes = expandAllowedEntityTypes([profileType, ...applicantTypes]);
  const location = thesis.location ?? {};

  return {
    id: thesis.profile_id ?? null,
    name: thesis.name ?? thesis.display_name ?? null,
    applicant_type: profileType,
    primary_type: profileType,
    profile_type: profileType,
    type: profileType,
    applicant_types: applicantTypes,
    applicantTypes: new Set(uniqueStrings([profileType, ...applicantTypes, ...canonicalApplicantTypes])),
    needs: uniqueStrings(thesis.needs),
    need_categories: uniqueStrings(thesis.needs),
    state: location.state ?? thesis.state ?? null,
    county: location.county ?? thesis.county ?? null,
    city: location.city ?? thesis.city ?? null,
    zip: location.zip ?? thesis.zip ?? null,
    location,
    school: thesis.school ?? null,
    allow_loans: Boolean(thesis.loan_allowed),
    allow_cost_share: Boolean(thesis.cost_share_allowed),
    tags: uniqueStrings([...(thesis.keywords ?? []), ...(thesis.needs ?? []), ...applicantTypes]),
    sections: opts.sections ?? null,
  };
}

function opportunityToCanonicalOpportunity(opportunity = {}) {
  const applicantTypes = stripWildcard(uniqueStrings(opportunity.applicant_types));
  const allowedTypes = expandOpportunityAllowedTypes(applicantTypes);
  const needs = uniqueStrings(opportunity.need_categories);
  const geography = opportunity.geography ?? {};
  const states = uniqueStrings(geography.states);
  const isNational = Boolean(geography.national) || states.some((s) => /^national|nationwide$/i.test(s));
  const description = [
    opportunity.summary,
    applicantTypes.filter((x) => x !== '*').length
      ? `Eligible applicants: ${uniqueStrings([...applicantTypes, ...allowedTypes]).join(', ')}`
      : '',
    needs.length ? `Funding needs: ${needs.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const url = opportunity.apply_url ?? opportunity.info_url ?? opportunity.evidence?.url ?? null;
  const kind = String(opportunity.kind ?? '').toUpperCase();
  const isDirectory = kind === OPPORTUNITY_KIND.DIRECTORY || kind === OPPORTUNITY_KIND.PAST_AWARD_INTEL;

  return {
    id: opportunity.id ?? null,
    title: opportunity.title ?? null,
    sponsor: opportunity.sponsor ?? null,
    funder: opportunity.sponsor ?? null,
    description,
    summary: opportunity.summary ?? null,
    entity_types_allowed: allowedTypes,
    need_types_supported: needs,
    categories: uniqueStrings([...needs, ...allowedTypes, ...applicantTypes]),
    eligibility_bullets: applicantTypes.length
      ? [`Eligible applicants: ${uniqueStrings([...applicantTypes, ...allowedTypes]).join(', ')}`]
      : [],
    keywords: uniqueStrings([
      ...needs,
      ...applicantTypes,
      ...allowedTypes,
      opportunity.source_id,
      opportunity.kind,
      opportunity.sponsor,
    ]),
    state: isNational ? 'nationwide' : (states[0] ?? null),
    is_national: isNational,
    geo_county: uniqueStrings(geography.counties)[0] ?? null,
    geo_zip: uniqueStrings(geography.zips)[0] ?? null,
    amount_min: opportunity.funding?.amount_min ?? null,
    amount_max: opportunity.funding?.amount_max ?? null,
    is_loan: Boolean(opportunity.funding?.is_loan),
    requires_match: Boolean(opportunity.funding?.requires_cost_share),
    deadline: opportunity.deadline ?? null,
    deadline_type: opportunity.is_rolling ? 'rolling' : null,
    application_url: opportunity.apply_url ?? null,
    apply_url: opportunity.apply_url ?? null,
    source_url: url,
    url,
    type: isDirectory ? 'DIRECTORY' : (opportunity.kind ?? null),
    opportunity_type: isDirectory ? 'directory' : 'grant',
    source: opportunity.source_id ?? null,
    record_origin: 'crawler_os',
    trust_tier: opportunity.trust_tier ?? null,
    reality_status: opportunity.reality_status ?? null,
    verification: opportunity.verification ?? null,
  };
}

function choosePrimaryApplicantType(applicantTypes) {
  const priority = [
    'vfd', 'church', 'ministry', 'nonprofit', 'school', 'government',
    'business', 'farm', 'student', 'veteran', 'family', 'individual',
  ];
  return priority.find((t) => applicantTypes.includes(t)) ?? applicantTypes[0] ?? null;
}

function expandAllowedEntityTypes(applicantTypes) {
  const expanded = [];
  for (const type of applicantTypes) {
    if (type === '*') continue;
    expanded.push(...(APPLICANT_TYPE_TO_CANONICAL_ALLOWED[type] ?? [type]));
  }
  return uniqueStrings(expanded);
}

// Opportunity-side (restrictive) counterpart — see OPPORTUNITY_APPLICANT_TYPE_TO_ALLOWED.
function expandOpportunityAllowedTypes(applicantTypes) {
  const expanded = [];
  for (const type of applicantTypes) {
    if (type === '*') continue;
    expanded.push(...(OPPORTUNITY_APPLICANT_TYPE_TO_ALLOWED[type] ?? [type]));
  }
  return uniqueStrings(expanded);
}

function toCrawlerDecision(decision) {
  const upper = String(decision ?? '').toUpperCase();
  if (upper === 'ACCEPT') return MATCH_DECISION.ACCEPT;
  if (upper === 'REJECT') return MATCH_DECISION.REJECT;
  return MATCH_DECISION.REVIEW;
}

function collectWarnings(canonical) {
  const out = [];
  for (const value of [
    ...(canonical?.reasons ?? []),
    ...(canonical?.ineligibilityReasons ?? []),
    ...(canonical?.match_explain?.scoreCaps ?? []),
  ]) {
    const s = String(value ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.some((s) => /^Opportunity is for .* but profile is /i.test(s))) {
    out.push('Applicant type mismatch');
  }
  return out;
}

function describeLocationMatch(canonical) {
  const signals = canonical?.match_explain?.matchedSignals ?? [];
  const geo = signals.find((sig) => String(sig).startsWith('geo:'));
  if (geo) return String(geo).slice(4);
  const breakdownGeo = canonical?.match_explain?.scoreBreakdown?.geo;
  if (Number.isFinite(Number(breakdownGeo)) && Number(breakdownGeo) > 0) return 'partial';
  return 'unknown';
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const s = String(value ?? '').trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function stripWildcard(values = []) {
  return values.filter((value) => value !== '*');
}

export default { computeMatchDecision, WEIGHTS, MATCHER_VERSION };
