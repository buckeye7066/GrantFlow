// crawler-os/sourceRegistry.js
//
// THE data-driven registry of real funding sources. One row per source. The
// planner reads this; adapters are matched to rows by source_id. Every URL here
// is a real, public endpoint. Growing the funding universe = adding rows here +
// a thin adapter, never new bespoke crawler logic.
//
// Pure data. No I/O.

import { TRUST_TIER, OPPORTUNITY_KIND } from './contract.js';

/**
 * Source row fields:
 *  - source_id        stable slug (also the adapter key)
 *  - name             human label
 *  - source_type      'api' | 'html' | 'directory' | 'rss'
 *  - trust_tier       TRUST_TIER.*
 *  - base_url         real public base URL
 *  - directory        true if this is a locator/list, not a direct-apply source
 *  - loan_allowed     does this source ever surface loans (gated again per profile)
 *  - cost_share_allowed
 *  - applicant_types  buckets this source serves ('*' = broad)
 *  - need_categories  needs this source covers ('*' = broad)
 *  - geography        { national, states }
 *  - default_kinds    the kind(s) candidates from this source default to
 *  - crawler_method   'api'|'html'|'rss'|'pdf'
 *  - requires_env     env keys required (honest skip if absent), or []
 *  - refresh_frequency_days  scheduler cadence hint
 *  - priority_score   planner tie-breaker
 */
export const SOURCES = Object.freeze([
  {
    source_id: 'grants_gov',
    name: 'Grants.gov (U.S. federal grants)',
    source_type: 'api',
    trust_tier: TRUST_TIER.OFFICIAL_API,
    base_url: 'https://www.grants.gov',
    directory: false,
    loan_allowed: false,
    cost_share_allowed: true,
    applicant_types: ['nonprofit', 'school', 'government', 'business', 'vfd', 'farm'],
    need_categories: ['*'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'api',
    requires_env: [],
    refresh_frequency_days: 1,
    priority_score: 100,
  },
  {
    source_id: 'sam_gov',
    name: 'SAM.gov assistance listings',
    source_type: 'api',
    trust_tier: TRUST_TIER.OFFICIAL_API,
    base_url: 'https://sam.gov',
    directory: false,
    loan_allowed: true, // CFDA includes loan programs; gated per profile downstream
    cost_share_allowed: true,
    applicant_types: ['nonprofit', 'school', 'government', 'business', 'farm'],
    need_categories: ['*'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'api',
    // Keyless: the sam.gov assistance-listings search needs no API key (the old
    // api.sam.gov host that required SAM_GOV_API_KEY was retired — see samGovAdapter.js).
    requires_env: [],
    refresh_frequency_days: 7,
    priority_score: 90,
  },
  {
    source_id: 'cof_locator',
    name: 'Council on Foundations — Community Foundation Locator',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.cof.org',
    directory: true,
    loan_allowed: false,
    cost_share_allowed: false,
    applicant_types: ['*'],
    need_categories: ['*'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html',
    requires_env: [],
    refresh_frequency_days: 30,
    priority_score: 40,
  },
  {
    source_id: 'benefits_gov',
    name: 'Benefits.gov (federal benefit finder)',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.benefits.gov',
    directory: true,
    loan_allowed: false,
    cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'student'],
    need_categories: ['housing', 'food', 'medical', 'energy', 'education', 'veterans'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html',
    requires_env: [],
    refresh_frequency_days: 14,
    priority_score: 60,
  },
  // --- Registry rows below have no adapter yet: the planner will SELECT them and
  //     the pipeline records an honest SKIPPED(no_adapter), never fakes results.
  //     Each becomes live by adding a thin createBaseAdapter() config. ---
  {
    source_id: 'usda_rd',
    name: 'USDA Rural Development programs',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.rd.usda.gov',
    directory: false, loan_allowed: true, cost_share_allowed: true,
    applicant_types: ['farm', 'government', 'business', 'vfd'],
    need_categories: ['capital', 'equipment', 'operations', 'energy'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 55,
  },
  {
    source_id: 'fema_afg',
    name: 'FEMA Assistance to Firefighters Grants',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.fema.gov',
    directory: false, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['vfd', 'government'],
    need_categories: ['equipment', 'emergency', 'operations'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 65,
  },
  {
    source_id: 'studentaid_gov',
    name: 'Federal Student Aid (studentaid.gov)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://studentaid.gov',
    // Truth-in-registry: the studentAidGov adapter is family:'directory' and
    // emits OPPORTUNITY_KIND.DIRECTORY with apply_url:null (there is no single
    // apply endpoint to scrape). The registry must agree so the planner counts
    // this as a directory/locator, not a direct scholarship funder.
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'family'],
    need_categories: ['education'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  // (CareerOneStop Scholarship Finder was removed here on 2026-06-23: DOL
  // retired the scholarship Web API — their 21 live services include none, and
  // scholarship* endpoints 404 while occupation returns 200 with the same token.
  // Individual scholarships are sourced by the Brave+LLM scholarshipWebDiscovery
  // service instead. If DOL reinstates it, re-add a row + a thin adapter.)
  //
  // --- Net-new key-free federal lanes (2026-06-24) ---------------------------
  {
    source_id: 'federal_register',
    name: 'Federal Register — funding notices (NOFO/NOFA)',
    source_type: 'api',
    trust_tier: TRUST_TIER.OFFICIAL_API,
    base_url: 'https://www.federalregister.gov',
    directory: false, loan_allowed: false, cost_share_allowed: true,
    // Federal NOFOs are institutional (agencies fund orgs/govts), so this lane
    // is gated OUT for individuals/students — the same precision as grants.gov.
    applicant_types: ['nonprofit', 'school', 'government', 'business', 'vfd', 'farm'],
    need_categories: ['*'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'api', requires_env: [], refresh_frequency_days: 1, priority_score: 80,
  },
  {
    source_id: 'nih_guide',
    name: 'NIH Guide for Grants & Contracts (funding opportunities)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://grants.nih.gov/grants/guide/newsfeed/fundingopps.xml',
    feed_url: 'https://grants.nih.gov/grants/guide/newsfeed/fundingopps.xml',
    sponsor_name: 'U.S. National Institutes of Health',
    directory: false, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['nonprofit', 'school', 'government', 'business'],
    // Research/health-leaning (NOT '*'): only profiles whose needs overlap (or
    // have no specific needs) pull NIH notices, so a fire dept needing turnout
    // gear isn't shown research R01s. The match engine still scores relevance.
    need_categories: ['medical', 'programs', 'technology', 'education'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 7, priority_score: 70,
  },
]);

const BY_ID = Object.freeze(Object.fromEntries(SOURCES.map((s) => [s.source_id, s])));

export function allSources() { return SOURCES.map((s) => ({ ...s })); }
export function getSource(id) { const s = BY_ID[id]; return s ? { ...s } : null; }
export function sourceIds() { return SOURCES.map((s) => s.source_id); }

export default { SOURCES, allSources, getSource, sourceIds };
