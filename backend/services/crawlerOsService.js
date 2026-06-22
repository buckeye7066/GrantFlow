// backend/services/crawlerOsService.js
//
// THE single seam between the live GrantFlow backend (Express routes, agent
// schedulers, admin control) and the canonical Crawler OS at backend/crawler-os/.
// Routes and jobs MUST reach the new pipeline through here — never by importing
// legacy crawler services. This keeps the cutover honest: there is exactly one
// place that binds the OS to the live database, builds the production fetcher,
// and runs discovery.
//
// Re-exports the OS public surface so callers do:
//   import { runProfileDiscovery, computeMatchDecision, buildThesis } from '../services/crawlerOsService.js';
//
// STAGED CUTOVER NOTE: the OS storage layer is synchronous (better-sqlite3
// style). Under SQLite (local/test) getDb() is synchronous and binds directly.
// Under Postgres (production) the DB shim's prepare() is ASYNC, so a synchronous
// SqlStore would persist unresolved Promises. Rather than corrupt the prod
// catalog, getCrawlerOsStore() throws a loud, explicit error on Postgres until
// the async store adapter lands (see backend/crawler-os/store.js). The pure
// parts of the OS (matching, thesis, planning, reality gate, telemetry shapes,
// admin-control state machine) are dialect-independent and safe to use now.

import dns from 'node:dns';

import { getDb } from '../db/index.js';
import { loadProfileContext } from './profileHelpers.js';
import { profileContextToThesisInput, persistRun } from './crawlerOsPersistence.js';
import {
  createSqlStore,
  createMemoryStore,
  applySchema,
  createFetcher,
  runDiscovery,
  buildThesis,
  computeMatchDecision,
  createFleet,
  createScheduler,
  createAdminControl,
  CONTROL_STATE,
  ADMIN_EMAIL,
  storage,
} from '../crawler-os/index.js';

// Re-export the canonical, dialect-independent surface for routes/agents.
export {
  runDiscovery,
  buildThesis,
  computeMatchDecision,
  createFleet,
  createScheduler,
  createAdminControl,
  createMemoryStore,
  CONTROL_STATE,
  ADMIN_EMAIL,
  storage,
};

/**
 * getCrawlerOsStore — bind the Crawler OS storage layer to the live database.
 *
 * SQLite: returns a SqlStore over the live connection (synchronous, works).
 * Postgres: throws — the synchronous SqlStore cannot run over the async PG shim
 *   without the async store adapter (the remaining cutover step). Failing loud
 *   is intentional: we never want a half-bound store silently writing Promises.
 *
 * @param {{ allowMemoryFallback?: boolean }} [opts]
 */
export function getCrawlerOsStore(opts = {}) {
  const db = getDb();
  if (db.dialect === 'sqlite') {
    return createSqlStore(db);
  }
  if (opts.allowMemoryFallback) {
    // Explicit opt-in for read-only/diagnostic flows that must not touch prod.
    return createMemoryStore();
  }
  throw new Error(
    `crawlerOsService: durable discovery against dialect "${db.dialect}" is not yet wired. ` +
      'The synchronous Crawler OS SqlStore cannot run over the async Postgres shim; ' +
      'implement the async store adapter (backend/crawler-os/store.js) before cutting ' +
      'live Postgres routes over to runProfileDiscovery. Pure matching/planning/admin ' +
      'APIs from this module are safe to use on any dialect.',
  );
}

/**
 * makeProductionFetcher — the ONE network entry for live discovery. All fetching
 * goes through the OS fetcher (safeUrl validation, DNS-rebinding guard, redirect
 * validation, per-host rate limit, evidence hashing). Never call fetch() directly.
 */
export function makeProductionFetcher(overrides = {}) {
  return createFetcher({
    doFetch: (url, init) => fetch(url, init),
    resolve: (host) => dns.promises.resolve(host),
    ...overrides,
  });
}

