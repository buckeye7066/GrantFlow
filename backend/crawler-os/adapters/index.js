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
  // .
  // The pipeline records SKIPPED(no_adapter) for these until implemented.
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
