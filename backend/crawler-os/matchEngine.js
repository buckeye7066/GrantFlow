// crawler-os/matchEngine.js
//
// Compatibility facade for Crawler OS callers.
//
// Doctrine rule: backend/services/matchEngine.js remains the canonical source for
// normalization, evidence, eligibility, geography, and confidence. The need-first
// adapter then enforces the owner-facing product rule that a direct source must
// address a profile's actual funding purpose. Crawler OS maps the result back to
// its lower-case storage contract.

import {
  computeMatchDecision as computeCanonicalMatchDecision,
  MATCHER_VERSION,
} from '../services/matchEngine.js';
import {
  applyNeedFirstScoring,
  isAcceptLevelScore,
  NEED_FIRST_SCORING_VERSION,
} from '../services/matching/needFirstScoringAdapter.js';
import { MATCH_DECISION, OPPORTUNITY_KIND } from './contract.js';

export { MATCHER_VERSION };
export const SCORING_POLICY_VERSION = NEED_FIRST_SCORING_VERSION;

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

// Opportunity-side applicant-type mapping is deliberately restrictive. Profile
// types may widen to their parent entity type, but a veterans-only opportunity
// must never widen to every individual.
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
 * Does this pair belong in a run's recommendation list?
 * Direct funding requires ACCEPT. A directory locator is separately reachable
 * at REVIEW because it is a place to search, not an award.
 */
export function isRecommendable(opportunity, decision) {
  if (decision === MATCH_DECISION.ACCEPT) return true;
  const isDirectoryLocator = String(opportunity?.kind ?? '').toUpperCase() === OPPORTUNITY_KIND.DIRECTORY;
  return isDirectoryLocator && decision === MATCH_DECISION.REVIEW;
}

/**
 * Score an OS-normalized opportunity against one thesis.
 */
