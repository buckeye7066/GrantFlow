// crawler-os/webLane.js
//
// The open-web funding-discovery lane — the bridge that lets GrantFlow find the
// state/local/foundation/community funding that has NO federal API. It runs
// ALONGSIDE the registry/adapter pipeline, writing into the SAME OS store so the
// existing async persistence flushes web finds exactly like federal-API finds.
//
// Flow (per profile thesis):
//   buildWebQueries -> searchWeb (SearXNG/Brave) -> fetch each real result page
//   -> LLM extract real opportunities -> enforceReality (same gate) -> normalize
//   -> upsertOpportunity (same catalog + dedup) -> computeMatchDecision + upsertMatch
//
// SEED PAGES (opts.seedPages) enter the SAME flow at the page stage, skipping
// only the search that would have had to find them. They implement the owner's
// standing rule ("a funding source found to meet a profile's needs gets added")
// for pages the Google-bar benchmark already found and this lane's search missed.
// A seed bypasses NO gate: it is fetched, extracted, reality-gated, deduped and
// scored exactly like a search hit, and is added only if all of that passes.
//
// Every guardrail the adapter pipeline uses applies here unchanged: the reality
// gate rejects stubs/placeholders/expired/loan-disallowed/unsafe-URL, the catalog
// dedup collapses repeats, and the canonical match engine (not this lane) decides
// ACCEPT/REVIEW/REJECT. Network + search + LLM are INJECTED so the lane is pure
// and fully testable offline.

import { enforceReality } from './realityGate.js';
import { normalize } from './normalizer.js';
import { computeMatchDecision, isRecommendable } from './matchEngine.js';
import { upsertSource, upsertOpportunity, upsertMatch, recordRejection } from './storage.js';
import { OPPORTUNITY_KIND, TRUST_TIER, MATCH_DECISION, canonicalOpportunityKey } from './contract.js';
import { buildWebQueries } from './webQueries.js';
// Pure URL canonicalizer (tracking-param strip) — from the SHARED urlCanonical
// module, NOT the blind link inventory, so the live lane stays blind-import-free.
import { canonicalizeUrl } from './urlCanonical.js';

