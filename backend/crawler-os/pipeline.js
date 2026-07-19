// crawler-os/pipeline.js
//
// THE discovery spine. One function, runDiscovery, walks the canonical flow:
//
//   thesis -> planner.plan -> [per source] adapter.buildRequests
//          -> fetcher.fetch (SSRF-safe, evidence) -> parsers.parse
//          -> adapter.mapCandidate -> realityGate.enforceReality
//          -> normalizer.normalize -> storage.upsertOpportunity (GLOBAL catalog)
//          -> matchEngine.computeMatchDecision -> storage.upsertMatch (per profile)
//
// Honesty is structural: a source with no adapter or missing env is recorded as
// SKIPPED (never faked); every rejected candidate is recorded with its reason;
// and when nothing is stored, a zero-result ladder explains exactly why and what
// to do next. All telemetry is persisted via the storage services.
//
// Network and clock are injected, so the whole spine runs deterministically
// offline in tests and is driven by the host's real `fetch` in production.

import { buildThesis } from './profileIntelligence.js';
import { plan } from './planner.js';
import { getSource } from './sourceRegistry.js';
import { getAdapter } from './adapters/index.js';
import { parse } from './parsers.js';
import { enforceReality } from './realityGate.js';
import { normalize } from './normalizer.js';
import { computeMatchDecision, isRecommendable } from './matchEngine.js';
import { buildEvolutionSignals } from './profileEvolution.js';
import { CRAWLER_OUTCOME, MATCH_DECISION, OPPORTUNITY_KIND, REASON, canonicalOpportunityKey } from './contract.js';
import {
  upsertSource, upsertOpportunity, upsertMatch,
  recordRun, recordSourceRun, recordRejection, recordFetch,
} from './storage.js';

/**
 * runDiscovery — execute one discovery run for a profile thesis, matching every
 * stored opportunity against one or more profile theses.
 *
 * @param {{ store:object, fetcher:{fetch:Function}, env?:object, clock?:Function }} deps
 * @param {{ profile?:object, thesis?:object, matchProfiles?:object[], runId?:string, floor?:number }} [opts]
 * @returns {Promise<object>} run summary incl. recommendations + zero_result ladder
 */
