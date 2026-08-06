// crawler-os/index.js
//
// Public surface for GrantFlow Crawler OS. Import from here.
//
// One-glance wiring:
//
//   import { createMemoryStore, applySchema, createFetcher, runDiscovery,
//            createFleet, createScheduler, createAdminControl } from './index.js';
//
//   const store = createMemoryStore();            // or createSqlStore(db) in prod
//   const fetcher = createFetcher({ doFetch: fetch, resolve });
//   const fleet = createFleet({ store, fetcher, env: process.env });
//   const control = createAdminControl({ store, admin: validatedOperatorEmail });
//   const scheduler = createScheduler({ store, fleet, control });

// contract + canonical logic
export * from './contract.js';
export * from './stages.js';
export { isSafeUrl, isPrivateHost } from './safeUrl.js';
export { buildThesis } from './profileIntelligence.js';
export { allSources, getSource, sourceIds } from './sourceRegistry.js';
export { plan } from './planner.js';
export { createFetcher } from './fetcher.js';
export { buildCrawlerQueries, inferCandidateProfile, inferFundingFlags, agencyLooksLike } from './crawlerVocabulary.js';
export { parse } from './parsers.js';
export { enforceReality } from './realityGate.js';
export { normalize } from './normalizer.js';
export { computeMatchDecision, WEIGHTS } from './matchEngine.js';
export { matchOpportunity } from './matcher.js';
export { buildProjectReadinessPlan, renderProjectPlanDocument } from './projectReadinessPlan.js';

// storage
export { createMemoryStore, createSqlStore } from './store.js';
export * as storage from './storage.js';
export { SCHEMA_DDL } from './storage.js';

// adapters
export { getAdapter, implementedAdapterIds } from './adapters/index.js';

// pipeline
export { runDiscovery } from './pipeline.js';

// agents + orchestration
export { createFleet, CYCLE_ORDER } from './agents/index.js';
export { createRobert } from './agents/robert.js';
export { createYana } from './agents/yana.js';
export { createJohn } from './agents/john.js';
export { createHamilton } from './agents/hamilton.js';
export { createSam } from './agents/sam.js';
export { createAnya } from './agents/anya.js';
export { createScheduler } from './scheduler.js';
export { createAdminControl, CONTROL_STATE } from './adminControl.js';

// convenience: apply the production schema to a better-sqlite3-style db.
import { SCHEMA_DDL } from './storage.js';
import { PAGE_FACT_OS_STORE_COLUMN_DEFS } from './pageFacts.js';
export function applySchema(db) {
  if (!db || typeof db.exec !== 'function') throw new Error('applySchema: db with .exec required');
  db.exec(SCHEMA_DDL);
  // Heal pre-existing DBs that predate additive columns (CREATE IF NOT EXISTS
  // above never alters an existing table). Tolerant: errors mean "exists".
  for (const col of ['match_confidence REAL', 'source_query TEXT', 'discovered_via TEXT']) {
    // audit:allow dynamic-sql — col comes from the hardcoded list above
    try { db.exec(`ALTER TABLE profile_opportunity_matches ADD COLUMN ${col}`); } catch { /* exists */ }
  }
  // Page-fact provenance (Phase 0.1): heal the OS-store columns on a DB that
  // predates them, so an unset upsertOpportunity (which always NAMES these
  // columns) never fails with "no column named eligibility_text" on a store
  // built by an earlier applySchema. DRIVEN by the pageFacts registry so this
  // heal list can never drift from what SCHEMA_DDL / upsertOpportunity emit.
  for (const col of PAGE_FACT_OS_STORE_COLUMN_DEFS) {
    // audit:allow dynamic-sql — col comes from the hardcoded registry defs
    try { db.exec(`ALTER TABLE funding_opportunities ADD COLUMN ${col}`); } catch { /* exists */ }
  }
  return db;
}
