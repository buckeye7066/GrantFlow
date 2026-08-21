/**
 * robertAgent.js
 *
 * Evolved mission (2026-07): Robert grows pillar 2 of the product thesis —
 * the official-lane surface ("80+ lanes, simultaneously, continuously").
 * A lane the registry lacks is a structural gap on the adapter wishlist,
 * never a silent miss; Robert's source discovery is how those gaps get
 * retired. See docs/AGENTS.md + canonical_rules.md "The product thesis".
 *
 * The orchestrator. Coordinates Robert's modes:
 *   observe                — coverage analysis only (no network)
 *   discover-sources       — search for new sources (gated by config)
 *   discover-opportunities — fetch and extract opportunity candidates
 *   verify                 — run candidates through canonical gates
 *   ingest                 — push verified opps into the canonical pool
 *   match                  — score + create per-profile recommendations
 *   recommend              — same as match but only creates recs, no scoring side-effects
 *   full-cycle             — coverage → sources → opps → verify → ingest → match → recommend
 *
 * The agent is fully INJECTABLE for unit tests:
 *   - loadProfileContext  (default = real profileHelpers.loadProfileContext)
 *   - searchProvider      (default = null → discover-sources skipped)
 *   - fetcher             (default = null → discover-opportunities yields nothing)
 *   - upsertFundingOpportunity  (default = real)
 *   - computeMatchDecision      (default = real)
 *   - logAuditEvent       (default = real, but tolerated if missing)
 */

import {
  DEFAULT_MODE,
  ROBERT_MODES,
  ROBERT_TRIGGERS,
  RUN_STATUS,
  isValidMode,
} from './robertTypes.js'
import { getRobertConfig, maskSecrets } from './robertSafety.js'
import { createLogger } from '../../utils/logger.js'
import {
  completeRun,
  insertOpportunityCandidate,
  latestRun,
  listRecommendationsForProfile,
  startRun,
  updateOpportunityCandidate,
  upsertSourceCandidate,
} from './robertRunStore.js'
import { analyzeProfileCoverage } from './robertCoverageAnalyzer.js'
import { buildProfileDemand } from './robertProfileDemandPlanner.js'
import { buildSearchPlans } from './robertSearchPlanner.js'
import {
  discoverSourceCandidates,
  seedSourceRegistry,
} from './robertSourceDiscovery.js'
import { extractCandidates } from './robertOpportunityExtractor.js'
import { normalizeForCanonicalInsert } from './robertOpportunityNormalizer.js'
import { verifyOpportunity } from './robertVerification.js'
import { ingestOpportunity } from './robertIngestionBridge.js'
import { scoreOpportunityForProfile } from './robertMatchBridge.js'
import { createRecommendationIfHelpful } from './robertRecommendationService.js'
import { mineCatalogForProfiles } from './robertCatalogMiner.js'
import { runEmailFeedForRobert } from './robertEmailFeedBridge.js'
import { runProfileDiscoveryLive } from '../crawlerOsService.js'

const log = createLogger('robert-agent')

// Modes where Robert DISCOVERS and MATCHES opportunities. These are driven by
// the canonical Crawler OS pipeline (one discovery/matching authority), not the
// legacy source-discovery/extract/ingest/legacy-match phases.
const CRAWLER_OS_DISCOVERY_MODES = new Set([
  ROBERT_MODES.DISCOVER_OPPORTUNITIES,
  ROBERT_MODES.INGEST,
  ROBERT_MODES.MATCH,
  ROBERT_MODES.RECOMMEND,
  ROBERT_MODES.FULL_CYCLE,
])

/**
 * runRobertDiscoveryViaCrawlerOs — Robert's canonical discovery engine. For each
 * target profile it runs the Crawler OS pipeline (buildThesis -> plan -> fetch
 * -> realityGate -> normalize -> match) and persists the global catalog +
 * per-profile matches via the OS persistence adapter. No legacy crawler/matcher
 * code runs. Populates Robert's counters/summary so the run record is unchanged.
 */