// The synthetic source row for open-web finds. UNVERIFIED trust tier is honest:
// these are corroborated by a real fetched page + reality gate, but not by an
// official API. (record_origin persists as 'live_crawl'; not in the relevance
// floor's TRUSTED set, so web rows must clear the higher ≥55 match floor.)
export const WEB_SOURCE = Object.freeze({
  source_id: 'web_search',
  name: 'Open Web (profile-keyed search + LLM extraction)',
  trust_tier: TRUST_TIER.UNVERIFIED,
  geography: { national: false, states: [] },
  default_kinds: [OPPORTUNITY_KIND.DIRECT_GRANT],
});

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function firstHttps(...urls) {
  for (const u of urls) {
    const s = String(u || '').trim();
    if (/^https:\/\//i.test(s)) return s;
  }
  return null;
}

// Derive honest need tags: the opp's own text intersected with the profile's
// needs (never blind-inherit the whole profile — that would inflate matching).
function deriveNeeds(ex, thesisNeeds = []) {
  const blob = `${ex.title || ''} ${ex.summary || ''} ${ex.eligibility || ''} ${ex.relevance_reason || ''}`.toLowerCase();
  return (thesisNeeds || []).filter((n) => n && blob.includes(String(n).toLowerCase())).slice(0, 6);
}

/** Map one LLM-extracted opportunity to the OS candidate contract. */
function toCandidate(ex, evidence, thesis, page) {
  const sponsor = String(ex.funder || ex.sponsor || '').trim();
  const title = String(ex.title || '').trim();
  if (!sponsor || sponsor.length < 2 || !title) return null;

  const isRolling = String(ex.deadline || '').toLowerCase() === 'rolling' || ex.is_rolling === true;
  const deadline = !isRolling && /^\d{4}-\d{2}-\d{2}/.test(String(ex.deadline || ''))
    ? String(ex.deadline).slice(0, 10)
    : null;

  // Geography: prefer the opportunity's own scope; fall back to the profile's
  // state (we searched by that geo, so a local result is presumed in-scope).
  const exState = ex.state ? String(ex.state).toUpperCase().slice(0, 2) : null;
  const profState = thesis.location?.state ? String(thesis.location.state).toUpperCase().slice(0, 2) : null;
  const national = ex.national === true;
  const states = national ? [] : [exState || profState].filter(Boolean);

  const applyUrl = firstHttps(ex.apply_url, evidence.url, page.url);

  return {
    external_id: null,
    source_id: WEB_SOURCE.source_id,
    kind: isRolling ? OPPORTUNITY_KIND.PROGRAM : OPPORTUNITY_KIND.DIRECT_GRANT,
    title,
    sponsor,
    summary: (String(ex.summary || ex.eligibility || '').replace(/\s+/g, ' ').trim() || null)?.slice(0, 800) ?? null,
    deadline,
    is_rolling: isRolling,
    apply_url: applyUrl,
    info_url: applyUrl || evidence.url,
    // The LLM already judged this opp applyable for THIS applicant; tag the
    // profile's types so eligibility scores honestly. Cross-profile matches are
    // still filtered by geo + need, so this does not pollute other profiles.
    applicant_types: Array.isArray(thesis.applicant_types) ? thesis.applicant_types.filter((t) => t && t !== '*') : [],
    need_categories: deriveNeeds(ex, thesis.needs),
    geography: { national, states },
    amount_min: numOrNull(ex.amount_min),
    amount_max: numOrNull(ex.amount_max),
    is_loan: ex.is_loan === true,
    requires_cost_share: ex.requires_cost_share === true || ex.requires_match === true,
    raw: { extracted: ex, query: page.query, page_url: page.url },
  };
}

/**
 * pickTargetUrl — the candidate's OWN independent application/target URL to verify:
 * a real apply_url, else info_url, that is an absolute http(s) URL. Returns null
 * when the candidate exposes no such target.
 */
function pickTargetUrl(cand) {
  const apply = cand && typeof cand.apply_url === 'string' && /^https?:\/\//i.test(cand.apply_url) ? cand.apply_url.trim() : null;
  if (apply) return apply;
  const info = cand && typeof cand.info_url === 'string' && /^https?:\/\//i.test(cand.info_url) ? cand.info_url.trim() : null;
  return info || null;
}

/**
 * targetDedupKey — normalize a target URL to its FETCH identity for per-run dedup.
 * Reuses the shared URL canonicalizer (`canonicalizeUrl` — strips known tracking
 * params, so `?utm_source=…` aliases collapse) AND additionally drops the fragment:
 * a `#hash` is never sent in an HTTP request, so two targets that differ only by
 * fragment are the SAME server fetch and must dedup to one. Falls back to the
 * trimmed raw string if canonicalization fails (defensive — pickTargetUrl already
 * guarantees an absolute http(s) URL, so canonicalization normally succeeds).
 */
function targetDedupKey(url) {
  const canon = canonicalizeUrl(url);
  if (!canon) return String(url || '').trim();
  try {
    const u = new URL(canon);
    u.hash = '';
    return u.toString();
  } catch {
    return canon;
  }
}

/**
 * verifyBlindTargets — bounded, best-effort INDEPENDENT target verification for a
 * run's collected blind candidates. Mutates `shadow`'s target-* accumulators ONLY;
 * it never touches the live lane's `result`, `store`, or matches. See the call
 * site for the full contract (single wall-clock budget + max-fetches cap, per-fetch
 * timeout + abort, dedup, SSRF-safe fetcher only, error isolation).
 */
async function verifyBlindTargets(shadow, fetcher, fetchedSourceKeys, minSliceMs) {
  // Dedup by NORMALIZED key (tracking-param + fragment stripped), and cache the
  // RESULT of EVERY attempted target — success AND failure/timeout — so a given
  // target is fetched at most ONCE per run (a repeatedly-failing url is never
  // re-fetched up to the caps).
  const cache = new Map(); // dedup key -> boolean verified
  for (const { cand, evidenced } of shadow.targets) {
    const targetUrl = pickTargetUrl(cand);
    const key = targetUrl ? targetDedupKey(targetUrl) : null;

    // No INDEPENDENT target (missing, or it IS a source page we already fetched):
    // the candidate rests on source evidence alone. Counted, but no fetch spent.
    if (!targetUrl || (fetchedSourceKeys && key && fetchedSourceKeys.has(key))) {
      shadow.target_checked += 1;
      shadow.source_only += 1;
      continue;
    }

    // Deduped: a target another candidate already ATTEMPTED this run (verified OR
    // failed) reuses the cached verdict — no second network fetch (the dedup
    // guarantee, now covering failures too so a bad url costs exactly one fetch).
    if (cache.has(key)) {
      shadow.target_checked += 1;
      if (cache.get(key)) {
        shadow.target_verified += 1;
        if (evidenced) shadow.real_and_matched += 1;
      } else {
        shadow.source_only += 1;
      }
      continue;
    }

    // Bounds checked BEFORE the fetch: once the max-fetches cap OR the single
    // wall-clock budget is spent, stop and mark capped (remaining candidates are
    // simply not sampled — this is a bounded sample by design).
    const remaining = shadow.targetBudgetMs - shadow.target_elapsed_ms;
    if (shadow.target_fetches >= shadow.targetMax || remaining < minSliceMs) {
      shadow.target_capped = true;
      break;
    }

    const sliceMs = Math.min(shadow.targetTimeoutMs, remaining);
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer;
    let timedOut = false;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('target_verify_timeout')); }, sliceMs);
      });
      // Fetch the candidate's OWN target via the SSRF-safe fetcher (the SAME one
      // live discovery uses), then decide verified via the injected classifier
      // (reachable + real single program, not aggregator/error/login). The whole
      // fetch+classify is raced against the slice deadline so a hung host aborts.
      const work = (async () => {
        const resp = await fetcher.fetch(targetUrl, { method: 'GET', signal: controller.signal });
        // reachable = the fetcher followed any 3xx to a final 2xx (resp.ok).
        if (!resp || !resp.ok || resp.body == null) return false;
        if (typeof shadow.classifyTarget === 'function') {
          const verdict = await shadow.classifyTarget({
            candidate: cand,
            finalUrl: resp.finalUrl ?? targetUrl,
            html: resp.body,
            status: resp.status ?? null,
            signal: controller.signal,
          });
          return !!(verdict && verdict.verified === true);
        }
        return true; // no classifier => reachability alone stands in
      })();
      const verified = await Promise.race([work, deadline]);
      cache.set(key, verified);
      shadow.target_checked += 1;
      if (verified) {
        shadow.target_verified += 1;
        if (evidenced) shadow.real_and_matched += 1;
      } else {
        shadow.source_only += 1;
      }
    } catch {
      // Best-effort isolation: any fetch/classify error or timeout is counted and
      // never affects the live lane. The FAILURE is cached (as not-verified) so a
      // later candidate sharing this target reuses the verdict instead of spending
      // another fetch — a repeatedly-failing url costs exactly one fetch per run.
      void timedOut;
      cache.set(key, false);
      shadow.target_checked += 1;
      shadow.target_check_errors += 1;
    } finally {
      clearTimeout(timer);
      shadow.target_fetches += 1;
      shadow.target_elapsed_ms += Date.now() - startedAt;
    }
  }
}

