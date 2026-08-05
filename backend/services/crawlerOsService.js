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
import { createLogger } from '../utils/logger.js';
import { loadProfileContext } from './profileHelpers.js';
import { assessProfileConfiguration, describeUnconfiguredProfile } from './profile/profileConfiguration.js';
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

const log = createLogger('crawler-os:service');

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
    doFetch: (url, init) => fetchWithTimeout(url, init),
    resolve: (host) => dns.promises.resolve(host),
    ...overrides,
  });
}

// Per-request timeout for the production crawl fetcher. The OS fetcher
// (backend/crawler-os/fetcher.js) intentionally delegates timeouts to the host
// app's doFetch; native fetch/undici has NO default deadline, so without this a
// single half-open remote hangs runProfileDiscoveryLive forever and pins one of
// the MAX_CONCURRENT_CRAWLERS slots. Respects a caller-provided AbortSignal.
function crawlFetchTimeoutMs() {
  // Read at call time so tests (and live env changes) can tune it.
  return Math.max(50, Number(process.env.CRAWLER_FETCH_TIMEOUT_MS) || 30000);
}

/**
 * Browser-equivalent request headers for the production crawl fetcher.
 *
 * Native fetch/undici identifies itself as a non-browser client, and some
 * official sources' WAFs answer that with a fake 404 (2026-07-12:
 * highered.ohio.gov served 404 to the crawler while the same OCOG page is 200
 * under a browser UA — Amy reported it as source_fetch_failed). These are
 * public program pages fetched for legitimate discovery; presenting standard
 * browser headers is owner-approved (2026-07-12) for exactly this class.
 * Caller-provided headers always win (API adapters keep their keys/accepts).
 * Kill switch: CRAWLER_BROWSER_HEADERS=0.
 */
export const BROWSER_FETCH_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
});

function browserHeadersEnabled() {
  return String(process.env.CRAWLER_BROWSER_HEADERS ?? '1').toLowerCase() !== '0';
}

/** Exported for tests. */
export function fetchWithTimeout(url, init = {}) {
  const timeoutSignal = AbortSignal.timeout(crawlFetchTimeoutMs());
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let headers = init.headers;
  if (browserHeadersEnabled()) {
    // Headers() merge is case-insensitive, so a caller's 'user-agent' cleanly
    // overrides the default 'User-Agent' instead of duplicating it.
    const merged = new Headers(BROWSER_FETCH_HEADERS);
    for (const [k, v] of new Headers(init.headers ?? {})) merged.set(k, v);
    headers = merged;
  }
  return fetch(url, { ...init, headers, signal });
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

/**
 * isWebLaneProfileBlindEnabled — Phase 1b SHADOW gate for the profile-BLIND
 * extractor. Default OFF: the blind path is pure observation and must not run in
 * prod until proven. When ON (`WEB_LANE_PROFILE_BLIND=1`/true), the web lane ALSO
 * re-extracts each already-fetched page through the profile-blind path and emits
 * a read-only `web_lane_blind_shadow` delta counter — it changes NOTHING the live
 * lane returns or persists (no shadow candidate is scored or written). The writes
 * flag (WEB_LANE_PROFILE_BLIND_WRITES) is a LATER phase and is not read here.
 */
export function isWebLaneProfileBlindEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.WEB_LANE_PROFILE_BLIND ?? '').trim());
}

// A blind shadow page's raw HTML is truncated to this many chars BEFORE any DOM
// parse (htmlToText + buildLinkInventory both `cheerio.load`, which is unbounded
// on input and would block the event loop synchronously on a multi-MB body). The
// extractor already caps its OUTPUT; this caps the INPUT work. A funding page's
// meaningful copy is far under this; the tail is nav/scripts/comments.
export const MAX_SHADOW_HTML_CHARS = 500_000;

/** Truncate raw page HTML to a bounded size before any (synchronous) DOM parse. */
export function capShadowHtml(html) {
  return typeof html === 'string' && html.length > MAX_SHADOW_HTML_CHARS
    ? html.slice(0, MAX_SHADOW_HTML_CHARS)
    : html;
}

// Phase 1d target-verification "not a real single program" cues, matched as
// normalized substrings of a FETCHED target page's own text. A page dominated by
// these is an error/login wall, not a fundable program — so it fails verification
// even though it returned 2xx. Kept narrow + paired with a thin-page requirement
// so a real program page that merely has a "Log in" nav link is never rejected.
const TARGET_LOGIN_CUES = ['enter your password', 'forgot your password', 'forgot password', 'sign in to your account', 'log in to your account', 'please log in', 'please sign in', 'password'];
const TARGET_ERROR_CUES = ['page not found', '404 error', 'error 404', 'access denied', '403 forbidden', 'account suspended', 'this page has moved', 'no longer available', 'we could not find', "we couldn't find", 'temporarily unavailable', 'service unavailable'];
// Below this the target copy is too thin to be a real program page; combined with a
// login/error cue it is treated as an error/login wall.
const TARGET_THIN_PAGE_CHARS = 1200;