async function runRobertDiscoveryViaCrawlerOs({
  db,
  profileIds,
  counters,
  summary,
  dryRun = false,
  runProfileDiscovery = runProfileDiscoveryLive,
}) {
  // Charter doctrine: "match every newly stored opportunity against ALL known
  // profiles". Build every active profile's thesis ONCE and pass them as
  // matchProfiles so each profile's discovered opps are matched against all the
  // others in-run (the live catalog can't reconstruct match fields). The
  // discovering profile is PRIMARY (authoritative 'crawler-os' set); others get
  // additive 'crawler-os-xmatch'. Clear last cycle's cross-matches once up front
  // so they rebuild fresh (no staleness). Skipped on dry-run and single-profile.
  let allTheses = null;
  if (!dryRun && profileIds.length > 1) {
    const { buildThesisForProfile } = await import('../crawlerOsService.js');
    allTheses = (await Promise.all(
      profileIds.map((pid) => buildThesisForProfile(db, pid).catch(() => null)),
    )).filter(Boolean);
    try {
      await db.prepare(`DELETE FROM profile_opportunity_matches WHERE matcher_version = 'crawler-os-xmatch'`).run();
    } catch (err) {
      summary.errors.push({ stage: 'xmatch_reset', error: String(err?.message || err) });
    }
  }
  for (const profileId of profileIds) {
    try {
      // dryRun PREVIEW: run the real pipeline (plan + fetch + match) against an
      // in-memory store but DO NOT flush to the live catalog/matches. This makes
      // a dry-run an honest read-only preview of what discovery WOULD store, with
      // real per-source outcomes — instead of silently skipping discovery and
      // reporting a misleading 0/0/0.
      const { run, persisted, thesis } = await runProfileDiscovery({ db, profileId, dryRun, matchProfiles: allTheses || undefined })
      counters.cross_matches = (counters.cross_matches || 0) + (run.cross_matches || 0)
      counters.urls_fetched += run.sources.reduce((a, s) => a + (s.fetched || 0), 0)
      counters.candidates_found += run.sources.reduce((a, s) => a + (s.parsed || 0), 0)
      counters.opportunities_ingested += persisted.opportunities
      counters.opportunities_matched += persisted.matches
      // CRITICAL FIX (charter audit 2026-06-23): the OS path used to only
      // INCREMENT a counter by run.recommendations.length and never wrote a
      // robert_profile_recommendations row — so the count was fiction and the
      // user never saw a Robert toast (the delivery stream reads that empty
      // table). Actually persist each ACCEPT-band recommendation now, and count
      // only the ones really created. Skipped on dry-run (preview only).
      let recsCreated = 0
      if (!dryRun) {
        for (const rec of run.recommendations || []) {
          const res = await safe(() => createRecommendationIfHelpful({
            db,
            profileId,
            opportunityId: rec.opportunity_id,
            matchDecision: rec.decision,
            matchScore: rec.match_score,
            opportunityTitle: rec.title || '',
            whyFound: 'Robert discovery (crawler-os)',
          }), { errors: summary.errors, stage: `persist_recommendation:${profileId}` })
          if (res?.created) recsCreated += 1
        }
      } else {
        recsCreated = run.recommendations.length // preview count only
      }
      counters.recommendations_created += recsCreated
      summary.matched.push({
        profile_id: profileId,
        applicant_types: thesis.applicant_types,
        stored: run.stored,
        matches: persisted.matches,
        recommendations: recsCreated,
        dry_run: dryRun || undefined,
        sources: run.sources.map((s) => ({
          source_id: s.source_id,
          outcome: s.outcome,
          reason: s.reason,
          fetched: s.fetched,
          parsed: s.parsed,
          stored: s.stored,
          deduped: s.deduped,
        })),
        zero_result: run.zero_result?.reason ?? null,
      })
    } catch (err) {
      summary.errors.push({ stage: 'crawler_os_discovery', profile_id: profileId, error: String(err?.message || err) })
    }
  }
  return summary
}

const MODE_REQUIRES_LIVE_WEB = new Set([
  ROBERT_MODES.DISCOVER_SOURCES,
  ROBERT_MODES.DISCOVER_OPPORTUNITIES,
])

const FULL_CYCLE_PIPELINE = [
  'observe',
  'discover-sources',
  'discover-opportunities',
  'verify',
  'ingest',
  'match',
  'recommend',
]

/**
 * Run Robert.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.req                — caller request context (auth/admin info)
 * @param {string} [args.mode]             — defaults to ROBERT_MODE env or 'observe'
 * @param {string} [args.trigger]          — manual | scheduled | startup | admin-ui | api
 * @param {string[]} [args.profileIds]     — optional whitelist
 * @param {boolean} [args.dryRun]          — never insert/upsert anything if true
 * @param {object} [args.deps]             — injected dependencies (see file header)
 * @param {object} [args.options]          — body params from /api/robert/run
 * @returns {Promise<object>}              — run summary
 */
