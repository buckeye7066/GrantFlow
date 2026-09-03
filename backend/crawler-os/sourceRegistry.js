// crawler-os/sourceRegistry.js
//
// THE data-driven registry of real funding sources. One row per source. The
// planner reads this; adapters are matched to rows by source_id. Every URL here
// is a real, public endpoint. Growing the funding universe = adding rows here +
// a thin adapter, never new bespoke crawler logic.
//
// Pure data. No I/O.

import { TRUST_TIER, OPPORTUNITY_KIND } from './contract.js';
// State housing-finance agencies are ALREADY a curated registry — every one of
// the 51 states/DC carries a verified `housingName`/`housingUrl`. The state HFA
// source rows below are GENERATED from it rather than hand-typed, so a state
// cannot silently fall out (the repeatedly-shipped hand-typed-subset defect).
import { STATE_REGISTRY } from '../services/shared/data/stateRegistry.js';
// Amy-managed additive coverage overrides (broaden an existing source's
// need_categories/applicant_types). Additive-only + reversible; lives inside
// the OS so the package stays self-contained. See ./coverageOverrides.js.
import { mergeSourceCoverage } from './coverageOverrides.js';

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
// ── State benefits portals (state_programs lane) ────────────────────────────
// One official state-government HOUSEHOLD benefits/assistance portal per state.
// Originally (2026-07-12) states with "a dedicated row elsewhere" were skipped —
// but a dedicated row is not a household portal: TN's was a disability waiver
// (tn_ecf_choices), WV's was business funding, PA's was campaign finance, OR's
// was likewise non-household, so a PA/WV/OR family selecting on housing/food
// got NOTHING from its state lane (the 2026-07-25 "geographically out of
// scope ×5 profiles" fleet gap). TN/WV/PA/OR portals added 2026-07-26 (URLs
// verified live, curl -L → 200 with a browser UA; base_url is the final
// post-redirect URL); only KY/OH/WA keep bespoke household-portal rows.
// Guard: "every state serves individual/family household needs" totality test
// in coverageEvidenceService.test.js. Other URLs verified live 2026-07-12
// (NH EASY answers 403 to non-browser clients — the DIRECTORY kind honestly
// survives fetch failures as link_unverified). Closes the fleet-wide "No
// {ST}-specific state-programs source exists" coverage gap for every US state,
// DC, and Puerto Rico.
// Row shape: [state, portal name, verified URL, sponsor, summary]
const STATE_BENEFITS_PORTALS = Object.freeze([
  ['AL', 'MyDHR — Alabama benefits portal', 'https://mydhr.alabama.gov', 'Alabama Department of Human Resources', 'Official Alabama portal to apply for and manage SNAP food assistance, TANF cash assistance, and child care assistance.'],
  ['AK', 'Alaska Division of Public Assistance', 'https://health.alaska.gov/dpa', 'Alaska Department of Health', 'Official Alaska public-assistance hub: SNAP, Temporary Assistance, Medicaid, heating assistance, and senior benefits programs.'],
  ['AZ', 'Health-e-Arizona Plus', 'https://www.healthearizonaplus.gov', 'Arizona Department of Economic Security', 'Official Arizona portal to apply for AHCCCS health coverage, SNAP nutrition assistance, and cash assistance.'],
  ['AR', 'Access Arkansas', 'https://access.arkansas.gov', 'Arkansas Department of Human Services', 'Official Arkansas portal to apply for SNAP, TEA cash assistance, health care coverage, and child care assistance.'],
  ['CA', 'BenefitsCal', 'https://benefitscal.com', 'State of California (county consortia)', 'Official California portal to apply for CalFresh food benefits, CalWORKs cash aid, Medi-Cal health coverage, and General Assistance.'],
  ['CO', 'Colorado PEAK', 'https://co.gov/PEAK', 'Colorado Department of Human Services', 'Official Colorado PEAK portal to apply for SNAP, Health First Colorado (Medicaid), cash assistance, and child care assistance.'],
  ['CT', 'ConneCT — Connecticut DSS benefits', 'https://connect.ct.gov', 'Connecticut Department of Social Services', 'Official Connecticut portal for SNAP, cash assistance, and HUSKY Health coverage applications and case management.'],
  ['DE', 'Delaware ASSIST', 'https://assist.dhss.delaware.gov/assisthome', 'Delaware Health and Social Services', 'Official Delaware ASSIST portal to screen and apply for food benefits, cash assistance, medical coverage, and child care.'],
  ['DC', 'District Direct', 'https://districtdirect.dc.gov', 'DC Department of Human Services', 'Official District of Columbia portal for SNAP, TANF, Medicaid, and other public benefits applications and renewals.'],
  ['FL', 'MyACCESS Florida', 'https://myaccess.myflfamilies.com', 'Florida Department of Children and Families', 'Official Florida portal to apply for SNAP food assistance, temporary cash assistance, and Medicaid.'],
  ['GA', 'Georgia Gateway', 'https://gateway.ga.gov', 'Georgia Department of Human Services', 'Official Georgia portal for SNAP, TANF, Medicaid/PeachCare, child care assistance (CAPS), and WIC eligibility.'],
  ['HI', 'My Benefits Hawaiʻi', 'https://mybenefits.hawaii.gov', 'Hawaiʻi Department of Human Services', 'Official Hawaiʻi portal for medical assistance (Med-QUEST), SNAP, and financial assistance program applications.'],
  ['ID', 'idalink Idaho', 'https://idalink.idaho.gov', 'Idaho Department of Health and Welfare', 'Official Idaho portal to apply for food assistance, cash assistance, child care assistance, and Medicaid.'],
  ['IL', 'Illinois ABE (Application for Benefits Eligibility)', 'https://abe.illinois.gov', 'Illinois Department of Human Services', 'Official Illinois portal to apply for SNAP, cash assistance, and medical benefits and manage existing cases.'],
  ['IN', 'Indiana FSSA Benefits Portal', 'https://fssabenefits.in.gov', 'Indiana Family and Social Services Administration', 'Official Indiana portal to apply for SNAP, TANF, and Health Coverage (Medicaid/HIP) benefits.'],
  ['IA', 'Iowa HHS programs', 'https://hhs.iowa.gov/programs', 'Iowa Department of Health and Human Services', 'Official Iowa HHS programs hub covering food assistance, health coverage, child care assistance, and family support programs.'],
  ['KS', 'KEES Self-Service Portal (Kansas)', 'https://cssp.kees.ks.gov', 'Kansas Department for Children and Families', 'Official Kansas self-service portal to apply for food, cash, and child care assistance and medical coverage.'],
  ['LA', 'Louisiana CAFÉ', 'https://www.dcfs.louisiana.gov/cafe', 'Louisiana Department of Children and Family Services', 'Official Louisiana CAFÉ portal for SNAP, FITAP cash assistance, child care assistance, and other DCFS services.'],
  ['ME', 'My Maine Connection', 'https://www.maine.gov/mymaineconnection', 'Maine Department of Health and Human Services', 'Official Maine portal to apply for food supplement (SNAP), TANF, MaineCare health coverage, and other assistance.'],
  ['MD', 'Maryland benefits (myMDTHINK)', 'https://mymdthink.maryland.gov', 'Maryland Department of Human Services', 'Official Maryland myMDTHINK portal for SNAP, cash assistance, Medicaid, and social services applications.'],
  ['MA', 'DTA Connect (Massachusetts)', 'https://dtaconnect.eohhs.mass.gov', 'Massachusetts Department of Transitional Assistance', 'Official Massachusetts portal for SNAP and cash assistance (TAFDC/EAEDC) applications and case management.'],
  ['MI', 'MI Bridges', 'https://newmibridges.michigan.gov', 'Michigan Department of Health and Human Services', 'Official Michigan portal to apply for food, cash, child care, emergency relief, and health care assistance.'],
  ['MN', 'MNbenefits', 'https://mnbenefits.mn.gov', 'Minnesota Department of Human Services', 'Official Minnesota portal to apply for SNAP, cash programs, emergency assistance, child care assistance, and housing supports in one application.'],
  ['MS', 'Mississippi Department of Human Services programs', 'https://www.mdhs.ms.gov', 'Mississippi Department of Human Services', 'Official Mississippi DHS hub for SNAP, TANF, child care payment assistance, and workforce development programs.'],
  ['MO', 'myDSS Missouri', 'https://mydss.mo.gov', 'Missouri Department of Social Services', 'Official Missouri portal for food stamps (SNAP), temporary assistance, child care subsidy, and MO HealthNet coverage.'],
  ['MT', 'apply.mt.gov — Montana public assistance', 'https://apply.mt.gov', 'Montana Department of Public Health and Human Services', 'Official Montana portal to apply for SNAP, TANF, Medicaid, and healthy Montana kids coverage.'],
  ['NE', 'ACCESSNebraska', 'https://accessnebraska.ne.gov', 'Nebraska Department of Health and Human Services', 'Official Nebraska portal for SNAP, child care subsidy, energy assistance, and economic assistance applications.'],
  ['NV', 'Access Nevada', 'https://accessnevada.dwss.nv.gov', 'Nevada Division of Welfare and Supportive Services', 'Official Nevada portal to apply for SNAP, TANF, Medicaid, and energy assistance and manage existing cases.'],
  ['NH', 'NH EASY Gateway to Services', 'https://nheasy.nh.gov', 'New Hampshire Department of Health and Human Services', 'Official New Hampshire portal to apply for food stamps, cash assistance, Medicaid, and child care scholarship.'],
  ['NJ', 'MyNJHelps', 'https://www.mynjhelps.gov', 'New Jersey Department of Human Services', 'Official New Jersey portal to screen and apply for NJ SNAP, WorkFirst NJ cash assistance, and NJ FamilyCare.'],
  ['NM', 'YES New Mexico', 'https://www.yes.state.nm.us', 'New Mexico Health Care Authority', 'Official New Mexico YESNM portal for SNAP, cash assistance, Medicaid, and energy assistance (LIHEAP).'],
  ['NY', 'myBenefits New York', 'https://mybenefits.ny.gov', 'New York State Office of Temporary and Disability Assistance', 'Official New York portal to screen and apply for SNAP, HEAP energy assistance, and other state benefits.'],
  ['NC', 'ePASS North Carolina', 'https://epass.nc.gov', 'North Carolina Department of Health and Human Services', 'Official North Carolina portal to apply for Food and Nutrition Services, Medicaid, energy, and child care assistance.'],
  ['ND', 'North Dakota Apply for Help', 'https://applyforhelp.nd.gov', 'North Dakota Health and Human Services', 'Official North Dakota hub to apply for SNAP, TANF, child care assistance, energy assistance, and health coverage.'],
  ['OK', 'OKDHS Live!', 'https://www.okdhslive.org', 'Oklahoma Human Services', 'Official Oklahoma portal to apply for SNAP food benefits, child care subsidy, and TANF and manage existing benefits.'],
  ['OR', 'Oregon ONE Eligibility', 'https://one.oregon.gov', 'Oregon Department of Human Services', 'Official Oregon ONE portal to apply for SNAP food benefits, cash assistance (TANF), child care assistance (ERDC), and Oregon Health Plan coverage.'],
  ['PA', 'COMPASS Pennsylvania', 'https://www.compass.dhs.pa.gov/home/', 'Pennsylvania Department of Human Services', 'Official Pennsylvania COMPASS portal to apply for SNAP, cash assistance, Medical Assistance, LIHEAP heating assistance, and child care works.'],
  ['RI', 'HealthyRhode', 'https://healthyrhode.ri.gov', 'Rhode Island Executive Office of Health and Human Services', 'Official Rhode Island portal for health coverage, SNAP, cash assistance, and child care assistance applications.'],
  ['SC', 'SC DSS Benefits Portal', 'https://benefitsportal.dss.sc.gov', 'South Carolina Department of Social Services', 'Official South Carolina portal to apply for SNAP and TANF benefits and manage existing DSS cases.'],
  ['SD', 'South Dakota Department of Social Services', 'https://dss.sd.gov', 'South Dakota Department of Social Services', 'Official South Dakota DSS hub for SNAP, TANF, child care assistance, energy assistance, and Medicaid programs.'],
  ['TN', 'Tennessee One DHS', 'https://onedhs.tn.gov/csp', 'Tennessee Department of Human Services', 'Official Tennessee One DHS portal to apply for SNAP food assistance, Families First (TANF) cash assistance, and child care payment assistance.'],
  ['TX', 'Your Texas Benefits', 'https://www.yourtexasbenefits.com', 'Texas Health and Human Services Commission', 'Official Texas portal to apply for SNAP food benefits, TANF cash help, Medicaid/CHIP, and other support programs.'],
  ['UT', 'Utah DWS public assistance', 'https://jobs.utah.gov/assistance/', 'Utah Department of Workforce Services', 'Official Utah hub for SNAP, financial assistance, child care assistance, and unemployment services (myCase).'],
  ['VT', 'Vermont DCF Economic Services benefits', 'https://dcf.vermont.gov/benefits', 'Vermont Department for Children and Families', 'Official Vermont hub for 3SquaresVT (SNAP), Reach Up cash assistance, fuel assistance, and child care financial assistance.'],
  ['VA', 'CommonHelp Virginia', 'https://commonhelp.virginia.gov', 'Virginia Department of Social Services', 'Official Virginia portal to apply for SNAP, TANF, Medicaid/FAMIS, child care, and energy assistance.'],
  ['WV', 'WV PATH', 'https://www.wvpath.wv.gov', 'West Virginia Department of Human Services', 'Official West Virginia PATH portal to apply for SNAP, WV WORKS cash assistance, Medicaid, child care assistance, and LIEAP energy assistance.'],
  ['WI', 'ACCESS Wisconsin', 'https://access.wisconsin.gov', 'Wisconsin Department of Health Services', 'Official Wisconsin portal to apply for FoodShare, BadgerCare Plus health coverage, child care, and other benefits.'],
  ['WY', 'Wyoming Department of Family Services', 'https://dfs.wyo.gov', 'Wyoming Department of Family Services', 'Official Wyoming DFS hub for SNAP, POWER cash assistance, child care subsidy, and energy assistance (LIEAP).'],
  ['PR', 'Departamento de la Familia de Puerto Rico', 'https://www.familia.pr.gov', 'Departamento de la Familia (ADSEF)', 'Official Puerto Rico family-services hub covering the Nutrition Assistance Program (PAN), TANF, and social services.'],
]);

