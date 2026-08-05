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
import { createSbirGovAdapter } from "./sbirGovAdapter.js";
import { createAgencyRssAdapter } from "./agencyRssAdapter.js";
import { createOfficialDirectoryAdapter } from "./officialDirectoryAdapter.js";
import { createEcfChoicesAdapter } from "./ecfChoicesAdapter.js";
import { createPropublica990Adapter } from "./propublica990Adapter.js";
import { createCountyCityDirectoryAdapter } from "./countyCityDirectoryAdapter.js";
import { STATE_BENEFITS_SOURCE_IDS, STATE_HOUSING_AGENCY_SOURCE_ID } from "../sourceRegistry.js";
import { createStateHousingAgencyAdapter } from "./stateHousingAgencyAdapter.js";

const officialDirectory = (sourceId) => () => createOfficialDirectoryAdapter(sourceId);
const countyCityDirectory = (sourceId) => () => createCountyCityDirectoryAdapter(sourceId);

const FACTORIES = Object.freeze({
  grants_gov: createGrantsGovAdapter,
  sam_gov: createSamGovAdapter,
  cof_locator: createFoundationDirectoryAdapter,
  benefits_gov: createBenefitsGovAdapter,
  community_action: officialDirectory('community_action'),
  feeding_america: officialDirectory('feeding_america'),
  hrsa_health_centers: officialDirectory('hrsa_health_centers'),
  liheap: officialDirectory('liheap'),
  snap: officialDirectory('snap'),
  medicaid: officialDirectory('medicaid'),
  // Medicaid-waiver lane (ported from the legacy ecfBenefitsCrawler /
  // stateWaiverBenefitsCrawler on 2026-07-07 — neither was ever registered
  // post-cutover, so ECF CHOICES members' own program was structurally
  // uncrawlable). tn_ecf_choices has a real extraction adapter; the national
  // HCBS index and SSA disability lanes are honest official locators.
  tn_ecf_choices: createEcfChoicesAdapter,
  state_hcbs_waivers: officialDirectory('state_hcbs_waivers'),
  ssa_disability: officialDirectory('ssa_disability'),
  area_agency_on_aging: officialDirectory('area_agency_on_aging'),
  state_vocational_rehab: officialDirectory('state_vocational_rehab'),
  community_211: officialDirectory('community_211'),
  pell_grant: officialDirectory('pell_grant'),
  // Sibling federal need-based student aid (full federal-aid family beyond Pell).
  fseog: officialDirectory('fseog'),
  federal_work_study: officialDirectory('federal_work_study'),
  teach_grant: officialDirectory('teach_grant'),
  iraq_afghanistan_service_grant: officialDirectory('iraq_afghanistan_service_grant'),
  us_dept_of_ed: officialDirectory('us_dept_of_ed'),
  usda_rd: createUsdaRdAdapter,
  fema_afg: createFemaAfgAdapter,
  usda_rd_community_facilities: officialDirectory('usda_rd_community_facilities'),
  fema_public_assistance: officialDirectory('fema_public_assistance'),
  fema_hazard_mitigation: officialDirectory('fema_hazard_mitigation'),
  cdbg_state_local: officialDirectory('cdbg_state_local'),
  eda_economic_development: officialDirectory('eda_economic_development'),
  dot_transportation_grants: officialDirectory('dot_transportation_grants'),
  epa_water_infrastructure: officialDirectory('epa_water_infrastructure'),
  broadband_grants: officialDirectory('broadband_grants'),
  studentaid_gov: createStudentAidGovAdapter,
  // Net-new key-free federal lanes (2026-06-24): Federal Register NOFOs (JSON
  // API) + NIH Guide funding feed (RSS). Both flow through the planner ->
  // reality gate -> match engine unchanged and widen REAL federal coverage.
  federal_register: createFederalRegisterAdapter,
  // SBIR/STTR solicitations — the research-org funding universe. Planner-gated
  // on thesis.is_research_org (sourceRegistry research_only flag).
  sbir_gov: createSbirGovAdapter,
  nih_guide: createAgencyRssAdapter,
  // NOTE: CareerOneStop's Scholarship Web API was retired (verified 2026-06-23:
  // their 21 live services include no scholarship endpoint; scholarship* paths
  // 404 while occupation returns 200). Student profiles use honest directory
  // sources unless a real source-specific adapter is added.
  united_way_211: officialDirectory('united_way_211'),
  donorschoose: officialDirectory('donorschoose'),
  cancer_care: officialDirectory('cancer_care'),
  ssa_survivors: officialDirectory('ssa_survivors'),
  dol_black_lung_benefits: officialDirectory('dol_black_lung_benefits'),
  alzheimers_gov_services: officialDirectory('alzheimers_gov_services'),
  kynect_benefits: officialDirectory('kynect_benefits'),
  ana_grants: officialDirectory('ana_grants'),
  bia_tribal_programs: officialDirectory('bia_tribal_programs'),
  imls_library_museum: officialDirectory('imls_library_museum'),
  cdc_grants: officialDirectory('cdc_grants'),
  samhsa_grants: officialDirectory('samhsa_grants'),
  hud_homeless_assistance: officialDirectory('hud_homeless_assistance'),
  ovw_grants: officialDirectory('ovw_grants'),
  bja_second_chance: officialDirectory('bja_second_chance'),
  petsmart_charities_grants: officialDirectory('petsmart_charities_grants'),
  petco_love_grants: officialDirectory('petco_love_grants'),
  aspca_grants: officialDirectory('aspca_grants'),
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
  // --- Orphaned funding lanes ported into the OS (2026-07-07). propublica_990
  //     is a real API adapter (IRS 990 grantmakers, NTEE+state driven); the
  //     rest are honest official program/directory rows.
  propublica_990: createPropublica990Adapter,
  arc_dra: officialDirectory('arc_dra'),
  orr_refugee: officialDirectory('orr_refugee'),
  acf_chafee_foster: officialDirectory('acf_chafee_foster'),
  ccdf_childcare: officialDirectory('ccdf_childcare'),
  dol_eta_workforce: officialDirectory('dol_eta_workforce'),
  nea_neh_arts: officialDirectory('nea_neh_arts'),
  usda_conservation: officialDirectory('usda_conservation'),
  hrsa_health_workforce: officialDirectory('hrsa_health_workforce'),
  copay_assistance_foundations: officialDirectory('copay_assistance_foundations'),
  va_housing_grants: officialDirectory('va_housing_grants'),
  // --- County & city programs lane (2026-07-08): geo-aware locators titled
  //     with the profile's own county/city (countyCityDirectoryAdapter).
  usa_gov_local_governments: countyCityDirectory('usa_gov_local_governments'),
  hud_resource_locator: countyCityDirectory('hud_resource_locator'),
  findhelp_local_programs: countyCityDirectory('findhelp_local_programs'),
  // --- OH + WA state-programs lanes (adapter wishlist 2026-07-08).
  oh_benefits: officialDirectory('oh_benefits'),
  oh_college_opportunity_grant: officialDirectory('oh_college_opportunity_grant'),
  wa_connection_benefits: officialDirectory('wa_connection_benefits'),
  wa_college_grant: officialDirectory('wa_college_grant'),
  // --- Disease-specific lanes: mobility impairment + neurodivergent.
  reeve_foundation_paralysis: officialDirectory('reeve_foundation_paralysis'),
  autism_speaks_family_support: officialDirectory('autism_speaks_family_support'),
  // --- Disease-specific lanes: adapter wishlist 2026-07-11 (hip replacement,
  //     PTSD, chronic kidney disease, hypertension).
  arthritis_foundation_help: officialDirectory('arthritis_foundation_help'),
  samhsa_findtreatment: officialDirectory('samhsa_findtreatment'),
  american_kidney_fund: officialDirectory('american_kidney_fund'),
  needymeds_diagnosis_assistance: officialDirectory('needymeds_diagnosis_assistance'),
  // --- Adapter-wishlist lanes (2026-07-15): transportation, deaf/hard of
  //     hearing, assistive technology, sleep apnea.
  mercy_medical_angels: officialDirectory('mercy_medical_angels'),
  pan_foundation_nemt_directory: officialDirectory('pan_foundation_nemt_directory'),
  hlaa_financial_assistance: officialDirectory('hlaa_financial_assistance'),
  at3_state_at_programs: officialDirectory('at3_state_at_programs'),
  asaa_cpap_assistance: officialDirectory('asaa_cpap_assistance'),
  // --- Adapter-wishlist lanes (2026-07-26): vision loss, acquired brain
  //     injury, medical debt / hospital charity care.
  vision_aware_resources: officialDirectory('vision_aware_resources'),
  biausa_brain_injury_resources: officialDirectory('biausa_brain_injury_resources'),
  dollar_for_charity_care: officialDirectory('dollar_for_charity_care'),
  // --- Canonical-flag totality lanes (2026-07-26): hiv, amputee, rare_disease,
  //     terminal — every HEALTH_DIAGNOSIS_FLAGS token must have a covering lane.
  findhivcare_ryan_white: officialDirectory('findhivcare_ryan_white'),
  amputee_coalition_resources: officialDirectory('amputee_coalition_resources'),
  nord_rare_disease_assistance: officialDirectory('nord_rare_disease_assistance'),
  caringinfo_serious_illness: officialDirectory('caringinfo_serious_illness'),
  // --- Adapter-wishlist lane (2026-08-02): neuromuscular / claw-hand class
  //     ("clawing effect in hands" → Charcot-Marie-Tooth / ulnar nerve palsy).
  mda_neuromuscular_resources: officialDirectory('mda_neuromuscular_resources'),
  // --- Benchmark-gap lanes (2026-07-13): kinship/grandfamily caregivers,
  //     heirs'-property / beginning farmers, homeschool families.
  acl_family_caregiver_support: officialDirectory('acl_family_caregiver_support'),
  gks_network: officialDirectory('gks_network'),
  farmers_gov_heirs_property: officialDirectory('farmers_gov_heirs_property'),
  farmers_gov_beginning_farmers: officialDirectory('farmers_gov_beginning_farmers'),
  hslda_compassion_grants: officialDirectory('hslda_compassion_grants'),
  // --- Housing-loss lane (2026-08-02): a homeowner in foreclosure and a renter
  //     facing eviction had NO source at all before these.
  hud_avoiding_foreclosure: officialDirectory('hud_avoiding_foreclosure'),
  cfpb_rent_and_housing_help: officialDirectory('cfpb_rent_and_housing_help'),
  lawhelp_legal_aid: officialDirectory('lawhelp_legal_aid'),
  // --- Congregation / sacred-places lane (2026-08-02).
  national_fund_sacred_places: officialDirectory('national_fund_sacred_places'),
  partners_sacred_places: officialDirectory('partners_sacred_places'),
  // --- Indigenous philanthropy lane (2026-08-04): the Native-led grantmaker
  // complement to the federal ANA/BIA lanes (zero indigenous funders on a
  // Pine Ridge ministry's pipeline was the audit finding).
  first_nations_dev_institute: officialDirectory('first_nations_dev_institute'),
  native_american_ag_fund: officialDirectory('native_american_ag_fund'),
  // --- Farm-lane DIRECTORY rows left unwired by their registry PR (found by
  // crawler:verify 2026-08-04; missing_adapter since they shipped). Only the
  // directory-typed four are wired here — sare_farmer_rancher_grants,
  // usda_value_added_producer_grants, and ky_agricultural_development_fund are
  // DIRECT_GRANT html sources that need REAL scraping adapters (wiring them to
  // officialDirectory would mint directory rows for grant programs).
  usda_fsa_farm_programs: officialDirectory('usda_fsa_farm_programs'),
  nifa_extension_land_grant: officialDirectory('nifa_extension_land_grant'),
  conservation_districts_directory: officialDirectory('conservation_districts_directory'),
  farm_credit_young_beginning_small: officialDirectory('farm_credit_young_beginning_small'),
  nthp_preservation_grants: officialDirectory('nthp_preservation_grants'),
  // --- VA benefits hub (2026-08-02).
  va_veteran_benefits: officialDirectory('va_veteran_benefits'),
  // --- State benefits portals (2026-07-12): one official portal per remaining
  //     state/DC/PR, generated in lockstep with the registry table.
  ...Object.fromEntries(STATE_BENEFITS_SOURCE_IDS.map((id) => [id, officialDirectory(id)])),
  // --- State housing finance agency (2026-08-02): ONE national row whose
  //     adapter resolves the profile's own state from STATE_REGISTRY. See the
  //     registry note for why this is not 51 state-scoped rows.
  [STATE_HOUSING_AGENCY_SOURCE_ID]: () => createStateHousingAgencyAdapter(STATE_HOUSING_AGENCY_SOURCE_ID),
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