export async function runRobert({
  db,
  req = null,
  mode = null,
  trigger = ROBERT_TRIGGERS.MANUAL,
  profileIds = null,
  dryRun = false,
  deps = {},
  options = {},
} = {}) {
  if (!db) throw new Error('runRobert: db required')

  const cfg = { ...getRobertConfig(), ...(deps.configOverride || {}) }
  let chosenMode = (mode || cfg.mode || DEFAULT_MODE).toLowerCase()
  if (!isValidMode(chosenMode)) chosenMode = DEFAULT_MODE

  // Mode gating: the legacy live-web downshift guarded the OLD unsafe web
  // crawler. Crawler OS discovery modes are exempt — the OS fetcher is the safe
  // canonical network path (safeUrl + DNS-rebind guard + rate limit), so OS
  // discovery does not depend on the legacy allowLiveWeb flag.
  const liveWebPermitted = cfg.enabled && cfg.allowLiveWeb
  if (MODE_REQUIRES_LIVE_WEB.has(chosenMode) && !liveWebPermitted && !CRAWLER_OS_DISCOVERY_MODES.has(chosenMode)) {
    chosenMode = ROBERT_MODES.OBSERVE
  }
  if (chosenMode === ROBERT_MODES.DISCOVER_SOURCES && !cfg.allowSourceDiscovery) {
    chosenMode = ROBERT_MODES.OBSERVE
  }
  // dryRun forces 'recommend' down-shift for ingestion-class modes.
  if (dryRun && [ROBERT_MODES.INGEST, ROBERT_MODES.FULL_CYCLE].includes(chosenMode)) {
    // Keep mode but the per-step code respects dryRun.
  }
  // Hard stop: Robert disabled entirely.
  if (!cfg.enabled && trigger !== ROBERT_TRIGGERS.MANUAL && trigger !== ROBERT_TRIGGERS.ADMIN_UI) {
    return {
      run_id: null,
      mode: chosenMode,
      status: 'skipped',
      reason: 'robert_disabled',
      summary: {},
    }
  }

  const runId = await startRun(db, {
    mode: chosenMode,
    trigger,
    created_by_user_id: req?.ctx?.userId ?? null,
  })
  const counters = {
    profiles_considered: 0,
    sources_considered: 0,
    urls_fetched: 0,
    candidates_found: 0,
    candidates_verified: 0,
    opportunities_ingested: 0,
    opportunities_matched: 0,
    recommendations_created: 0,
    recommendations_delivered: 0,
    recommendations_accepted: 0,
    recommendations_declined: 0,
    zero_result_profiles_helped: 0,
    email_opportunities_imported: 0,
  }
  const summary = {
    mode: chosenMode,
    trigger,
    config: maskedConfig(cfg),
    coverage: [],
    sources: { inserted: 0, updated: 0, candidates: [], reason: null },
    candidates: [],
    verified: [],
    rejected: [],
    ingested: [],
    matched: [],
    recommendations: [],
    errors: [],
    notes: [],
  }

  try {
    const profilesToConsider = await resolveProfileIds({ db, profileIds, cap: cfg.maxProfilesPerRun, deps })
    counters.profiles_considered = profilesToConsider.length

    // Always seed the curated registry (idempotent, no network).
    if (chosenMode !== ROBERT_MODES.OBSERVE && cfg.persistCandidates) {
      const seeded = await seedSourceRegistry({ db, upsert: upsertSourceCandidate })
      summary.sources.inserted += seeded.inserted
      summary.sources.updated += seeded.updated
    }

    // ---- AUDIT-PIPELINES (owner order 2026-08-21) ----------------------
    // Robert's fifth tool: verify every funding source already IN a profile's
    // pipeline against REAL / RELATABLE / COVERS-A-NEED / QUALIFIES, collapse
    // duplicates to one surviving record, remove what fails (auditably and
    // reversibly, via the canonical dismissal tombstone), and notate Amy.
    //
    // It returns BEFORE the coverage/discovery phases: this mode is a cleanup
    // of what exists, not a discovery run, and mixing the two would make the
    // run's counters unreadable. There is NO preview mode — owner order
    // 2026-08-13, "I don't want dry runs, I want work" — so `dryRun` is
    // deliberately not consulted here.
    if (chosenMode === ROBERT_MODES.AUDIT_PIPELINES) {
      const { auditAllPipelines } = await import('./robertPipelineAudit.js')
      const audit = await auditAllPipelines(db, {
        db,
        profileIds: profilesToConsider.length > 0 ? profilesToConsider : null,
        userId: req?.ctx?.userId ? `user:${req.ctx.userId}` : 'agent:robert',
        runId,
        realGate: options?.realGate !== false,
      })
      summary.pipeline_audit = audit
      summary.notes.push({
        stage: 'pipeline_audit',
        candidates: audit.totals.candidates,
        kept: audit.totals.kept,
        removed: audit.totals.removed,
        deduped_away: audit.totals.deduped_away,
        unverifiable: audit.totals.unverifiable,
        balanced: audit.totals.balanced,
      })
      counters.profiles_considered = audit.totals.profiles
      counters.candidates_verified = audit.totals.candidates
      return finishRun({ db, runId, status: RUN_STATUS.COMPLETED, counters, summary })
    }

    // ---- Phase 1: coverage analysis (always runs) ----
    const coverageResults = await runCoveragePhase({
      db,
      profileIds: profilesToConsider,
      deps,
    })
    summary.coverage = coverageResults.coverage
    counters.zero_result_profiles_helped = coverageResults.coverage.filter((c) => Number(c.zero_result_risk) >= 60).length

    if (chosenMode === ROBERT_MODES.OBSERVE) {
      summary.notes.push('observe mode — no network access, no ingestion, no recommendations')
      return finishRun({ db, runId, status: RUN_STATUS.COMPLETED, counters, summary })
    }

    // ---- Phase 1b: email→grant feed (connect existing feeder) ----
    // Trigger the already-shipped Outlook grant feeder so any grant-announcement
    // emails are parsed into `funding_opportunities` BEFORE the catalog-mining
    // match phase below — that way email-sourced rows flow through the SAME
    // match + recommend path as crawler/curated rows in the same run. Gated by
    // EMAIL_GRANTS_SYNC_ENABLED and self-no-ops when the mailbox/Graph creds are
    // unset, so this is safe to always attempt. Only on modes that recommend.
    if (
      !dryRun &&
      [ROBERT_MODES.MATCH, ROBERT_MODES.RECOMMEND, ROBERT_MODES.INGEST, ROBERT_MODES.FULL_CYCLE].includes(chosenMode)
    ) {
      const emailFeed = await safe(
        () => runEmailFeedForRobert({
          db,
          runOutlookGrantFeed: deps.runOutlookGrantFeed,
          provider: deps.outlookProvider,
        }),
        { errors: summary.errors, stage: 'email_feed' },
      )
      summary.email_feed = emailFeed || { ran: false, reason: 'email_feed_error' }
      if (emailFeed?.ran) {
        counters.email_opportunities_imported = Number(emailFeed?.result?.summary?.imported) || 0
        summary.notes.push({ stage: 'email_feed', imported: counters.email_opportunities_imported })
      } else {
        summary.notes.push({ stage: 'email_feed', skipped: emailFeed?.reason || 'unknown' })
      }
    }

    // ---- Phase 1c: email-contact lead scan (Robert's ONLY lead source) ----
    // Per owner scope: Robert finds LEADS only in the owner's email contacts and
    // hands them to John (via robertJohnBridge). Gated by ROBERT_SCAN_EMAIL_CONTACTS
    // + Graph Contacts.Read; self-no-ops otherwise. Funding discovery below is
    // unaffected and never produces leads.
    if (!dryRun) {
      const contactScan = await safe(
        async () => {
          const { runContactScanForRobert } = await import('./robertContactDiscovery.js')
          return runContactScanForRobert(db, {})
        },
        { errors: summary.errors, stage: 'contact_lead_scan' },
      )
      summary.contact_lead_scan = contactScan || { ran: false, reason: 'contact_scan_error' }
      summary.notes.push({ stage: 'contact_lead_scan', ...(contactScan?.ran ? { tagged: contactScan.tagged } : { skipped: contactScan?.reason || 'unknown' }) })
    }

    // ---- Phase 1d: owner-contact HARVEST → Yana's verification lane ----
    // Owner directive 2026-07-25: Robert reads the owner's four mailboxes
    // (Gmail/Yahoo×2/axiombiolabs) for (name, email) contacts and files them in
    // Yana's verification lane (yana_lead_candidates, source
    // 'robert_contact_harvest', status 'candidate'). Only Yana-VERIFIED
    // contacts ever reach John, through Yana's existing capped handoff — this
    // phase never touches John's stores and never sends mail. Gated by
    // ROBERT_CONTACT_HARVEST (default off); unconfigured accounts are skipped
    // with per-account honesty inside the summary.
    if (!dryRun) {
      const harvest = await safe(
        async () => {
          const { runContactHarvestForRobert } = await import('./robertContactHarvest.js')
          return runContactHarvestForRobert(db, { runId })
        },
        { errors: summary.errors, stage: 'contact_harvest' },
      )
      summary.contact_harvest = harvest || { ran: false, reason: 'contact_harvest_error' }
      summary.notes.push({
        stage: 'contact_harvest',
        ...(harvest?.ran
          ? { harvested: harvest.harvested, submitted_to_yana: harvest.submitted?.inserted ?? 0 }
          : { skipped: harvest?.reason || 'unknown' }),
      })
    }

    // ---- Phase 2: search plans (always derived; cheap) ----
    const allPlans = []
    for (const profileId of profilesToConsider) {
      const ctx = await safe(() => getCtx({ db, profileId, deps }))
      if (!ctx?.profile) continue
      const demand = buildProfileDemand(ctx)
      if (!demand) continue
      const plans = buildSearchPlans(demand, { maxPlans: 6 })
      for (const p of plans) allPlans.push(p)
    }

    // ---- CANONICAL DISCOVERY + MATCH: Crawler OS ----
    // Robert drives the Crawler OS as the single discovery/matching authority.
    // For discovery/match modes this REPLACES the legacy source-discovery,
    // opportunity-extraction, verification, ingestion, and legacy-match phases
    // below (they are NEVER executed for these modes — no dual-run, no split
    // brain, and crucially no wasteful per-plan web-search calls that took ~51s
    // and produced nothing). Coverage analysis and the email feed above still run.
    //
    // A dry-run still runs the OS pipeline, but as a READ-ONLY PREVIEW (the
    // persistence flush is skipped), so a dry-run reports honest per-source
    // outcomes instead of silently skipping discovery and returning a misleading
    // 0 found / 0 verified / 0 ingested.
    if (CRAWLER_OS_DISCOVERY_MODES.has(chosenMode)) {
      await runRobertDiscoveryViaCrawlerOs({
        db,
        profileIds: profilesToConsider,
        counters,
        summary,
        dryRun,
        runProfileDiscovery: deps.runProfileDiscoveryLive || runProfileDiscoveryLive,
      })
      summary.notes.push({ stage: 'discovery', engine: 'crawler-os', profiles: profilesToConsider.length, dry_run: dryRun || undefined })
      // Honest degradation: if discovery ran but every source was SKIPPED for
      // missing env (e.g. an API key), or no source could be selected, surface a
      // clear status reason rather than a healthy-looking empty run.
      const degraded = summarizeDiscoveryDegradation(summary)
      if (degraded) {
        summary.status_reason = degraded.reason
        summary.notes.push({ stage: 'discovery', degraded: degraded.reason, detail: degraded.detail })
      }
      return finishRun({ db, runId, status: RUN_STATUS.COMPLETED, counters, summary, statusReason: degraded?.reason || null })
    }

    // ---- Phase 3: source discovery (only if allowed) ----
    let discoveredSources = []
    if ([ROBERT_MODES.DISCOVER_SOURCES, ROBERT_MODES.FULL_CYCLE].includes(chosenMode) && cfg.allowSourceDiscovery && deps.searchProvider) {
      const result = await discoverSourceCandidates({ plans: allPlans, searchProvider: deps.searchProvider, config: cfg })
      summary.sources.reason = result.reason
      discoveredSources = result.candidates || []
      counters.sources_considered = discoveredSources.length
      if (cfg.persistCandidates && !dryRun) {
        for (const c of discoveredSources) {
          const r = await safe(() => upsertSourceCandidate(db, c))
          if (r?.inserted) summary.sources.inserted += 1
          else if (r?.updated) summary.sources.updated += 1
        }
      }
      summary.sources.candidates = discoveredSources.slice(0, 25)
    }

    // ---- Phase 4: opportunity discovery (only if allowed and adapter provided) ----
    const candidateIds = []
    if ([ROBERT_MODES.DISCOVER_OPPORTUNITIES, ROBERT_MODES.FULL_CYCLE].includes(chosenMode) && cfg.allowLiveWeb && typeof deps.opportunityAdapter === 'function') {
      const adapterInputs = discoveredSources.length > 0 ? discoveredSources : (deps.seedSources || [])
      for (const src of adapterInputs.slice(0, cfg.maxSourcesPerRun)) {
        let records = []
        try {
          records = await deps.opportunityAdapter({ source: src, plans: allPlans, config: cfg }) || []
          counters.urls_fetched += 1
        } catch (err) {
          summary.errors.push({ stage: 'opportunity_adapter', source: src.source_url, error: String(err?.message || err).slice(0, 200) })
          continue
        }
        const { candidates: extracted, dropped, reasons } = extractCandidates({
          records, sourceCandidateId: src.id || null, runId, extractionMethod: src.source_type || 'adapter',
        })
        counters.candidates_found += extracted.length
        if (dropped > 0) summary.notes.push({ source: src.source_url, dropped, reasons: dedup(reasons).slice(0, 5) })
        if (cfg.persistCandidates && !dryRun) {
          for (const c of extracted) {
            const r = await safe(() => insertOpportunityCandidate(db, c))
            if (r?.id) candidateIds.push({ id: r.id, candidate: c })
          }
        } else {
          for (const c of extracted) candidateIds.push({ id: null, candidate: c })
        }
      }
    }

    // ---- Phase 5–6: verify + (optionally) ingest ----
    if ([ROBERT_MODES.VERIFY, ROBERT_MODES.INGEST, ROBERT_MODES.FULL_CYCLE].includes(chosenMode)) {
      for (const { id, candidate } of candidateIds.slice(0, cfg.maxOpportunitiesPerRun)) {
        const normalized = normalizeForCanonicalInsert(candidate)
        const verification = await safe(() => verifyOpportunity({ opportunity: normalized, checkUrl: deps.checkUrl, config: cfg }))
        if (!verification?.ok) {
          summary.rejected.push({ candidate_id: id, reason: verification?.reason, stage: verification?.stage })
          if (!dryRun && id) {
            await safe(() => updateOpportunityCandidate(db, id, {
              verification_status: 'rejected',
              verification_reasons: [verification?.reason].filter(Boolean),
              policy_status: verification?.stage === 'policy' ? 'rejected' : null,
              policy_rejection_reason: verification?.stage === 'policy' ? verification?.reason : null,
              reality_status: verification?.stage === 'reality' ? 'rejected' : null,
              reviewer_status: verification?.stage === 'reviewer' ? 'rejected' : null,
            }))
          }
          continue
        }
        counters.candidates_verified += 1
        summary.verified.push({ candidate_id: id, title: candidate.title, application_url: candidate.application_url })

        // INGEST step (config-gated)
        if ([ROBERT_MODES.INGEST, ROBERT_MODES.FULL_CYCLE].includes(chosenMode) && cfg.autoIngestVerified && !dryRun) {
          const insertResult = await safe(() => ingestOpportunity({
            db, opportunity: normalized,
            upsertFundingOpportunity: deps.upsertFundingOpportunity,
          }), { errors: summary.errors, stage: 'ingest_opportunity' })
          if (insertResult?.id) {
            counters.opportunities_ingested += (insertResult.inserted || insertResult.updated) ? 1 : 0
            summary.ingested.push({ id: insertResult.id, title: candidate.title, inserted: insertResult.inserted, updated: insertResult.updated })
            if (id) {
              await safe(() => updateOpportunityCandidate(db, id, {
                verification_status: 'verified',
                verification_reasons: verification.warnings || [],
                ingested_opportunity_id: insertResult.id,
                normalized_opportunity_json: normalized,
              }), { errors: summary.errors, stage: 'update_candidate' })
            }
          } else if (insertResult?.skipped) {
            summary.rejected.push({ candidate_id: id, reason: insertResult.reason || 'inserter_skipped', stage: 'inserter' })
            if (id) {
              await safe(() => updateOpportunityCandidate(db, id, {
                verification_status: 'rejected',
                verification_reasons: [insertResult.reason].filter(Boolean),
              }), { errors: summary.errors, stage: 'update_candidate' })
            }
          } else {
            // ingestOpportunity threw (already logged + recorded in
            // summary.errors by safe()). Surface it as a rejected candidate so a
            // verified opportunity is never silently dropped while the run still
            // reports success.
            summary.rejected.push({ candidate_id: id, reason: 'ingest_error', stage: 'inserter' })
          }
        } else if (id && !dryRun) {
          await safe(() => updateOpportunityCandidate(db, id, {
            verification_status: 'verified',
            verification_reasons: verification.warnings || [],
            normalized_opportunity_json: normalized,
          }))
        }
      }
    }

    // ---- Phase 7–9: match + recommend ----
    if ([ROBERT_MODES.MATCH, ROBERT_MODES.RECOMMEND, ROBERT_MODES.FULL_CYCLE].includes(chosenMode)) {
      // (a) Score the rows Robert ingested in THIS run (Phase 4→5). These are
      // brand-new to the catalog so they wouldn't be reached by the broad
      // catalog query below if it were capped tightly; score them explicitly so
      // a fresh ingest always gets a chance to recommend.
      const newlyIngested = summary.ingested.map((x) => x.id)
      const ingestedRows = await fetchOpportunitiesByIds(db, newlyIngested)
      if (ingestedRows.length > 0) {
        const freshContexts = await Promise.all(
          profilesToConsider.map((pid) => safe(() => getCtx({ db, profileId: pid, deps }))),
        )
        for (const opp of ingestedRows) {
          for (const ctx of freshContexts) {
            if (!ctx?.profile) continue
            const decision = await safe(() => scoreOpportunityForProfile({
              profileContext: ctx, opportunity: opp, computeMatchDecision: deps.computeMatchDecision,
            }))
            if (!decision) continue
            counters.opportunities_matched += 1
            summary.matched.push({ profile_id: ctx.profile.id, opportunity_id: opp.id, score: decision.score, decision: decision.decision, source: 'fresh_ingest' })
            if (chosenMode === ROBERT_MODES.MATCH) continue   // match-only stops here
            const recResult = await safe(() => createRecommendationIfHelpful({
              db,
              profileId: ctx.profile.id,
              opportunityId: opp.id,
              matchDecision: decision.decision,
              matchScore: decision.score,
              matchReasons: decision.reasons || [],
              missingProfileFields: decision.missingProfileFields || [],
              whyFound: `Robert discovered this opportunity from ${opp.source || 'a verified source'}.`,
              searchQueryUsed: '',
              opportunityCandidateId: null,
              robertRunId: runId,
              opportunityTitle: opp.title,
              profileDisplayName: ctx.profile.display_name || 'this profile',
              config: cfg,
            }))
            if (recResult?.created) {
              counters.recommendations_created += 1
              summary.recommendations.push({ id: recResult.recommendation_id, profile_id: ctx.profile.id, opportunity_id: opp.id, decision: decision.decision, source: 'fresh_ingest' })
            }
          }
        }
      }

      // (b) PRIMARY discovery: mine the EXISTING funding catalog and match it to
      // every profile. This is the user's core ask — Robert searches the rows
      // the crawlers / school-portal imports / email feeder / manual curation
      // already populated (the "universe already discovered"), scores each with
      // the CANONICAL matcher, EXCLUDES anything already in the profile's
      // pipeline/dismissed (pipelineExclusion), applies the canonical relevance
      // floor (config/relevanceFloor), and queues recommendations through the
      // same idempotent recommendation path. It always runs (not gated on a
      // wired opportunityAdapter), so Robert never no-ops while funding exists.
      const mineResult = await safe(
        () => mineCatalogForProfiles({
          db,
          profileIds: profilesToConsider,
          getCtx: (d, pid) => getCtx({ db: d, profileId: pid, deps }),
          config: cfg,
          runId,
          dryRun: dryRun || chosenMode === ROBERT_MODES.MATCH,
          computeMatchDecision: deps.computeMatchDecision,
          perProfileCap: cfg.maxOpportunitiesPerRun,
          errors: summary.errors,
          matched: summary.matched,
          recommendations: summary.recommendations,
          counters,
        }),
        { errors: summary.errors, stage: 'catalog_mine' },
      )
      summary.catalog_mine = mineResult || { error: 'catalog_mine_failed' }
      summary.notes.push({ stage: 'catalog_mine', ...(mineResult || {}) })
    }

    return finishRun({ db, runId, status: RUN_STATUS.COMPLETED, counters, summary })
  } catch (err) {
    summary.errors.push({ stage: 'agent', error: maskSecrets(String(err?.stack || err?.message || err)).slice(0, 4000) })
    return finishRun({ db, runId, status: RUN_STATUS.FAILED, counters, summary, error: err })
  }
}

