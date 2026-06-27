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
//   const control = createAdminControl({ store });
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
export { createAdminControl, CONTROL_STATE, ADMIN_EMAIL } from './adminControl.js';

// convenience: apply the production schema to a better-sqlite3-style db.
import { SCHEMA_DDL } from './storage.js';
export function applySchema(db) {
  if (!db || typeof db.exec !== 'function') throw new Error('applySchema: db with .exec required');
  db.exec(SCHEMA_DDL);
  return db;
}
