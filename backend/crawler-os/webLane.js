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
// Every guardrail the adapter pipeline uses applies here unchanged: the reality
// gate rejects stubs/placeholders/expired/loan-disallowed/unsafe-URL, the catalog
// dedup collapses repeats, and the canonical match engine (not this lane) decides
// ACCEPT/REVIEW/REJECT. Network + search + LLM are INJECTED so the lane is pure
// and fully testable offline.

import { enforceReality } from './realityGate.js';
import { normalize } from './normalizer.js';
import { computeMatchDecision } from './matchEngine.js';
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
 * @param {{ store, fetcher:{fetch:Function}, searchWeb:Function, extractOpportunities:Function }} deps
 * @param {{ thesis, matchProfiles?, floor?, runId?, maxQueries?, resultsPerQuery?, maxPages? }} opts
 * @returns {Promise<object>} lane telemetry
 */
export async function runWebDiscoveryLane(deps, opts = {}) {
  const { store, fetcher, searchWeb, extractOpportunities } = deps;
  const result = { ok: false, queries: [], pages: 0, fetched: 0, extracted: 0, stored: 0, deduped: 0, rejected: 0, recommendations: [] };
  if (!store || !fetcher?.fetch || typeof searchWeb !== 'function' || typeof extractOpportunities !== 'function') {
    result.reason = 'web_lane_deps_missing';
    return result;
  }
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
  const queries = buildWebQueries(thesis, { max: maxQueries, seed });
  result.queries = queries;
  const seen = new Set();
  const pages = [];
  for (const q of queries) {
    if (pages.length >= maxPages) break;
    let hits = [];
    try { hits = await searchWeb(q, { count: resultsPerQuery }); } catch { hits = []; }
    for (const h of Array.isArray(hits) ? hits : []) {
      const url = String(h?.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      pages.push({ url, query: q, title: h.title, snippet: h.snippet });
      if (pages.length >= maxPages) break;
    }
  }
  result.pages = pages.length;

  // 2) Fetch each page → LLM-extract → gate → normalize → store → match.
  const storedKeys = new Set();
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

    for (const ex of Array.isArray(extracted) ? extracted : []) {
      const cand = toCandidate(ex, evidence, thesis, page);
      if (!cand) continue;
      result.extracted += 1;

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

      // Per-profile matching — decision comes ONLY from the canonical engine.
      const matchOpp = canonicalId !== opp.id ? { ...opp, id: canonicalId } : opp;
      for (const mp of matchProfiles) {
        const decision = computeMatchDecision(matchOpp, mp, { floor: opts.floor });
        // Provenance for the crawler doctor: the exact query that surfaced the
        // page this opportunity was extracted from.
        upsertMatch(store, { ...decision, source_query: page.query, discovered_via: 'web_search' });
        if (decision.decision === MATCH_DECISION.ACCEPT && mp.profile_id === thesis.profile_id) {
          // topical_evidence: legacy weighted-evidence subscale for Amy's
          // weight-tuning validation (weights no longer move the final score).
          result.recommendations.push({ opportunity_id: matchOpp.id, title: matchOpp.title, sponsor: matchOpp.sponsor, match_score: decision.match_score, source: 'web_search', topical_evidence: decision.match_explain?.score_breakdown?.topical_evidence ?? null });
        }
      }
    }
  }

  result.ok = true;
  result.recommendations.sort((a, b) => b.match_score - a.match_score);
  return result;
}

export default { runWebDiscoveryLane, WEB_SOURCE };