/**
 * decideTargetVerified — the PURE Phase-1d verdict: given a FETCHED target's kind
 * (from the 1c classifier), its own text, and status, is it INDEPENDENTLY a real
 * single program? Verified requires: reachable (asserted by the caller — this runs
 * only on a 2xx/3xx-final response), NOT an aggregator/directory (1c kind), and NOT
 * an error/login wall. Exported (and blind-import-free) so the login/error+kind
 * decision is unit-testable apart from the network + DOM parse.
 *
 * @param {{ kind?:string, pageText?:string, status?:number|null }} input
 * @returns {{ verified:boolean, reason:string }}
 */
export function decideTargetVerified({ kind, pageText, status } = {}) {
  const hay = String(pageText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // A server-error status that still carried a body is not a real program page.
  if (Number.isFinite(status) && status >= 400) return { verified: false, reason: 'error_status' };
  const thin = hay.length < TARGET_THIN_PAGE_CHARS;
  const isError = TARGET_ERROR_CUES.some((c) => hay.includes(c));
  const isLogin = thin && TARGET_LOGIN_CUES.some((c) => hay.includes(c));
  if (isError || isLogin) return { verified: false, reason: isError ? 'error_page' : 'login_page' };
  // An AGGREGATOR/DIRECTORY target is a locator, not a directly-applicable program.
  if (kind === 'AGGREGATOR_INDEX') return { verified: false, reason: 'aggregator' };
  return { verified: true, reason: kind || 'reachable' };
}

/**
 * makeBlindShadow — build the injectable profile-BLIND shadow for the web lane
 * from the Phase-1a modules + a REAL Claude/OpenAI adapter (the same providers
 * `webGrantExtractor` uses). Returns null (shadow OFF) when the flag is off or any
 * dependency fails to load — the lane then runs exactly as before. Best-effort by
 * construction: the extractor never throws and enforces its own timeout, and the
 * caller (webLane) additionally races each call against a wall-clock budget.
 *
 * Callers should only invoke this when the flag is ON (the caller guards the
 * await), so a flag-off run never crosses this async boundary.
 */
export async function makeBlindShadow() {
  if (!isWebLaneProfileBlindEnabled()) return null;
  try {
    const [{ buildLinkInventory }, { extractPageFactsBlind }, { mapBlindFactsToCandidate }, { classifyBlindOpportunityKind }, { htmlToText }, aiProviders] =
      await Promise.all([
        import('../crawler-os/blindLinkInventory.js'),
        import('../crawler-os/blindPageFactExtractor.js'),
        import('../crawler-os/blindFactsMapper.js'),
        import('../crawler-os/blindOpportunityKind.js'),
        import('./webGrantExtractor.js'),
        import('../utils/aiProviders.js'),
      ]);
    const openai = aiProviders.getOpenAIOptional();
    // Injected LLM adapter: async ({system,prompt,signal}) => object. Reuses the
    // repo's OpenAI→Anthropic JSON fallback; the extractor's coerceLlmJson reads
    // the returned { json } shape. `invokeJsonWithFallback` has no AbortSignal
    // parameter (its HTTP call cannot be truly cancelled), so on abort we STOP
    // AWAITING it — the underlying call resolves on its own internal LLM deadline
    // and is GC'd; what matters is that neither this adapter nor the live lane
    // keeps awaiting past the timeout.
    const blindLlm = async ({ system, prompt, signal }) => {
      const call = aiProviders.invokeJsonWithFallback({
        openai,
        system,
        prompt,
        temperature: 0.1,
        maxTokens: 1600,
        anthropicModel: process.env.WEB_DISCOVERY_MODEL_ANTHROPIC || 'claude-haiku-4-5',
        openaiModel: process.env.WEB_DISCOVERY_MODEL_OPENAI || 'gpt-4o-mini',
      });
      if (!signal) return call;
      if (signal.aborted) return null;
      return Promise.race([
        call,
        new Promise((resolve) => { signal.addEventListener('abort', () => resolve(null), { once: true }); }),
      ]);
    };
    const maxPages = Number(process.env.WEB_LANE_PROFILE_BLIND_MAX_PAGES) || 8;
    const totalBudgetMs = Number(process.env.WEB_LANE_PROFILE_BLIND_TOTAL_BUDGET_MS) || 6000;
    const perPageTimeoutMs = Number(process.env.WEB_LANE_PROFILE_BLIND_TIMEOUT_MS) || 4000;
    // Phase 1d INDEPENDENT TARGET VERIFICATION bounds. A SINGLE wall-clock budget +
    // a max-fetches cap for the whole run, plus a short per-fetch timeout — kept
    // small so the shadow's extra target fetches can never delay the live lane.
    const targetVerifyBudgetMs = Number(process.env.WEB_LANE_TARGET_VERIFY_BUDGET_MS) || 5000;
    const rawTargetMax = process.env.WEB_LANE_TARGET_VERIFY_MAX;
    const targetVerifyMax = rawTargetMax !== undefined && rawTargetMax !== '' && Number.isFinite(Number(rawTargetMax))
      ? Number(rawTargetMax) : 5; // allows an explicit 0 (disable) while defaulting to 5
    const targetVerifyTimeoutMs = Number(process.env.WEB_LANE_TARGET_VERIFY_TIMEOUT_MS) || 3000;
    return {
      maxPages,
      totalBudgetMs,
      perPageTimeoutMs,
      targetVerifyBudgetMs,
      targetVerifyMax,
      targetVerifyTimeoutMs,
      // Phase 1d: classify a FETCHED target page (the candidate's OWN apply/info
      // URL, fetched independently by the web lane via the SSRF-safe fetcher). PURE
      // + page-derived: builds the target's own text + link inventory, reuses the
      // 1c trust-aware classifier for the aggregator/directory axis, and applies the
      // login/error heuristic — NO profile, NO network here (the lane owns the
      // fetch). Best-effort: any failure degrades to a conservative unverified.
      classifyTarget: async ({ finalUrl, html, status }) => {
        try {
          const cappedHtml = capShadowHtml(html);
          const pageText = htmlToText(cappedHtml, 12000);
          const linkInventory = buildLinkInventory(cappedHtml, { baseUrl: finalUrl });
          // Classify the TARGET page itself: a lightweight page-derived candidate
          // built from the fetched target (title/sponsor unknown here — the kind
          // axis keys off directory language + link fan-out + apply target, all
          // page-derived), so the aggregator/directory verdict is about the TARGET.
          const { kind } = classifyBlindOpportunityKind({
            candidate: { page_url: finalUrl, info_url: finalUrl },
            linkInventory,
            pageText,
          });
          return decideTargetVerified({ kind, pageText, status });
        } catch {
          return { verified: false, reason: 'classify_error' };
        }
      },
      // webLane passes the per-call slice (timeoutMs) + AbortSignal; forward both.
      extractPage: async ({ pageUrl, html, timeoutMs, signal }) => {
        // Cap the raw HTML BEFORE parsing so DOM work is bounded regardless of body size.
        const cappedHtml = capShadowHtml(html);
        const pageText = htmlToText(cappedHtml, 12000);
        const linkInventory = buildLinkInventory(cappedHtml, { baseUrl: pageUrl });
        const facts = await extractPageFactsBlind(
          { pageUrl, pageText, linkInventory },
          { llm: blindLlm, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : perPageTimeoutMs, signal },
        );
        // Phase 1c: label each shadow candidate with its trust-aware KIND
        // (DIRECT_PROGRAM / AGGREGATOR_INDEX / UNKNOWN) + TRUST (PROTECTED /
        // UNVERIFIED) using ONLY the same page-derived inputs (candidate +
        // linkInventory + pageText — never the profile). The labels ride on the
        // shadow candidate for the web lane's read-only per-kind counter; they are
        // NEVER persisted and change nothing the live lane returns.
        return (Array.isArray(facts) ? facts : [])
          .map(mapBlindFactsToCandidate)
          .filter(Boolean)
          .map((candidate) => {
            const { kind, trust } = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
            return { ...candidate, blind_kind: kind, blind_trust: trust };
          });
      },
    };
  } catch {
    return null;
  }
}

function skippedDiscoveryResult(profileId, reason, extra = null) {
  return {
    run: { skipped: true, reason, profile_id: profileId, planned: 0, stored: 0, rejected: 0, sources: [], zero_result: null, ...(extra || {}) },
    persisted: { opportunities: 0, matches: 0, sources: 0, rejected: 0, pipelinePruned: 0, skipped: true, reason },
    thesis: null,
    ...(extra || {}),
  };
}

/**
 * overlayLiveAmountKnowledge — fill a run's recommendations with what the LIVE
 * catalog row already KNOWS about amounts and kind.
 *
 * WHY (Amy flywheel `amount_recall_miss` ×31, 2026-07-26). Every discovery run
 * starts from a blank memory store, so a recommendation carries only what THIS
 * crawl's extraction saw. But the run's rows are persisted onto live
 * `funding_opportunities` rows by canonical identity — rows where the nightly
 * amount sweeps (adapter/page-read, `enforceAmountEnrichment`) and the locator
 * kind classification may have ALREADY recorded the answer. Ignoring that
 * knowledge made Amy's evaluator count a miss on an amount GrantFlow already
 * knows and displays (the finding's own claim — "pipeline value will display
 * ~$0" — reads the LIVE row, which has the figure), and let a catalog row
 * classified DIRECTORY/BENEFIT re-enter the denominator as grant-shaped
 * because the fresh extraction carried no kind. The flywheel's two honesty
 * exclusions existed but could not fire on deduped rows.
 *
 * FILL-GAPS ONLY — the mirror of the never-wipe rule (#950): a live answer
 * fills a rec's SILENCE; it never overwrites a fact this crawl extracted.
 * The one deliberate exception mirrors the kind tug-of-war doctrine
 * (locatorUrlKind.js): a live 'directory'/'benefit' classification is a
 * curated/structural judgment and outranks a generic machine stamp, exactly
 * as `fundingOpportunityConflictExpr` refuses to downgrade it on write.
 *
 * Mutates recs in place (the run object is the single source consumers read);
 * returns { checked, enriched } for run telemetry. Best-effort: any read
 * failure leaves every rec exactly as extracted.
 */
export async function overlayLiveAmountKnowledge(db, recommendations, idRemap) {
  const recs = Array.isArray(recommendations) ? recommendations : [];
  if (recs.length === 0) return { checked: 0, enriched: 0 };
  const liveIdOf = (osId) => (idRemap instanceof Map ? (idRemap.get(osId) ?? osId) : osId);
  const liveIds = [...new Set(recs.map((r) => liveIdOf(r?.opportunity_id)).filter(Boolean))];
  if (liveIds.length === 0) return { checked: 0, enriched: 0 };
  let rows = [];
  try {
    const placeholders = liveIds.map(() => '?').join(', ');
    // TRAP (#946/#954 schema-drift class): select only columns BOTH dialects
    // have — never fo.url here.
    rows = await db
      .prepare(
        `SELECT id, amount_min, amount_max, amount_status, opportunity_kind
           FROM funding_opportunities
          WHERE id IN (${placeholders})`,
      )
      .all(...liveIds);
  } catch {
    return { checked: recs.length, enriched: 0 };
  }
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  let enriched = 0;
  for (const rec of recs) {
    const live = byId.get(liveIdOf(rec?.opportunity_id));
    if (!live) continue;
    let touched = false;
    // Amounts: a known live figure fills a rec that carries none (Postgres
    // NUMERIC arrives as a string — normalize to Number for consumers).
    if (!(Number(rec.amount_min) > 0) && Number(live.amount_min) > 0) {
      rec.amount_min = Number(live.amount_min);
      touched = true;
    }
    if (!(Number(rec.amount_max) > 0) && Number(live.amount_max) > 0) {
      rec.amount_max = Number(live.amount_max);
      touched = true;
    }
    // Status: a real live answer ('none_published'/'varies'/…) replaces only
    // SILENCE (null/'not_listed'). Silence never replaces anything.
    const recStatus = String(rec.amount_status ?? '').toLowerCase();
    const liveStatus = String(live.amount_status ?? '').toLowerCase();
    if ((recStatus === '' || recStatus === 'not_listed') && liveStatus && liveStatus !== 'not_listed') {
      rec.amount_status = live.amount_status;
      touched = true;
    }
    // Kind: canonical directory/benefit wins (tug-of-war rule); otherwise the
    // live kind only fills a rec with no kind at all.
    const liveKind = String(live.opportunity_kind ?? '').toLowerCase();
    if (liveKind === 'directory' || liveKind === 'benefit') {
      if (String(rec.kind ?? '').toLowerCase() !== liveKind) {
        rec.kind = live.opportunity_kind;
        touched = true;
      }
    } else if ((rec.kind === null || rec.kind === undefined) && live.opportunity_kind) {
      rec.kind = live.opportunity_kind;
      touched = true;
    }
    if (touched) enriched += 1;
  }
  return { checked: recs.length, enriched };
}

export async function runProfileDiscoveryLive({ db = getDb(), profileId, fetcher, floor, dryRun = false, matchProfiles = null, onlySourceIds = null, crawlerType = null, deadlineMs = null, timeBudgetMs = null } = {}) {
  if (!profileId) throw new Error('runProfileDiscoveryLive: profileId is required');
  const ctx = await loadProfileContext(db, profileId);
  // Lifecycle guard: never crawl a deleted/archived/merged profile (no-op, no writes).
  const profileStatus = String(ctx?.profile?.status ?? '').trim().toLowerCase();
  if (NON_DISCOVERABLE_PROFILE_STATUSES.has(profileStatus) || ctx?.profile?.deleted_at) {
    return skippedDiscoveryResult(profileId, `profile_${profileStatus || 'deleted'}`);
  }
  // THE CRAWLERS READ THE PROFILE FIRST — and say so when there is nothing in
  // it (owner rule; 2026-08-02). A profile that declares no need, no
  // eligibility fact and no usable location cannot be served by ANY lane, and
  // crawling it anyway is how `profile-melissa-justus` came to hold 27 matches
  // — every one a DIRECTORY, with invented geography — while reading as a
  // crawler shortfall to chase. This is the EVA runner's posture: BLOCKED,
  // with the prerequisite NAMED. It is not a crawler failure and must never be
  // reported as one. Nothing is written and no profile content is touched.
  const configuration = assessProfileConfiguration(ctx);
  if (configuration.unconfigured) {
    log.warn('discovery blocked: the profile has not been filled in', {
      profileId,
      missing_prerequisites: configuration.missing_prerequisites,
      evidence: configuration.signals.map((s) => `${s.family}/${s.id}`),
    });
    return skippedDiscoveryResult(profileId, 'profile_unconfigured', {
      unconfigured: true,
      missing_prerequisites: configuration.missing_prerequisites,
      blocked_reason: describeUnconfiguredProfile(configuration),
      evidence: configuration.signals,
    });
  }
  const thesis = buildThesis(profileContextToThesisInput(ctx));
  // FULL-CONTEXT scoring for the PRIMARY profile (2026-07-27, the "9 of the
  // profile's 6 data points — 83%" class): the pipeline used to score every
  // profile against its THESIS STUB (~6 data points: the needs list), so any
  // broad registry directory trivially "covered" 50–100% of EVERY profile and
  // identical junk lists topped Anita's and Anastasia's matches. The engine's
  // calibrated bands assume real 50–150-point inventories, which live in the
  // profile context this function already loaded — attach it so the pipeline
  // scores the discovering profile against everything it actually knows.
  // Non-enumerable: the thesis is persisted/logged as JSON and the context is
  // heavy run-scoped scoring input, not thesis content. Cross-match theses
  // (buildThesisForProfile) deliberately carry no context and fall under the
  // engine's MIN_CALIBRATED_INVENTORY topical cap — additive candidates only,
  // and the promotion lane canonically rescores before anything reaches a
  // pipeline.
  Object.defineProperty(thesis, '_profileContext', {
    value: { profile: ctx?.profile ?? null, sections: ctx?.sections ?? null, signals: ctx?.signals ?? null },
    enumerable: false,
  });
  // Close the learning loop ON THE CRAWL PATH. The learned-gap attach used to
  // live only in buildThesisForProfile — whose callers (Robert's cross-profile
  // matchProfiles, invariants, audits) use the thesis for MATCHING, not query
  // building — so buildWebQueries' gap targeting never fired on an actual
  // crawl. Attaching here steers THIS run's web queries with what prior crawls
  // (per-profile, Anya brain) and Amy's synthetic cohort (per-archetype,
  // amy_archetype_learning) proved the crawler misses. Best-effort, additive.
  await attachLearnedGaps(db, profileId, thesis);
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
  // SAME-DOMAIN source URL overrides (the autonomous half of source repair):
  // any URL an adapter builds under a repaired prefix is transparently fetched
  // from its same-registrable-domain replacement. Best-effort — no overrides
  // (or any load failure) means crawls run exactly as curated. A caller-
  // supplied fetcher (tests, single-source probes) is wrapped too, so a repair
  // is never silently bypassed by one entry point.
  let liveFetcher = fetcher ?? makeProductionFetcher();
  try {
    const { loadSourceUrlOverrides, makeOverrideRewritingFetcher } = await import('./sources/sourceUrlOverrides.js');
    const urlOverrides = await loadSourceUrlOverrides(db);
    if (urlOverrides.length > 0) liveFetcher = makeOverrideRewritingFetcher(liveFetcher, urlOverrides);
  } catch { /* overrides are an enhancement, never a crawl blocker */ }
  const onlySources = Array.isArray(onlySourceIds) && onlySourceIds.length > 0 ? onlySourceIds : null;
  const resolvedDeadline = Number.isFinite(Number(deadlineMs))
    ? Number(deadlineMs)
    : (Number.isFinite(Number(timeBudgetMs)) && Number(timeBudgetMs) > 0
      ? Date.now() + Number(timeBudgetMs)
      : null);
  const run = await runDiscovery(
    { store, fetcher: liveFetcher },
    { thesis, matchProfiles: effMatchProfiles, floor, onlySourceIds: onlySources, deadlineMs: resolvedDeadline },
  );

  // Open-web discovery lane — the bridge to state/local/foundation/community
  // funding that has no federal API. Runs profile-keyed web search (SearXNG/Brave)
  // + LLM extraction, then writes finds into the SAME store through the same
  // reality gate + matcher, so persistRun flushes them alongside the API finds.
  // Best-effort and bounded; never blocks or fails the run.
  //
  // Phase 1d target verification (shadow, flag ON) is a bounded telemetry-only
  // step the lane runs WITHOUT blocking its live return — it hands back a promise
  // (`web.targetVerification`) that we await AFTER persistRun so the live result
  // and persistence never wait on it (it also runs concurrently with persistRun).
  // A single-source-scoped run (the admin "re-crawl this stale source" action)
  // must stay targeted and bounded — the open-web search+LLM lane is a
  // different, unbounded discovery mechanism that is not keyed to any one
  // registry source, so it is skipped whenever onlySourceIds narrows the run.
  let webTargetVerification = null;
  if (isWebDiscoveryEnabled() && !onlySources) {
    try {
      const [{ runWebDiscoveryLane }, { searchWeb }, { extractOpportunitiesFromPage }, parity] = await Promise.all([
        import('../crawler-os/webLane.js'),
        import('./shared/webSearchEngine.js'),
        import('./webGrantExtractor.js'),
        import('./webParityBenchmark.js'),
      ]);

      // OWNER RULE — "if a funding source is found that meets the needs of a
      // profile, ADD that funding source." The Google-bar benchmark finds real
      // funding pages this lane's own search misses and files them as
      // candidates; before this, that queue had NO consumer, so the same real
      // sources were re-found nightly and never added (2026-07-15: "candidate
      // queue — nothing auto-added", fleet parity 41.2). Seeding them here is
      // what makes the benchmark a feedback loop instead of a report.
      //
      // Seeds bypass no gate — the lane fetches, extracts, reality-gates and
      // scores them exactly like search hits. Best-effort: a queue read must
      // never fail a crawl.
      let seedPages = [];
      try {
        seedPages = await parity.loadGapSeedPagesForProfile(db, profileId);
      } catch { seedPages = []; }

      // Phase 1b SHADOW (WEB_LANE_PROFILE_BLIND, default OFF): when ON, the lane
      // ALSO runs the profile-blind extractor on each already-fetched page and
      // emits a read-only `web_lane_blind_shadow` delta. null (flag off / load
      // failure) => the lane runs exactly as before. Never changes live results.
      // Flag-OFF short-circuits BEFORE the await, so an off run never crosses the
      // shadow-builder's async boundary — no extra work, no behavior change.
      const blindShadow = isWebLaneProfileBlindEnabled() ? await makeBlindShadow() : null;

      const web = await runWebDiscoveryLane(
        { store, fetcher: liveFetcher, searchWeb, extractOpportunities: extractOpportunitiesFromPage, blindShadow },
        { thesis, matchProfiles: effMatchProfiles, floor, runId: run.run_id, seedPages },
      );
      const { recommendations: webRecs, targetVerification, ...webTelemetry } = web;
      // The bounded target-verification promise is awaited AFTER persistRun (it
      // mutates web_lane_blind_shadow.promotion_evidence in place — a shared ref —
      // so recordWebLaneRun below sees the final counter) and is kept OUT of the
      // persisted telemetry object.
      webTargetVerification = targetVerification ?? null;
      run.web_lane = webTelemetry;
      if (Array.isArray(webRecs) && webRecs.length) {
        run.recommendations = [...(run.recommendations ?? []), ...webRecs].sort((a, b) => b.match_score - a.match_score);
      }

      // Record the gates' verdict on each seed. A seed that produced a catalog
      // row is 'adopted'; one that did not was SEEN and refused, which is a real
      // answer — leaving it 'candidate' would rebuild the write-only queue this
      // rule exists to drain. Skipped on a dry run (nothing was persisted, so
      // nothing has been judged).
      if (!dryRun && seedPages.length) {
        try {
          const adoptedUrls = Array.isArray(web.seeded_adopted_urls) ? web.seeded_adopted_urls : [];
          run.gap_adoption = await parity.markGapCandidateOutcomes(db, {
            offeredUrls: seedPages.map((s) => s.url),
            adoptedUrls,
            profileId,
          });
        } catch { /* bookkeeping must never fail a crawl */ }
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

  // Read BACK what the live rows already know (amounts learned by the nightly
  // enrichment sweeps, directory/benefit kind classifications) into this run's
  // recommendations — see overlayLiveAmountKnowledge. Runs AFTER persistRun so
  // the id remap (os id -> live canonical id) exists and the conflict-expression
  // never-wipe guards have already reconciled the row. Consumers downstream of
  // this seam (Amy's flywheel evaluator, coverage scoreboard, Anya handoff) all
  // read run.recommendations, so the overlay happens exactly once, here.
  // Best-effort: a failure leaves the recs as extracted and never fails a crawl.
  try {
    run.amount_overlay = await overlayLiveAmountKnowledge(db, run.recommendations, persisted?.idRemap);
  } catch { /* observability-only; never fails a crawl */ }

  // ── In-run institution catalog recall ──────────────────────────────────────
  // The attendance-authorized look at the catalog the BOOT net
  // (enforceInstitutionAidLinkage) gives the fleet — served to the DISCOVERING
  // profile at crawl time. A profile created, crawled, and read between boots
  // (every Amy synthetic; a newly-onboarded student's first crawl) never meets
  // a boot net, so its own school's already-cataloged aid was invisible to this
  // run's recommendations no matter how good the engine is (the
  // institution_recall_miss 21-of-21-days class). Same narrow key (attendance
  // only, whole-name sponsor equality), same match-row identity
  // ('il:', matcher_version 'institution-link') so the two writers can never
  // duplicate and the boot net's convergence pass governs both. The engine
  // remains the sole authority. Best-effort: never fails a crawl.
  try {
    const { recallInstitutionAidForRun } = await import('./matching/institutionRunRecall.js');
    const instRecall = await recallInstitutionAidForRun(db, {
      profile: ctx?.profile ?? null,
      sections: ctx?.sections ?? null,
      idRemap: persisted?.idRemap ?? null,
      existingRecommendations: run.recommendations ?? [],
    });
    run.institution_recall = {
      schools: instRecall.schools,
      scanned: instRecall.scanned,
      linked: instRecall.linked,
      rejected_by_engine: instRecall.rejectedByEngine,
      recommended: instRecall.recommendations.length,
      ...(instRecall.skipped ? { skipped: instRecall.skipped } : {}),
    };
    if (instRecall.recommendations.length > 0) {
      run.recommendations = [...(run.recommendations ?? []), ...instRecall.recommendations]
        .sort((a, b) => b.match_score - a.match_score);
    }
  } catch { /* institution recall is additive; never fails a crawl */ }

  // Now that the live result is persisted, settle the bounded Phase-1d target
  // verification (started before the lane returned, so it ran CONCURRENTLY with
  // persistRun and never delayed it) so its promotion_evidence counter is present
  // on run.web_lane before we record web-lane health telemetry below. Best-effort:
  // it never throws, and a failure here can never affect the persisted result.
  if (webTargetVerification) {
    try { await webTargetVerification; } catch { /* telemetry-only; never fails a crawl */ }
  }

  // Return the full-fidelity stored opportunities (OS shape, with
  // applicant_types/need_categories/geography/kind) so the caller can cross-match
  // them against OTHER profiles in the same cycle — the live funding_opportunities
  // table does NOT persist those matching fields, so they can only be matched
  // in-memory while the run objects are alive.
  const opportunities = storage.listCatalog(store);

  // ── Web-lane health telemetry ──────────────────────────────────────────────
  // Record the lane's per-run telemetry (pages found, extracted, stored, errors)
  // into the rolling system_kv store Sam's crawler.webLaneHealth check reads. A
  // dead search backend / exhausted LLM key degrades the lane to a silent no-op
  // by design (it must never fail a crawl) — this is the observability that
  // makes that death visible as ITSELF, not as a flood of hyperlocal gaps.
  // Recorded for ALL live runs (including Amy's synthetic cohort): the lane's
  // infrastructure health is profile-independent.
  try {
    if (run.web_lane) {
      const { recordWebLaneRun } = await import('./coverageAudit/webLaneHealth.js');
      await recordWebLaneRun(db, { profileId, telemetry: run.web_lane });
    }
  } catch {
    /* web-lane health telemetry must never fail the crawl */
  }

  // ── Admin Crawl Coverage & Health dashboard telemetry ─────────────────────
  // Persist this run's per-source outcomes (already computed by pipeline.js's
  // runDiscovery as run.sources) into the durable crawler_source_runs table so
  // GET /api/admin/crawl-coverage stays live for the Crawler OS. This table's
  // only writer used to be realCrawlers.js's legacy pipeline, removed wholesale
  // by the 2026-06-22 OS cutover without a replacement — leaving the dashboard
  // frozen on the retired engine's last runs. Best-effort, non-blocking, and
  // skipped on dry runs (nothing was actually queried against the live DB).
  if (!dryRun && Array.isArray(run.sources) && run.sources.length > 0) {
    try {
      const { persistSourceCoverage } = await import('./crawlerOsCoveragePersistence.js');
      await persistSourceCoverage(db, {
        crawlerRunId: run.run_id,
        profileId,
        crawlerType: crawlerType ?? 'crawler-os',
        sources: run.sources,
      });
    } catch {
      /* coverage telemetry must never fail the crawl */
    }
  }

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

  // post_crawl_match_decision_integrity: eligibility and need-first scorers may
  // legitimately produce REJECT, but REJECT is never a surfaced match. Run the
  // structural pass after every post-persistence writer, including web-llm.
  try {
    if (!dryRun && String(ctx?.profile?.created_by ?? '') !== 'agent:amy') {
      const { normalizePersistedMatchDecisionIntegrity } = await import('./matching/matchDecisionIntegrity.js');
      await normalizePersistedMatchDecisionIntegrity(db, { profileId });
    }
  } catch {
    /* match-decision integrity is also re-asserted by the boot invariant net */
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
  const thesis = buildThesis(profileContextToThesisInput(ctx));
  await attachLearnedGaps(db, profileId, thesis);
  return thesis;
}

/**
 * attachLearnedGaps — close the learning loop by attaching everything the
 * system has LEARNED about this profile's coverage gaps to the thesis, so
 * buildWebQueries can TARGET those gaps on the next run. Two learning lanes
 * are merged (union of gap classes):
 *
 *   1. PER-PROFILE — liveCrawlGapLearning records this exact profile's gaps
 *      into Anya's brain after each real crawl (memory_key `crawler_gap`).
 *      Carries missing_schools for institution-specific targeting.
 *   2. PER-ARCHETYPE — Amy's synthetic training cohort proves what the crawler
 *      systematically misses for this profile's archetype (student / veteran /
 *      senior / …) and records it in system_kv `amy_archetype_learning`, so a
 *      lesson learned on a synthetic veteran steers EVERY real veteran's next
 *      crawl — even a brand-new profile with no crawl history.
 *
 * SAFETY: consumption is ADDITIVE-ONLY (extra bounded web queries in
 * buildWebQueries); no gate, floor, or policy is touched. Best-effort: any
 * failure leaves the thesis unchanged and never blocks a crawl.
 *
 * @returns {Promise<object>} the same thesis (mutated in place)
 */
export async function attachLearnedGaps(db = getDb(), profileId, thesis) {
  if (!thesis || !profileId) return thesis;
  const classes = new Set();
  let missingSchools = [];
  let archetype = null;
  const sources = [];

  // 1. Per-profile learned gaps (Anya brain, written by liveCrawlGapLearning).
  try {
    const { getMemory } = await import('./anyaBrainService.js');
    const mem = await getMemory(db, { scope: 'profile', scopeId: String(profileId), memoryKey: 'crawler_gap' });
    const c = mem?.content;
    if (c && (c.needs_rediscovery || (Array.isArray(c.classes) && c.classes.length))) {
      for (const cls of Array.isArray(c.classes) ? c.classes : []) classes.add(cls);
      missingSchools = Array.isArray(c.missing_schools) ? c.missing_schools : [];
      sources.push('profile');
    }
  } catch { /* learned-gap load is best-effort observability, never a blocker */ }

  // 2. Per-archetype learned gaps (Amy's synthetic training flywheel).
  try {
    const { getArchetypeLearning, learnedClassesForThesis } = await import('./amy/archetypeLearning.js');
    const store = await getArchetypeLearning(db);
    const learned = learnedClassesForThesis(store, thesis);
    archetype = learned.archetype;
    if (learned.classes.length > 0) {
      for (const cls of learned.classes) classes.add(cls);
      sources.push(`amy_archetype:${learned.archetype}`);
    }
  } catch { /* archetype-learning load is best-effort, never a blocker */ }

  if (classes.size > 0 || missingSchools.length > 0) {
    thesis.learned_gaps = {
      classes: [...classes],
      missing_schools: missingSchools,
      // Audit trail: which learning lane(s) steered this crawl.
      sources,
      archetype,
    };
  }
  return thesis;
}

export default {
  getCrawlerOsStore,
  makeProductionFetcher,
  ensureCrawlerOsSchema,
  runProfileDiscovery,
  runProfileDiscoveryLive,
  runDiscovery,
  buildThesis,
  attachLearnedGaps,
  computeMatchDecision,
  createFleet,
  createScheduler,
  createAdminControl,
  storage,
};
