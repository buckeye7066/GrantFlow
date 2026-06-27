// crawler-os/adapters/index.js
//
// The adapter registry. Maps a source_id -> its adapter factory. A registry row
// WITHOUT an entry here is honestly reported as SKIPPED(no_adapter) by the
// pipeline — it is never silently dropped and never faked. Implementing a new
// source = add a row in sourceRegistry.js + an entry here.
import { createGrantsGovAdapter } from './grantsGovAdapter.js';
import { createSamGovAdapter } from './samGovAdapter.js';
import { createFoundationDirectoryAdapter } from './foundationDirectoryAdapter.js';
import { createBenefitsGovAdapter } from './benefitsGovAdapter.js';
import { createUsdaRdAdapter } from "./usdaRdAdapter.js";
import { createFemaAfgAdapter } from "./femaAfgAdapter.js";
import { createStudentAidGovAdapter } from "./studentAidGovAdapter.js";
import { createFederalRegisterAdapter } from "./federalRegisterAdapter.js";
import { createAgencyRssAdapter } from "./agencyRssAdapter.js";
import { createOfficialDirectoryAdapter } from "./officialDirectoryAdapter.js";

const officialDirectory = (sourceId) => () => createOfficialDirectoryAdapter(sourceId);

const FACTORIES = Object.freeze({
  grants_gov: createGrantsGovAdapter,
  sam_gov: createSamGovAdapter,
  cof_locator: createFoundationDirectoryAdapter,
  benefits_gov: createBenefitsGovAdapter,
  usda_rd: createUsdaRdAdapter,
  fema_afg: createFemaAfgAdapter,
  studentaid_gov: createStudentAidGovAdapter,
  // Net-new key-free federal lanes (2026-06-24): Federal Register NOFOs (JSON
  // API) + NIH Guide funding feed (RSS). Both flow through the planner ->
  // reality gate -> match engine unchanged and widen REAL federal coverage.
  federal_register: createFederalRegisterAdapter,
  nih_guide: createAgencyRssAdapter,
  // NOTE: CareerOneStop's Scholarship Web API was RETIRED (verified 2026-06-23:
  // their 21 live services include no scholarship endpoint; scholarship* paths
  // 404 while occupation returns 200). Individual scholarships are covered by
  // the Brave+LLM scholarshipWebDiscovery service instead.
  united_way_211: officialDirectory('united_way_211'),
  donorschoose: officialDirectory('donorschoose'),
  cancer_care: officialDirectory('cancer_care'),
  ssa_survivors: officialDirectory('ssa_survivors'),
  dol_black_lung_benefits: officialDirectory('dol_black_lung_benefits'),
  alzheimers_gov_services: officialDirectory('alzheimers_gov_services'),
  kynect_benefits: officialDirectory('kynect_benefits'),
  ana_grants: officialDirectory('ana_grants'),
  sba_grants: officialDirectory('sba_grants'),
  sba_veteran_business: officialDirectory('sba_veteran_business'),
  sba_vboc: officialDirectory('sba_vboc'),
  military_onesource: officialDirectory('military_onesource'),
  mycaa: officialDirectory('mycaa'),
  dol_tap: officialDirectory('dol_tap'),
  sba_boots_to_business: officialDirectory('sba_boots_to_business'),
  wv_sbdc_funding: officialDirectory('wv_sbdc_funding'),
  wv_business_funding_resources: officialDirectory('wv_business_funding_resources'),
  lsc_grants: officialDirectory('lsc_grants'),
  oregon_parks_rec_grants: officialDirectory('oregon_parks_rec_grants'),
  dhs_grants: officialDirectory('dhs_grants'),
  doj_grants: officialDirectory('doj_grants'),
  cops_grants: officialDirectory('cops_grants'),
  fec_candidate_resources: officialDirectory('fec_candidate_resources'),
  pa_campaign_finance: officialDirectory('pa_campaign_finance'),
});
/** @returns {object|null} an adapter instance, or null if none is implemented. */
export function getAdapter(sourceId) {
  const make = FACTORIES[sourceId];
  return make ? make() : null;
}
/** @returns {string[]} source_ids that currently have a real adapter. */
export function implementedAdapterIds() {
  return Object.keys(FACTORIES);
}
export default { getAdapter, implementedAdapterIds };