export async function runDiscovery(deps, opts = {}) {
  const store = deps.store;
  const fetcher = deps.fetcher;
  if (!store) throw new Error('runDiscovery: deps.store required');
  if (!fetcher?.fetch) throw new Error('runDiscovery: deps.fetcher required');
  const env = deps.env ?? {};
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();

  const thesis = opts.thesis ?? buildThesis(opts.profile ?? {});
  const matchProfiles = (opts.matchProfiles && opts.matchProfiles.length)
    ? opts.matchProfiles
    : (thesis.profile_id ? [thesis] : []); // no profile -> store globally, match later
  const runId = opts.runId ?? `run_${clock()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date(clock()).toISOString();

  const thePlan = plan(thesis);
  recordRun(store, { run_id: runId, profile_id: thesis.profile_id ?? null, started_at: startedAt, planned: thePlan.selected_source_ids.length });

  const sourceSummaries = [];
  const storedOppIds = new Set();
  const recommendations = [];
  const recommendationKeys = new Set();
  const storedRealKeys = new Map(); // real-world opportunity identity -> canonical stored id (cross-source dedup)
  let totalRejected = 0;

  function matchCanonicalOpportunity(opp, canonicalId) {
    const canonicalOpp = canonicalId && canonicalId !== opp.id ? { ...opp, id: canonicalId } : opp;
    storedOppIds.add(canonicalOpp.id);
    for (const mp of matchProfiles) {
      const decision = computeMatchDecision(canonicalOpp, mp, { floor: opts.floor });
      // Crawler-doctor provenance: registry adapters have no query string, but
      // the SOURCE that produced the match is knowable (web lane sets both
      // source_query and discovered_via; here only the source id applies).
      upsertMatch(store, { ...decision, discovered_via: canonicalOpp.source_id ?? null });
      const recommendationKey = `${mp.profile_id}:${canonicalOpp.id}`;
      if (isRecommendable(canonicalOpp, decision.decision) && mp.profile_id === thesis.profile_id && !recommendationKeys.has(recommendationKey)) {
        recommendationKeys.add(recommendationKey);
        // topical_evidence: legacy weighted-evidence subscale, retained so Amy's
        // weight-tuning validation can measure where the W_* weights still act
        // (the need-anchored final score does not move with weight changes).
        // kind travels with the recommendation so downstream honesty checks
        // (Amy's amount-recall evaluator) can tell a DIRECTORY locator — which
        // never carries a per-award dollar amount by design — from a grant row.
        recommendations.push({ opportunity_id: canonicalOpp.id, title: canonicalOpp.title, sponsor: canonicalOpp.sponsor, kind: canonicalOpp.kind ?? null, amount_min: canonicalOpp.funding?.amount_min ?? null, amount_max: canonicalOpp.funding?.amount_max ?? null, amount_status: canonicalOpp.funding?.amount_status ?? null, match_score: decision.match_score, decision: decision.decision, topical_evidence: decision.match_explain?.score_breakdown?.topical_evidence ?? null });
      }
    }
  }

  if (thePlan.selected_source_ids.length === 0) {
    return finalize({
      store, runId, thesis, thePlan, startedAt, clock,
      sourceSummaries, storedOppIds, recommendations, totalRejected,
      zeroReason: REASON.NO_SOURCES_SELECTED,
    });
  }

  for (const sourceId of thePlan.selected_source_ids) {
    const source = getSource(sourceId);
    if (!source) continue;
    upsertSource(store, source); // keep the funding_sources catalog current

    const srStartedAt = new Date(clock()).toISOString();
    const sr = { source_id: sourceId, fetched: 0, parsed_candidates: 0, rejected: 0, stored: 0, existing: 0, deduped: 0, queries: [], started_at: srStartedAt };

    const adapter = getAdapter(sourceId);
    if (!adapter) {
      finishSource(store, runId, sr, CRAWLER_OUTCOME.SKIPPED, 'no_adapter', clock, sourceSummaries);
      continue;
    }
    const missing = adapter.missingEnv(env);
    if (missing.length) {
      finishSource(store, runId, sr, CRAWLER_OUTCOME.SKIPPED, `missing_env:${missing.join(',')}`, clock, sourceSummaries);
      continue;
    }

    let requests = [];
    try { requests = adapter.buildRequests(thesis, source, env); }
    catch (e) { finishSource(store, runId, sr, CRAWLER_OUTCOME.ERROR, `build_requests_error:${e?.message ?? e}`, clock, sourceSummaries); continue; }

    let sawFetchError = false;
    let sawParseError = false;
    for (const req of requests) {
      if (req.query) sr.queries.push(req.query);
      let resp;
      try { resp = await fetcher.fetch(req.url, req.init); }
      catch (e) { resp = { ok: false, status: null, error: String(e?.message ?? e), reason: 'fetch_threw' }; }
      sr.fetched += 1;
      recordFetch(store, runId, { source_id: sourceId, url: req.url, status: resp.status, ok: resp.ok, content_hash: resp.contentHash, error: resp.error });

      if (!resp.ok || resp.body == null) {
        // Adapter-declared benign failure: some APIs signal END OF DATA with a
        // non-ok status (ProPublica's search 404s on page overrun). The adapter
        // can declare that specific shape honest — a clean empty page, not a
        // FETCH_ERROR and not a rejection. Everything else stays a real failure.
        if (typeof adapter.benignFetchFailure === 'function' && adapter.benignFetchFailure(resp, req)) {
          continue;
        }
        sawFetchError = true;
        recordRejection(store, runId, { source_id: sourceId, reason: 'fetch_failed', detail: resp.reason ?? resp.error ?? `status:${resp.status}`, url: req.url });
        // A registry-declared candidate (parseCfg.directoryCandidate) is
        // constructed ENTIRELY from curated registry config — parseDirectory
        // never reads the body; the fetch only captures evidence. A transient
        // fetch failure (site hiccup, WAF 403 on automated clients, CI-runner
        // egress blocked) must not erase the honest row a sparse profile
        // depends on — and that holds for its HONEST kind, not only DIRECTORY.
        // Coupling survival to the DIRECTORY kind forced real programs (SSDI,
        // Black Lung, MyCAA) to be registered as fake "directories" just to
        // stay resilient. Emit the candidate anyway with fetch-less evidence
        // (content_hash stays null → the reality gate marks a non-directory
        // kind LINK_UNVERIFIED; link_unverified ≠ dead, and it can never claim
        // VERIFIED without a captured page). API/list candidates still skip:
        // they come from the body.
        if (!req.parseCfg?.directoryCandidate) continue;
      }

      const parsed = parse(req.family, resp.ok ? resp.body : '', req.parseCfg ?? {});
      const candidates = parsed.candidates ?? [];
      if (parsed.error) {
        sawParseError = true;
        recordRejection(store, runId, { source_id: sourceId, reason: 'parse_error', detail: parsed.note ?? parsed.error, url: req.url });
      } else if (parsed.note) {
        recordRejection(store, runId, { source_id: sourceId, reason: 'parser_note', detail: parsed.note, url: req.url });
      }

      // A failed response's body (an error page, a WAF block) is NOT evidence
      // of the opportunity — without an ok fetch the evidence hash stays null
      // so the reality gate can never stamp the row VERIFIED off a 500 body.
      const evidence = {
        url: resp.finalUrl ?? req.url,
        content_hash: resp.ok ? (resp.contentHash ?? null) : null,
        fetched_at: resp.fetchedAt ?? null,
      };

      for (const raw of candidates) {
        const cand = adapter.mapCandidate(raw, { thesis, source });
        if (!cand) continue;
        sr.parsed_candidates += 1;

        const verdict = enforceReality(cand, { thesis, source, evidence });
        if (!verdict.ok) {
          sr.rejected += 1; totalRejected += 1;
          recordRejection(store, runId, { source_id: sourceId, reason: verdict.reason, detail: verdict.verdict_reasons?.join('; '), title: cand.title, url: cand.apply_url ?? cand.info_url });
          continue;
        }

        const opp = normalize(cand, verdict, { source, evidence });

        // Cross-source dedup: the same real-world opportunity (e.g. a USDA grant)
        // can be surfaced by both the grants_gov catch-all and a specialized
        // agency crawler. Collapse it to ONE catalog row so the catalog and the
        // recommendation list are not inflated. Recall is unaffected: nothing is
        // dropped, the first crawler to store it owns the canonical row.
        const realKey = canonicalOpportunityKey(opp);
        const canonicalId = storedRealKeys.get(realKey);
        if (canonicalId && canonicalId !== opp.id) {
          sr.deduped += 1;
          continue; // already stored + matched under canonicalId (run-local fast path)
        }

        const res = upsertOpportunity(store, opp);
        if (res.deduped) {
          // Durable cross-run dedup: the store already holds this real-world
          // opportunity under a different source-folded id. Provenance recorded;
          // match the existing canonical row for this profile, but do not
          // inflate the catalog or recommendation list.
          storedRealKeys.set(realKey, res.canonical_id);
          if (res.canonical_id) {
            sr.existing += 1;
            matchCanonicalOpportunity(opp, res.canonical_id);
          }
          sr.deduped += 1;
          continue;
        }
        if (!res.stored) {
          sr.rejected += 1; totalRejected += 1;
          recordRejection(store, runId, { source_id: sourceId, reason: 'not_catalog_acceptable', detail: res.reason, title: opp.title, url: opp.apply_url });
          continue;
        }
        const firstStoredInThisRun = !storedOppIds.has(opp.id);
        if (firstStoredInThisRun) sr.stored += 1;
        storedOppIds.add(opp.id);
        storedRealKeys.set(realKey, opp.id);

        // Per-profile matching. The decision comes ONLY from the canonical engine.
        matchCanonicalOpportunity(opp, opp.id);
      }
    }

    const foundForProfile = sr.stored + sr.existing;
    const outcome = foundForProfile > 0 ? CRAWLER_OUTCOME.OK
      : (sawParseError ? CRAWLER_OUTCOME.PARSE_ERROR : sawFetchError ? CRAWLER_OUTCOME.FETCH_ERROR : CRAWLER_OUTCOME.EMPTY);
    const reason = foundForProfile > 0 ? null
      : (sawParseError ? 'parse_error'
        : (sr.deduped > 0 ? 'all_candidates_deduped' : 'no_candidates_stored'));
    finishSource(store, runId, sr, outcome, reason, clock, sourceSummaries);
  }

  const zeroReason = storedOppIds.size > 0 ? null : diagnoseZeroResult(sourceSummaries, totalRejected);
  return finalize({ store, runId, thesis, thePlan, startedAt, clock, sourceSummaries, storedOppIds, recommendations, totalRejected, zeroReason });
}

// ---- helpers --------------------------------------------------------------

// Cross-source identity now lives in contract.canonicalOpportunityKey — the
// single authority shared by the run-local fast path here and the durable
// store-level dedup in storage.upsertOpportunity. Two crawlers that surface the
// same grant (same apply/info URL + external id) share that key, so the catalog
// stores it once regardless of which source or run found it. Directory/intel
// rows with no URL or external id fall back to their own id (never merged).

function finishSource(store, runId, sr, outcome, reason, clock, summaries) {
  sr.outcome = outcome; sr.reason = reason; sr.finished_at = new Date(clock()).toISOString();
  recordSourceRun(store, runId, sr);
  summaries.push({ source_id: sr.source_id, outcome, reason, fetched: sr.fetched, parsed: sr.parsed_candidates, rejected: sr.rejected, stored: sr.stored, existing: sr.existing ?? 0, deduped: sr.deduped ?? 0, queries: sr.queries ?? [] });
}

function diagnoseZeroResult(summaries, totalRejected) {
  if (summaries.length === 0) return REASON.NO_SOURCES_SELECTED;
  const allSkipped = summaries.every((s) => s.outcome === CRAWLER_OUTCOME.SKIPPED);
  if (allSkipped) return REASON.ALL_SOURCES_SKIPPED;
  const anyFetched = summaries.some((s) => s.fetched > 0);
  if (!anyFetched) return REASON.ALL_FETCHES_FAILED;
  const allFetchFailed = summaries.filter((s) => s.fetched > 0).every((s) => s.outcome === CRAWLER_OUTCOME.FETCH_ERROR);
  if (allFetchFailed) return REASON.ALL_FETCHES_FAILED;
  const anyParsed = summaries.some((s) => s.parsed > 0);
  if (!anyParsed) return REASON.NO_CANDIDATES_PARSED;
  if (totalRejected > 0) return REASON.ALL_REJECTED_BY_REALITY;
  return REASON.NO_CANDIDATES_PARSED;
}

/**
 * Build the zero-result ladder: a plain, explainable account of what was
 * searched, what was expanded, why results are limited, which profile fields are
 * missing, and what deeper search should happen next.
 */
function buildLadder(thesis, thePlan, summaries, zeroReason) {
  const searched = summaries.filter((s) => s.outcome !== CRAWLER_OUTCOME.SKIPPED).map((s) => s.source_id);
  const skipped = summaries.filter((s) => s.outcome === CRAWLER_OUTCOME.SKIPPED).map((s) => ({ source_id: s.source_id, reason: s.reason }));
  const excluded = thePlan.source_decisions.filter((d) => !d.selected).map((d) => ({ source_id: d.source_id, reasons: d.reasons }));

  const missingFields = [];
  if (!thesis.location?.state) missingFields.push('location.state (adding a state unlocks state/local sources and improves geo scoring)');
  if (!thesis.needs?.length) missingFields.push('need_categories (adding needs sharpens matching and source selection)');
  if (thesis.applicant_types?.length === 1 && thesis.applicant_types[0] === 'individual' && !thesis.raw_profile_present) {
    missingFields.push('applicant_type (profile defaulted to "individual"; specifying the real type changes which sources run)');
  }

  const queryExpansion = summaries.flatMap((s) => (s.queries ?? []).map((q) => `${s.source_id}: ${q}`));

  const nextSteps = [];
  if (zeroReason === REASON.ALL_SOURCES_SKIPPED) nextSteps.push('Provide the missing API keys/env so skipped sources can run, or implement adapters for registry rows that lack one.');
  if (zeroReason === REASON.ALL_FETCHES_FAILED) nextSteps.push('Check network egress/allowlist; retry — every fetch in this run failed before producing a body.');
  if (zeroReason === REASON.NO_CANDIDATES_PARSED) nextSteps.push('Broaden keywords or relax the query; sources responded but returned no rows for these terms.');
  if (zeroReason === REASON.ALL_REJECTED_BY_REALITY) nextSteps.push('Candidates were found but failed the reality gate (placeholder/loan/expired/bad-URL). Loosen profile gating only if appropriate (e.g. allow loans), or widen sources.');
  if (missingFields.length) nextSteps.push('Complete the profile fields listed under missing_profile_fields, then re-run.');
  nextSteps.push('Expand to additional sources/states, or schedule a continuous background run (Robert) so the catalog grows over time.');

  return {
    zero_result_reason: zeroReason,
    searched_sources: searched,
    skipped_sources: skipped,
    excluded_sources: excluded,
    expansions_tried: [
      'planner selected all in-scope registry sources',
      'source adapters expanded the profile thesis into multiple focused queries',
      ...queryExpansion.slice(0, 12),
    ],
    missing_profile_fields: missingFields,
    next_steps: nextSteps,
  };
}

function finalize({ store, runId, thesis, thePlan, startedAt, clock, sourceSummaries, storedOppIds, recommendations, totalRejected, zeroReason }) {
  const finishedAt = new Date(clock()).toISOString();
  const ladder = zeroReason ? buildLadder(thesis, thePlan, sourceSummaries, zeroReason) : null;
  const profileEvolution = buildEvolutionSignals({ thesis, plan: thePlan, summaries: sourceSummaries, zeroReason });
  recordRun(store, {
    run_id: runId, profile_id: thesis.profile_id ?? null, started_at: startedAt, finished_at: finishedAt,
    planned: thePlan.selected_source_ids.length, found: storedOppIds.size, stored: storedOppIds.size, rejected: totalRejected,
    zero_result_reason: zeroReason,
    telemetry: { source_decisions: thePlan.source_decisions, sources: sourceSummaries, zero_result: ladder, profile_evolution: profileEvolution },
  });
  return {
    run_id: runId,
    profile_id: thesis.profile_id ?? null,
    planned: thePlan.selected_source_ids.length,
    stored: storedOppIds.size,
    rejected: totalRejected,
    sources: sourceSummaries,
    recommendations: recommendations.sort((a, b) => b.match_score - a.match_score),
    zero_result: ladder,
    profile_evolution: profileEvolution,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

// Test-only: the ladder builder is unit-tested directly because honest
// DIRECTORY locators now survive fetch failures, making an organic all-sources
// zero unreachable for any thesis whose plan includes a directory source.
export const _internal = { buildLadder };

export default { runDiscovery };