/**
 * Quick read-only status snapshot for the admin UI.
 */
export async function getRobertStatus(db, { config = null } = {}) {
  const cfg = config || getRobertConfig()
  const last = await safe(() => latestRun(db))
  return {
    agent: 'Robert',
    enabled: cfg.enabled,
    mode: cfg.mode,
    allow_live_web: cfg.allowLiveWeb,
    allow_source_discovery: cfg.allowSourceDiscovery,
    allow_search_engine: cfg.allowSearchEngine,
    auto_ingest_verified: cfg.autoIngestVerified,
    rate_limit_per_domain_per_hour: cfg.rateLimitPerDomainPerHour,
    last_run: last,
  }
}

/**
 * Helper used by /api/robert/recommendations endpoint to assemble what
 * to show a particular profile right now.
 */
export async function listPendingRecommendationsForProfile(db, profileId, { limit = 50 } = {}) {
  return await listRecommendationsForProfile(db, profileId, {
    statuses: ['pending', 'delivered', 'viewed'],
    limit,
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function runCoveragePhase({ db, profileIds, deps }) {
  const out = { coverage: [] }
  for (const profileId of profileIds) {
    const result = await safe(() => analyzeProfileCoverage({
      db,
      profileId,
      loadProfileContext: deps.loadProfileContext || (async (d, id) => loadProfileContextDefault(d, id)),
    }))
    if (result?.coverage) out.coverage.push(result.coverage)
  }
  return out
}

async function getCtx({ db, profileId, deps }) {
  if (typeof deps.loadProfileContext === 'function') return await deps.loadProfileContext(db, profileId)
  return await loadProfileContextDefault(db, profileId)
}

let _cachedLoadProfileContext = null
async function loadProfileContextDefault(db, profileId) {
  if (!_cachedLoadProfileContext) {
    const mod = await import('../profileHelpers.js')
    _cachedLoadProfileContext = mod.loadProfileContext
  }
  return await _cachedLoadProfileContext(db, profileId)
}

async function resolveProfileIds({ db, profileIds, cap, deps }) {
  if (Array.isArray(profileIds) && profileIds.length > 0) return profileIds.slice(0, cap)
  if (typeof deps.listActiveProfileIds === 'function') return (await deps.listActiveProfileIds(db)).slice(0, cap)
  // Default: live SQL.
  if (!db?.prepare) return []
  try {
    const rows = await db.prepare(
      `SELECT id FROM profiles WHERE COALESCE(status,'active') = 'active' ORDER BY updated_at DESC LIMIT ?`,
    ).all(Number(cap) || 50)
    return rows.map((r) => r.id)
  } catch (err) {
    log.warn(`resolveProfileIds failed (returning none): ${String(err?.message || err)}`)
    return []
  }
}

async function fetchOpportunitiesByIds(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || !db?.prepare) return []
  const placeholders = ids.map(() => '?').join(',')
  try {
    return await db.prepare(`SELECT * FROM funding_opportunities WHERE id IN (${placeholders})`).all(...ids) || []
  } catch (err) {
    log.warn(`fetchOpportunitiesByIds failed (returning none): ${String(err?.message || err)}`)
    return []
  }
}

// Run fn, returning null on failure — but NEVER silently. Every caught error is
// logged, and when a `ctx.errors` array is supplied (the run summary's errors
// list) the failure is recorded there so a swallowed DB write (e.g. a verified
// opportunity that failed to ingest) surfaces in the run summary instead of
// vanishing while the run still reports success.
async function safe(fn, ctx = null) {
  try {
    return await fn()
  } catch (err) {
    const msg = maskSecrets(String(err?.message || err)).slice(0, 300)
    if (Array.isArray(ctx?.errors)) ctx.errors.push({ stage: ctx?.stage || 'safe', error: msg })
    log.warn(`safe() swallowed error${ctx?.stage ? ` at ${ctx.stage}` : ''}: ${msg}`)
    return null
  }
}

function dedup(arr) {
  return Array.from(new Set(arr || []))
}

/**
 * summarizeDiscoveryDegradation — inspect a Crawler-OS discovery run summary and
 * return an honest status reason when the run produced nothing for an
 * explainable CONFIG/ENV reason (so the dashboard/telemetry can show "discovery
 * provider not configured" rather than a healthy-looking empty run). Returns
 * null when discovery stored matches or when the empty result is a genuine
 * "no funding for this profile" rather than a misconfiguration.
 */
export function summarizeDiscoveryDegradation(summary) {
  const runs = Array.isArray(summary?.matched) ? summary.matched.filter((m) => Array.isArray(m.sources)) : []
  const discoveryErrors = Array.isArray(summary?.errors)
    ? summary.errors.filter((error) => error?.stage === 'crawler_os_discovery')
    : []
  if (discoveryErrors.length > 0) {
    return {
      reason: runs.length > 0
        ? 'crawler_os_discovery_partially_failed'
        : 'crawler_os_discovery_failed',
      detail: `${discoveryErrors.length} profile discovery run(s) failed before a durable Crawler OS receipt was produced`,
    }
  }
  if (runs.length === 0) return null
  const stored = runs.reduce((a, m) => a + (Number(m.stored) || 0), 0)
  if (stored > 0) return null // discovery worked — not degraded

  // Flatten every source outcome across the profiles discovered this run.
  const sources = runs.flatMap((m) => m.sources || [])
  if (sources.length === 0) {
    return { reason: 'no_sources_selected', detail: 'planner selected no in-scope sources for these profiles' }
  }
  const skippedMissingEnv = sources.filter(
    (s) => s.outcome === 'skipped' && typeof s.reason === 'string' && s.reason.startsWith('missing_env:'),
  )
  const allSkipped = sources.every((s) => s.outcome === 'skipped')
  if (allSkipped && skippedMissingEnv.length > 0) {
    const keys = dedup(
      skippedMissingEnv.flatMap((s) => String(s.reason).replace('missing_env:', '').split(',')),
    ).filter(Boolean)
    return {
      reason: 'discovery_provider_not_configured',
      detail: `every funding source was skipped for missing configuration: ${keys.join(', ')}`,
    }
  }
  if (allSkipped) {
    return { reason: 'all_sources_skipped', detail: 'every funding source was skipped (no adapter or out of scope)' }
  }
  const anyFetched = sources.some((s) => (Number(s.fetched) || 0) > 0)
  if (!anyFetched) {
    return { reason: 'all_fetches_failed', detail: 'no source returned a response (network egress / source outage)' }
  }
  // Sources ran and fetched but nothing cleared the floor — honest empty, not a
  // misconfiguration. Leave status_reason unset.
  return null
}

function maskedConfig(cfg) {
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    allow_live_web: cfg.allowLiveWeb,
    allow_source_discovery: cfg.allowSourceDiscovery,
    allow_search_engine: cfg.allowSearchEngine,
    auto_ingest_verified: cfg.autoIngestVerified,
    max_profiles_per_run: cfg.maxProfilesPerRun,
    max_sources_per_run: cfg.maxSourcesPerRun,
    max_opportunities_per_run: cfg.maxOpportunitiesPerRun,
    timeout_ms: cfg.timeoutMs,
    rate_limit_per_domain_per_hour: cfg.rateLimitPerDomainPerHour,
    min_source_trust: cfg.minSourceTrust,
    require_real_application_url: cfg.requireRealApplicationUrl,
    respect_robots: cfg.respectRobots,
    user_agent: cfg.userAgent,
  }
}

async function finishRun({ db, runId, status, counters, summary, error = null, statusReason = null }) {
  await safe(() => completeRun(db, runId, {
    status,
    counters,
    summary,
    error: error ? String(error?.message || error) : null,
  }))
  return {
    // A run that completed but produced nothing for a CONFIG reason is reported
    // ok:false with a status_reason so health/telemetry shows the real cause
    // (e.g. discovery_provider_not_configured) instead of a healthy empty run.
    ok: status === RUN_STATUS.COMPLETED && !statusReason,
    run_id: runId,
    mode: summary.mode,
    status,
    status_reason: statusReason,
    summary,
    coverage: summary.coverage,
    sources: summary.sources,
    candidates: summary.verified.length + summary.rejected.length,
    ingested: summary.ingested,
    matched: summary.matched,
    recommendations: summary.recommendations,
    rejected: summary.rejected,
    errors: summary.errors,
    counters,
  }
}