/**
 * runWebDiscoveryLane — execute the open-web lane for one thesis, writing finds
 * into `store` (so the caller's persistRun flushes them).
 *
 * @param {{ store, fetcher:{fetch:Function}, searchWeb:Function, extractOpportunities:Function, blindShadow? }} deps
 * @param {{ extractPage:Function, maxPages?:number, totalBudgetMs?:number, perPageTimeoutMs?:number, classifyTarget?:Function, targetVerifyBudgetMs?:number, targetVerifyMax?:number, targetVerifyTimeoutMs?:number }} [deps.blindShadow]
 *   Phase-1b profile-BLIND shadow observer (WEB_LANE_PROFILE_BLIND). When the caller
 *   injects it (flag ON), the lane ALSO re-extracts each already-fetched page through
 *   the profile-blind path via
 *   `extractPage({pageUrl,html,timeoutMs,signal}) => Promise<Array<candidate>>`
 *   and records a read-only `web_lane_blind_shadow` delta counter. It NEVER writes
 *   to `store`, never touches what the live lane returns/persists. A single
 *   wall-clock `totalBudgetMs` (default 6000) caps the TOTAL time the live loop
 *   awaits blind work all run; each page is awaited ≤ min(`perPageTimeoutMs`
 *   default 4000, budget remaining), raced against that deadline with the signal
 *   aborted on timeout, so blind work can never stall live. Absent (flag OFF) =>
 *   this path never runs and the counter never exists (byte-identical control
 *   flow, return, and writes).
 *
 *   Phase 1d additionally: when the shadow is active, AFTER all live work the lane
 *   verifies a BOUNDED sample of blind candidates' OWN apply/info targets by
 *   fetching them via THIS same SSRF-safe `fetcher` (never the source page — that
 *   is already fetched — and deduped by target URL), and reports a
 *   `promotion_evidence` breakdown ({ target_checked, target_verified, source_only,
 *   real_and_matched, … }). `deps.blindShadow.classifyTarget({candidate,finalUrl,
 *   html,status,signal}) => {verified}` supplies the page-derived verdict (the seam
 *   that imports the 1c classifier); `targetVerifyBudgetMs`/`targetVerifyMax`/
 *   `targetVerifyTimeoutMs` bound it (single wall-clock budget + max fetches +
 *   per-fetch timeout). Source-evidence and target-verification stay DISTINCT facts.
 * @param {{ thesis, matchProfiles?, floor?, runId?, maxQueries?, resultsPerQuery?, maxPages?, seedPages? }} opts
 * @param {Array<{url,title?,snippet?}>} [opts.seedPages] Known funding pages to
 *   fetch IN ADDITION to this run's search hits — see SEED PAGES below.
 * @returns {Promise<object>} lane telemetry
 */
