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
import { computeMatchDecision, isResearchLead } from './matchEngine.js';
import { isVerifiedDirectFundingRecommendation } from './fundingTruthPolicy.js';
import { upsertSource, upsertOpportunity, upsertMatch, recordRejection } from './storage.js';
import { OPPORTUNITY_KIND, TRUST_TIER, MATCH_DECISION, canonicalOpportunityKey } from './contract.js';
import {
  buildWebQueryPlan,
  hasPersistentQueryShortfall,
  normalizeQueryKey,
  PERSISTENT_QUERY_ANCHOR_COUNT,
} from './webQueries.js';
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

function cleanStringArray(value, max = 12) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function cleanState(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

// Preserve the search engine's non-enumerable provenance before the result
// array is flattened into pages. Acceptance must distinguish a real provider
// response from cache, degradation, an unavailable backend, or missing
// metadata; result count alone cannot prove any of those facts.
function searchProvenanceFor(results, queryIndex, threw = false, query = null) {
  const meta = results?.searchMeta && typeof results.searchMeta === 'object'
    ? results.searchMeta
    : null;
  const resultCount = Array.isArray(results) ? results.length : 0;
  const cacheAgeKnown = meta?.cache_age_ms !== null && meta?.cache_age_ms !== undefined &&
    Number.isFinite(Number(meta.cache_age_ms));
  return {
    query_index: queryIndex,
    query,
    result_count: resultCount,
    provider: String(meta?.provider || 'unknown'),
    provenance: String(meta?.provenance || 'unknown'),
    status: String(meta?.status || (threw ? 'error' : (resultCount > 0 ? 'ok' : 'empty'))),
    cache_age_ms: cacheAgeKnown ? Math.max(0, Number(meta.cache_age_ms)) : null,
    cache_age_known: cacheAgeKnown,
    provider_mode: meta?.provider_mode ?? null,
    provenance_reason: meta?.reason ?? null,
  };
}

/** Map one PAGE-DERIVED extraction to the OS candidate contract. */
function toCandidate(ex, evidence, _thesis, page) {
  if (!ex || typeof ex !== 'object') return null;

  // The live extractor now returns the profile-blind mapper's canonical
  // candidate. Preserve it byte-for-byte except for run provenance. Most
  // importantly, do not overwrite its empty/unknown applicant and geo facts
  // with the searching profile's answers.
  if (ex.raw?.blind_extraction === true) {
    return {
      ...ex,
      source_id: WEB_SOURCE.source_id,
      raw: {
        ...(ex.raw || {}),
        query: page.query,
        page_url: ex.raw?.page_url ?? evidence.url,
      },
    };
  }

  // Compatibility path for injected tests or older source-specific extractors.
  // It remains page-only: categorical facts come from ex, never the profile.
  const sponsor = String(ex.funder || ex.sponsor || '').trim();
  const title = String(ex.title || '').trim();
  if (!sponsor || sponsor.length < 2 || !title) return null;

  const isRolling = String(ex.deadline || '').toLowerCase() === 'rolling' || ex.is_rolling === true;
  const deadline = !isRolling && /^\d{4}-\d{2}-\d{2}/.test(String(ex.deadline || ''))
    ? String(ex.deadline).slice(0, 10)
    : null;
  const explicitKind = Object.values(OPPORTUNITY_KIND).includes(ex.kind) ? ex.kind : null;
  const kind = explicitKind ?? (isRolling ? OPPORTUNITY_KIND.PROGRAM : OPPORTUNITY_KIND.DIRECT_GRANT);
  const national = ex.national === true || ex.geography?.national === true;
  const statedStates = Array.isArray(ex.geography?.states)
    ? ex.geography.states
    : (Array.isArray(ex.states) ? ex.states : [ex.state]);
  const states = national
    ? []
    : cleanStringArray(statedStates, 25).map(cleanState).filter(Boolean);
  const applyUrl = kind === OPPORTUNITY_KIND.DIRECTORY ? null : firstHttps(ex.apply_url);
  const infoUrl = firstHttps(ex.info_url, evidence.url, page.url);

  return {
    external_id: null,
    source_id: WEB_SOURCE.source_id,
    kind,
    title,
    sponsor,
    summary: (String(ex.summary || ex.eligibility || ex.eligibility_text || '').replace(/\s+/g, ' ').trim() || null)?.slice(0, 800) ?? null,
    deadline,
    is_rolling: isRolling,
    apply_url: applyUrl,
    info_url: infoUrl,
    applicant_types: [],
    need_categories: cleanStringArray(ex.need_categories, 12),
    geography: { national, states },
    amount_min: numOrNull(ex.amount_min),
    amount_max: numOrNull(ex.amount_max),
    is_loan: ex.is_loan === true,
    requires_cost_share: ex.requires_cost_share === true || ex.requires_match === true,
    eligibility_text: typeof ex.eligibility_text === 'string' ? ex.eligibility_text : null,
    eligibility_bullets: cleanStringArray(ex.eligibility_bullets, 20),
    page_fact_schema_version: ex.page_fact_schema_version ?? null,
    field_provenance: ex.field_provenance ?? null,
    raw: { extracted: ex, query: page.query, page_url: evidence.url },
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

// ── Stage ledger (REQUIREMENT E, 2026-09-12) ─────────────────────────────────
// The lane used to report only totals (pages/fetched/extracted/stored) and the
// PLANNED query list, so a dead LLM key, a dead search backend, a gate that
// rejected everything and an honestly empty web all read as the same
// `ok:true extracted:0`. Every stage now has ONE counter with an exact name,
// tallied in this file and nowhere else; the choke point
// (crawlerOsService → recordWebLaneRun → learnFromCrawlGaps) persists it.

/** The exact counter vocabulary. Order is the pipeline order. */
export const STAGE_COUNTERS = Object.freeze([
  'query_generated', 'query_skipped_duplicate', 'query_skipped_budget',
  'provider_attempted', 'provider_degraded', 'provider_unavailable',
  'response_received', 'candidates_extracted', 'extraction_failed',
  'canonical_duplicates', 'reality_rejected', 'eligibility_rejected',
  'need_match_rejected', 'apply_target_rejected', 'qualified_admitted',
]);

/** Extraction failure classes (mirrors services/webGrantExtractor.js). */
export const EXTRACTION_FAILURE_CLASSES = Object.freeze([
  'llm_unavailable', 'llm_quota', 'llm_timeout', 'parse_error', 'page_too_short', 'unknown',
]);
const LLM_FAILURE_CLASSES = new Set(['llm_unavailable', 'llm_quota', 'llm_timeout', 'parse_error', 'unknown']);

function emptyStageLedger() {
  const out = {};
  for (const k of STAGE_COUNTERS) out[k] = 0;
  // Accounting helpers (not in the public vocabulary, but needed so every
  // extracted candidate lands in exactly one bucket):
  //   catalog_refused  upsertOpportunity refused a reality-passed row
  //   review_held      primary verdict REVIEW for a reason that is not an
  //                    apply-target / need / eligibility hold (pointer, band)
  out.catalog_refused = 0;
  out.review_held = 0;
  out.extraction_failed_by_class = {};
  return out;
}

function emptyProviderHealth() {
  return { search: 'unknown', llm: 'unknown', detail: {} };
}

/** Classify an extractor THROW the same way webGrantExtractor classifies a result. */
function classifyThrownExtractionError(err) {
  const msg = String(err?.message ?? err ?? '');
  if (err?.name === 'AbortError' || /timeout|timed out|abort/i.test(msg)) return 'llm_timeout';
  if (/quota|credit|billing|insufficient|rate[_ ]?limit|\b429\b|\b402\b/i.test(msg)) return 'llm_quota';
  return 'unknown';
}

/** Read the extractor's non-enumerable failure tag (null when healthy / untagged). */
function extractionFailureClassOf(list) {
  const f = list && typeof list === 'object' ? list.extraction_failure : null;
  const cls = f && typeof f === 'object' ? String(f.class || '') : '';
  return EXTRACTION_FAILURE_CLASSES.includes(cls) ? cls : (cls ? 'unknown' : null);
}

function newPageLedgerEntry({ url, canonicalKey, query, seeded }) {
  return {
    url,
    canonical_key: canonicalKey,
    query,
    seeded: Boolean(seeded),
    fetched: false,
    fetch_status: null,
    final_url: null,
    extracted: 0,
    extraction_failure: null,
    reality_rejected: 0,
    reality_reason: null,
    gate_rejected: { eligibility: 0, need: 0, apply_target: 0 },
    canonical_duplicate: 0,
    catalog_refused: 0,
    review_held: 0,
    admitted: 0,
    stored: 0,
    deduped: 0,
  };
}

/**
 * Classify the PRIMARY profile's verdict on one candidate into exactly one
 * stage bucket. Reads only what computeMatchDecision already recorded.
 */
function classifyPrimaryVerdict(decision, opportunity = null) {
  const d = String(decision?.decision ?? '').toLowerCase();
  const explain = decision?.match_explain ?? {};
  const warnings = Array.isArray(explain.warnings) ? explain.warnings.map((w) => String(w ?? '')) : [];
  const proof = explain.four_truth_proof ?? null;
  if (d === MATCH_DECISION.ACCEPT) return 'qualified_admitted';
  if (d === MATCH_DECISION.REJECT) {
    if (explain.eligibility_fit === false || explain.eligibility_fit === 'no') return 'eligibility_rejected';
    if (explain.need_first_policy?.need_first_hard_mismatch === true) return 'need_match_rejected';
    if (proof && proof.meets_profile_need && proof.meets_profile_need.passed === false && (!proof.profile_qualifies || proof.profile_qualifies.passed !== false)) return 'need_match_rejected';
    return 'eligibility_rejected';
  }
  // REVIEW: which hold? The apply-target gate is STRUCTURAL (a non-pointer
  // with no apply URL can never be an apply-now ACCEPT, whatever the other
  // legs say), so it is judged from the row itself — the engine only writes
  // its warning when the hold flipped an ACCEPT, and a four-truth hold that
  // fired first would otherwise hide it.
  const kind = String(opportunity?.kind ?? '').toUpperCase();
  const isPointer = kind === OPPORTUNITY_KIND.DIRECTORY || kind === OPPORTUNITY_KIND.PAST_AWARD_INTEL;
  const hasApplyUrl = Boolean(opportunity?.apply_url ?? opportunity?.application_url);
  if (opportunity && !isPointer && !hasApplyUrl) return 'apply_target_rejected';
  if (warnings.some((w) => /no direct application URL/i.test(w))) return 'apply_target_rejected';
  const held = warnings.find((w) => /four-truth gate held at REVIEW/i.test(w)) || '';
  if (held) {
    if (/profile_qualifies/.test(held)) return 'eligibility_rejected';
    if (/meets_profile_need/.test(held)) return 'need_match_rejected';
  }
  return 'review_held';
}

function summarizeProviderHealth(result, llmStats) {
  const s = result.stage_ledger;
  const attempted = s.provider_attempted;
  let search = 'unknown';
  if (attempted > 0) {
    if (s.provider_unavailable >= attempted) search = 'unavailable';
    else if (s.provider_degraded > 0 || s.provider_unavailable > 0) search = 'degraded';
    else search = 'healthy';
  }
  let llm = 'unknown';
  if (result.fetched > 0) {
    if (llmStats.ok_pages > 0) llm = 'healthy';
    else if (llmStats.llm_failed_pages > 0) llm = 'unavailable';
  }
  const detail = {
    search: {
      attempted,
      degraded: s.provider_degraded,
      unavailable: s.provider_unavailable,
      cache_hits: result.search_cache_hits,
      unknown_provenance: result.search_unknown_provenance_count,
      provider_counts: { ...result.search_provider_counts },
    },
    llm: {
      pages_fetched: result.fetched,
      ok_pages: llmStats.ok_pages,
      failed_pages: s.extraction_failed,
      failed_by_class: { ...s.extraction_failed_by_class },
    },
  };
  return { search, llm, detail };
}

function dominantFailureClass(byClass) {
  let best = null;
  let bestN = 0;
  for (const [k, n] of Object.entries(byClass || {})) {
    if (Number(n) > bestN) { best = k; bestN = Number(n); }
  }
  return best;
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
  const result = {
    ok: false,
    // EXECUTED queries (webq-1). The plan is `queries_planned` / `query_ledger`.
    // Until 2026-09-12 this held the PLANNED list, so telemetry said 28
    // searches ran when the 44-page cap stopped execution after ~6.
    queries: [],
    queries_planned: [],
    queries_executed: 0,
    pages: 0,
    pages_deduped: 0,
    seeded: 0,
    fetched: 0,
    extracted: 0,
    stored: 0,
    deduped: 0,
    rejected: 0,
    recommendations: [],
    // Pointer rows (DIRECTORY / PAST_AWARD_INTEL) held at REVIEW. Never direct
    // funding; carried separately so they stay visible for research.
    research_leads: [],
    search_provenance: [],
    search_provider_counts: {},
    search_cache_hits: 0,
    search_unknown_provenance_count: 0,
    search_degraded_queries: 0,
    search_unavailable_queries: 0,
    // ── REQUIREMENT E ledgers ──
    query_ledger: { planned: [], executed: [], skipped_budget: [], skipped_duplicate: [], plan_dropped: { by_cap: [], duplicates: [] } },
    stage_ledger: emptyStageLedger(),
    page_ledger: [],
    page_ledger_truncated: 0,
    seed_outcomes: [],
    provider_health: emptyProviderHealth(),
    extraction_available: null,
    primary_attribution: null,
    reason: null,
  };
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
  // RAISED 20 -> 28 (2026-09-08, "use the entire profile"). The bridge now
  // carries occupation, income band, geographic qualifiers, immigration status,
  // licensure and first-generation status through to the query builder, which
  // emits them as CORE queries. `.slice(0, max)` truncates from the END, so
  // leaving the cap at 20 would have paid for those new queries by silently
  // cutting eight that already ran — the same starvation this file's own
  // comment warns about. maxPages rises with it below.
  const maxQueries = Number.isFinite(opts.maxQueries) ? opts.maxQueries
    : envInt(process.env.WEB_LANE_MAX_QUERIES, 28);
  const resultsPerQuery = Number.isFinite(opts.resultsPerQuery) ? opts.resultsPerQuery
    : envInt(process.env.WEB_LANE_RESULTS_PER_QUERY, 8);
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages
    : envInt(process.env.WEB_LANE_MAX_PAGES, 44);
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
  // Page dedupe keys on the CANONICAL FETCH IDENTITY (discovery-attrib-4):
  // `targetDedupKey` = the shared canonicalizer (tracking params stripped) +
  // fragment dropped. Two SERPs returning `…/grant` and `…/grant?utm_source=x#top`
  // are ONE server fetch; keying on the raw string fetched + LLM-extracted the
  // alias twice and burned a maxPages slot on it. The raw URL is still what we
  // fetch; only the identity is canonical.
  const seen = new Set();
  const pages = [];
  const ledgerByPage = new Map();
  const pageKeyOf = (url) => targetDedupKey(url);
  const enqueuePage = (page) => {
    const key = pageKeyOf(page.url);
    if (seen.has(key)) { result.pages_deduped += 1; return false; }
    seen.add(key);
    pages.push(page);
    ledgerByPage.set(page, newPageLedgerEntry({ url: page.url, canonicalKey: key, query: page.query, seeded: page.seeded }));
    return true;
  };
  for (const s of Array.isArray(opts.seedPages) ? opts.seedPages : []) {
    const url = String(s?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    enqueuePage({ url, query: s.query ?? 'seed:web_parity_gap', title: s.title, snippet: s.snippet, seeded: true });
  }
  result.seeded = pages.length;
  result.results_per_query = resultsPerQuery;
  result.max_pages = maxPages;
  result.max_queries = maxQueries;

  // THE PLAN — every entry carries its tier/family/gap_class so the ledger can
  // say which KIND of query executed and which kind the page budget starved.
  const plan = buildWebQueryPlan(thesis, { max: maxQueries, seed });
  const builtQueries = plan.queries;
  const planEntryByKey = new Map();
  for (const e of Array.isArray(plan.entries) ? plan.entries : []) planEntryByKey.set(normalizeQueryKey(e.query), e);
  result.query_ledger.plan_dropped = {
    by_cap: (Array.isArray(plan.dropped_by_budget) ? plan.dropped_by_budget : []).map((d) => ({ query: d.query, tier: d.tier ?? null, family: d.family ?? null })),
    duplicates: (Array.isArray(plan.dropped_duplicates) ? plan.dropped_duplicates : []).map((d) => ({ query: d.query, duplicate_of: d.duplicate_of ?? null })),
  };
  // EXTRA QUERIES (opts.extraQueries): the applyable-floor archetype directive's
  // query patterns (initiative agent #3). They run ALONGSIDE the profile's own
  // web queries — additive and deduped ON THE NORMALIZED KEY (webq-7: an exact-
  // string Set let "HOUSING GRANTS …" and "housing grants …" both execute and
  // spend two of the ~6 executed slots). They lower no bar: every hit is
  // fetched, extracted, reality-gated and scored exactly like a built query's hit.
  const builtByKey = new Map();
  for (const q of builtQueries) builtByKey.set(normalizeQueryKey(q), q);
  const extra = [];
  const extraByKey = new Map();
  for (const raw of Array.isArray(opts.extraQueries) ? opts.extraQueries : []) {
    const q = String(raw || '').trim();
    if (!q) continue;
    const key = normalizeQueryKey(q);
    const dupOf = builtByKey.get(key) ?? extraByKey.get(key) ?? null;
    if (dupOf) {
      result.query_ledger.skipped_duplicate.push({ query: q, duplicate_of: dupOf, source: 'extra_query' });
      continue;
    }
    extraByKey.set(key, q);
    extra.push(q);
  }
  let queries = builtQueries;
  if (extra.length) {
    // The applyable-floor caller can supply six directive queries. Six full
    // eight-hit SERPs fill the 44-page queue before a learned rotating query
    // runs. On persistent shortfalls, keep the directive anchors first, then
    // schedule the builder's two anchors plus its first rotating slot before
    // resuming the directives. Query/page/provider budgets and every downstream
    // gate stay unchanged. Unlearned runs retain their prior exact ordering.
    const builtEarlyCount = PERSISTENT_QUERY_ANCHOR_COUNT + 1;
    queries = hasPersistentQueryShortfall(thesis)
      ? [
          ...extra.slice(0, PERSISTENT_QUERY_ANCHOR_COUNT),
          ...builtQueries.slice(0, builtEarlyCount),
          ...extra.slice(PERSISTENT_QUERY_ANCHOR_COUNT),
          ...builtQueries.slice(builtEarlyCount),
        ]
      : [...extra, ...builtQueries];
  }
  const tierOf = (q) => {
    const e = planEntryByKey.get(normalizeQueryKey(q));
    if (e) return { tier: e.tier ?? 'core', family: e.family ?? null, gap_class: e.gap_class ?? null };
    return { tier: 'directive', family: 'archetype_directive', gap_class: null };
  };
  result.queries_planned = queries;
  result.query_ledger.planned = queries.map((q) => ({ query: q, ...tierOf(q) }));
  result.stage_ledger.query_generated = queries.length;
  result.stage_ledger.query_skipped_duplicate =
    result.query_ledger.skipped_duplicate.length + result.query_ledger.plan_dropped.duplicates.length;

  let executedCount = 0;
  for (const [queryIndex, q] of queries.entries()) {
    if (pages.length - result.seeded >= maxPages) break;
    executedCount += 1;
    let hits = [];
    let threw = false;
    try { hits = await searchWeb(q, { count: resultsPerQuery }); }
    catch { threw = true; hits = []; }
    const provenance = searchProvenanceFor(hits, queryIndex, threw, q);
    result.search_provenance.push(provenance);
    result.search_provider_counts[provenance.provider] =
      (result.search_provider_counts[provenance.provider] || 0) + 1;
    if (provenance.provenance === 'cache' || provenance.provider === 'cache') result.search_cache_hits += 1;
    if (provenance.provenance === 'unknown' || provenance.provider === 'unknown') result.search_unknown_provenance_count += 1;
    const degraded = String(provenance.status).includes('degrad');
    const unavailable = ['error', 'unavailable', 'not_attempted'].includes(provenance.status);
    if (degraded) result.search_degraded_queries += 1;
    if (unavailable) result.search_unavailable_queries += 1;
    result.stage_ledger.provider_attempted += 1;
    if (degraded) result.stage_ledger.provider_degraded += 1;
    if (unavailable) result.stage_ledger.provider_unavailable += 1;
    let newPages = 0;
    for (const h of Array.isArray(hits) ? hits : []) {
      const url = String(h?.url || '').trim();
      if (!url) continue;
      if (enqueuePage({ url, query: q, title: h.title, snippet: h.snippet })) newPages += 1;
      if (pages.length - result.seeded >= maxPages) break;
    }
    result.queries.push(q);
    result.query_ledger.executed.push({
      query: q,
      ...tierOf(q),
      provider: provenance.provider,
      status: provenance.status,
      result_count: provenance.result_count,
      new_pages: newPages,
    });
  }
  result.queries_executed = executedCount;
  for (const q of queries.slice(executedCount)) {
    result.query_ledger.skipped_budget.push({ query: q, ...tierOf(q) });
  }
  result.stage_ledger.query_skipped_budget = result.query_ledger.skipped_budget.length;
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
  // Pages the extractor answered HEALTHILY on (ok or an honest empty) vs pages
  // whose extraction failed with an LLM-class reason — the provider_health.llm
  // verdict is derived from these, never from `extracted === 0` alone.
  const llmStats = { ok_pages: 0, llm_failed_pages: 0 };
  const primaryProfileId = thesis.profile_id ?? matchProfiles[0]?.profile_id ?? null;
  for (const page of pages) {
    const entry = ledgerByPage.get(page);
    let resp;
    try { resp = await fetcher.fetch(page.url, { method: 'GET' }); }
    catch (err) { resp = { ok: false, error: String(err?.message ?? err) }; }
    if (entry) entry.fetch_status = resp?.status ?? (resp?.ok ? 200 : (resp?.error ? `error:${String(resp.error).slice(0, 80)}` : 'failed'));
    if (!resp?.ok || resp.body == null) continue;
    result.fetched += 1;
    result.stage_ledger.response_received += 1;
    if (entry) { entry.fetched = true; entry.final_url = resp.finalUrl ?? null; }

    const evidence = { url: resp.finalUrl ?? page.url, content_hash: resp.contentHash ?? null, fetched_at: resp.fetchedAt ?? null };
    // Remember this source page's own URL so target verification never re-fetches
    // it (both the requested and any redirect-final URL are ours already), keyed
    // the SAME normalized way targets are so an alias/fragment variant still hits.
    if (fetchedSourceKeys) { fetchedSourceKeys.add(targetDedupKey(page.url)); fetchedSourceKeys.add(targetDedupKey(evidence.url)); }

    // EXTRACTION — a failure is CLASSIFIED, never swallowed into []. The
    // extractor tags its array with a non-enumerable `extraction_failure`
    // (services/webGrantExtractor.js); a throw is classified here.
    let extracted = [];
    let failureClass = null;
    try {
      extracted = await extractOpportunities({ pageUrl: evidence.url, html: resp.body });
      failureClass = extractionFailureClassOf(extracted);
    } catch (err) {
      extracted = [];
      failureClass = classifyThrownExtractionError(err);
    }
    if (failureClass) {
      result.stage_ledger.extraction_failed += 1;
      result.stage_ledger.extraction_failed_by_class[failureClass] =
        (result.stage_ledger.extraction_failed_by_class[failureClass] || 0) + 1;
      if (LLM_FAILURE_CLASSES.has(failureClass)) llmStats.llm_failed_pages += 1;
      if (entry) entry.extraction_failure = failureClass;
    } else {
      llmStats.ok_pages += 1;
    }

    // Count the current (profile-conditioned) path's candidates for THIS page so
    // the blind shadow can report a per-page delta. Shadow-only bookkeeping: it is
    // touched ONLY when the shadow is active, so a flag-off run does no extra work.
    let pageCurrentCandidates = 0;
    for (const ex of Array.isArray(extracted) ? extracted : []) {
      const cand = toCandidate(ex, evidence, thesis, page);
      if (!cand) continue;
      result.extracted += 1;
      result.stage_ledger.candidates_extracted += 1;
      if (entry) entry.extracted += 1;
      if (shadow) pageCurrentCandidates += 1;

      const verdict = enforceReality(cand, { thesis, source: WEB_SOURCE, evidence });
      if (!verdict.ok) {
        result.rejected += 1;
        result.stage_ledger.reality_rejected += 1;
        if (entry) { entry.reality_rejected += 1; if (!entry.reality_reason) entry.reality_reason = verdict.reason ?? null; }
        if (runId) recordRejection(store, runId, { source_id: WEB_SOURCE.source_id, reason: verdict.reason, detail: verdict.verdict_reasons?.join('; '), title: cand.title, url: cand.apply_url ?? cand.info_url });
        continue;
      }

      const opp = normalize(cand, verdict, { source: WEB_SOURCE, evidence });
      const key = canonicalOpportunityKey(opp);
      if (storedKeys.has(key)) {
        result.deduped += 1;
        result.stage_ledger.canonical_duplicates += 1;
        if (entry) entry.canonical_duplicate += 1;
        continue;
      }

      const res = upsertOpportunity(store, opp);
      const canonicalId = res.canonical_id ?? opp.id;
      if (!res.stored && !res.deduped) {
        result.rejected += 1;
        result.stage_ledger.catalog_refused += 1;
        if (entry) entry.catalog_refused += 1;
        continue;
      }
      if (res.deduped) {
        result.deduped += 1;
        // A durable dedupe (the row already exists in the run store from another
        // source/page) is a canonical duplicate too; the candidate still gets
        // matched below so the primary verdict is counted once.
        result.stage_ledger.canonical_duplicates += 1;
        if (entry) { entry.canonical_duplicate += 1; entry.deduped += 1; }
      } else {
        result.stored += 1;
        if (entry) entry.stored += 1;
      }
      storedKeys.add(key);
      // `deduped` counts as adopted: the source IS in the catalog and reachable
      // for this profile, which is what the rule promises. Re-offering it next
      // run would just re-dedupe it forever.
      if (page.seeded) seededAdopted.add(page.url);

      // Per-profile matching — decision comes ONLY from the canonical engine.
      const matchOpp = canonicalId !== opp.id ? { ...opp, id: canonicalId } : opp;
      let primaryCounted = false;
      for (const mp of matchProfiles) {
        // Full profile context when the thesis carries it (primary profile) —
        // see pipeline.js: context-less cross-match stubs fall under the
        // engine's MIN_CALIBRATED_INVENTORY topical cap.
        const decision = computeMatchDecision(matchOpp, mp, {
          floor: opts.floor,
          profileRow: mp._profileContext?.profile ?? null,
          profileSections: mp._profileContext?.sections ?? null,
          signals: mp._profileContext?.signals ?? null,
          // A safe URL or score is not enough. The open-web lane must enforce
          // the same four positive truths as the registry-adapter pipeline.
          realityPassed: Boolean(
            matchOpp.evidence?.url &&
            matchOpp.evidence?.content_hash &&
            matchOpp.evidence?.fetched_at
          ),
          enforceFourTruths: true,
        });
        // Provenance for the crawler doctor: the exact query that surfaced the
        // page this opportunity was extracted from.
        upsertMatch(store, { ...decision, source_query: page.query, discovered_via: 'web_search' });
        // Stage attribution for the PRIMARY (discovering) profile only — one
        // bucket per candidate, read straight off the engine's recorded verdict.
        // A durable-deduped row is already counted under canonical_duplicates,
        // so its verdict is not double-booked into an admission/rejection bucket.
        if (!primaryCounted && !res.deduped && (primaryProfileId === null || mp.profile_id === primaryProfileId)) {
          primaryCounted = true;
          const bucket = classifyPrimaryVerdict(decision, matchOpp);
          result.stage_ledger[bucket] = (result.stage_ledger[bucket] || 0) + 1;
          if (entry) {
            if (bucket === 'qualified_admitted') entry.admitted += 1;
            else if (bucket === 'eligibility_rejected') entry.gate_rejected.eligibility += 1;
            else if (bucket === 'need_match_rejected') entry.gate_rejected.need += 1;
            else if (bucket === 'apply_target_rejected') entry.gate_rejected.apply_target += 1;
            else entry.review_held += 1;
          }
        }
        const truthProof = decision.match_explain?.four_truth_proof ?? null;
        if (isVerifiedDirectFundingRecommendation(matchOpp, decision) &&
            mp.profile_id === thesis.profile_id) {
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
            four_truth_proof: truthProof,
            source: 'web_search',
            topical_evidence: decision.match_explain?.score_breakdown?.topical_evidence ?? null,
          });
        }
        // Same research-lead surface as the registry pipeline (pipeline.js):
        // a web-found locator is a place to search, never an award.
        if (isResearchLead(matchOpp, decision.decision) && mp.profile_id === thesis.profile_id) {
          result.research_leads.push({
            opportunity_id: matchOpp.id,
            title: matchOpp.title,
            description: matchOpp.description ?? null,
            sponsor: matchOpp.sponsor,
            kind: matchOpp.kind ?? null,
            info_url: matchOpp.info_url ?? matchOpp.apply_url ?? null,
            match_score: decision.match_score,
            decision: decision.decision,
            classification: 'research_lead_not_direct_funding',
            source: 'web_search',
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
  result.research_leads.sort((a, b) => b.match_score - a.match_score);

  // ── Ledgers (REQUIREMENT E) ──────────────────────────────────────────────
  // Page ledger: one bounded row per queued page (seeds first). Bounded to
  // maxPages entries; the overflow (seeds are exempt from maxPages) is counted.
  const allEntries = pages.map((p) => ledgerByPage.get(p)).filter(Boolean);
  result.page_ledger = allEntries.slice(0, maxPages);
  result.page_ledger_truncated = Math.max(0, allEntries.length - result.page_ledger.length);
  // Per-seed outcome ledger: the GATES' verdict on each seeded URL, in the
  // vocabulary webParityBenchmark.markGapCandidateOutcomes reads (adopted /
  // <gate>_rejected / fetch_failed / extraction_failed / no_candidates). A seed
  // that was fetched but produced nothing is NEVER a gate verdict.
  result.seed_outcomes = allEntries.filter((e) => e.seeded).map((e) => {
    let outcome = 'no_candidates';
    let gate = null;
    let reason = null;
    if (!e.fetched) { outcome = 'fetch_failed'; reason = e.fetch_status != null ? String(e.fetch_status) : null; }
    else if (seededAdopted.has(e.url)) { outcome = 'adopted'; }
    else if (e.extraction_failure) { outcome = 'extraction_failed'; reason = e.extraction_failure; }
    else if (e.extracted === 0) { outcome = 'no_candidates'; }
    else {
      const gates = [
        ['reality', e.reality_rejected], ['eligibility', e.gate_rejected.eligibility],
        ['need', e.gate_rejected.need], ['apply_target', e.gate_rejected.apply_target],
      ].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
      if (gates.length) {
        gate = gates[0][0];
        outcome = `${gate}_rejected`;
        reason = gate === 'reality' ? (e.reality_reason ?? null) : null;
      } else if (e.canonical_duplicate > 0) { outcome = 'deduped'; }
      else if (e.catalog_refused > 0) { outcome = 'catalog_refused'; }
      else { outcome = 'review_held'; }
    }
    return { url: e.url, outcome, gate, reason, fetched: e.fetched, extracted: e.extracted, stored: e.stored, deduped: e.deduped };
  });
  // Provider health + the honest reason line. `ok` stays "the lane ran to
  // completion"; a dead extraction layer is named in provider_health, reason
  // and (at the choke point) primary_attribution — never hidden behind ok:true.
  result.provider_health = summarizeProviderHealth(result, llmStats);
  result.extraction_available = result.provider_health.llm === 'unavailable' ? false
    : (result.provider_health.llm === 'healthy' ? true : null);
  if (result.provider_health.llm === 'unavailable') {
    result.reason = `extraction_failed:${dominantFailureClass(result.stage_ledger.extraction_failed_by_class) || 'unknown'}`;
  } else if (result.provider_health.search === 'unavailable') {
    result.reason = 'search_unavailable';
  }

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