export function computeMatchDecision(opportunity, thesis = {}, opts = {}) {
  const profile = opts.profileRow ?? thesisToCanonicalProfile(thesis, opts);
  const opp = opportunityToCanonicalOpportunity(opportunity);
  const sections = opts.profileSections ?? opts.sections ?? null;
  const signals = opts.signals ?? null;

  const canonicalBase = computeCanonicalMatchDecision(profile, opp, {
    profileSections: sections,
    signals,
    preferenceSignals: opts.preferenceSignals,
  });
  const canonical = applyNeedFirstScoring({
    canonical: canonicalBase,
    profileContext: {
      profile,
      sections: sections ?? {},
      signals,
      profileNorm: opts.profileNorm ?? null,
    },
    opportunity: opp,
  });

  const score = Number.isFinite(Number(canonical?.score))
    ? Math.round(Number(canonical.score))
    : 0;
  let decision = toCrawlerDecision(canonical?.decision);
  const warnings = collectWarnings(canonical);

  // A program/listing with no direct apply target cannot be an apply-now ACCEPT.
  // Directory locators are exempt because their contract is the information link.
  const hasApplyUrl = Boolean(opportunity?.apply_url ?? opportunity?.application_url);
  const isDirectoryLocator = String(opportunity?.kind ?? '').toUpperCase() === OPPORTUNITY_KIND.DIRECTORY;
  if (!hasApplyUrl && !isDirectoryLocator && decision === MATCH_DECISION.ACCEPT) {
    decision = MATCH_DECISION.REVIEW;
    warnings.push('no direct application URL — strong fit held at REVIEW until an apply target is known');
  }

  // A directory is a pointer, never direct funding.
  if (isDirectoryLocator && decision === MATCH_DECISION.ACCEPT) {
    decision = MATCH_DECISION.REVIEW;
    warnings.push('directory locator surfaced as a pointer to look through, not a strong match');
  }
  // The need-first overlay's resource routing usually holds a directory at
  // REVIEW before this facade ever sees an ACCEPT — but the demotion WARNING
  // is part of the locator contract ("Recommended ≠ strong match"): an
  // ACCEPT-LEVEL locator must SAY it is a pointer, whichever layer held it at
  // REVIEW. Keyed on the canonical accept band via the adapter (this package
  // is deny-listed from importing the thresholds directly).
  if (isDirectoryLocator && decision === MATCH_DECISION.REVIEW && isAcceptLevelScore(score) &&
      !warnings.some((w) => /pointer to look through/i.test(String(w ?? '')))) {
    warnings.push('directory locator surfaced as a pointer to look through, not a strong match');
  }

  return {
    profile_id: thesis?.profile_id ?? profile?.id ?? null,
    opportunity_id: opportunity?.id ?? opp?.id ?? null,
    match_score: score,
    // The canonical engine already computes confidence from evidence
    // completeness. Keep it profile-scoped beside the score so persistence and
    // read paths can distinguish a measured value from an unknown one.
    match_confidence: typeof canonical?.confidence === 'number' && Number.isFinite(canonical.confidence)
      ? Math.round(canonical.confidence)
      : null,
    decision,
    match_explain: {
      matched_profile_type: Boolean(canonical?.match_explain?.matchedSignals?.includes?.('applicant_type')),
      matched_location: describeLocationMatch(canonical),
      eligibility_fit: canonical?.eligible ?? 'maybe',
      why: canonical?.explanation ?? `Canonical ${MATCHER_VERSION} / ${NEED_FIRST_SCORING_VERSION} decision: ${String(canonical?.decision ?? 'REVIEW')}`,
      warnings,
      matched_needs: canonical?.matchedNeeds ?? [],
      matched_profile_facts: canonical?.matched_profile_facts ?? [],
      missing_eligibility_fields: canonical?.missingEligibilityFields ?? [],
      dataPointEvidence: canonical?.match_explain?.dataPointEvidence ?? {},
      score_breakdown: canonical?.match_explain?.scoreBreakdown ?? canonical?.match_explain?.score_breakdown ?? {},
      need_first_policy: canonical?.match_explain?.needFirstPolicy ?? null,
      scoring_policy_version: NEED_FIRST_SCORING_VERSION,
      canonical_decision: canonical?.decision ?? 'REVIEW',
      canonical_score: score,
      matcher_version: canonical?.matcherVersion ?? MATCHER_VERSION,
      evaluated_at: canonical?.evaluatedAt ?? new Date().toISOString(),
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
    age: Number.isFinite(Number(thesis.age)) ? Number(thesis.age) : null,
    foster_youth: thesis.has_foster_indicator === true,
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
  const isNational = Boolean(geography.national) || states.some((state) => /^national|nationwide$/i.test(state));
  const description = [
    opportunity.summary,
    applicantTypes.filter((value) => value !== '*').length
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
    // The sponsor's NAME is deliberately NOT a keyword: keywords feed the
    // need-first TARGETING text, and a funder identity is not a targeting
    // statement (#1086 identity-vs-topic). With it in, "U.S. Department of
    // Agriculture" read as an agriculture/farming PROFESSION restriction and
    // hard-rejected USDA Community Facilities — a program that serves
    // nonprofits — for every non-farm profile. The sponsor still reaches the
    // canonical engine through its own `sponsor`/`funder` fields.
    keywords: uniqueStrings([
      ...needs,
      ...applicantTypes,
      ...allowedTypes,
      opportunity.source_id,
      opportunity.kind,
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
    opportunity_kind: isDirectory ? 'DIRECTORY' : (opportunity.kind ?? null),
    opportunity_type: isDirectory ? 'directory' : 'grant',
    funding_type: opportunity.funding_type ?? null,
    source: opportunity.source_id ?? null,
    record_origin: 'crawler_os',
    trust_tier: opportunity.trust_tier ?? null,
    reality_status: opportunity.reality_status ?? null,
    verification: opportunity.verification ?? null,
    eligibility_text: opportunity.eligibility_text ?? null,
    page_fact_eligibility_bullets: Array.isArray(opportunity.eligibility_bullets)
      ? opportunity.eligibility_bullets
      : [],
    page_fact_schema_version: opportunity.page_fact_schema_version ?? null,
    field_provenance: opportunity.field_provenance ?? null,
  };
}

function choosePrimaryApplicantType(applicantTypes) {
  const priority = [
    'vfd', 'church', 'ministry', 'nonprofit', 'school', 'government',
    'business', 'farm', 'student', 'veteran', 'family', 'individual',
  ];
  return priority.find((type) => applicantTypes.includes(type)) ?? applicantTypes[0] ?? null;
}

function expandAllowedEntityTypes(applicantTypes) {
  const expanded = [];
  for (const type of applicantTypes) {
    if (type === '*') continue;
    expanded.push(...(APPLICANT_TYPE_TO_CANONICAL_ALLOWED[type] ?? [type]));
  }
  return uniqueStrings(expanded);
}

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
    const text = String(value ?? '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  if (out.some((text) => /^Opportunity is for .* but profile is /i.test(text))) {
    out.push('Applicant type mismatch');
  }
  return out;
}

function describeLocationMatch(canonical) {
  const signals = canonical?.match_explain?.matchedSignals ?? [];
  const geo = signals.find((signal) => String(signal).startsWith('geo:'));
  if (geo) return String(geo).slice(4);
  const breakdownGeo = canonical?.match_explain?.scoreBreakdown?.geo;
  if (Number.isFinite(Number(breakdownGeo)) && Number(breakdownGeo) > 0) return 'partial';
  return 'unknown';
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value ?? '').trim().toLowerCase();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function stripWildcard(values = []) {
  return values.filter((value) => value !== '*');
}

export default {
  computeMatchDecision,
  WEIGHTS,
  MATCHER_VERSION,
  SCORING_POLICY_VERSION,
};