/**
 * ensureCrawlerOsSchema — apply the OS SCHEMA_DDL to a SQLite connection (no-op
 * convenience for local/test bootstrapping). Production schema is owned by the
 * numbered migrations.
 */
export function ensureCrawlerOsSchema(db = getDb()) {
  if (db.dialect !== 'sqlite') return db;
  return applySchema(db);
}

/**
 * runProfileDiscovery — the canonical discovery entry for a single profile.
 * Robert (and the discovery routes, once cut over) call this. It builds the
 * funding thesis, runs the real pipeline against the live store, and returns the
 * canonical run telemetry (stored / rejected / recommendations / per-source
 * outcomes / zero-result ladder) — no legacy code path involved.
 *
 * @param {object} profile  raw GrantFlow profile
 * @param {{ store?, fetcher?, matchProfiles?, floor?:number }} [opts]
 */
export async function runProfileDiscovery(profile, opts = {}) {
  const store = opts.store ?? getCrawlerOsStore();
  const fetcher = opts.fetcher ?? makeProductionFetcher();
  const thesis = buildThesis(profile);
  const matchProfiles = opts.matchProfiles ?? [thesis];
  return runDiscovery({ store, fetcher }, { thesis, matchProfiles, floor: opts.floor });
}

/**
 * runProfileDiscoveryLive — the production-safe discovery entry for ONE live
 * GrantFlow profile, on ANY dialect. It loads the profile through the app's
 * loadProfileContext, builds the OS thesis, runs the REAL pipeline against an
 * in-memory OS store (synchronous, dialect-free), then flushes the results into
 * the live tables via the async persistence adapter. This is the seam Robert and
 * the discovery routes call — no legacy crawler/matching code is involved.
 *
 * @param {object} opts
 * @param {object} [opts.db]         live DB (defaults to getDb()).
 * @param {string} opts.profileId    the profile to discover for.
 * @param {object} [opts.fetcher]    OS fetcher (defaults to the production fetcher).
 * @param {number} [opts.floor]      match floor override.
 * @param {boolean} [opts.dryRun]    when true, run the real pipeline against the
 *                                   in-memory store but DO NOT flush to the live
 *                                   catalog/matches — returns a preview of what
 *                                   WOULD be stored (read-only).
 * @returns {Promise<{run:object, persisted:object, thesis:object}>}
 */
export async function runProfileDiscoveryLive({ db = getDb(), profileId, fetcher, floor, dryRun = false } = {}) {
  if (!profileId) throw new Error('runProfileDiscoveryLive: profileId is required');
  const ctx = await loadProfileContext(db, profileId);
  const thesis = buildThesis(profileContextToThesisInput(ctx));
  const store = createMemoryStore();
  const run = await runDiscovery(
    { store, fetcher: fetcher ?? makeProductionFetcher() },
    { thesis, matchProfiles: [thesis], floor },
  );
  if (dryRun) {
    // Read-only preview: report what discovery FOUND/MATCHED in the memory store
    // without touching the live tables. Mirrors persistRun's return shape.
    const catalog = storage.listCatalog(store);
    const matchRows = store.all('profile_opportunity_matches');
    const sourceRows = store.all('opportunity_sources');
    return {
      run,
      persisted: {
        opportunities: catalog.length,
        matches: matchRows.length,
        sources: sourceRows.length,
        rejected: run?.rejected ?? 0,
        pipelinePruned: 0,
        dry_run: true,
      },
      thesis,
    };
  }
  const persisted = await persistRun(db, store, run);
  return { run, persisted, thesis };
}

export default {
  getCrawlerOsStore,
  makeProductionFetcher,
  ensureCrawlerOsSchema,
  runProfileDiscovery,
  runProfileDiscoveryLive,
  runDiscovery,
  buildThesis,
  computeMatchDecision,
  createFleet,
  createScheduler,
  createAdminControl,
  storage,
};