function stateBenefitsPortalRow([state, name, url, sponsor, summary]) {
  return {
    source_id: `${state.toLowerCase()}_benefits`,
    name,
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: url,
    sponsor_name: sponsor,
    resource_title: name,
    resource_summary: summary,
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'student'],
    need_categories: ['housing', 'food', 'medical', 'energy', 'caregiving', 'childcare', 'survivor_benefits'],
    geography: { national: false, states: [state] },
    // A state portal is an honest LOCATOR (directory:true forces the emitted
    // kind anyway); default_kinds must agree — registryKindTotality.test.mjs.
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 76,
  };
}

/** source_ids of the generated per-state benefits portal rows (adapter + lane wiring). */
export const STATE_BENEFITS_SOURCE_IDS = Object.freeze(
  STATE_BENEFITS_PORTALS.map(([state]) => `${state.toLowerCase()}_benefits`),
);

// ── State HOUSING FINANCE AGENCY lane (2026-08-02) ──────────────────────────
// The state benefits portal above is the SNAP/TANF/Medicaid door. It is not the
// door for someone losing a HOUSE. Measured end-to-end on 2026-08-02 with the
// real planner + the real discovery path: a homeowner in Kokomo, Indiana four
// months behind on his mortgage got 40 rows, 35 of them pointers, headed by
// "Benefits.gov finder — substance_recovery benefits", "HLAA financial
// assistance for hearing aids" and "Arthritis Foundation help line" — and NOT
// ONE row naming a mortgage, a foreclosure, or a housing counselor. The state
// HFA (IHCDA in Indiana, OHFA in Ohio, WVHDF in West Virginia) is the agency
// that actually administers Homeowner Assistance Fund money, foreclosure
// counseling, down-payment and home-repair programs.
//
// WHY THIS IS **ONE** ROW AND NOT 51 STATE-SCOPED ROWS. The obvious shape was
// to mirror STATE_BENEFITS_PORTALS: generate one `<st>_housing_agency` row per
// state from STATE_REGISTRY (which already carries a curated housingName /
// housingUrl for all 51). It was built that way first and MEASURED against all
// 33 real prod profiles before shipping — and it FLOODED: `planner.servesGeo`
// returns `true` when the thesis has no state ("unknown location -> keep"), so
// the 5 prod profiles with no resolvable state selected **all 51** rows,
// +54 sources each (Lisa Klinger 99 → 153). That is the 2026-07 geo-link flood
// class, and the only clean gate for it lives in planner.js, which is not this
// change's to touch. The rule is "never fix a gap by widening a gate", so the
// lane is a SINGLE national row whose adapter resolves the profile's OWN state
// from STATE_REGISTRY (see adapters/stateHousingAgencyAdapter.js). Measured
// after: +1 source for a profile with a state, +1 (the honest national HUD
// fallback) for one without. No profile can select more than one.
export const STATE_HOUSING_AGENCY_SOURCE_ID = 'state_housing_finance_agency';