export async function runWebDiscoveryLane(deps, opts = {}) {
  const { store, fetcher, searchWeb, extractOpportunities, blindShadow } = deps;
  const result = { ok: false, queries: [], pages: 0, seeded: 0, fetched: 0, extracted: 0, stored: 0, deduped: 0, rejected: 0, recommendations: [] };
  if (!store || !fetcher?.fetch || typeof searchWeb !== 'function' || typeof extractOpportunities !== 'function') {
    result.reason = 'web_lane_deps_missing';
    return result;
  }
  // Profile-BLIND shadow accumulator (Phase 1b). Non-null ONLY when the caller
  // injected a valid blind shadow (WEB_LANE_PROFILE_BLIND ON). While null, NOTHING
  // below reads it — no blind extraction runs and `web_lane_blind_shadow` is never
  // attached, so a flag-off run is byte-identical to the pre-1b baseline.
  //
  // COST/LATENCY GUARANTEE: the shadow is best-effort observation and must NEVER
  // delay the live lane. A SINGLE wall-clock budget (`totalBudgetMs`) caps the
  // TOTAL time the live loop will ever await blind work across the whole run — not
  // per-page × pages. Each page is awaited for at most min(perPageTimeoutMs,
  // budget-remaining), the lane races it against that deadline and ABORTS on
  // timeout (so a hung provider cannot stall live), and once the budget is spent
  // no further page is shadowed (capped). A timeout is counted as such — never as
  // a silent 0-candidate success.
  const shadow = (blindShadow && typeof blindShadow.extractPage === 'function')
    ? {
        extractPage: blindShadow.extractPage,
        maxPages: Number.isFinite(blindShadow.maxPages) && blindShadow.maxPages > 0 ? Math.floor(blindShadow.maxPages) : 8,
        totalBudgetMs: Number.isFinite(blindShadow.totalBudgetMs) && blindShadow.totalBudgetMs > 0 ? Math.floor(blindShadow.totalBudgetMs) : 6000,
        perPageTimeoutMs: Number.isFinite(blindShadow.perPageTimeoutMs) && blindShadow.perPageTimeoutMs > 0 ? Math.floor(blindShadow.perPageTimeoutMs) : 4000,
        pagesRun: 0, pages_shadowed: 0, errors: 0, timeouts: 0, capped: false, elapsedMs: 0,
        current_candidates: 0, blind_candidates: 0, blind_evidenced: 0,
        // Phase 1c per-kind breakdown of the blind candidates (trust-aware
        // classifier labels, tallied read-only). protected_directory +
        // unverified_index === aggregator_index by construction. Blind candidates
        // arrive already labeled by the shadow builder (the sanctioned seam that
        // imports the classifier); this lane only COUNTS them, so it stays
        // blind-import-free.
        by_kind: { direct: 0, aggregator_index: 0, unknown: 0, protected_directory: 0, unverified_index: 0 },
        // ── Phase 1d INDEPENDENT TARGET VERIFICATION (promotion evidence) ──────
        // classifyTarget: an OPTIONAL page-derived verdict callback the shadow
        // builder supplies (the sanctioned seam that imports the 1c classifier +
        // the login/error heuristic). It is handed the FETCHED target's own bytes
        // and returns `{ verified:boolean }`. When absent (a minimal/mock shadow),
        // reachability alone (2xx/3xx-final) stands in. This lane never imports a
        // blind module — it only fetches (via the SAME SSRF-safe fetcher live uses)
        // and tallies.
        classifyTarget: typeof blindShadow.classifyTarget === 'function' ? blindShadow.classifyTarget : null,
        // A SINGLE wall-clock budget + a max-fetches cap for the WHOLE run's target
        // verification — the same shape/guarantee as the blind-extract budget above.
        // Checked BEFORE each network fetch; once either is hit the pass stops and
        // marks `target_capped`. Each fetch also has its own short slice timeout +
        // AbortSignal, so a hung target host can never stall the live lane.
        targetBudgetMs: Number.isFinite(blindShadow.targetVerifyBudgetMs) && blindShadow.targetVerifyBudgetMs > 0 ? Math.floor(blindShadow.targetVerifyBudgetMs) : 5000,
        targetMax: Number.isFinite(blindShadow.targetVerifyMax) && blindShadow.targetVerifyMax >= 0 ? Math.floor(blindShadow.targetVerifyMax) : 5,
        targetTimeoutMs: Number.isFinite(blindShadow.targetVerifyTimeoutMs) && blindShadow.targetVerifyTimeoutMs > 0 ? Math.floor(blindShadow.targetVerifyTimeoutMs) : 3000,
        // Collected blind candidates awaiting target verification (their apply/info
        // target is fetched INDEPENDENTLY of the source listing page, after ALL live
        // work is done). Each is { cand, evidenced } — evidenced mirrors the 1a
        // page-supported-evidence fact so `real_and_matched` stays a DISTINCT fact
        // from target reachability, never conflated.
        targets: [],
        // Target-verification accumulators (all read-only telemetry). target_checked
        // partitions into target_verified + source_only + target_check_errors.
        target_fetches: 0, target_elapsed_ms: 0, target_capped: false,
        target_checked: 0, target_verified: 0, source_only: 0,
        target_check_errors: 0, real_and_matched: 0,
      }
    : null;
  // The smallest slice worth attempting: below this the LLM cannot plausibly
  // answer, so we stop rather than spend the tail of the budget on sure timeouts.
  const SHADOW_MIN_SLICE_MS = 250;
  // The smallest target-verify slice worth a fetch: below this a real remote round
  // trip cannot complete, so we stop rather than burn the budget tail on sure aborts.
  const TARGET_VERIFY_MIN_SLICE_MS = 200;
  // The source pages we ALREADY fetched this run, held as NORMALIZED dedup keys.
  // Target verification must NEVER re-fetch the source/listing page (we have its
  // bytes) — only the candidate's OWN independent apply/info target. A candidate
  // whose only target IS the source page (matched on the normalized key, so an
  // alias/fragment variant still counts) has no independent target and rests on
  // source evidence alone (source_only).
  const fetchedSourceKeys = shadow ? new Set() : null;
  const thesis = opts.thesis ?? {};
  const matchProfiles = (opts.matchProfiles && opts.matchProfiles.length) ? opts.matchProfiles : [thesis];
  const runId = opts.runId ?? null;
  // Breadth caps (bounded to respect search rate limits / the Brave breaker,
  // which makes searchWeb return [] when paused). Raised from 5/6/14 to widen the
  // candidate pool per run without hammering the provider.
  // Breadth raised 8/8/20 -> 14/8/26 so the new institution- / employer- /
  // county-specific CORE queries (buildWebQueries) run ALONGSIDE the need /
  // interest / field-of-study queries in one pass, instead of crowding them out.
  //
  // Raised again 14/8/26 -> 20/8/32 and made ENV-TUNABLE (2026-08-03, the
  // recall-guardrail audit). MEASURED on all 34 real prod profiles at
  // 2026-08-03T16:49Z: buildWebQueries assembled 2,531 profile-keyed queries
  // fleet-wide and the cap of 14 ran 476 of them — 81% of the topical/
  // hyperlocal/entity queries the profile's own facts justify NEVER executed
  // (per-profile truncation p50 61, max 129), and every one of the 34 profiles
  // was truncated. The pool is deliberately larger than any one run (the seed
  // rotation samples it across nights), but at 14 with ONE rotating tail slot a
  // p50 profile needs ~61 nights to see each broadening query once. 20 is a
  // bounded step, not a floodgate: every extra query still faces the SERP →
  // fetch → LLM-extract → reality gate → canonical match engine stack, and
  // maxPages rises with it so the extra queries can actually contribute pages.
  // The owner rule this serves: precision comes from classifying junk out,
  // never from starving what is searched.
  const envInt = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const maxQueries = Number.isFinite(opts.maxQueries) ? opts.maxQueries
    : envInt(process.env.WEB_LANE_MAX_QUERIES, 20);
  const resultsPerQuery = Number.isFinite(opts.resultsPerQuery) ? opts.resultsPerQuery
    : envInt(process.env.WEB_LANE_RESULTS_PER_QUERY, 8);
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages
    : envInt(process.env.WEB_LANE_MAX_PAGES, 32);
  // Per-run rotation seed: successive discoveries sample DIFFERENT broadening
  // queries (the CORE queries always run) so a profile stops getting the same
  // set every time. Injectable for deterministic tests; defaults to wall-clock.
  const seed = Number.isFinite(opts.seed) ? opts.seed : Date.now();

  upsertSource(store, WEB_SOURCE);

  // 1) Search → collect unique candidate pages (bounded).
  //
  // SEED PAGES — the owner's standing rule: "if a funding source is found that
  // meets the needs of a profile, ADD that funding source." The Google-bar
  // benchmark already FINDS real funding pages this lane's own search misses
  // (fleet parity 41.2 on 2026-07-15 = most of what a plain web session surfaces
  // was absent), and it filed every one into a candidate queue that had no
  // consumer — so a source we had already found, and already judged real, was
  // re-found and re-filed nightly and never added. Seeding those URLs here is
  // what closes that loop.
  //
  // A seed is a URL, NOT a verdict. It enters at exactly the same place a search
  // hit does and is then fetched, LLM-extracted, reality-gated, deduped, and
  // scored by the canonical match engine like anything else — "found by a
  // benchmark" earns a page a LOOK, never a row and never a match. Seeds are
  // placed FIRST and are exempt from `maxPages` (which exists to bound how much
  // of an unbounded SERP we chase, a question already settled for a known URL);
  // the caller bounds the seed list itself.
  const seen = new Set();
  const pages = [];
  for (const s of Array.isArray(opts.seedPages) ? opts.seedPages : []) {
    const url = String(s?.url || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    pages.push({ url, query: s.query ?? 'seed:web_parity_gap', title: s.title, snippet: s.snippet, seeded: true });
  }
  result.seeded = pages.length;

  const queries = buildWebQueries(thesis, { max: maxQueries, seed });
  result.queries = queries;
  for (const q of queries) {
    if (pages.length - result.seeded >= maxPages) break;
    let hits = [];
    try { hits = await searchWeb(q, { count: resultsPerQuery }); } catch { hits = []; }
    for (const h of Array.isArray(hits) ? hits : []) {
      const url = String(h?.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      pages.push({ url, query: q, title: h.title, snippet: h.snippet });
      if (pages.length - result.seeded >= maxPages) break;
    }
  }
  result.pages = pages.length;

  // 2) Fetch each page → LLM-extract → gate → normalize → store → match.
  const storedKeys = new Set();
  // Which SEEDED pages actually produced a catalog row. This is the evidence the
  // owner rule worked: it lets the caller mark a candidate 'adopted' vs
  // 'gated_out' from what the gates DID, rather than from the fact we tried.
  // Without it, "we seeded 8 pages" would be reported as if it were "we added 8
  // sources" — the same read-green-while-doing-nothing class as the sweep that
  // marked rows attempted and found zero amounts.
  const seededAdopted = new Set();
  for (const page of pages) {
    let resp;
    try { resp = await fetcher.fetch(page.url, { method: 'GET' }); }
    catch { resp = { ok: false }; }
    if (!resp?.ok || resp.body == null) continue;
    result.fetched += 1;

    const evidence = { url: resp.finalUrl ?? page.url, content_hash: resp.contentHash ?? null, fetched_at: resp.fetchedAt ?? null };
    // Remember this source page's own URL so target verification never re-fetches
    // it (both the requested and any redirect-final URL are ours already), keyed
    // the SAME normalized way targets are so an alias/fragment variant still hits.
    if (fetchedSourceKeys) { fetchedSourceKeys.add(targetDedupKey(page.url)); fetchedSourceKeys.add(targetDedupKey(evidence.url)); }

    let extracted = [];
    try { extracted = await extractOpportunities({ pageUrl: evidence.url, html: resp.body, thesis, query: page.query }); }
    catch { extracted = []; }

    // Count the current (profile-conditioned) path's candidates for THIS page so
    // the blind shadow can report a per-page delta. Shadow-only bookkeeping: it is
    // touched ONLY when the shadow is active, so a flag-off run does no extra work.
    let pageCurrentCandidates = 0;
    for (const ex of Array.isArray(extracted) ? extracted : []) {
      const cand = toCandidate(ex, evidence, thesis, page);
      if (!cand) continue;
      result.extracted += 1;
      if (shadow) pageCurrentCandidates += 1;

      const verdict = enforceReality(cand, { thesis, source: WEB_SOURCE, evidence });
      if (!verdict.ok) {
        result.rejected += 1;
        if (runId) recordRejection(store, runId, { source_id: WEB_SOURCE.source_id, reason: verdict.reason, detail: verdict.verdict_reasons?.join('; '), title: cand.title, url: cand.apply_url ?? cand.info_url });
        continue;
      }

      const opp = normalize(cand, verdict, { source: WEB_SOURCE, evidence });
      const key = canonicalOpportunityKey(opp);
      if (storedKeys.has(key)) { result.deduped += 1; continue; }

      const res = upsertOpportunity(store, opp);
      const canonicalId = res.canonical_id ?? opp.id;
      if (!res.stored && !res.deduped) { result.rejected += 1; continue; }
      if (res.deduped) result.deduped += 1; else result.stored += 1;
      storedKeys.add(key);
      // `deduped` counts as adopted: the source IS in the catalog and reachable
      // for this profile, which is what the rule promises. Re-offering it next
      // run would just re-dedupe it forever.
      if (page.seeded) seededAdopted.add(page.url);

      // Per-profile matching — decision comes ONLY from the canonical engine.
      const matchOpp = canonicalId !== opp.id ? { ...opp, id: canonicalId } : opp;
      for (const mp of matchProfiles) {
        // Full profile context when the thesis carries it (primary profile) —
        // see pipeline.js: context-less cross-match stubs fall under the
        // engine's MIN_CALIBRATED_INVENTORY topical cap.
        const decision = computeMatchDecision(matchOpp, mp, {
          floor: opts.floor,
          profileRow: mp._profileContext?.profile ?? null,
          profileSections: mp._profileContext?.sections ?? null,
          signals: mp._profileContext?.signals ?? null,
        });
        // Provenance for the crawler doctor: the exact query that surfaced the
        // page this opportunity was extracted from.
        upsertMatch(store, { ...decision, source_query: page.query, discovered_via: 'web_search' });
        if (isRecommendable(matchOpp, decision.decision) && mp.profile_id === thesis.profile_id) {
          // topical_evidence: legacy weighted-evidence subscale for Amy's
          // weight-tuning validation (weights no longer move the final score).
          // kind + amounts travel with the recommendation so Amy's evaluator
          // measures award-amount recall against what the run actually found
          // (a DIRECTORY locator never carries a per-award amount by design).
          result.recommendations.push({
            opportunity_id: matchOpp.id,
            title: matchOpp.title,
            // The engine's generic-only ACCEPT cap evaluates title +
            // DESCRIPTION; Amy's false_positive detector must read the same
            // text, so the description travels with the recommendation.
            description: matchOpp.description ?? null,
            sponsor: matchOpp.sponsor,
            kind: matchOpp.kind ?? null,
            amount_min: matchOpp.funding?.amount_min ?? null,
            amount_max: matchOpp.funding?.amount_max ?? null,
            amount_status: matchOpp.funding?.amount_status ?? null,
            match_score: decision.match_score,
            // The canonical decision must travel with the recommendation. The
            // registry lane already does this; dropping it here made Amy infer
            // ACCEPT from a capped REVIEW score and report phantom defects.
            decision: decision.decision,
            match_decision: decision.decision,
            match_explanation: decision.match_explain?.why ?? null,
            source: 'web_search',
            topical_evidence: decision.match_explain?.score_breakdown?.topical_evidence ?? null,
          });
        }
      }
    }

    // ── Profile-BLIND shadow (Phase 1b, WEB_LANE_PROFILE_BLIND) ──────────────
    // Read-only observation on the SAME already-fetched page bytes (`resp.body`,
    // no extra network fetch). It re-extracts through the profile-blind path and
    // records a delta counter ONLY — it never writes to `store`, never touches
    // `result.recommendations`/`stored`/matches. Bounded by `shadow.maxPages` AND
    // a single wall-clock `totalBudgetMs`: each page is awaited for at most
    // min(perPageTimeoutMs, budget remaining), the await is RACED against that
    // deadline (and the extractPage AbortSignal fired) so a hung provider can
    // never stall the live lane, and once the budget is spent the shadow stops.
    if (shadow) {
      const remainingBudget = shadow.totalBudgetMs - shadow.elapsedMs;
      if (shadow.pagesRun >= shadow.maxPages || remainingBudget < SHADOW_MIN_SLICE_MS) {
        shadow.capped = true;
      } else {
        shadow.pagesRun += 1;
        const sliceMs = Math.min(shadow.perPageTimeoutMs, remainingBudget);
        const controller = new AbortController();
        const startedAt = Date.now();
        let timer;
        let timedOut = false;
        try {
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('shadow_timeout')); }, sliceMs);
          });
          // Thread the deadline (timeoutMs) + AbortSignal into extractPage so the
          // blind extractor self-bounds AND the provider call can be cancelled;
          // the lane's own race is the authoritative live-latency bound.
          const work = Promise.resolve(
            shadow.extractPage({ pageUrl: evidence.url, html: resp.body, timeoutMs: sliceMs, signal: controller.signal }),
          );
          const blind = await Promise.race([work, deadline]);
          const list = Array.isArray(blind) ? blind : [];
          shadow.pages_shadowed += 1;
          shadow.current_candidates += pageCurrentCandidates;
          shadow.blind_candidates += list.length;
          shadow.blind_evidenced += list.filter(
            (c) => c && c.field_provenance && typeof c.field_provenance === 'object' && Object.keys(c.field_provenance).length > 0,
          ).length;
          // Per-kind tally (Phase 1c). Each blind candidate carries a `blind_kind`
          // + `blind_trust` label from the classifier; an unlabeled candidate
          // (e.g. an older/mock shadow) counts conservatively as UNKNOWN. The trust
          // axis only ever splits the AGGREGATOR_INDEX bucket.
          for (const c of list) {
            const kind = c && typeof c.blind_kind === 'string' ? c.blind_kind : 'UNKNOWN';
            if (kind === 'DIRECT_PROGRAM') {
              shadow.by_kind.direct += 1;
            } else if (kind === 'AGGREGATOR_INDEX') {
              shadow.by_kind.aggregator_index += 1;
              if (c && c.blind_trust === 'PROTECTED') shadow.by_kind.protected_directory += 1;
              else shadow.by_kind.unverified_index += 1;
            } else {
              shadow.by_kind.unknown += 1;
            }
            // Collect for the Phase-1d target-verification pass (run AFTER all live
            // work). `evidenced` is the SAME 1a page-supported-evidence fact used
            // for blind_evidenced — kept as a candidate-level fact so real_and_matched
            // (target_verified AND evidenced) never conflates source vs target proof.
            const evidenced = !!(c && c.field_provenance && typeof c.field_provenance === 'object'
              && Object.keys(c.field_provenance).length > 0);
            shadow.targets.push({ cand: c, evidenced });
          }
        } catch {
          // Best-effort isolation: a blind failure/timeout never affects the live
          // lane. A timeout is counted as itself, never as a silent 0-cand success.
          if (timedOut) shadow.timeouts += 1;
          else shadow.errors += 1;
        } finally {
          clearTimeout(timer);
          shadow.elapsedMs += Date.now() - startedAt;
        }
      }
    }
  }

  // ── Finalize the LIVE result — WITHOUT awaiting target verification ────────
  // The live outputs (result.ok, recommendations, seeded_adopted) and everything
  // the caller persists are produced and returned here. Independent target
  // verification (below) is a bounded, best-effort telemetry-only step that must
  // NEVER gate this — see the `targetVerification` handle after this block.
  result.ok = true;
  // Additive shadow delta (mirrors the SEMANTIC_RECALL additive-counter
  // precedent). Present ONLY when the flag is ON; absent otherwise so a flag-off
  // run is byte-identical. Blind candidates are NEVER persisted — this is pure
  // observation (current-path vs blind-path counts, and how many blind candidates
  // carried page-supported evidence).
  if (shadow) {
    result.web_lane_blind_shadow = {
      ran: true,
      pages_shadowed: shadow.pages_shadowed,
      errors: shadow.errors,
      timeouts: shadow.timeouts,
      capped: shadow.capped,
      elapsed_ms: shadow.elapsedMs,
      current_candidates: shadow.current_candidates,
      blind_candidates: shadow.blind_candidates,
      blind_evidenced: shadow.blind_evidenced,
      delta: shadow.blind_candidates - shadow.current_candidates,
      by_kind: shadow.by_kind,
      // Phase 1d promotion_evidence is attached ASYNCHRONOUSLY by the target
      // verification step (result.targetVerification) so the live return never
      // waits on it. It is NOT present on the returned object until that handle
      // settles — the caller awaits it AFTER persistRun (telemetry-only).
    };
  }
  result.seeded_adopted_urls = [...seededAdopted];
  result.seeded_adopted = seededAdopted.size;
  result.recommendations.sort((a, b) => b.match_score - a.match_score);

  // ── Phase 1d: INDEPENDENT TARGET VERIFICATION (promotion evidence) ─────────
  // Runs ONLY when the shadow is active (WEB_LANE_PROFILE_BLIND ON), and its ONLY
  // effect is the shadow telemetry counter — it does NOT gate result.ok,
  // recommendations, or anything the caller persists. It is STARTED here but
  // deliberately NOT awaited on the live path: the function returns immediately
  // with the live result, and `result.targetVerification` is a promise the caller
  // awaits AFTER persistRun (so the live result + persist never wait on it — a
  // target that hangs for the whole budget cannot delay the live return). Because
  // it is fired before the return, it also runs CONCURRENTLY with persistRun.
  //
  // For a BOUNDED sample of blind candidates it fetches the candidate's OWN
  // apply/info target via the SAME SSRF-safe fetcher live discovery uses (never a
  // raw fetch, never the source page — deduped by normalized key), and records
  // whether that target is INDEPENDENTLY reachable + a real single program (not an
  // aggregator/error/login page) — stronger promotion evidence than the source
  // LISTING page's hash.
  //
  // HARD BOUNDS: one wall-clock budget (`targetBudgetMs`) AND a max-fetches cap
  // (`targetMax`) for the WHOLE run, both checked BEFORE every fetch; once either
  // is hit the pass stops and marks `target_capped`. Each fetch has its own short
  // slice timeout + AbortSignal and is raced against that deadline, so a hung host
  // is aborted and counted (`target_check_errors`), never awaited past the budget.
  // Best-effort: any fetch/classify error is caught and counted; the live lane's
  // result/writes are NEVER touched.
  if (shadow) {
    result.targetVerification = (async () => {
      try {
        if (shadow.targets.length) {
          await verifyBlindTargets(shadow, fetcher, fetchedSourceKeys, TARGET_VERIFY_MIN_SLICE_MS);
        }
      } catch {
        // Best-effort isolation: target verification can never fail the lane.
      }
      // SOURCE evidence (blind_evidenced) and TARGET verification are DIFFERENT
      // facts, reported apart:
      //   target_checked      candidates whose target we produced a verdict for
      //                       (= target_verified + source_only + target_check_errors)
      //   target_verified     target independently reachable + a real single program
      //   source_only         checked but not target-verified (no independent target,
      //                       unreachable, aggregator, or error/login page)
      //   real_and_matched    target_verified AND the candidate was page-evidenced
      //                       (1a) — the NET real-matched evidence a promotion needs
      //   target_check_errors best-effort fetch/classify failures (never affect live)
      //   target_fetches      real network fetches spent (≤ targetMax)
      //   target_capped       stopped early because a bound was hit
      const promotion_evidence = {
        target_checked: shadow.target_checked,
        target_verified: shadow.target_verified,
        source_only: shadow.source_only,
        real_and_matched: shadow.real_and_matched,
        target_check_errors: shadow.target_check_errors,
        target_fetches: shadow.target_fetches,
        target_capped: shadow.target_capped,
        target_elapsed_ms: shadow.target_elapsed_ms,
      };
      if (result.web_lane_blind_shadow) result.web_lane_blind_shadow.promotion_evidence = promotion_evidence;
      return promotion_evidence;
    })();
  }

  return result;
}

export default { runWebDiscoveryLane, WEB_SOURCE };
