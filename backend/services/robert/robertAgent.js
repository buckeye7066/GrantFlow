/**
 * robertAgent.js
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

  // Mode gating: live-web modes downgrade to observe when config says so.
  const liveWebPermitted = cfg.enabled && cfg.allowLiveWeb
  if (MODE_REQUIRES_LIVE_WEB.has(chosenMode) && !liveWebPermitted) {
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
          }))
          if (insertResult?.id) {
            counters.opportunities_ingested += (insertResult.inserted || insertResult.updated) ? 1 : 0
            summary.ingested.push({ id: insertResult.id, title: candidate.title, inserted: insertResult.inserted, updated: insertResult.updated })
            if (id) {
              await safe(() => updateOpportunityCandidate(db, id, {
                verification_status: 'verified',
                verification_reasons: verification.warnings || [],
                ingested_opportunity_id: insertResult.id,
                normalized_opportunity_json: normalized,
              }))
            }
          } else if (insertResult?.skipped) {
            summary.rejected.push({ candidate_id: id, reason: insertResult.reason || 'inserter_skipped', stage: 'inserter' })
            if (id) {
              await safe(() => updateOpportunityCandidate(db, id, {
                verification_status: 'rejected',
                verification_reasons: [insertResult.reason].filter(Boolean),
              }))
            }
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
      // Pull the opportunities we just ingested.
      const newlyIngested = summary.ingested.map((x) => x.id)
      const ingestedRows = await fetchOpportunitiesByIds(db, newlyIngested)
      const profileContexts = await Promise.all(
        profilesToConsider.map((pid) => safe(() => getCtx({ db, profileId: pid, deps }))),
      )
      for (const opp of ingestedRows) {
        for (const ctx of profileContexts) {
          if (!ctx?.profile) continue
          const decision = await safe(() => scoreOpportunityForProfile({
            profileContext: ctx, opportunity: opp, computeMatchDecision: deps.computeMatchDecision,
          }))
          if (!decision) continue
          counters.opportunities_matched += 1
          summary.matched.push({ profile_id: ctx.profile.id, opportunity_id: opp.id, score: decision.score, decision: decision.decision })
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
            summary.recommendations.push({ id: recResult.recommendation_id, profile_id: ctx.profile.id, opportunity_id: opp.id, decision: decision.decision, score: decision.score })
          }
        }
      }
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
  } catch {
    return []
  }
}

async function fetchOpportunitiesByIds(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || !db?.prepare) return []
  const placeholders = ids.map(() => '?').join(',')
  try {
    return await db.prepare(`SELECT * FROM funding_opportunities WHERE id IN (${placeholders})`).all(...ids) || []
  } catch {
    return []
  }
}

async function safe(fn) {
  try { return await fn() } catch { return null }
}

function dedup(arr) {
  return Array.from(new Set(arr || []))
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

async function finishRun({ db, runId, status, counters, summary, error = null }) {
  await safe(() => completeRun(db, runId, {
    status,
    counters,
    summary,
    error: error ? String(error?.message || error) : null,
  }))
  return {
    ok: status === RUN_STATUS.COMPLETED,
    run_id: runId,
    mode: summary.mode,
    status,
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
