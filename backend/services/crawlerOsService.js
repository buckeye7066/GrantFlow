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
// Profile lifecycle statuses for which discovery is a no-op. A deleted/archived
// profile must NOT be crawled — the live audit (2026-06-23) found a DELETED,
// empty church profile still producing 74 stored matches (incl. accept-decisioned
// false positives). Discovery only runs for live profiles.
const NON_DISCOVERABLE_PROFILE_STATUSES = new Set(['deleted', 'archived', 'removed', 'inactive', 'merged']);

/**
 * isWebDiscoveryEnabled — gate for the open-web discovery lane. ON by default
 * (it's the bridge to non-federal funding); set WEB_DISCOVERY_ENABLED=false to
 * disable (e.g. to cap LLM/search spend). Requires a search backend (SearXNG or
 * Brave) and an LLM key to actually produce results, but degrades to a no-op
 * lane otherwise — it never throws.
 */
export function isWebDiscoveryEnabled() {
  return String(process.env.WEB_DISCOVERY_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function skippedDiscoveryResult(profileId, reason) {
  return {
    run: { skipped: true, reason, profile_id: profileId, planned: 0, stored: 0, rejected: 0, sources: [], zero_result: null },
    persisted: { opportunities: 0, matches: 0, sources: 0, rejected: 0, pipelinePruned: 0, skipped: true, reason },
    thesis: null,
  };
}

export async function runProfileDiscoveryLive({ db = getDb(), profileId, fetcher, floor, dryRun = false, matchProfiles = null } = {}) {
  if (!profileId) throw new Error('runProfileDiscoveryLive: profileId is required');
  const ctx = await loadProfileContext(db, profileId);
  // Lifecycle guard: never crawl a deleted/archived/merged profile (no-op, no writes).
  const profileStatus = String(ctx?.profile?.status ?? '').trim().toLowerCase();
  if (NON_DISCOVERABLE_PROFILE_STATUSES.has(profileStatus) || ctx?.profile?.deleted_at) {
    return skippedDiscoveryResult(profileId, `profile_${profileStatus || 'deleted'}`);
  }
  const thesis = buildThesis(profileContextToThesisInput(ctx));
  // CROSS-PROFILE matching (Robert charter: "match every newly stored opportunity
  // against ALL known profiles"). When the caller supplies matchProfiles (all
  // active theses), each stored opp is matched against all of them in-run (the
  // live catalog can't reconstruct match fields, so this must happen here). The
  // discovering profile is PRIMARY; others get additive 'crawler-os-xmatch'.
  // Single-profile callers (the user-facing /run route) pass nothing → exact
  // legacy behavior.
  const effMatchProfiles = Array.isArray(matchProfiles) && matchProfiles.length > 0 ? matchProfiles : [thesis];
  const crossProfile = effMatchProfiles.length > 1;
  const store = createMemoryStore();
  const liveFetcher = fetcher ?? makeProductionFetcher();
  const run = await runDiscovery(
    { store, fetcher: liveFetcher },
    { thesis, matchProfiles: effMatchProfiles, floor },
  );

  // Open-web discovery lane — the bridge to state/local/foundation/community
  // funding that has no federal API. Runs profile-keyed web search (SearXNG/Brave)
  // + LLM extraction, then writes finds into the SAME store through the same
  // reality gate + matcher, so persistRun flushes them alongside the API finds.
  // Best-effort and bounded; never blocks or fails the run.
  if (isWebDiscoveryEnabled()) {
    try {
      const [{ runWebDiscoveryLane }, { searchWeb }, { extractOpportunitiesFromPage }] = await Promise.all([
        import('../crawler-os/webLane.js'),
        import('./shared/webSearchEngine.js'),
        import('./webGrantExtractor.js'),
      ]);
      const web = await runWebDiscoveryLane(
        { store, fetcher: liveFetcher, searchWeb, extractOpportunities: extractOpportunitiesFromPage },
        { thesis, matchProfiles: effMatchProfiles, floor, runId: run.run_id },
      );
      const { recommendations: webRecs, ...webTelemetry } = web;
      run.web_lane = webTelemetry;
      if (Array.isArray(webRecs) && webRecs.length) {
        run.recommendations = [...(run.recommendations ?? []), ...webRecs].sort((a, b) => b.match_score - a.match_score);
      }
    } catch (err) {
      run.web_lane = { ok: false, error: String(err?.message ?? err) };
    }
  }

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
  const persisted = await persistRun(db, store, run, crossProfile ? { primaryProfileId: thesis.profile_id } : {});

  // Return the full-fidelity stored opportunities (OS shape, with
  // applicant_types/need_categories/geography/kind) so the caller can cross-match
  // them against OTHER profiles in the same cycle — the live funding_opportunities
  // table does NOT persist those matching fields, so they can only be matched
  // in-memory while the run objects are alive.
  const opportunities = storage.listCatalog(store);

  // ── Global crawler-gap learning ────────────────────────────────────────────
  // On EVERY live (non-dry-run) discovery call, audit this profile's RESULT
  // coverage and record any gaps into the shared learning store so Sam
  // (diagnostics) and Anya (brain) get smarter from REAL crawls — not just Amy's
  // synthetic cohort or the offline nightly sweep. Synthetic Amy profiles are
  // skipped (they have their own evaluation loop and get reaped, not remediated).
  // Best-effort and fully guarded: learning is observability, never a blocker.
  try {
    if (String(ctx?.profile?.created_by ?? '') !== 'agent:amy') {
      const { learnFromCrawlGaps } = await import('./coverageAudit/liveCrawlGapLearning.js');
      await learnFromCrawlGaps(db, {
        profileId,
        thesis,
        displayName: ctx?.profile?.display_name ?? null,
      });
    }
  } catch {
    /* crawler-gap learning must never fail the crawl */
  }

  // ── Self-correct this crawl's OWN ineligible output ─────────────────────────
  // A live crawl (esp. the web-llm lane) can persist a stale/inflated ACCEPT that
  // the FAITHFUL engine would hard-reject for THIS profile (e.g. a student-aid
  // scholarship surfaced onto a non-student). The nightly fleet sweep eventually
  // demotes these, but that leaves the just-crawled profile showing ineligible
  // matches until then. Re-score just this profile's surfaced matches now, at the
  // choke point closest to creation. Scoped to one profile => cheap; gated by
  // ENFORCE_SURFACED_MATCH_ELIGIBILITY; never blocks the crawl.
  try {
    if (!dryRun && String(ctx?.profile?.created_by ?? '') !== 'agent:amy') {
      const { reScoreSurfacedIneligible } = await import('./coverageAudit/surfacedEligibility.js');
      // Demotions are logged inside the sweep via its own logger.
      await reScoreSurfacedIneligible(db, { profileId });
    }
  } catch {
    /* post-crawl eligibility re-score must never fail the crawl */
  }

  return { run, persisted, thesis, opportunities };
}

/**
 * Build the Crawler-OS thesis for one live profile (loadProfileContext ->
 * thesis). Returns null for a deleted/archived profile. Used by Robert to
 * assemble ALL active theses for cross-profile matching.
 */
export async function buildThesisForProfile(db = getDb(), profileId) {
  if (!profileId) return null;
  const ctx = await loadProfileContext(db, profileId);
  const status = String(ctx?.profile?.status ?? '').trim().toLowerCase();
  if (NON_DISCOVERABLE_PROFILE_STATUSES.has(status) || ctx?.profile?.deleted_at) return null;
  return buildThesis(profileContextToThesisInput(ctx));
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
