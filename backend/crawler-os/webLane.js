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
 * runWebDiscoveryLane — execute the open-web lane for one thesis, writing finds
 * into `store` (so the caller's persistRun flushes them).
 *
 * @param {{ store, fetcher:{fetch:Function}, searchWeb:Function, extractOpportunities:Function, blindShadow? }} deps
 * @param {{ extractPage:Function, maxPages?:number, totalBudgetMs?:number, perPageTimeoutMs?:number }} [deps.blindShadow]
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
      }
    : null;
  // The smallest slice worth attempting: below this the LLM cannot plausibly
  // answer, so we stop rather than spend the tail of the budget on sure timeouts.
  const SHADOW_MIN_SLICE_MS = 250;
  const thesis = opts.thesis ?? {};
  const matchProfiles = (opts.matchProfiles && opts.matchProfiles.length) ? opts.matchProfiles : [thesis];
  const runId = opts.runId ?? null;
  // Breadth caps (bounded to respect search rate limits / the Brave breaker,
  // which makes searchWeb return [] when paused). Raised from 5/6/14 to widen the
  // candidate pool per run without hammering the provider.
  // Breadth raised 8/8/20 -> 14/8/26 so the new institution- / employer- /
  // county-specific CORE queries (buildWebQueries) run ALONGSIDE the need /
  // interest / field-of-study queries in one pass, instead of crowding them out.
  const maxQueries = Number.isFinite(opts.maxQueries) ? opts.maxQueries : 14;
  const resultsPerQuery = Number.isFinite(opts.resultsPerQuery) ? opts.resultsPerQuery : 8;
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : 26;
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
        const decision = computeMatchDecision(matchOpp, mp, { floor: opts.floor });
        // Provenance for the crawler doctor: the exact query that surfaced the
        // page this opportunity was extracted from.
        upsertMatch(store, { ...decision, source_query: page.query, discovered_via: 'web_search' });
        if (isRecommendable(matchOpp, decision.decision) && mp.profile_id === thesis.profile_id) {
          // topical_evidence: legacy weighted-evidence subscale for Amy's
          // weight-tuning validation (weights no longer move the final score).
          // kind + amounts travel with the recommendation so Amy's evaluator
          // measures award-amount recall against what the run actually found
          // (a DIRECTORY locator never carries a per-award amount by design).
          result.recommendations.push({ opportunity_id: matchOpp.id, title: matchOpp.title, sponsor: matchOpp.sponsor, kind: matchOpp.kind ?? null, amount_min: matchOpp.funding?.amount_min ?? null, amount_max: matchOpp.funding?.amount_max ?? null, amount_status: matchOpp.funding?.amount_status ?? null, match_score: decision.match_score, source: 'web_search', topical_evidence: decision.match_explain?.score_breakdown?.topical_evidence ?? null });
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
    };
  }
  result.seeded_adopted_urls = [...seededAdopted];
  result.seeded_adopted = seededAdopted.size;
  result.recommendations.sort((a, b) => b.match_score - a.match_score);
  return result;
}

export default { runWebDiscoveryLane, WEB_SOURCE };