/** States/DC whose HFA the adapter can name — read from STATE_REGISTRY, never hand-typed. */
export const STATE_HOUSING_AGENCY_STATES = Object.freeze(
  Object.keys(STATE_REGISTRY).filter((st) => STATE_REGISTRY[st]?.housingUrl).sort(),
);

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
    source_id: 'sbir_gov',
    name: 'SBIR.gov (Small Business Innovation Research / STTR solicitations)',
    source_type: 'api',
    trust_tier: TRUST_TIER.OFFICIAL_API,
    base_url: 'https://www.sbir.gov',
    directory: false,
    loan_allowed: false,
    cost_share_allowed: false,
    // SBIR/STTR is exclusively for small for-profit businesses; nonprofit is
    // included only because generic research orgs derive both buckets — the
    // research_only gate below is the real precision control.
    applicant_types: ['business', 'nonprofit'],
    need_categories: ['*'],
    // ONLY selected for research-capable orgs (thesis.is_research_org) — the
    // planner's research_only gate. A food pantry never searches solicitations.
    research_only: true,
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'api',
    // Public API, no key. RE-MEASURED 2026-08-24 (the 2026-07-06 note said the
    // API returned "not available at this time" service-wide; that is no longer
    // the observed behavior and the distinction matters for burn semantics):
    //   www.sbir.gov                      -> HTTP 200 (the site is UP)
    //   api.www.sbir.gov /solicitations   -> HTTP 403 {"message":"Forbidden"}
    //   api.www.sbir.gov /awards          -> HTTP 403 {"message":"Forbidden"}
    // Identical with a browser User-Agent, so this is NOT a UA/Accept problem —
    // the API refuses THIS caller (WAF / allowlist / egress), while the site
    // itself serves fine. Per the amount-enrichment rules a 401/403/429 is
    // `environment: true` (refuses our caller, not the URL) and must NOT burn a
    // row's one-shot attempt the way a stable 404/410 does.
    //
    // CONSEQUENCE: an sbir_gov AMOUNT adapter cannot be written or verified from
    // here — there is no reachable endpoint to read award figures from. Do not
    // add one speculatively; re-probe the two URLs above first. The crawler-os
    // adapter classifies this exact 403 response as a typed BLOCKED external
    // outage (`external_blocked:sbir_public_api_403_forbidden`) so it stays
    // observable without pretending the source was healthily empty or that
    // GrantFlow has a fetch/parse defect. Other 403/WAF/body shapes remain
    // FETCH_ERROR.
    requires_env: [],
    refresh_frequency_days: 3,
    priority_score: 95,
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
    applicant_types: ['individual', 'family', 'veteran', 'active_duty', 'guard_reserve', 'transitioning_service_member', 'military_spouse', 'student'],
    need_categories: ['housing', 'food', 'medical', 'energy', 'education', 'veterans', 'active_duty_support', 'military_transition', 'military_spouse_support', 'caregiving', 'survivor_benefits'],
    geography: { national: true, states: [] },
    // The adapter emits one DIRECTORY candidate for the benefit finder, not
    // individual apply-now benefit rows. Keep the registry honest.
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html',
    requires_env: [],
    refresh_frequency_days: 14,
    priority_score: 60,
  },
  {
    source_id: 'community_action',
    name: 'Community Action Partnership agency finder',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://communityactionpartnership.com/find-a-cap/',
    sponsor_name: 'Community Action Partnership',
    resource_title: 'Community Action agency finder',
    resource_summary: 'Directory of local Community Action agencies for housing, utilities, food, transportation, childcare, and household support referrals.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'student', 'veteran', 'active_duty', 'guard_reserve', 'military_spouse'],
    need_categories: ['housing', 'food', 'energy', 'childcare', 'transportation', 'medical', 'emergency'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 66,
  },
  {
    source_id: 'feeding_america',
    name: 'Feeding America food bank locator',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.feedingamerica.org/find-your-local-foodbank',
    sponsor_name: 'Feeding America',
    resource_title: 'Local food bank locator',
    resource_summary: 'Directory for finding local food banks and hunger-relief networks. This is a directory/referral lane, not a direct cash grant.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'student', 'veteran', 'nonprofit', 'church', 'ministry'],
    need_categories: ['food', 'school_nutrition'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 63,
  },
  {
    source_id: 'hrsa_health_centers',
    name: 'HRSA Find a Health Center',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://findahealthcenter.hrsa.gov',
    sponsor_name: 'Health Resources and Services Administration',
    resource_title: 'HRSA Find a Health Center',
    resource_summary: 'Official locator for HRSA-funded health centers that may provide care regardless of ability to pay.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'student', 'veteran', 'active_duty', 'guard_reserve'],
    need_categories: ['medical', 'disability', 'medical_bills', 'medication', 'mental_health', 'substance_recovery'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 69,
  },
  {
    source_id: 'liheap',
    name: 'LIHEAP energy assistance',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.acf.hhs.gov/ocs/programs/liheap',
    sponsor_name: 'Administration for Children and Families',
    resource_title: 'Low Income Home Energy Assistance Program',
    resource_summary: 'Official LIHEAP program information for eligible households needing energy, heating, cooling, or utility-bill assistance.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'student', 'veteran'],
    need_categories: ['energy', 'housing'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 68,
  },
  {
    source_id: 'snap',
    name: 'USDA SNAP state directory',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.fns.usda.gov/snap/state-directory',
    sponsor_name: 'U.S. Department of Agriculture',
    resource_title: 'SNAP state directory',
    resource_summary: 'Official SNAP state directory for food-assistance application portals and local program information.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'student', 'veteran'],
    need_categories: ['food'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 67,
  },
  {
    source_id: 'medicaid',
    name: 'Medicaid and CHIP',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.medicaid.gov',
    sponsor_name: 'Centers for Medicare & Medicaid Services',
    resource_title: 'Medicaid and CHIP',
    resource_summary: 'Official Medicaid and CHIP program information for health coverage and medical support.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'student', 'veteran'],
    need_categories: ['medical', 'disability', 'medical_bills', 'medication'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 67,
  },
  {
    // TennCare ECF CHOICES — Tennessee's Medicaid HCBS waiver (employment and
    // community-living supports for people with intellectual/developmental
    // disabilities + Essential Family Supports for family caregivers). Ported
    // from the legacy ecfBenefitsCrawler on 2026-07-07: the legacy crawler was
    // never registered here, so after the crawler-os cutover the ECF lane was
    // structurally uncrawlable — actual ECF CHOICES members (the Gilbert/Kim
    // class) never had their own program crawled. NOTE: tn.gov intermittently
    // ECONNRESETs automated fetchers; the adapter degrades honestly
    // (FETCH_ERROR), never fabricates.
    source_id: 'tn_ecf_choices',
    name: 'TennCare Employment and Community First CHOICES (ECF CHOICES)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
    sponsor_name: 'TennCare',
    resource_title: 'Employment and Community First CHOICES (ECF CHOICES)',
    resource_summary: 'Official TennCare ECF CHOICES program page: employment and independent-community-living supports for Tennesseans with intellectual or developmental disabilities, including Essential Family Supports for family caregivers.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'disabled', 'caregiver'],
    need_categories: ['disability', 'healthcare', 'medical', 'employment', 'caregiving'],
    geography: { national: false, states: ['TN'] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 78,
  },
  {
    // Every state's Medicaid HCBS waiver universe (the legacy
    // stateWaiverBenefitsCrawler's generic scope): the medicaid.gov HCBS index
    // is the authoritative national locator for state waiver programs — each
    // state's ECF-CHOICES-equivalent. An honest DIRECTORY, so a waiver-family
    // profile outside TN still reaches its own state's program.
    source_id: 'state_hcbs_waivers',
    name: 'Medicaid Home & Community-Based Services (HCBS) waivers by state',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.medicaid.gov/medicaid/home-community-based-services/index.html',
    sponsor_name: 'Centers for Medicare & Medicaid Services',
    resource_title: 'Medicaid HCBS waiver programs (state directory)',
    resource_summary: 'Official CMS index of Home and Community-Based Services waiver programs — the entry point for finding your state\'s Medicaid waiver (employment supports, community living, respite, and caregiver services).',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'senior', 'veteran', 'disabled', 'caregiver'],
    need_categories: ['disability', 'healthcare', 'medical', 'caregiving', 'aging'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 69,
  },
  {
    // SSA disability benefits (SSDI/SSI) — the federal branch of the legacy ECF
    // crawler's individual sources. A real benefit PROGRAM (apply at ssa.gov),
    // honestly classified BENEFIT — not a directory. NOTE: ssa.gov
    // intermittently 403s automated fetchers (seen in CI); registry-declared
    // candidates survive a failed fetch with their honest kind as
    // link_unverified (≠ dead) while the run records fetch_error.
    source_id: 'ssa_disability',
    name: 'Social Security disability benefits (SSDI / SSI)',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.ssa.gov/disability',
    application_url: 'https://www.ssa.gov/disability',
    sponsor_name: 'Social Security Administration',
    resource_title: 'Social Security disability benefits (SSDI/SSI)',
    resource_summary: 'Official Social Security disability-benefits information and application entry point: SSDI for workers with a qualifying disability and SSI for people with limited income and resources. This is a benefits lane, not a grant.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'disabled'],
    need_categories: ['disability', 'medical'],
    // A profile that explicitly declares disability must reach this federal
    // benefit before a bounded crawl can spend its budget on lower-signal
    // lanes. Selection and matching rules remain unchanged.
    priority_need_categories: ['disability'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    // Seniors + their caregivers: the Eldercare Locator connects older adults to
    // their local Area Agency on Aging (meals, transportation, in-home support,
    // caregiver respite). An authoritative national locator — surfaced as an
    // honest DIRECTORY so it reaches senior/caregiver profiles the grant sources miss.
    source_id: 'area_agency_on_aging',
    name: 'Area Agencies on Aging (Eldercare Locator)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://eldercare.acl.gov',
    sponsor_name: 'Administration for Community Living',
    resource_title: 'Area Agency on Aging & Eldercare Locator',
    resource_summary: 'Find your local Area Agency on Aging for senior services: meals, transportation, in-home care, benefits counseling, and caregiver respite support.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'senior', 'caregiver'],
    need_categories: ['aging', 'senior', 'housing', 'food', 'medical', 'caregiving', 'transportation'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 66,
  },
  {
    // People with disabilities: state Vocational Rehabilitation agencies fund
    // assistive technology, job training, and employment support. Reachable only
    // by the state agency locator, so individuals never find them via grant search.
    source_id: 'state_vocational_rehab',
    name: 'State Vocational Rehabilitation agencies',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://rsa.ed.gov/about/states',
    sponsor_name: 'Rehabilitation Services Administration',
    resource_title: 'State Vocational Rehabilitation (disability employment & assistive tech)',
    resource_summary: 'State VR agencies help people with disabilities get assistive technology, job training, and employment support. Find your state agency to apply.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'disabled'],
    need_categories: ['disability', 'employment', 'assistive_technology', 'education', 'equipment'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 66,
  },
  {
    // Universal local safety net: 211 connects anyone to nearby help for rent,
    // utilities, food, and emergencies. The single best locator for a low-income
    // individual (works even for a sparse profile), so it is a national DIRECTORY.
    source_id: 'community_211',
    name: '211 local community resources',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.211.org',
    sponsor_name: 'United Way / 211',
    resource_title: '211 - Local help with rent, utilities, food & emergencies',
    resource_summary: 'Dial 211 or search 211.org to connect with local programs for rent and utility assistance, food, healthcare, and emergency needs in your area.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'senior', 'veteran', 'caregiver'],
    need_categories: ['housing', 'energy', 'utility', 'food', 'emergency', 'medical', 'basic_needs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 67,
  },
  {
    source_id: 'pell_grant',
    name: 'Federal Pell Grant',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    sponsor_name: 'Federal Student Aid',
    resource_title: 'Federal Pell Grant',
    resource_summary: 'Official Federal Student Aid Pell Grant page. Eligibility is determined through FAFSA and school financial-aid processing.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'family'],
    need_categories: ['education', 'scholarship', 'fafsa', 'pell', 'tuition'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.SCHOLARSHIP],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 71,
  },
  // --- Sibling federal need-based student aid (the rest of the "federal grant"
  //     family beyond Pell). Real official studentaid.gov program pages, modeled
  //     exactly like pell_grant so a student/family profile surfaces the FULL set
  //     of federal aid — not just the Pell Grant. Each flows through the same
  //     reality gate + match engine; nothing is fabricated. ---
  {
    source_id: 'fseog',
    name: 'Federal Supplemental Educational Opportunity Grant (FSEOG)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://studentaid.gov/understand-aid/types/grants/fseog',
    sponsor_name: 'Federal Student Aid',
    resource_title: 'Federal Supplemental Educational Opportunity Grant (FSEOG)',
    resource_summary: 'Official Federal Student Aid FSEOG page. Need-based grant for undergraduates with exceptional financial need (priority to Pell recipients); awarded by participating schools. Does not need to be repaid.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'family'],
    need_categories: ['education', 'scholarship', 'fafsa', 'pell', 'tuition'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.SCHOLARSHIP],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  {
    source_id: 'federal_work_study',
    name: 'Federal Work-Study',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://studentaid.gov/understand-aid/types/work-study',
    sponsor_name: 'Federal Student Aid',
    resource_title: 'Federal Work-Study',
    resource_summary: 'Official Federal Student Aid Work-Study page. Part-time jobs for undergraduate and graduate students with financial need to help pay education expenses; awarded by participating schools via the FAFSA.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'family'],
    need_categories: ['education', 'scholarship', 'fafsa', 'tuition', 'employment'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.SCHOLARSHIP],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 69,
  },
  {
    source_id: 'teach_grant',
    name: 'TEACH Grant',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://studentaid.gov/understand-aid/types/grants/teach',
    sponsor_name: 'Federal Student Aid',
    resource_title: 'TEACH Grant',
    resource_summary: 'Official Federal Student Aid TEACH Grant page. Up to $4,000/year for students who agree to teach in a high-need field at a low-income school for four years; becomes a loan if the service obligation is not met.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'family'],
    need_categories: ['education', 'scholarship', 'fafsa', 'tuition', 'professional_development'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.SCHOLARSHIP],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 68,
  },
  {
    source_id: 'iraq_afghanistan_service_grant',
    name: 'Iraq and Afghanistan Service Grant',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://studentaid.gov/understand-aid/types/grants/iraq-afghanistan-service',
    sponsor_name: 'Federal Student Aid',
    resource_title: 'Iraq and Afghanistan Service Grant',
    resource_summary: 'Official Federal Student Aid page. Grant for students whose parent or guardian died as a result of U.S. military service in Iraq or Afghanistan after 9/11 and who were under 24 or enrolled at the time. Does not need to be repaid.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'family'],
    need_categories: ['education', 'scholarship', 'fafsa', 'tuition', 'veterans', 'survivor_benefits'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.SCHOLARSHIP],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 67,
  },
  {
    source_id: 'us_dept_of_ed',
    name: 'U.S. Department of Education grant programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www2.ed.gov/fund/grant.html',
    sponsor_name: 'U.S. Department of Education',
    resource_title: 'U.S. Department of Education grants',
    resource_summary: 'Official Department of Education grant-program page for schools, districts, states, nonprofits, and education partners.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['school', 'government', 'nonprofit', 'teacher'],
    need_categories: ['education', 'curriculum', 'classroom_supplies', 'special_education', 'professional_development', 'technology'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 64,
  },
  // --- Additional official/program lanes. Most static program pages below use
  //     the generic officialDirectory adapter so they surface as honest
  //     directories or program pages, never as fabricated "apply now" grants. ---
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
    source_id: 'usda_rd_community_facilities',
    name: 'USDA Rural Development Community Facilities',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.rd.usda.gov/programs-services/community-facilities',
    sponsor_name: 'USDA Rural Development',
    resource_title: 'USDA RD Community Facilities programs',
    resource_summary: 'Official USDA Rural Development Community Facilities program entry point for essential community facilities in rural areas.',
    directory: true, loan_allowed: true, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'school', 'vfd'],
    need_categories: ['community_facilities', 'capital', 'infrastructure', 'public_safety', 'medical', 'education'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 62,
  },
  {
    source_id: 'fema_public_assistance',
    name: 'FEMA Public Assistance',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.fema.gov/assistance/public',
    sponsor_name: 'Federal Emergency Management Agency',
    resource_title: 'FEMA Public Assistance',
    resource_summary: 'Official FEMA Public Assistance program information for eligible public entities and certain nonprofits after declared disasters.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'vfd', 'nonprofit'],
    need_categories: ['emergency', 'infrastructure', 'community_facilities', 'public_safety'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 61,
  },
  {
    source_id: 'fema_hazard_mitigation',
    name: 'FEMA Hazard Mitigation Assistance',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.fema.gov/grants/mitigation',
    sponsor_name: 'Federal Emergency Management Agency',
    resource_title: 'FEMA Hazard Mitigation Assistance',
    resource_summary: 'Official FEMA mitigation grants entry point for hazard mitigation, flood mitigation, and resilience programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'vfd', 'nonprofit'],
    need_categories: ['emergency', 'infrastructure', 'environmental_remediation', 'public_safety'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 60,
  },
  {
    source_id: 'cdbg_state_local',
    name: 'HUD Community Development Block Grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.hud.gov/program_offices/comm_planning/cdbg',
    sponsor_name: 'U.S. Department of Housing and Urban Development',
    resource_title: 'Community Development Block Grant program',
    resource_summary: 'Official HUD CDBG program page for community development, housing, public facilities, and eligible state/local pass-through activities.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit'],
    need_categories: ['housing_development', 'community_facilities', 'infrastructure', 'economic_development', 'housing'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 63,
  },
  {
    source_id: 'eda_economic_development',
    name: 'Economic Development Administration funding',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.eda.gov/funding',
    sponsor_name: 'U.S. Economic Development Administration',
    resource_title: 'EDA funding opportunities',
    resource_summary: 'Official EDA funding page for economic development, public works, infrastructure, recovery, and planning programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'business'],
    need_categories: ['economic_development', 'infrastructure', 'community_facilities', 'broadband', 'workforce'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 62,
  },
  {
    source_id: 'dot_transportation_grants',
    name: 'U.S. DOT grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.transportation.gov/grants',
    sponsor_name: 'U.S. Department of Transportation',
    resource_title: 'DOT grant programs',
    resource_summary: 'Official DOT grants entry point for transportation, safety, bridge, transit, and community mobility programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'school'],
    need_categories: ['roads_transportation', 'transportation', 'infrastructure', 'public_safety', 'school_transportation'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 62,
  },
  {
    source_id: 'epa_water_infrastructure',
    name: 'EPA grants and water infrastructure',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.epa.gov/grants',
    sponsor_name: 'U.S. Environmental Protection Agency',
    resource_title: 'EPA grants',
    resource_summary: 'Official EPA grants page for environmental, water, brownfields, and environmental-justice programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'school'],
    need_categories: ['water_sewer', 'environmental_remediation', 'infrastructure', 'medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 61,
  },
  {
    source_id: 'broadband_grants',
    name: 'BroadbandUSA funding programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://broadbandusa.ntia.doc.gov/funding-programs',
    sponsor_name: 'National Telecommunications and Information Administration',
    resource_title: 'BroadbandUSA funding programs',
    resource_summary: 'Official NTIA BroadbandUSA funding page for broadband, digital equity, and connectivity programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'school', 'business'],
    need_categories: ['broadband', 'technology', 'infrastructure', 'community_facilities', 'education'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 61,
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
  // If DOL reinstates it, re-add a row plus a thin adapter.)
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
  {
    source_id: 'united_way_211',
    name: '211 local assistance directory',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.211.org/get-help',
    sponsor_name: '211',
    resource_title: '211 local assistance finder',
    resource_summary: 'Connects people to local help for food, housing, utilities, health care, transportation, legal aid, and crisis needs. This is a directory, not a direct grant.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'student', 'veteran'],
    need_categories: ['housing', 'food', 'medical', 'energy', 'emergency', 'legal', 'caregiving', 'survivor_benefits'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 75,
  },
  {
    source_id: 'donorschoose',
    name: 'DonorsChoose classroom funding',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.donorschoose.org/teachers',
    sponsor_name: 'DonorsChoose',
    resource_title: 'DonorsChoose teacher project funding',
    resource_summary: 'Teacher-facing classroom project funding platform for supplies, books, technology, and student materials. GrantFlow treats this as a portal/directory, not a guaranteed award.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['teacher', 'school'],
    need_categories: ['education', 'equipment', 'technology'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 68,
  },
  {
    source_id: 'cancer_care',
    name: 'CancerCare financial assistance',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.cancercare.org/financial_assistance',
    sponsor_name: 'CancerCare',
    resource_title: 'CancerCare financial assistance',
    resource_summary: 'Financial and practical-support assistance information for people affected by cancer. Eligibility and available funds vary, so this is surfaced for review rather than promised as an award.',
    // `keywords` are the CURATED vocabulary conditionCoveredBySource matches on.
    // They are not decoration: the coverage haystack is keywords + need_categories
    // ONLY, so a disease source without them is invisible to condition matching
    // and mints a false "no source lane exists" wishlist entry every night.
    keywords: ['cancer', 'oncology', 'chemotherapy', 'radiation therapy', 'tumor', 'leukemia', 'lymphoma', 'melanoma', 'carcinoma', 'metastatic'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family'],
    need_categories: ['cancer_support'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'ssa_survivors',
    name: 'Social Security survivors benefits',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.ssa.gov/survivor',
    sponsor_name: 'Social Security Administration',
    resource_title: 'Social Security survivors benefits',
    resource_summary: 'Official Social Security survivor-benefits information for eligible surviving spouses, children, and families. This is a benefits lane, not a grant.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['survivor_benefits', 'housing', 'food', 'medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    source_id: 'dol_black_lung_benefits',
    name: 'DOL Black Lung Program',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.dol.gov/agencies/owcp/dcmwc/filing_guide_survivor',
    sponsor_name: 'U.S. Department of Labor',
    resource_title: 'Black Lung Program benefits',
    resource_summary: 'Official Department of Labor Black Lung Program information for eligible coal miners and surviving family members. GrantFlow treats this as benefit guidance, not an open grant.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family'],
    need_categories: ['black_lung_benefits'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 76,
  },
  {
    source_id: 'alzheimers_gov_services',
    name: 'Alzheimers.gov local services',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.alzheimers.gov/life-with-dementia/find-local-services',
    sponsor_name: 'Alzheimers.gov',
    resource_title: 'Dementia local services finder',
    resource_summary: 'Official federal dementia resource for finding local services, support, and care resources for people living with dementia and their caregivers.',
    // Curated match vocabulary (see cancer_care). 'alzheimers' must be spelled
    // BOTH ways: the possessive form is what people actually type, and token
    // matching does not fold an apostrophe.
    keywords: ['dementia', 'alzheimers', "alzheimer's", 'alzheimer', 'memory loss', 'memory care', 'cognitive decline', 'vascular dementia', 'lewy body'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family'],
    need_categories: ['dementia_support'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  {
    source_id: 'kynect_benefits',
    name: 'Kentucky kynect benefits',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://kynect.ky.gov/benefits/s/?language=en_US',
    sponsor_name: 'Commonwealth of Kentucky',
    resource_title: 'Kentucky kynect benefits',
    resource_summary: 'Official Kentucky benefits portal for programs such as health coverage, food assistance, child care, and other household supports.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'student'],
    need_categories: ['housing', 'food', 'medical', 'energy', 'caregiving', 'survivor_benefits'],
    geography: { national: false, states: ['KY'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 78,
  },
  {
    source_id: 'ana_grants',
    name: 'Administration for Native Americans grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.acf.hhs.gov/ana/grants',
    sponsor_name: 'Administration for Native Americans',
    resource_title: 'Administration for Native Americans grants',
    resource_summary: 'Official Administration for Native Americans grants resource for tribal governments, Native nonprofits, and Native communities.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['tribal', 'government', 'nonprofit'],
    need_categories: ['capital', 'operations', 'programs', 'technology', 'public_safety', 'agriculture', 'recreation', 'energy'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    source_id: 'bia_tribal_programs',
    name: 'Bureau of Indian Affairs grants and services',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.bia.gov/service/grants',
    sponsor_name: 'Bureau of Indian Affairs',
    resource_title: 'BIA grants and services',
    resource_summary: 'Official BIA grants and services entry point for tribal governments, tribal organizations, and Native communities.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['tribal', 'government'],
    need_categories: ['housing_development', 'community_facilities', 'medical', 'public_safety', 'education', 'broadband', 'infrastructure', 'economic_development'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    // The largest Native-led grantmaker to Native-controlled nonprofits — the
    // philanthropic complement to the federal ANA/BIA lanes above (a ministry
    // serving Pine Ridge is exactly its applicant pool; the 2026-08-04 audit
    // found zero indigenous funders on such a profile's pipeline). base_url
    // fetch-verified live 2026-08-04 (HTTP 200).
    source_id: 'first_nations_dev_institute',
    name: 'First Nations Development Institute grantmaking',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.firstnations.org/grantmaking/',
    sponsor_name: 'First Nations Development Institute',
    resource_title: 'First Nations Development Institute grant programs',
    resource_summary: 'Native-led grantmaker funding Native-controlled nonprofits and tribal programs: community economic development, food systems, youth, language/culture, and stewardship.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['nonprofit', 'tribal', 'school'],
    need_categories: ['operations', 'programs', 'capital', 'agriculture', 'education', 'economic_development', 'food'],
    geography: { national: true, states: [] },
    keywords: ['native american', 'indigenous', 'tribal', 'first nations', 'native-led', 'reservation', 'native community'],
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    // Charitable trust from the Keepseagle v. Vilsack settlement — grants to
    // orgs serving Native farmers and ranchers (nonprofits, educational orgs,
    // CDFIs, tribal orgs). base_url fetch-verified live 2026-08-04 (HTTP 200).
    source_id: 'native_american_ag_fund',
    name: 'Native American Agriculture Fund',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://nativeamericanagriculturefund.org/',
    sponsor_name: 'Native American Agriculture Fund',
    resource_title: 'Native American Agriculture Fund grants',
    resource_summary: 'Grants to nonprofits, educational organizations, CDFIs, and tribal organizations serving Native American farmers and ranchers.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['nonprofit', 'tribal', 'school'],
    need_categories: ['agriculture', 'economic_development', 'education', 'food'],
    geography: { national: true, states: [] },
    keywords: ['native american', 'indigenous', 'tribal', 'farmer', 'rancher', 'agriculture', 'reservation'],
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  {
    source_id: 'imls_library_museum',
    name: 'Institute of Museum and Library Services grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.imls.gov/grants',
    sponsor_name: 'Institute of Museum and Library Services',
    resource_title: 'IMLS grants',
    resource_summary: 'Official IMLS grant page for libraries, museums, archives, and related public or nonprofit institutions.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['nonprofit', 'government', 'school'],
    need_categories: ['library_media', 'community_facilities', 'education', 'technology', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 64,
  },
  {
    source_id: 'cdc_grants',
    name: 'CDC grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.cdc.gov/grants',
    sponsor_name: 'Centers for Disease Control and Prevention',
    resource_title: 'CDC grants',
    resource_summary: 'Official CDC grants page for public-health departments, tribes, nonprofits, schools, and eligible partners.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'school'],
    need_categories: ['medical', 'mental_health', 'substance_recovery', 'public_safety', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 66,
  },
  {
    source_id: 'samhsa_grants',
    name: 'SAMHSA grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.samhsa.gov/grants',
    sponsor_name: 'Substance Abuse and Mental Health Services Administration',
    resource_title: 'SAMHSA grants',
    resource_summary: 'Official SAMHSA grants page for mental health, substance-use recovery, prevention, and behavioral-health programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'school'],
    need_categories: ['mental_health', 'substance_recovery', 'medical', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 67,
  },
  {
    source_id: 'hud_homeless_assistance',
    name: 'HUD homeless assistance programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.hud.gov/program_offices/comm_planning/homeless',
    sponsor_name: 'U.S. Department of Housing and Urban Development',
    resource_title: 'HUD homeless assistance',
    resource_summary: 'Official HUD homeless-assistance entry point for Continuum of Care, Emergency Solutions Grants, and related homelessness programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'church', 'ministry'],
    need_categories: ['housing', 'housing_development', 'mental_health', 'medical', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 66,
  },
  {
    source_id: 'ovw_grants',
    name: 'Office on Violence Against Women grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.justice.gov/ovw/grant-programs',
    sponsor_name: 'U.S. Department of Justice Office on Violence Against Women',
    resource_title: 'OVW grant programs',
    resource_summary: 'Official DOJ OVW grant-program page for violence-prevention, survivor services, transitional housing, and related justice programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'law_enforcement'],
    need_categories: ['domestic_violence', 'housing', 'mental_health', 'public_safety', 'legal', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 66,
  },
  {
    source_id: 'bja_second_chance',
    name: 'BJA Second Chance Act resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://bja.ojp.gov/program/second-chance-act/overview',
    sponsor_name: 'Bureau of Justice Assistance',
    resource_title: 'Second Chance Act program',
    resource_summary: 'Official BJA Second Chance Act overview for reentry, reintegration, and justice-involved workforce/community programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'church', 'ministry'],
    need_categories: ['reentry', 'workforce', 'employment', 'housing', 'mental_health', 'substance_recovery', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 65,
  },
  {
    source_id: 'petsmart_charities_grants',
    name: 'PetSmart Charities grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://petsmartcharities.org/pro/grants',
    sponsor_name: 'PetSmart Charities',
    resource_title: 'PetSmart Charities grant programs',
    resource_summary: 'Animal-welfare grant program page for eligible animal shelters, rescues, and community partners. GrantFlow treats this as a portal/directory until a specific open grant is parsed.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['nonprofit', 'government'],
    need_categories: ['animal_welfare', 'capacity_building', 'equipment', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 63,
  },
  {
    source_id: 'petco_love_grants',
    name: 'Petco Love grant opportunities',
    source_type: 'directory',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://petcolove.org/partners/grants/',
    sponsor_name: 'Petco Love',
    resource_title: 'Petco Love grant opportunities',
    resource_summary: 'Animal-welfare grant portal for eligible shelter and rescue partners. GrantFlow treats this as a portal/directory until a specific open grant is parsed.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['nonprofit', 'government'],
    need_categories: ['animal_welfare', 'capacity_building', 'equipment', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 62,
  },
  {
    source_id: 'aspca_grants',
    name: 'ASPCA grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://www.aspcapro.org/grants',
    sponsor_name: 'ASPCA',
    resource_title: 'ASPCA grants',
    resource_summary: 'Animal-welfare grant information for eligible organizations. GrantFlow treats this as a portal/directory until a specific open grant is parsed.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['nonprofit', 'government'],
    need_categories: ['animal_welfare', 'capacity_building', 'equipment', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 61,
  },
  {
    source_id: 'sba_grants',
    name: 'SBA grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.sba.gov/funding-programs/grants',
    sponsor_name: 'U.S. Small Business Administration',
    resource_title: 'SBA grants',
    resource_summary: 'Official SBA grants page. SBA grants are limited and are not ordinary practice-startup money; loans are not surfaced here unless a profile explicitly allows loan products elsewhere.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['business', 'farm'],
    need_categories: ['capital', 'operations', 'technology', 'agriculture', 'legal', 'startup', 'equipment'],
    keywords: ['small business', 'rural business', 'farm', 'farmer', 'agribusiness', 'startup'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 62,
  },
  {
    source_id: 'sba_veteran_business',
    name: 'SBA veteran-owned business resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.sba.gov/business-guide/grow-your-business/veteran-owned-businesses',
    sponsor_name: 'U.S. Small Business Administration',
    resource_title: 'SBA veteran-owned business resources',
    resource_summary: 'Official SBA resource page for veterans, service members, and military spouses starting or growing a business. This is resource guidance, not guaranteed funding.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['veteran', 'active_duty', 'guard_reserve', 'transitioning_service_member', 'military_spouse'],
    need_categories: ['veteran_startup', 'military_startup'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'sba_vboc',
    name: 'SBA Veterans Business Outreach Centers',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.sba.gov/local-assistance/resource-partners/veterans-business-outreach-centers-vboc',
    sponsor_name: 'U.S. Small Business Administration',
    resource_title: 'Veterans Business Outreach Center program',
    resource_summary: 'Official SBA VBOC program resource for veteran and military-community entrepreneurs seeking business training, counseling, and startup support.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['veteran', 'active_duty', 'guard_reserve', 'transitioning_service_member', 'military_spouse'],
    need_categories: ['veteran_startup', 'military_startup'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 71,
  },
  {
    source_id: 'military_onesource',
    name: 'Military OneSource',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.militaryonesource.mil/',
    sponsor_name: 'U.S. Department of Defense',
    resource_title: 'Military OneSource support resources',
    resource_summary: 'Official Department of Defense support portal for service members, military spouses, and families. Covers active-duty, Guard/Reserve, transition, education, career, financial, and family support resources.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['active_duty', 'guard_reserve', 'transitioning_service_member', 'military_spouse'],
    need_categories: ['active_duty_support', 'military_transition', 'military_spouse_support'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 73,
  },
  {
    source_id: 'mycaa',
    name: 'MyCAA Scholarship',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://mycaa.militaryonesource.mil/mycaa/',
    sponsor_name: 'U.S. Department of Defense',
    resource_title: 'MyCAA Scholarship',
    resource_summary: 'Official Military Spouse Career Advancement Account Scholarship portal for eligible military spouses pursuing licenses, certificates, certifications, or associate degrees.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['military_spouse'],
    need_categories: ['military_spouse_support', 'education', 'employment'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.SCHOLARSHIP],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'dol_tap',
    name: 'DOL Transition Assistance Program',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.dol.gov/agencies/vets/programs/tap',
    sponsor_name: 'U.S. Department of Labor',
    resource_title: 'Transition Assistance Program employment resources',
    resource_summary: 'Official DOL VETS transition employment resource for separating and transitioning service members, veterans, and military spouses.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['transitioning_service_member', 'active_duty', 'veteran', 'military_spouse'],
    need_categories: ['military_transition', 'employment', 'startup'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'sba_boots_to_business',
    name: 'SBA Boots to Business',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.sba.gov/sba-learning-platform/boots-business',
    sponsor_name: 'U.S. Small Business Administration',
    resource_title: 'Boots to Business entrepreneurship training',
    resource_summary: 'Official SBA entrepreneurship training resource for transitioning service members, veterans, National Guard/Reserve members, and military spouses.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['transitioning_service_member', 'active_duty', 'guard_reserve', 'veteran', 'military_spouse'],
    need_categories: ['military_startup', 'veteran_startup'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'wv_sbdc_funding',
    name: 'West Virginia SBDC funding resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://wvsbdc.com/services/funding/',
    sponsor_name: 'West Virginia Small Business Development Center',
    resource_title: 'WV SBDC funding resources',
    resource_summary: 'West Virginia Small Business Development Center funding-resource page for small business owners and startup founders. Loan products still remain gated by user preference.',
    directory: true, loan_allowed: true, cost_share_allowed: false,
    applicant_types: ['business', 'individual', 'veteran'],
    need_categories: ['startup', 'capital', 'operations', 'equipment'],
    geography: { national: false, states: ['WV'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 73,
  },
  {
    source_id: 'wv_business_funding_resources',
    name: 'West Virginia business funding resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://sos.wv.gov/business/general-information/funding-grant-resources',
    sponsor_name: 'West Virginia Secretary of State',
    resource_title: 'West Virginia funding and grant resources',
    resource_summary: 'Official West Virginia business funding-resource page listing organizations that offer funding, loans, grants, and guidance for West Virginia businesses. Loan products remain gated by user preference.',
    directory: true, loan_allowed: true, cost_share_allowed: false,
    applicant_types: ['business', 'individual', 'veteran'],
    need_categories: ['startup', 'capital', 'operations', 'equipment'],
    geography: { national: false, states: ['WV'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    source_id: 'lsc_grants',
    name: 'Legal Services Corporation grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.lsc.gov/grants',
    sponsor_name: 'Legal Services Corporation',
    resource_title: 'Legal Services Corporation grants',
    resource_summary: 'Official LSC grant information for civil legal aid organizations. This is for eligible legal-services organizations, not a general private law-practice grant.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['nonprofit', 'government'],
    need_categories: ['legal', 'programs', 'operations'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 58,
  },
  {
    source_id: 'oregon_parks_rec_grants',
    name: 'Oregon Parks and Recreation Department grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.oregon.gov/oprd/GRA/Pages/GRA-overview.aspx',
    sponsor_name: 'Oregon Parks and Recreation Department',
    resource_title: 'Oregon parks and recreation grant programs',
    resource_summary: 'Official Oregon parks and recreation grants overview for public recreation, trails, parks, heritage, and local government projects.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'nonprofit'],
    need_categories: ['recreation', 'capital', 'equipment', 'programs'],
    geography: { national: false, states: ['OR'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 76,
  },
  {
    source_id: 'dhs_grants',
    name: 'DHS grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.dhs.gov/dhs-grants',
    sponsor_name: 'U.S. Department of Homeland Security',
    resource_title: 'DHS grants',
    resource_summary: 'Official DHS grants page for preparedness, security, emergency management, and homeland-security programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'vfd', 'law_enforcement'],
    need_categories: ['public_safety', 'emergency', 'equipment', 'technology', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 73,
  },
  {
    source_id: 'doj_grants',
    name: 'Department of Justice grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.justice.gov/grants',
    sponsor_name: 'U.S. Department of Justice',
    resource_title: 'Department of Justice grants',
    resource_summary: 'Official DOJ grants page for public safety, legal services, violence prevention, victim services, and justice programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'law_enforcement'],
    need_categories: ['public_safety', 'legal', 'programs', 'technology'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 71,
  },
  {
    source_id: 'cops_grants',
    name: 'COPS Office grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://cops.usdoj.gov/grants',
    sponsor_name: 'U.S. Department of Justice COPS Office',
    resource_title: 'COPS Office grants',
    resource_summary: 'Official COPS Office grants page for community policing, law-enforcement hiring, equipment, training, and public-safety programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'law_enforcement'],
    need_categories: ['public_safety', 'equipment', 'technology', 'programs'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 70,
  },
  {
    source_id: 'fec_candidate_resources',
    name: 'FEC candidate and committee resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.fec.gov/help-candidates-and-committees/',
    sponsor_name: 'Federal Election Commission',
    resource_title: 'FEC candidate and committee resources',
    resource_summary: 'Official federal campaign-finance resource. This is compliance/funding-process guidance, not a grant or award.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['candidate'],
    need_categories: ['campaign', 'operations'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 64,
  },
  {
    source_id: 'pa_campaign_finance',
    name: 'Pennsylvania campaign finance',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.pa.gov/agencies/dos/programs/voting-and-elections/campaign-finance',
    sponsor_name: 'Pennsylvania Department of State',
    resource_title: 'Pennsylvania campaign finance resources',
    resource_summary: 'Official Pennsylvania campaign-finance resource for candidates and committees. This is state compliance/funding-process guidance, not a grant or guaranteed funding source.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['candidate'],
    need_categories: ['campaign', 'operations'],
    geography: { national: false, states: ['PA'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 66,
  },
  // --- Orphaned funding lanes ported into the OS (2026-07-07, owner directive:
  //     "if there are other crawler lanes that got left out like ECF, port them
  //     in too"). propublica_990 is a REAL API lane (IRS 990 grantmakers); the
  //     rest are honest official program/directory rows via the generic
  //     officialDirectory adapter — never fabricated "apply now" grants. -------
  {
    // IRS 990 grantmaker discovery. ProPublica's Nonprofit Explorer indexes
    // 1.8M+ nonprofit 990 filings (free public API, no key) — the dataset
    // GrantWatch/Candid charge for. The adapter searches grantmaking
    // foundations (NTEE-driven, state-scoped from the profile thesis) and
    // surfaces each as an approach-the-funder PROGRAM row with the ProPublica
    // profile as info_url; it NEVER invents an apply URL or a deadline.
    source_id: 'propublica_990',
    name: 'ProPublica Nonprofit Explorer (IRS 990 grantmakers)',
    source_type: 'api',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://projects.propublica.org/nonprofits/api',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['nonprofit', 'school', 'church', 'ministry', 'government'],
    need_categories: ['*'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'api', requires_env: [], refresh_frequency_days: 7, priority_score: 78,
  },
  {
    source_id: 'arc_dra',
    name: 'Appalachian Regional Commission grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.arc.gov/grants/',
    sponsor_name: 'Appalachian Regional Commission',
    resource_title: 'Appalachian Regional Commission grant programs',
    resource_summary: 'Official ARC grants entry point for economic development, infrastructure, workforce, broadband, and health projects in the 13 Appalachian states.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'tribal', 'nonprofit', 'business'],
    need_categories: ['economic_development', 'infrastructure', 'workforce', 'broadband', 'medical'],
    geography: { national: false, states: ['WV', 'KY', 'OH', 'PA', 'TN', 'VA', 'NC', 'GA', 'AL', 'MS', 'SC', 'MD', 'NY'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 68,
  },
  {
    // NOTE: 'refugee' is not an OS need slug — ORR's cash/medical assistance,
    // employment, and resettlement services map to the existing taxonomy needs
    // below (housing/employment/education/medical/legal).
    source_id: 'orr_refugee',
    name: 'HHS Office of Refugee Resettlement programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.acf.hhs.gov/orr',
    sponsor_name: 'HHS Office of Refugee Resettlement',
    resource_title: 'Office of Refugee Resettlement programs',
    resource_summary: 'Official ORR entry point for refugee cash and medical assistance, employment services, and resettlement support programs, for refugees/new arrivals and the organizations serving them.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['nonprofit', 'government', 'individual', 'family'],
    need_categories: ['housing', 'employment', 'education', 'medical', 'legal'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 66,
  },
  {
    // NOTE: 'foster_youth' is not an OS need slug — Chafee serves current/former
    // foster youth with education, housing, and employment support, which map to
    // the existing taxonomy needs below.
    source_id: 'acf_chafee_foster',
    name: 'Chafee program for youth aging out of foster care',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    // acf.hhs.gov now 301s to acf.gov and the old /cb/program-guide/chafee path
    // 404s there (verified live 2026-08-07). This is the live 200 page for the
    // same program; www.acf.hhs.gov/cb/resource/chafee-foster-care-program
    // redirects here, so keep the canonical target, not the redirector.
    base_url: 'https://acf.gov/cb/grant-funding/john-h-chafee-foster-care-independence-program',
    sponsor_name: 'HHS Administration for Children and Families',
    resource_title: 'John H. Chafee Foster Care Program for Successful Transition to Adulthood',
    resource_summary: 'Official Chafee program information for current and former foster youth: education and training vouchers, housing, employment, and transition-to-adulthood support. This is a benefits lane administered by states.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'student'],
    need_categories: ['education', 'housing', 'employment'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 68,
  },
  {
    source_id: 'ccdf_childcare',
    name: 'Childcare.gov (Child Care and Development Fund assistance)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://childcare.gov',
    sponsor_name: 'HHS Office of Child Care',
    resource_title: 'Childcare.gov child care assistance',
    resource_summary: 'Official federal child-care portal for finding state CCDF child-care subsidies and other help paying for child care for working and studying families.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family'],
    need_categories: ['childcare', 'education', 'employment'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 68,
  },
  {
    // NOTE: 'displaced_worker' is not an OS need slug — dislocated-worker
    // programs are covered by the existing 'workforce'/'employment' needs.
    source_id: 'dol_eta_workforce',
    name: 'DOL Employment and Training Administration grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.dol.gov/agencies/eta/grants',
    sponsor_name: 'U.S. Department of Labor Employment and Training Administration',
    resource_title: 'DOL ETA workforce grants',
    resource_summary: 'Official DOL ETA grants page for workforce development, job training, apprenticeship, and dislocated-worker programs.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['government', 'nonprofit', 'individual'],
    need_categories: ['workforce', 'employment', 'education'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 66,
  },
  {
    // NOTE: 'arts' is not an OS need slug — mapped to the existing
    // 'arts_education' need (nearest taxonomy category).
    source_id: 'nea_neh_arts',
    name: 'National Endowment for the Arts grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.arts.gov/grants',
    sponsor_name: 'National Endowment for the Arts',
    resource_title: 'NEA grants',
    resource_summary: 'Official National Endowment for the Arts grants page for arts organizations, communities, schools, and individual artists/writers (fellowships).',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['nonprofit', 'government', 'school', 'individual'],
    need_categories: ['arts_education', 'programs', 'education'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 63,
  },
  {
    source_id: 'usda_conservation',
    name: 'USDA NRCS conservation programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.nrcs.usda.gov/programs',
    sponsor_name: 'USDA Natural Resources Conservation Service',
    resource_title: 'NRCS conservation programs (EQIP, CSP, and more)',
    resource_summary: 'Official USDA NRCS programs page for conservation cost-share and easement programs for farmers, ranchers, tribes, and local governments: soil, water, energy, and environmental improvements.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['farm', 'government', 'tribal'],
    need_categories: ['agriculture', 'environmental_remediation', 'water_sewer', 'energy'],
    keywords: ['farm', 'farmer', 'rancher', 'agricultural producer', 'conservation', 'eqip', 'csp', 'cost share'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 66,
  },
  {
    source_id: 'hrsa_health_workforce',
    name: 'HRSA Bureau of Health Workforce programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://bhw.hrsa.gov',
    sponsor_name: 'HRSA Bureau of Health Workforce',
    resource_title: 'HRSA health workforce programs (scholarships, loan repayment, grants)',
    resource_summary: 'Official HRSA Bureau of Health Workforce entry point: NHSC/NURSE Corps scholarships and loan repayment for health-profession students and clinicians, plus workforce grants for training organizations.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'nonprofit', 'government'],
    need_categories: ['education', 'medical', 'employment', 'professional_development'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 14, priority_score: 65,
  },
  {
    source_id: 'copay_assistance_foundations',
    name: 'NeedyMeds copay and medical assistance programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.needymeds.org',
    sponsor_name: 'NeedyMeds',
    resource_title: 'NeedyMeds medication and healthcare cost assistance finder',
    resource_summary: 'Directory of patient-assistance programs, copay assistance foundations, drug discount programs, and diagnosis-based medical financial aid. A directory/referral lane, not a direct cash grant.',
    // Curated match vocabulary (see cancer_care). NeedyMeds is DIAGNOSIS-agnostic
    // — it indexes patient-assistance programs by condition — so these name the
    // cost/medication axis it genuinely covers rather than claiming any specific
    // disease. Do NOT add broad disease names here to make gaps disappear: that
    // would manufacture coverage the source does not have (G0).
    keywords: ['copay', 'copayment', 'prescription', 'medication', 'patient assistance', 'drug costs', 'diabetes', 'insulin', 'hypercholesterolemia', 'high cholesterol'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family'],
    need_categories: ['medical', 'medication', 'medical_bills', 'cancer_support'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  {
    // SAH/SHA are REAL grants (statutory dollar caps, real application via
    // VA Form 26-4555), so this is a DIRECT_GRANT lane, not a directory.
    source_id: 'va_housing_grants',
    name: 'VA disability housing grants (SAH/SHA)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.va.gov/housing-assistance/disability-housing-grants/',
    sponsor_name: 'U.S. Department of Veterans Affairs',
    resource_title: 'VA Specially Adapted Housing (SAH) and Special Home Adaptation (SHA) grants',
    resource_summary: 'Official VA disability housing grants for veterans and service members with qualifying service-connected disabilities: buy, build, or adapt a home for independent living. Apply online or with VA Form 26-4555.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['veteran', 'active_duty'],
    need_categories: ['housing', 'disability', 'veterans'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  // ── County & city programs lane (2026-07-08) — the fleet's #1 structural
  //    gap: EVERY scanned profile lacked a county_city source. These are honest
  //    national LOCATORS that resolve to the profile's own county/city via the
  //    geo-aware countyCityDirectoryAdapter (candidate is titled with the
  //    profile's place and, where the site supports it, deep-linked by ZIP). ──
  {
    source_id: 'usa_gov_local_governments',
    name: 'USA.gov local government directory',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.usa.gov/local-governments',
    sponsor_name: 'USA.gov',
    resource_title: 'County & city government assistance programs (USA.gov directory)',
    resource_summary: 'Official USA.gov index of city, county, and town government websites — the front door to locally administered assistance (housing, utility, emergency, human services) that never appears in federal or state catalogs.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['*'],
    need_categories: ['*'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 62,
  },
  {
    source_id: 'hud_resource_locator',
    name: 'HUD Resource Locator (local housing offices & programs)',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://resources.hud.gov',
    sponsor_name: 'U.S. Department of Housing and Urban Development',
    resource_title: 'Local housing help — HUD Resource Locator',
    resource_summary: 'Official HUD map/locator for local Public Housing Agencies, HUD-approved housing counselors, multifamily and homeless-assistance resources near a given address — county/city-level housing help.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    // NOTE: homelessness maps to the OS 'housing' need slug (no separate slug).
    need_categories: ['housing', 'emergency'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 64,
  },
  {
    source_id: 'findhelp_local_programs',
    name: 'findhelp.org local assistance programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.findhelp.org',
    // ZIP-scoped deep link — the countyCityDirectoryAdapter substitutes the
    // profile's ZIP so the candidate lands on THEIR county/city programs.
    url_template: 'https://www.findhelp.org/search_results/{zip}',
    sponsor_name: 'findhelp (Aunt Bertha)',
    resource_title: 'Local assistance programs near you (findhelp)',
    resource_summary: 'ZIP-code-driven directory of free and reduced-cost local programs (food, housing, transit, money, care) run by county agencies, cities, churches, and charities — the hyperlocal safety-net layer.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'student'],
    need_categories: ['*'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 66,
  },
  // ── State-programs lane: OH + WA (adapter-wishlist states 2026-07-08;
  //    2 OH profiles + 1 WA profile had NO state-specific source). Mirrors the
  //    kynect_benefits (KY) shape: official portal, honest BENEFIT locator. ──
  {
    source_id: 'oh_benefits',
    name: 'Ohio Benefits portal',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://benefits.ohio.gov',
    sponsor_name: 'State of Ohio',
    resource_title: 'Ohio Benefits (state assistance portal)',
    resource_summary: 'Official Ohio benefits portal for Medicaid health coverage, SNAP food assistance, cash assistance (Ohio Works First), child care, and other household supports.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'student'],
    need_categories: ['housing', 'food', 'medical', 'energy', 'caregiving', 'childcare', 'survivor_benefits'],
    geography: { national: false, states: ['OH'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 78,
  },
  {
    source_id: 'oh_college_opportunity_grant',
    name: 'Ohio College Opportunity Grant (OCOG)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://highered.ohio.gov/initiatives/affordability/ocog/ocog',
    sponsor_name: 'Ohio Department of Higher Education',
    resource_title: 'Ohio College Opportunity Grant (OCOG)',
    resource_summary: 'Ohio\'s need-based state grant for resident undergraduates (FAFSA-driven, awarded by EFC/SAI and income) at Ohio public, private, and eligible proprietary institutions.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'individual'],
    need_categories: ['education'],
    geography: { national: false, states: ['OH'] },
    default_kinds: [OPPORTUNITY_KIND.SCHOLARSHIP],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 76,
  },
  {
    source_id: 'wa_connection_benefits',
    name: 'Washington Connection benefits portal',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.washingtonconnection.org',
    sponsor_name: 'Washington State DSHS',
    resource_title: 'Washington Connection (state assistance portal)',
    resource_summary: 'Official Washington State portal (DSHS) for food, cash, child care, long-term care, and Medicare Savings programs — one application across WA household supports.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'student'],
    need_categories: ['housing', 'food', 'medical', 'energy', 'caregiving', 'childcare', 'survivor_benefits'],
    geography: { national: false, states: ['WA'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 78,
  },
  {
    source_id: 'wa_college_grant',
    name: 'Washington College Grant (WSAC)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://wsac.wa.gov/wcg',
    sponsor_name: 'Washington Student Achievement Council',
    resource_title: 'Washington College Grant',
    resource_summary: 'Washington\'s largest state financial-aid program: income-based grants covering up to full tuition at WA public colleges, universities, and approved career-training programs.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['student', 'individual'],
    need_categories: ['education'],
    geography: { national: false, states: ['WA'] },
    default_kinds: [OPPORTUNITY_KIND.SCHOLARSHIP],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 76,
  },
  // ── Disease-specific lane: mobility impairment + neurodivergent (adapter
  //    wishlist 2026-07-08 — 2 profiles each had NO disease-specific source).
  //    `keywords` feed coverageEvidenceService.conditionCoveredBySource. ──
  {
    source_id: 'reeve_foundation_paralysis',
    name: 'Christopher & Dana Reeve Foundation — paralysis & mobility support',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.christopherreeve.org/todays-care/get-support/',
    sponsor_name: 'Christopher & Dana Reeve Foundation',
    resource_title: 'Reeve Foundation paralysis & mobility-impairment support',
    resource_summary: 'National Paralysis Resource Center: information specialists, peer support, and pointers to financial help (adaptive equipment, home modification, wheelchair funding) for people living with paralysis or mobility impairment.',
    keywords: ['mobility impairment', 'mobility', 'paralysis', 'spinal cord injury', 'wheelchair', 'adaptive equipment', 'physical disability', 'physical impairment'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical', 'disability'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'autism_speaks_family_support',
    name: 'Autism Speaks family services & financial resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.autismspeaks.org/financial-autism-support',
    sponsor_name: 'Autism Speaks',
    resource_title: 'Autism & neurodivergent family financial-support resources',
    resource_summary: 'Directory of financial supports for autistic and neurodivergent people and their families: family grant programs, care funding, ABLE accounts, and state/community resources.',
    keywords: ['neurodivergent', 'autism', 'adhd', 'developmental disability', 'neurodiversity'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family'],
    need_categories: ['medical', 'disability', 'caregiving'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  // ── Disease-specific lane: adapter wishlist 2026-07-11 (Amy: hip
  //    replacement ×2, PTSD, chronic kidney disease, hypertension profiles
  //    each had NO disease-specific source). Same honest-locator shape. ──
  {
    source_id: 'arthritis_foundation_help',
    name: 'Arthritis Foundation — joint surgery & mobility resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.arthritis.org/liveyes/helpline',
    sponsor_name: 'Arthritis Foundation',
    resource_title: 'Arthritis Foundation help line & financial-resource navigation',
    resource_summary: 'National helpline and resource navigation for people with arthritis or facing joint-replacement surgery: financial-assistance pointers (treatment costs, insurance appeals, medication programs), care planning, and local support.',
    keywords: ['hip replacement', 'joint replacement', 'knee replacement', 'arthritis', 'orthopedic surgery', 'joint surgery'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical', 'disability'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'samhsa_findtreatment',
    name: 'SAMHSA FindTreatment.gov — mental health & PTSD treatment locator',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://findtreatment.gov',
    sponsor_name: 'Substance Abuse and Mental Health Services Administration',
    resource_title: 'FindTreatment.gov — confidential mental-health & substance-use treatment locator',
    resource_summary: 'Official SAMHSA locator for state-licensed mental-health and substance-use treatment, including PTSD and trauma care; filters for sliding-scale fees, payment assistance, and free/low-cost programs.',
    // Real profiles spell diagnoses out ("post-traumatic stress disorder", "major
    // depressive disorder"); token matching does not stem or expand acronyms, so
    // the curated vocabulary must carry BOTH forms or SAMHSA — which plainly does
    // cover them — reads as no lane at all. Same class as 'diabetic' vs 'diabetes'.
    keywords: ['ptsd', 'post-traumatic stress disorder', 'post traumatic stress disorder', 'trauma', 'mental health treatment', 'depression', 'depressive disorder', 'major depressive disorder', 'anxiety', 'substance use', 'counseling'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    source_id: 'american_kidney_fund',
    name: 'American Kidney Fund — patient assistance grants',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.kidneyfund.org/all-about-kidneys/getting-financial-help',
    sponsor_name: 'American Kidney Fund',
    resource_title: 'American Kidney Fund financial assistance (dialysis & kidney disease)',
    resource_summary: 'National patient-assistance programs for people with chronic kidney disease and kidney failure: health-insurance premium help (HIPP), emergency grants for transportation/medication/utilities, and disaster relief for dialysis patients.',
    keywords: ['chronic kidney disease', 'kidney disease', 'kidney failure', 'dialysis', 'esrd', 'renal', 'transplant'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical', 'disability'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    source_id: 'needymeds_diagnosis_assistance',
    name: 'NeedyMeds — diagnosis-based assistance programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.needymeds.org/diagnosis_based_assistance',
    sponsor_name: 'NeedyMeds',
    resource_title: 'NeedyMeds diagnosis-based assistance directory (hypertension, heart disease & chronic conditions)',
    resource_summary: 'Directory of assistance programs organized by diagnosis — medication cost help, copay cards, and condition-specific funds for hypertension, high blood pressure, heart disease, diabetes, and other chronic conditions.',
    // 'diabetic' is the ADJECTIVE form real profiles actually type (prod
    // 2026-07-16 carried the condition "diabetic", not "diabetes"). Token
    // matching does not stem, so the curated vocabulary must carry both forms
    // or a genuinely covered condition mints a false wishlist entry.
    // 'obesity'/'bariatric' added 2026-07-26: NeedyMeds' diagnosis directory
    // includes obesity/weight-management programs, and the prod scoreboard
    // carried an unfillable "no lane exists for obesity" wishlist entry.
    keywords: ['hypertension', 'high blood pressure', 'heart disease', 'diabetes', 'diabetic', 'obesity', 'bariatric', 'medication assistance', 'copay assistance', 'chronic condition'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  // ── Adapter-wishlist lanes (2026-07-15). Amy's fleet coverage-gap scoreboard
  //    reported no disease/need lane for transportation, deaf/hearing loss,
  //    assistive technology, or sleep apnea. All URLs verified live 2026-07-15
  //    (curl -L → 200 with a browser UA).
  {
    source_id: 'mercy_medical_angels',
    name: 'Mercy Medical Angels — travel to medical care',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.mercymedical.org/',
    sponsor_name: 'Mercy Medical Angels',
    resource_title: 'Mercy Medical Angels — free transportation to medical treatment',
    resource_summary: 'Charitable transportation to medical care at no cost to the patient: volunteer air transport (Mid-Atlantic), plus commercial airline tickets, ground transportation, and gas cards nationwide. Eligibility guidelines apply, so this is surfaced for review rather than promised as an award.',
    keywords: ['transportation', 'medical transportation', 'travel to treatment', 'gas card', 'bus pass', 'rides to appointments', 'non-emergency medical transportation'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['transportation', 'medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'pan_foundation_nemt_directory',
    name: 'PAN Foundation — non-emergency medical transportation directory',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.panfoundation.org/nemt-directory/',
    sponsor_name: 'Patient Access Network (PAN) Foundation',
    resource_title: 'PAN Foundation non-emergency medical transportation (NEMT) directory',
    resource_summary: 'Directory of organizations that help patients get to medical appointments — ground rides, volunteer drivers, air travel, and fuel assistance, listed by need and region. A locator: programs set their own eligibility.',
    keywords: ['transportation', 'medical transportation', 'non-emergency medical transportation', 'nemt', 'rides to appointments', 'volunteer driver', 'travel assistance'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['transportation', 'medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  {
    source_id: 'hlaa_financial_assistance',
    name: 'Hearing Loss Association of America — hearing help & financial assistance',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://hearingloss.org/hearing-help/financial-assistance/',
    sponsor_name: 'Hearing Loss Association of America',
    resource_title: 'HLAA financial assistance for hearing aids & hearing care',
    resource_summary: 'Guide to financial help for people who are deaf or hard of hearing: hearing-aid assistance programs, state and national funds, and low-cost hearing-care routes. Eligibility and available funds vary by program, so this is surfaced for review rather than promised as an award.',
    // 'hearing impairment' / 'hearing' are the CANONICAL FLAG forms profileHelpers
    // mints (`hearing_impairment`); without them the flag reads as an uncovered
    // condition even though this is exactly its lane.
    keywords: ['deaf', 'hard of hearing', 'hearing loss', 'hearing impairment', 'hearing', 'hearing aid', 'hearing aids', 'cochlear implant', 'hearing care', 'assistive listening'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical', 'disability', 'equipment'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'at3_state_at_programs',
    name: 'AT3 Center — state assistive technology (AT Act) programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.at3center.net/state-at-programs',
    sponsor_name: 'AT3 Center (Assistive Technology Act programs)',
    resource_title: 'State assistive technology program finder (device demo, borrowing & reuse)',
    resource_summary: 'Finder for the federally funded AT Act program in every state and territory: try-before-you-buy device demonstration, short-term device borrowing, and refurbished device reuse/exchange — services that do not create debt. NOTE: some states ALSO list a separate "financial loan" / alternative-financing product (repayable debt) on the same page; those are governed by the profile\'s own loan preference, which is why this source is declared loan_allowed.',
    keywords: ['assistive technology', 'assistive device', 'adaptive equipment', 'durable medical equipment', 'device loan', 'device reuse', 'wheelchair', 'communication device', 'at act'],
    directory: true, loan_allowed: true, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['disability', 'equipment', 'technology', 'medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  {
    source_id: 'asaa_cpap_assistance',
    name: 'CPAP Assistance Program (American Sleep Apnea Association / WSCN)',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.sleephealth.org/asaa/cap-program/',
    sponsor_name: 'American Sleep Apnea Association (Wellness, Sleep & Circadian Network)',
    resource_title: 'CPAP Assistance Program — low-cost CPAP machines, masks & supplies',
    resource_summary: 'Assistance program for sleep-apnea patients who cannot afford CPAP equipment: donated machines refurbished to the applicant\'s own prescription, plus mask and yearly-supply packages. Not a loan and not repayable — a flat program fee applies (machine package and supply tiers are priced separately), and a current CPAP prescription is required.',
    keywords: ['sleep apnea', 'cpap', 'apnea', 'bipap', 'sleep study', 'cpap mask', 'cpap supplies', 'sleep disorder'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical', 'equipment'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  // ── Adapter-wishlist lanes (2026-07-26). Coverage-gap scoreboard entries the
  //    nightly report kept asking the owner to hand-adjudicate: "visual
  //    impairment" / "retina detachment (left eye)" (no vision lane existed),
  //    "anoxic brain injury" (no brain-injury lane), and "medical debt" (a real,
  //    fillable assistance class — hospital charity care). URLs verified live
  //    2026-07-26 (curl -L → 200 with a browser UA; base_url is the final
  //    post-redirect URL).
  {
    source_id: 'vision_aware_resources',
    name: 'VisionAware (APH ConnectCenter) — blindness & low-vision resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://aphconnectcenter.org/visionaware/',
    sponsor_name: 'American Printing House for the Blind (APH ConnectCenter)',
    resource_title: 'VisionAware — resources for adults living with vision loss',
    resource_summary: 'National resource hub for adults who are blind or have low vision: independent-living skills, assistive-technology guidance, and directories of local vision-rehabilitation services and support programs. A directory, not a direct award.',
    // 'visual impairment' is BOTH the free-text form real profiles carry and the
    // canonical flag profileHelpers mints (`visual_impairment` — underscores are
    // normalized before matching); 'retina'/'retinal' cover diagnosis phrasings
    // like "retina detachment (left eye)" (laterality words are generic-filtered).
    keywords: ['blind', 'blindness', 'visual impairment', 'visually impaired', 'low vision', 'vision loss', 'legally blind', 'macular degeneration', 'retina', 'retinal', 'retinopathy', 'glaucoma'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['vision_support', 'disability', 'medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    // Covers ACQUIRED brain injury broadly — anoxic/hypoxic injuries are NOT
    // TBIs, so a TBI-only source would leave "anoxic brain injury" uncovered.
    source_id: 'biausa_brain_injury_resources',
    name: 'Brain Injury Association of America — help & resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://biausa.org/',
    sponsor_name: 'Brain Injury Association of America',
    resource_title: 'BIAA National Brain Injury Information Center & state affiliates',
    resource_summary: 'National information and resource network for people living with traumatic or acquired (including anoxic/hypoxic) brain injury and their caregivers: the National Brain Injury Information Center, state affiliate programs, and support-service directories. A directory, not a direct award.',
    // 'tbi survivor' is load-bearing for the CANONICAL FLAG `tbi`: coverage terms
    // under 4 chars are filtered, so a bare 'tbi' keyword can never match — but
    // the REVERSE direction (condition ⊂ keyword) matches the 'tbi' token inside
    // the multi-word phrase.
    keywords: ['brain injury', 'traumatic brain injury', 'acquired brain injury', 'anoxic brain injury', 'anoxic', 'hypoxic', 'head injury', 'tbi survivor', 'concussion', 'post-concussion'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['brain_injury_support', 'disability', 'medical', 'caregiving'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    // "medical debt" reached the disease-lane wishlist because it lives in a
    // diagnosis field on a real profile; the honest coverage answer is not a
    // disease lane but a real, fillable assistance class: hospital
    // financial-assistance (charity care) applications, which nonprofit
    // hospitals are required to offer. Dollar For screens eligibility and
    // helps patients prepare and file.
    source_id: 'dollar_for_charity_care',
    name: 'Dollar For — hospital charity care (medical debt) assistance',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://dollarfor.org/',
    sponsor_name: 'Dollar For',
    resource_title: 'Dollar For — get hospital bills forgiven through charity care',
    resource_summary: 'National nonprofit that helps patients erase or reduce hospital bills through the hospital\'s own financial-assistance (charity care) policy: eligibility screening plus hands-on help preparing and filing the application. Not a loan; no fee.',
    keywords: ['medical debt', 'medical bills', 'hospital bills', 'hospital bill', 'hospital debt', 'charity care', 'financial assistance policy', 'bill forgiveness'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical_bills', 'medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  // ── Canonical-flag totality lanes (2026-07-26). Every HEALTH_DIAGNOSIS_FLAGS
  //    token (profileHelpers) must be covered by a disease_specific source or it
  //    mints the same unfillable "no lane exists" wishlist noise the moment any
  //    profile carries it — hiv / amputee / rare_disease / terminal had no lane
  //    (guard: coverageEvidenceService.test.js flag-coverage totality). URLs
  //    verified live 2026-07-26 (curl -L → 200 with a browser UA).
  {
    // NOTE: ryanwhite.hrsa.gov itself WAFs non-browser fetchers (403); the care
    // locator is the patient-facing surface and answers 200.
    source_id: 'findhivcare_ryan_white',
    name: 'HRSA Find HIV Care (Ryan White program locator)',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://findhivcare.hrsa.gov/',
    sponsor_name: 'Health Resources and Services Administration',
    resource_title: 'Find Ryan White HIV/AIDS Program medical care & support services',
    resource_summary: 'Official HRSA locator for Ryan White HIV/AIDS Program providers: HIV medical care, medications (ADAP), and support services for people with HIV who are uninsured or underinsured. A benefits/services lane, not a grant.',
    // Coverage terms under 4 chars are filtered, so bare 'hiv' can never match;
    // the multi-word phrases cover the canonical `hiv` flag via the reverse
    // (condition ⊂ keyword) direction, and 'aids' covers free-text forms.
    keywords: ['hiv care', 'hiv positive', 'hiv treatment', 'living with hiv', 'aids', 'ryan white', 'antiretroviral'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical', 'medication'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'amputee_coalition_resources',
    name: 'Amputee Coalition — limb loss resources & support',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://amputee-coalition.org/',
    sponsor_name: 'Amputee Coalition',
    resource_title: 'Amputee Coalition limb loss & limb difference resources',
    resource_summary: 'National nonprofit for people with limb loss or limb difference: peer support, resource navigation, and guidance on prosthetic coverage and assistance programs. A directory, not a direct award.',
    keywords: ['amputee', 'amputation', 'limb loss', 'limb difference', 'prosthetic', 'prosthetics', 'prosthesis'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['disability', 'medical', 'equipment'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    source_id: 'nord_rare_disease_assistance',
    name: 'NORD — rare disease patient assistance programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://rarediseases.org/patient-assistance-programs/',
    sponsor_name: 'National Organization for Rare Disorders',
    resource_title: 'NORD patient assistance programs (rare diseases)',
    resource_summary: 'NORD patient-assistance programs for people with rare diseases: medication and treatment cost help, travel and lodging assistance for care, and disease-specific funds. Program availability varies, so this is surfaced for review rather than promised as an award.',
    keywords: ['rare disease', 'rare disorder', 'orphan disease', 'orphan drug', 'undiagnosed disease'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical', 'medication', 'medical_bills'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    // Covers the canonical `terminal` flag via the reverse direction of
    // 'terminal illness' / 'terminal diagnosis' (see the tbi note above).
    source_id: 'caringinfo_serious_illness',
    name: 'CaringInfo (NHPCO) — serious & terminal illness care resources',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.caringinfo.org/',
    sponsor_name: 'National Hospice and Palliative Care Organization',
    resource_title: 'CaringInfo — hospice, palliative & end-of-life care resources',
    resource_summary: 'Consumer resource from NHPCO for people with serious or terminal illness and their caregivers: understanding and finding hospice and palliative care, paying for care (Medicare/Medicaid hospice benefits), and advance-care planning. A directory, not a direct award.',
    keywords: ['terminal illness', 'terminal diagnosis', 'hospice', 'palliative care', 'end of life care', 'life limiting illness'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['medical', 'caregiving'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    // Adapter-wishlist lane (2026-08-02): "clawing effect in hands" — symptom
    // prose a profile typed into a diagnosis field. The 2026-07-26 pass left it
    // an HONEST gap because symptom prose cannot be auto-mapped to a lane; this
    // entry is the human adjudication that closes it: clawing of the hands
    // ("claw hand") is the textbook presentation of Charcot-Marie-Tooth
    // disease and ulnar nerve palsy — neuromuscular / peripheral-nerve
    // conditions the Muscular Dystrophy Association serves (MDA's covered
    // diseases explicitly include CMT). URL verified live 2026-08-02
    // (curl -L → 200 with BOTH a browser UA and the plain fetcher UA; the page
    // names Charcot-Marie-Tooth, neuromuscular, and the MDA Resource Center).
    // cmtausa.org was considered and REJECTED as a base URL: it answers 403 to
    // non-browser fetchers (the ryanwhite.hrsa.gov WAF class above).
    source_id: 'mda_neuromuscular_resources',
    name: 'Muscular Dystrophy Association — services & resource center',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.mda.org/services',
    sponsor_name: 'Muscular Dystrophy Association',
    resource_title: 'MDA services & resource center (neuromuscular disease)',
    resource_summary: 'Muscular Dystrophy Association services for people living with neuromuscular diseases (muscular dystrophy, ALS, Charcot-Marie-Tooth, myasthenia gravis, spinal muscular atrophy): the MDA Resource Center, care-center network, and equipment/resource guidance. A support directory, not a direct award.',
    // Curated match vocabulary (see cancer_care). 'claw hand' / 'clawing' are
    // the symptom forms real profiles type (the 'diabetic' rule: carry the
    // form people write — token matching does not stem); 'als support'
    // carries the sub-4-char token via the reverse direction (the hiv/tbi
    // rule above).
    keywords: ['neuromuscular', 'muscular dystrophy', 'charcot-marie-tooth', 'charcot marie tooth', 'peripheral neuropathy', 'neuropathy', 'claw hand', 'clawing', 'ulnar nerve', 'nerve palsy', 'foot drop', 'myasthenia gravis', 'spinal muscular atrophy', 'als support', 'amyotrophic lateral sclerosis'],
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran'],
    need_categories: ['neuromuscular_support', 'disability', 'medical'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  // ── Benchmark-gap lanes (2026-07-13). Structural gaps surfaced by the
  //    12-persona stress cohort: kinship/grandfamily caregivers, heirs'-property
  //    / beginning farmers, and homeschool families had NO dedicated lane. All
  //    URLs verified live 2026-07-13 (curl -L → 200 with a browser UA).
  {
    // NFCSP funds caregiver services through local AAAs — including OLDER
    // RELATIVE CAREGIVERS (grandparents 55+ raising grandchildren), the
    // grandfamily class no grant feed reaches. A real benefit PROGRAM: the
    // next step (contact your AAA) is on the official page.
    source_id: 'acl_family_caregiver_support',
    name: 'National Family Caregiver Support Program (ACL)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://acl.gov/programs/support-caregivers/national-family-caregiver-support-program',
    sponsor_name: 'Administration for Community Living',
    resource_title: 'National Family Caregiver Support Program (NFCSP)',
    resource_summary: 'Official ACL program funding counseling, respite care, training, and supplemental services for family caregivers — including grandparents and other older relatives (55+) raising children. Services are delivered through local Area Agencies on Aging.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'senior', 'caregiver'],
    need_categories: ['caregiving', 'aging', 'family_support'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.BENEFIT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    // ACL-funded national TA center for kinship/grandfamily caregivers — an
    // honest locator for state kinship navigator programs and support groups.
    source_id: 'gks_network',
    name: 'Grandfamilies & Kinship Support Network',
    source_type: 'directory',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://www.gksnetwork.org',
    sponsor_name: 'Generations United (ACL-funded)',
    resource_title: 'Grandfamilies & Kinship Support Network',
    resource_summary: 'National technical-assistance network for kinship and grandfamily caregivers: state-by-state kinship navigator programs, support services, and resources for grandparents and relatives raising children.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'senior', 'caregiver'],
    need_categories: ['caregiving', 'family_support'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 70,
  },
  {
    // Heirs'-property pathway: establishing a farm number on undivided
    // inherited land is the gate to EVERY USDA program. A standing PROGRAM
    // (eligibility/intake guidance on the official page) — legal-assistance
    // adjacent, never presented as a grant.
    source_id: 'farmers_gov_heirs_property',
    name: 'USDA heirs’ property eligibility (farmers.gov)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.farmers.gov/working-with-us/heirs-property-eligibility',
    sponsor_name: 'U.S. Department of Agriculture',
    resource_title: 'Heirs’ property landowner eligibility (USDA)',
    resource_summary: 'Official USDA guidance for heirs’ property landowners: documentation paths to establish a farm number on undivided inherited land, unlocking FSA, NRCS conservation, and other USDA program eligibility. Includes the Heirs’ Property Relending Program (a LOAN, classified as such).',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['farm', 'individual', 'family'],
    need_categories: ['legal', 'agriculture'],
    keywords: ['farm', 'farmer', 'rancher', 'agricultural producer', 'heirs property', 'farm number'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  {
    // Beginning-farmer hub: the coordination point for FSA/NRCS/RD programs a
    // new producer qualifies for — an honest locator.
    source_id: 'farmers_gov_beginning_farmers',
    name: 'USDA beginning farmers and ranchers (farmers.gov)',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.farmers.gov/your-business/beginning-farmers',
    sponsor_name: 'U.S. Department of Agriculture',
    resource_title: 'USDA beginning farmer and rancher resources',
    resource_summary: 'Official USDA hub for beginning farmers and ranchers: coordinators in every state, farm loan programs, conservation cost-share, crop insurance options, and technical assistance for new and historically underserved producers.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['farm', 'individual', 'family'],
    need_categories: ['agriculture', 'startup', 'equipment'],
    keywords: ['farm', 'farmer', 'rancher', 'agricultural producer', 'beginning farmer', 'young farmer'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  // ── Agriculture lanes (the Anita class, 2026-08-01) ───────────────────────
  // Coverage audit finding: before this block the registry reached USDA Rural
  // Development, NRCS conservation, the heirs'-property pathway and the
  // beginning-farmer hub — but NOT the Farm Service Agency (the actual loan/
  // disaster/CRP administrator every producer deals with), NOT SARE (the one
  // national COMPETITIVE grant a working farmer can win directly), NOT the
  // Value-Added Producer Grant, NOT Cooperative Extension / 1890 & 1994
  // land-grant programs, NOT state departments of agriculture, and NOT the
  // county soil-and-water conservation districts that deliver most cost-share.
  // Every entry is an OFFICIAL .gov/.edu-anchored page; each is classified by
  // what it really is (a locator is a DIRECTORY, a loan lane is loan_allowed,
  // a cost-share lane is cost_share_allowed) — never dressed up as a grant.
  {
    source_id: 'usda_fsa_farm_programs',
    name: 'USDA Farm Service Agency programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.fsa.usda.gov/programs-and-services',
    sponsor_name: 'USDA Farm Service Agency',
    resource_title: 'USDA FSA programs and services (farm loans, disaster, conservation)',
    resource_summary: 'Official USDA Farm Service Agency index of producer programs: direct and guaranteed farm ownership/operating LOANS, microloans, beginning-farmer and historically-underserved set-asides, disaster assistance (ELAP, LFP, NAP), the Conservation Reserve Program, and the county-office network that administers them.',
    directory: true, loan_allowed: true, cost_share_allowed: true,
    applicant_types: ['farm'],
    need_categories: ['agriculture', 'disaster_recovery', 'equipment', 'operations', 'capital'],
    keywords: ['farm', 'farmer', 'rancher', 'agricultural producer', 'farm loan', 'beginning farmer', 'crop insurance', 'conservation reserve'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 76,
  },
  {
    // SARE is the one national program where a WORKING FARMER (not a
    // university) is the named applicant on a competitive grant — the single
    // highest-value agriculture lane for an individual producer.
    source_id: 'sare_farmer_rancher_grants',
    name: 'SARE Farmer/Rancher grants',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.sare.org/grants/',
    // Official portal page is the current apply/info path until a structured
    // regional-call scraper exists; keep DIRECT_GRANT (not directory).
    application_url: 'https://www.sare.org/grants/',
    sponsor_name: 'USDA Sustainable Agriculture Research and Education (SARE)',
    resource_title: 'SARE grants — Farmer/Rancher, Partnership, and Producer grants',
    resource_summary: 'USDA-funded Sustainable Agriculture Research and Education grant programs. The Farmer/Rancher grant is applied for BY the producer to trial a sustainable practice on their own operation; regional offices (Southern SARE covers Kentucky) run their own calls and award ceilings.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['farm'],
    need_categories: ['agriculture', 'research', 'equipment', 'programs'],
    keywords: ['farmer', 'rancher', 'sustainable agriculture', 'agricultural producer', 'farm research', 'sare'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 21, priority_score: 80,
  },
  {
    source_id: 'usda_value_added_producer_grants',
    name: 'USDA Value-Added Producer Grants',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.rd.usda.gov/programs-services/business-programs/value-added-producer-grants',
    application_url: 'https://www.rd.usda.gov/programs-services/business-programs/value-added-producer-grants',
    sponsor_name: 'USDA Rural Development',
    resource_title: 'Value-Added Producer Grant (VAPG)',
    resource_summary: 'USDA Rural Development grants to agricultural producers who process, market, or otherwise add value to what they grow — planning grants and working-capital grants, with set-asides for beginning, veteran, socially-disadvantaged and small/mid-size family farms. Requires matching funds.',
    directory: false, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['farm'],
    need_categories: ['agriculture', 'startup', 'capital', 'operations', 'equipment'],
    keywords: ['agricultural producer', 'value added', 'farm', 'farmer', 'rancher', 'family farm', 'vapg'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 78,
  },
  {
    // Extension + the 1890/1994 land-grant network is how a producer actually
    // REACHES most of the above: a locator, honestly classified as one.
    source_id: 'nifa_extension_land_grant',
    name: 'USDA NIFA Cooperative Extension / land-grant network',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.nifa.usda.gov/about-nifa/how-we-work/extension/cooperative-extension-system',
    sponsor_name: 'USDA National Institute of Food and Agriculture',
    resource_title: 'Cooperative Extension System and the 1862/1890/1994 land-grant universities',
    resource_summary: 'Official USDA NIFA directory of the Cooperative Extension System: a county-level office in nearly every U.S. county, plus the 1890 (historically Black) and 1994 (Tribal) land-grant institutions that run producer outreach, beginning-farmer training, and small-farm technical assistance programs.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['farm', 'individual', 'family', 'school', 'tribal'],
    need_categories: ['agriculture', 'training', 'programs', 'education'],
    keywords: ['farm', 'farmer', 'rancher', 'agricultural producer', 'extension', 'land grant', 'small farm'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 45, priority_score: 68,
  },
  {
    // Soil-and-water conservation districts are the LOCAL delivery arm for
    // cost-share; the national association is the only complete directory.
    source_id: 'conservation_districts_directory',
    name: 'Conservation district locator (NACD)',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://www.nacdnet.org/general-resources/conservation-district-directory/',
    sponsor_name: 'National Association of Conservation Districts',
    resource_title: 'Soil and water conservation district directory',
    resource_summary: 'Directory of the ~3,000 local soil-and-water conservation districts that deliver state and county cost-share for erosion control, fencing, water development, and other on-farm conservation practices — the local counterpart to NRCS EQIP/CSP.',
    directory: true, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['farm', 'government'],
    need_categories: ['agriculture', 'environmental_remediation', 'water_sewer', 'equipment'],
    keywords: ['farm', 'farmer', 'rancher', 'agricultural producer', 'conservation district', 'soil and water', 'cost share'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 60, priority_score: 62,
  },
  {
    // Kentucky specifically (the owner's profile state). KY runs the largest
    // state-funded on-farm cost-share program in the country via KADF; it is a
    // real, applicable-for grant an individual producer wins, and NOTHING in
    // the registry reached it — the state lane held only kynect (benefits).
    source_id: 'ky_agricultural_development_fund',
    name: 'Kentucky Agricultural Development Fund (KADF)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.kyagr.com/agpolicy/Ag-Development-Board.html',
    application_url: 'https://www.kyagr.com/agpolicy/Ag-Development-Board.html',
    sponsor_name: 'Kentucky Department of Agriculture / Governor’s Office of Agricultural Policy',
    resource_title: 'Kentucky Agricultural Development Fund — County Agricultural Investment Program (CAIP) and state cost-share',
    resource_summary: 'Kentucky’s tobacco-settlement-funded agricultural development programs: the County Agricultural Investment Program (CAIP) and related on-farm cost-share for fencing, forage, genetics, farm infrastructure and diversification, administered county by county through the Kentucky Department of Agriculture and the Governor’s Office of Agricultural Policy.',
    directory: false, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['farm'],
    need_categories: ['agriculture', 'equipment', 'capital', 'operations'],
    keywords: ['farm', 'farmer', 'rancher', 'agricultural producer', 'kentucky', 'caip', 'cost share', 'agricultural development'],
    geography: { national: false, states: ['KY'] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 21, priority_score: 80,
  },
  {
    // Farm Credit is the producer-owned lending system. It is a LOAN lane and
    // is declared as one so the doctrine default ("never surface loans as
    // grants") keeps it out of results unless the profile opts in.
    source_id: 'farm_credit_young_beginning_small',
    name: 'Farm Credit Young, Beginning and Small farmer programs',
    source_type: 'directory',
    trust_tier: TRUST_TIER.AGGREGATOR,
    base_url: 'https://farmcredit.com/find-local-lender',
    sponsor_name: 'Farm Credit System',
    resource_title: 'Farm Credit — Young, Beginning and Small (YBS) farmer lending',
    resource_summary: 'Locator for the Farm Credit System’s member associations, which are congressionally mandated to serve Young, Beginning and Small farmers with dedicated credit programs, reduced-rate operating loans, and education. LENDING, not grants.',
    directory: true, loan_allowed: true, cost_share_allowed: false,
    applicant_types: ['farm', 'business'],
    need_categories: ['agriculture', 'capital', 'equipment', 'startup'],
    keywords: ['farm', 'farmer', 'rancher', 'agricultural producer', 'beginning farmer', 'young farmer', 'farm credit'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 60, priority_score: 58,
  },
  {
    // The one national direct-grant program specifically for homeschooling
    // families in financial need (curriculum/materials). A real grant with a
    // real application path — the homeschool lane's anchor.
    source_id: 'hslda_compassion_grants',
    name: 'HSLDA Compassion Grants',
    source_type: 'html',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    // 2026-08-15: /compassion-grants now 301s to the grants-for-homeschooling
    // page (with tracking params) — recorded POST-redirect, tracking stripped,
    // fetch-verified 200 the same day.
    base_url: 'https://hslda.org/explore/grants-for-homeschooling',
    sponsor_name: 'Home School Legal Defense Association',
    resource_title: 'HSLDA Compassion Grants (homeschool families)',
    resource_summary: 'Direct grants for homeschooling families facing financial hardship: curriculum and educational materials support so families can keep homeschooling through crisis.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family'],
    need_categories: ['education', 'curriculum'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 72,
  },
  // ── DIRECT-AWARD anchors for Amy's persistent weak_match categories
  //    (2026-08-15). The flywheel's locator-only weak_match findings ("stored
  //    real candidates but recommended ONLY DIRECTORY locators") have fired
  //    across military_family and foster_youth for weeks — both categories'
  //    mapped lanes are benefit/locator surfaces (military_onesource, Chafee),
  //    so a probe profile could never be handed a direct award. These two are
  //    the national direct-assistance anchors for those situations; both
  //    base_urls fetch-verified 200 on 2026-08-15 (recorded post-redirect).
  //    modestneeds.org (the individual_assistance candidate) did NOT verify —
  //    connection refused from two egress paths — and is deliberately absent:
  //    an unverified source is a guess, not coverage. ──────────────────────────
  {
    source_id: 'operation_homefront',
    name: 'Operation Homefront — Critical Financial Assistance',
    source_type: 'html',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://operationhomefront.org/critical-financial-assistance/',
    sponsor_name: 'Operation Homefront',
    resource_title: 'Critical Financial Assistance for military families',
    resource_summary: 'Direct emergency financial assistance grants (not loans) to military and veteran families: rent/mortgage, utilities, vehicle repair, food, and home items — paid to the provider on the family’s behalf.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'military_spouse'],
    need_categories: ['emergency', 'housing', 'utilities', 'military_spouse_support', 'veterans'],
    keywords: ['military family', 'veteran family', 'critical financial assistance', 'emergency grant', 'rent assistance', 'utility assistance'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    source_id: 'fc2success_scholarships',
    name: 'Foster Care to Success — Scholarships & Grants',
    source_type: 'html',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://www.fc2success.org/programs/scholarships-and-grants/',
    sponsor_name: 'Foster Care to Success',
    resource_title: 'Scholarships and grants for youth from foster care',
    resource_summary: 'Direct scholarships and grants for young people who spent their teen years in foster care: college scholarships, Education & Training Voucher administration, and student support funds.',
    directory: false, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'student'],
    need_categories: ['education', 'scholarship'],
    keywords: ['foster care', 'foster youth', 'aged out', 'scholarship', 'education and training voucher'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  // ── HOUSING-LOSS lane (2026-08-02) ───────────────────────────────────────
  // Two whole real-world situations had NO source in this registry: a HOMEOWNER
  // in foreclosure and a RENTER facing eviction. Verified by grep on
  // 2026-08-02: zero registry occurrences of foreclos*, mortgage, HAF,
  // eviction, ERAP, rental assistance, or legal aid — while the need
  // VOCABULARY has carried them the whole time (needTaxonomy `rent` →
  // 'eviction prevention', `housing` → 'mortgage assistance', `legal` →
  // 'eviction defense'). The words existed; nothing to search existed.
  //
  // All four base_urls verified live 2026-08-02 (fetch → HTTP 200 after
  // redirects; the recorded URL is the FINAL post-redirect URL).
  {
    source_id: 'hud_avoiding_foreclosure',
    name: 'HUD — Avoiding foreclosure & HUD-approved housing counseling',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.hud.gov/topics/avoiding_foreclosure',
    sponsor_name: 'U.S. Department of Housing and Urban Development',
    resource_title: 'Avoid foreclosure — free HUD-approved housing counseling',
    resource_summary: 'Official HUD foreclosure-avoidance hub: how to work with your servicer, what a HUD-approved housing counselor does (the counseling is free), state-by-state foreclosure-avoidance resources, and the counselor search at hud.gov/findacounselor. Also covers rental counseling for tenants facing eviction.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'senior'],
    need_categories: ['housing', 'emergency', 'legal'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    source_id: 'cfpb_rent_and_housing_help',
    name: 'CFPB — Find help paying rent and bills',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.consumerfinance.gov/housing/housing-insecurity/help-for-renters/get-help-paying-rent-and-bills/',
    sponsor_name: 'Consumer Financial Protection Bureau',
    resource_title: 'Emergency rental assistance & renter protections near you',
    resource_summary: 'Official CFPB finder for local emergency rental-assistance programs (back rent, utilities, court costs) by state and county, plus renter protections and what to do when an eviction case is filed.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'senior', 'student'],
    need_categories: ['housing', 'emergency', 'energy'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 74,
  },
  {
    source_id: 'lawhelp_legal_aid',
    name: 'LawHelp.org — free legal aid by state',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.lawhelp.org/',
    sponsor_name: 'Pro Bono Net / Legal Services Corporation network',
    resource_title: 'Free civil legal aid near you (eviction, foreclosure, benefits)',
    resource_summary: 'State-by-state directory of free civil legal aid organizations for people who cannot afford a lawyer — eviction defense, foreclosure defense, benefits appeals, family and consumer law. Companion to the Legal Services Corporation "I need legal help" locator.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'senior'],
    need_categories: ['legal', 'housing', 'emergency'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 45, priority_score: 70,
  },

  // ── CONGREGATION / SACRED-PLACES lane (2026-08-02) ────────────────────────
  // `church` and `ministry` were applicant_types on four unrelated rows
  // (a food-bank locator, HUD homeless assistance, a reentry program and the
  // ProPublica 990 index) and NOTHING else. Measured end-to-end 2026-08-02, a
  // 120-year-old northern-Ohio congregation with a failing roof and boiler got
  // 30 rows headed by "PetSmart Charities grant programs", "Petco Love grant
  // opportunities" and NSF "Combustion and Fire Systems". The National Fund for
  // Sacred Places is the one national program that gives capital grants to
  // congregations for exactly this building — it is an AWARD, not a pointer.
  {
    source_id: 'national_fund_sacred_places',
    name: 'National Fund for Sacred Places',
    source_type: 'html',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://www.fundforsacredplaces.org/',
    sponsor_name: 'Partners for Sacred Places & National Trust for Historic Preservation',
    resource_title: 'Capital grants for congregations with historic buildings',
    resource_summary: 'National matching capital grants plus technical assistance for congregations of any denomination stewarding a historic building — roofs, masonry, windows, mechanical systems — awarded to the congregation itself.',
    directory: false, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['church', 'ministry', 'nonprofit'],
    need_categories: ['capital', 'operations', 'programs', 'historic_preservation'],
    keywords: ['sacred places', 'congregation', 'church building', 'historic preservation', 'capital campaign', 'roof', 'masonry'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 78,
  },
  {
    source_id: 'partners_sacred_places',
    name: 'Partners for Sacred Places',
    source_type: 'directory',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://sacredplaces.org/',
    sponsor_name: 'Partners for Sacred Places',
    resource_title: 'Funding, training & capital planning for older sacred places',
    resource_summary: 'The national non-sectarian organization for congregations with older and historic buildings: capital-campaign training, community-value assessments, and the funding programs and regional partners a small congregation can actually reach.',
    directory: true, loan_allowed: false, cost_share_allowed: false,
    applicant_types: ['church', 'ministry', 'nonprofit'],
    need_categories: ['capital', 'operations', 'programs', 'historic_preservation'],
    keywords: ['sacred places', 'congregation', 'church building', 'historic preservation'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 45, priority_score: 68,
  },
  {
    source_id: 'nthp_preservation_grants',
    name: 'National Trust for Historic Preservation grants',
    source_type: 'html',
    trust_tier: TRUST_TIER.VERIFIED_FOUNDATION,
    base_url: 'https://savingplaces.org/grants',
    sponsor_name: 'National Trust for Historic Preservation',
    resource_title: 'National Trust preservation grant programs',
    resource_summary: 'National Trust grant funds (including the African American Cultural Heritage Action Fund and the Preservation Fund) for planning and capital work on historic buildings owned by nonprofits, congregations, tribes and public agencies.',
    directory: false, loan_allowed: false, cost_share_allowed: true,
    applicant_types: ['nonprofit', 'church', 'ministry', 'government', 'tribal'],
    need_categories: ['capital', 'programs', 'historic_preservation'],
    keywords: ['historic preservation', 'preservation fund', 'historic building', 'restoration'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 71,
  },

  // ── VETERAN benefits hub (2026-08-02) ─────────────────────────────────────
  // The registry carried five veteran BUSINESS rows and `va_housing_grants`,
  // but no row for VA benefits as such (education, disability compensation,
  // healthcare, VR&E/Chapter 31 self-employment). NOTE: on 2026-08-02 the
  // planner excluded EVERY veteran row for a veteran who owns a business,
  // because the thesis emitted applicant_types:['business'] only — see the
  // exact patch in the persona-coverage report. This row is only reachable
  // once that lands.
  {
    source_id: 'va_veteran_benefits',
    name: 'VA benefits (education, disability, healthcare, employment)',
    source_type: 'html',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.benefits.va.gov/benefits/',
    sponsor_name: 'U.S. Department of Veterans Affairs',
    resource_title: 'VA benefits for veterans and their families',
    resource_summary: 'Official VA benefits hub: education (GI Bill), disability compensation, healthcare enrollment, home loans, pension, and Veteran Readiness and Employment (Chapter 31) — which includes a self-employment track for veterans starting a business.',
    directory: true, loan_allowed: true, cost_share_allowed: false,
    applicant_types: ['veteran', 'active_duty', 'guard_reserve', 'transitioning_service_member', 'military_spouse'],
    need_categories: ['veterans', 'housing', 'medical', 'education', 'employment', 'disability', 'startup'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 73,
  },

  {
    // ONE national row; the adapter names the profile's OWN state HFA from
    // STATE_REGISTRY (IHCDA / OHFA / WVHDF …). See the note above for why this
    // is not 51 state-scoped rows.
    source_id: STATE_HOUSING_AGENCY_SOURCE_ID,
    name: 'State housing finance agency (homeowner & renter programs)',
    source_type: 'directory',
    trust_tier: TRUST_TIER.OFFICIAL_HTML,
    base_url: 'https://www.hud.gov/states',
    sponsor_name: 'State housing finance agency',
    resource_title: 'State housing agency — homeowner & renter programs',
    resource_summary: "Your state's housing finance agency: homeowner assistance and foreclosure-prevention programs, rental assistance, home repair and weatherization, down-payment help, and the state's HUD-approved housing counseling network.",
    directory: true, loan_allowed: true, cost_share_allowed: false,
    applicant_types: ['individual', 'family', 'veteran', 'senior'],
    need_categories: ['housing', 'emergency'],
    geography: { national: true, states: [] },
    default_kinds: [OPPORTUNITY_KIND.DIRECTORY],
    crawler_method: 'html', requires_env: [], refresh_frequency_days: 30, priority_score: 75,
  },

  // State benefits portals — generated from the verified table above.
  ...STATE_BENEFITS_PORTALS.map(stateBenefitsPortalRow),
]);

const BY_ID = Object.freeze(Object.fromEntries(SOURCES.map((s) => [s.source_id, s])));

export function allSources() { return SOURCES.map((s) => mergeSourceCoverage({ ...s })); }
export function getSource(id) { const s = BY_ID[id]; return s ? mergeSourceCoverage({ ...s }) : null; }
export function sourceIds() { return SOURCES.map((s) => s.source_id); }

export default { SOURCES, allSources, getSource, sourceIds };
