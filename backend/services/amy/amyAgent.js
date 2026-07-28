/**
 * amyAgent.js
 *
 * Amy — synthetic crawler-training agent (orchestrator). The MISSION is to
 * CLOSE COVERAGE GAPS AND WIN THE GOOGLE-BAR, provably and reversibly: every
 * training/crawl task derives from the Coverage & Evidence gap scoreboard,
 * the structural matrix, and the web-parity gap queue (system_kv
 * `web_parity_gap_queue`) — never at random. Structural gaps Amy cannot fix
 * become adapter-wishlist proposals; everything she can fix is tuned
 * empirically with KEEP/REVERT (bounded, backed up, auto-reverted on
 * mismatch). See docs/AGENTS.md + canonical_rules.md "The self-improvement
 * loop".
 *
 * runAmyTraining():
 *   1. Generate varied synthetic profiles across categories (no real PII),
 *      cohort-weighted toward the fleet's proven gaps.
 *   2. Insert each (tagged synthetic + Sam-cleanable + traceable).
 *   3. Run a REAL crawler event for each profile at the discovery slider
 *      (floor = DEFAULT_MIN_SCORE, data-point scale) via
 *      runProfileDiscoveryLive, retaining the scored candidates. Mark each
 *      profile crawled_at.
 *   4. MEASURE cohort crawler quality (coverage / zero / false-positive) and
 *      SWEEP the score floor over the cohort to find the best threshold.
 *   5. IMPROVE (when enabled): auto-apply the proven, bounded, reversible floor
 *      change (edits matchThresholds.js with backup); hand the implicated files
 *      to Anya (root cause) → Sam (verified safe fixes); stage deeper levers
 *      (source coverage, scoring weights) into an approval queue.
 *   6. Persist a combined report (admin panel) + JSON artifacts.
 *   7. Clean up ONLY profiles that were crawled at least once (never before),
 *      then run the UNscoped expired-only sweep (cleanupExpiredAmyProfiles) so
 *      expired leftovers from ANY prior run are reaped too — the run-scoped
 *      pass alone deleted nothing when discovery skipped/errored, and prior
 *      runs' leftovers were permanently out of its onlyIds scope.
 *
 * Everything is dependency-injected so the agent is unit-testable offline.
 */

import { getDb } from '../../db/index.js'
import { runProfileDiscoveryLive } from '../crawlerOsService.js'
import { createLogger } from '../../utils/logger.js'
import { DEFAULT_MIN_SCORE, TOPICAL_EVIDENCE_STRONG_BAR } from '../../config/matchThresholds.js'
import { newRunId, clampTtlHours } from './amyMetadata.js'
import { generateScenarios, CATEGORY_IDS } from './syntheticProfileCatalog.js'
import { createAmyProfile, cleanupAmyProfiles, cleanupExpiredAmyProfiles, markProfileCrawled } from './amyProfileStore.js'
import { evaluateDiscovery, buildAnyaHandoff, summarizeEvaluations } from './amyReport.js'
import { cohortMetricsAtFloor, sweepFloors, summarizeCohort } from './crawlerMetrics.js'
import { decideFloorChange, decideWeightChange, proposeCoverageOverrides, buildApprovalQueue } from './crawlerTuner.js'
import { getEffectiveMinScore, getEffectiveWeights, setScoringTuning, persistScoringTuning } from '../../config/scoringTuning.js'
import { readLiveOverrides, applyCoverageOverrides, revertCoverageOverrides } from './crawlerCoverageEditor.js'
import { buildArchetypeMetrics, buildArchetypeLearningUpdate, saveArchetypeLearning, appendArchetypeMetrics, evaluationArchetype } from './archetypeLearning.js'
import { runAmyAnyaSamPipeline } from './amyPipeline.js'
import { saveAmyReport } from './amyReportStore.js'
import { recordFlywheelCohort } from './flywheelCohort.js'
import { buildFleetGapScoreboard, weightCategoriesByGaps, deriveAmyGapActions } from '../coverageGapScoreboard.js'
import { insertActivityEvent } from '../agentTelemetry/agentTelemetryStore.js'

const defaultLog = createLogger('services:amy:agent')

/**
 * Read profiles.last_discovery_at for one profile (tolerant: older/test
 * schemas without the column read as null). Used as the belt-and-suspenders
 * "the crawl really happened" signal: persistRun stamps last_discovery_at on
 * every live discovery flush, so if the stamp ADVANCED across a runDiscovery
 * call whose result said skipped — or that threw AFTER persisting (the prod
 * failure mode: post-persist steps erroring left crawled profiles counted as
 * not-crawled) — the profile was genuinely crawled and must be reapable.
 */
async function readLastDiscoveryAt(db, profileId) {
  try {
    const row = await db.prepare('SELECT last_discovery_at FROM profiles WHERE id = ?').get(profileId)
    return row?.last_discovery_at ?? null
  } catch {
    return null
  }
}

/** True when the profile's last_discovery_at stamp advanced past `before`. */
async function discoveryStampAdvanced(db, profileId, before) {
  const after = await readLastDiscoveryAt(db, profileId)
  if (!after) return false
  if (!before) return true
  const a = Date.parse(after)
  const b = Date.parse(before)
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b
  return String(after) !== String(before)
}

/**
 * @param {object} options  (all optional)
 *   db, categories, perCategory, targetCount, dryRunDiscovery=true,
 *   floor (defaults DEFAULT_MIN_SCORE — the slider, data-point scale), keepProfiles=false,
 *   ttlHours=48, runDiscovery, fetcher, logger, clock, writeArtifact, runId,
 *   improve=false (run the Anya→Sam chain + tuning), applyTuning=false (write
 *   the floor change), anyaApply=false, samApply=false, saveReport=true,
 *   runPipeline (inject), thresholdEditor (inject {read,apply}), tuningOpts,
 *   gapLearning=true (derive the cohort + task queue from the fleet
 *   Coverage & Evidence gap scoreboard instead of uniform random),
 *   gapScanLimit=100, refreshScoreboard (inject), recordActivity (inject).
 * @returns {Promise<object>} { run_id, summary, report (handoff), combined, ... }
 */
export async function runAmyTraining(options = {}) {
  const {
    db = getDb(),
    categories = CATEGORY_IDS,
    perCategory = 1,
    targetCount = null,
    dryRunDiscovery = true,
    floor,
    keepProfiles = false,
    ttlHours = 48,
    runDiscovery = runProfileDiscoveryLive,
    fetcher,
    logger = defaultLog,
    clock = () => new Date(),
    writeArtifact = null,
    improve = false,
    applyTuning = false,
    applyWeights = false,
    applyCoverage = false,
    // Archetype learning (query steering): the safest lever — it can only ADD
    // bounded web queries for archetypes the cohort proved weak — so it is ON
    // whenever the improvement loop runs.
    applyLearning = true,
    anyaEnabled = true,
    anyaApply = false,
    samEnabled = true,
    samApply = false,
    saveReport = true,
    runPipeline = runAmyAnyaSamPipeline,
    // Default editors apply tuning through the LIVE, DB-persisted scoring store
    // (backend/config/scoringTuning.js): changes take effect in-process for the
    // validation re-crawl and survive restarts. Reversible via restore(applied).
    thresholdEditor = {
      read: async () => getEffectiveMinScore(),
      apply: async (to) => {
        const from = getEffectiveMinScore()
        setScoringTuning({ minScore: to })
        await persistScoringTuning(db)
        return { applied: true, from, to }
      },
      restore: async (applied) => {
        const from = applied?.from
        if (Number.isFinite(Number(from))) { setScoringTuning({ minScore: Number(from) }); await persistScoringTuning(db) }
        return true
      },
    },
    weightEditor = {
      read: async () => getEffectiveWeights(),
      apply: async (to) => {
        const from = getEffectiveWeights()
        setScoringTuning({ weights: to })
        await persistScoringTuning(db)
        return { applied: true, from, to }
      },
      restore: async (applied) => {
        const from = applied?.from ?? applied
        if (from && typeof from === 'object') { setScoringTuning({ weights: from }); await persistScoringTuning(db) }
        return true
      },
    },
    coverageEditor = { read: readLiveOverrides, apply: applyCoverageOverrides, revert: revertCoverageOverrides },
    validationSampleSize = 40,
    tuningOpts = {},
    // Fleet gap learning (owner directive 2026-07-06): Amy's daily tasks come
    // from the Coverage & Evidence gap scoreboard, not random selection. The
    // refresh is bounded + best-effort — a scan failure degrades to the old
    // uniform round-robin, never blocks training.
    gapLearning = true,
    gapScanLimit = 100,
    refreshScoreboard = buildFleetGapScoreboard,
    recordActivity = insertActivityEvent,
  } = options

  const startedAtDate = clock()
  const runId = options.runId || newRunId(startedAtDate)
  const ttl = clampTtlHours(ttlHours)
  const sliderFloor = Number.isFinite(Number(floor)) ? Number(floor) : DEFAULT_MIN_SCORE

  logger.info('Amy training run starting', {
    run_id: runId,
    categories: categories.length,
    target_count: targetCount ?? null,
    slider_floor: sliderFloor,
    dry_run_discovery: dryRunDiscovery,
    improve,
    apply_tuning: applyTuning,
    keep_profiles: keepProfiles,
  })

  // ── LEARN FROM THE FLEET: refresh the Coverage & Evidence gap scoreboard ──
  // Amy derives her work queue from the gaps real profiles actually suffer:
  //  (a) actionable classes (lane_excluded / need_uncovered / disease-source-
  //      not-selected) WEIGHT the synthetic cohort so her validated levers
  //      (additive coverage, learned query steering) fire with evidence;
  //  (b) structural classes (no adapter for a lane/state/disease) become the
  //      prioritized ADAPTER WISHLIST — Amy cannot write code, so they are
  //      persisted on the scoreboard + emitted as a blocked telemetry event
  //      for Sam's check and Anya's morning report (Agent Observability Rule).
  let fleetGaps = null
  let categoryWeights = null
  if (gapLearning) {
    try {
      fleetGaps = await refreshScoreboard(db, { limit: gapScanLimit, now: clock() })
      if (fleetGaps?.profiles_scanned > 0) {
        categoryWeights = weightCategoriesByGaps(fleetGaps, categories)
      }
    } catch (err) {
      logger.warn('Amy fleet gap-scoreboard refresh failed (falling back to uniform cohort)', { error: err?.message })
      fleetGaps = null
    }
  }
  const gapActions = deriveAmyGapActions(fleetGaps)
  if (fleetGaps) {
    const topGap = fleetGaps.gaps?.[0]
    await Promise.resolve(recordActivity(db, {
      agent_name: 'amy',
      event_type: 'amy.gap_scoreboard.refreshed',
      status: 'succeeded',
      severity: 'info',
      title: `Amy refreshed the fleet coverage-gap scoreboard: ${fleetGaps.gaps?.length || 0} gap class(es) across ${fleetGaps.profiles_scanned} profile(s)`,
      description: topGap ? `Top gap (${topGap.count} profile(s)): ${topGap.statement}` : 'No fleet coverage gaps detected.',
      metric_key: 'fleet_gap_classes',
      metric_value: fleetGaps.gaps?.length || 0,
      details_json: {
        run_id: runId,
        top_gaps: (fleetGaps.gaps || []).slice(0, 5),
        category_weights: categoryWeights,
        actionable: gapActions.actionable.length,
        structural: gapActions.structural.length,
      },
    })).catch(() => {})
    if (gapActions.structural.length > 0) {
      // ACT on the wishlist, don't just log it. A `no_disease_source` gap is a
      // search waiting to happen: find a real patient-assistance source for the
      // condition and queue it for GATED adoption on the affected profiles' next
      // crawl (the seeding lane decides — this never inserts a source itself).
      //
      // Until now this block only emitted the 'blocked' telemetry below, so a
      // finding that was correct every night had no actor and the owner was asked
      // to hand-add adapters — "a queue with no consumer is a record of the gap,
      // not a fix for it". Best-effort: a search outage must never fail Amy's run.
      let searchOutcome = null
      try {
        const [{ searchForMissingConditionSources }, { searchWeb }] = await Promise.all([
          import('../coverageAudit/conditionSourceSearch.js'),
          import('../shared/webSearchEngine.js'),
        ])
        searchOutcome = await searchForMissingConditionSources(db, gapActions.structural, { searchWeb })
      } catch (err) {
        searchOutcome = { ran: false, reason: String(err?.message ?? err) }
      }

      const queued = Number(searchOutcome?.queued ?? 0)
      await Promise.resolve(recordActivity(db, {
        agent_name: 'amy',
        event_type: 'amy.adapter_wishlist',
        // Only still 'blocked' when nothing could be queued for ANY of them. If a
        // candidate is queued the gap is being worked, not blocked — and reporting
        // "blocked" then would understate the loop exactly as reporting "added"
        // would overstate it.
        status: queued > 0 ? 'succeeded' : 'blocked',
        severity: queued > 0 ? 'info' : 'medium',
        title: queued > 0
          ? `Adapter wishlist: queued ${queued} candidate source(s) for ${searchOutcome.searched} condition(s) — pending the gates on each profile's next crawl`
          : `Adapter wishlist: ${gapActions.structural.length} structural coverage gap(s) Amy cannot fix (source adapter needed)`,
        description: gapActions.structural
          .slice(0, 3)
          .map((w) => `${w.detail || w.lane}: ${w.statement} (${w.affected_profiles_count} profile(s))`)
          .join(' | '),
        metric_key: 'adapter_wishlist',
        metric_value: gapActions.structural.length,
        // `condition_search` records what the SEARCH did (queued ≠ added — the gates
        // have not run yet). Anya's report reads the evidence store for the rest.
        details_json: { run_id: runId, wishlist: gapActions.structural, condition_search: searchOutcome },
      })).catch(() => {})
    }
  }

  const scenarios = generateScenarios({ runId, categories, perCategory, targetCount, categoryWeights })
  const evaluations = []
  const createdProfileIds = []
  const crawledProfileIds = []
  const scenarioByProfile = new Map()

  for (const scenario of scenarios) {
    let profileId = null
    try {
      const created = await createAmyProfile(db, scenario, { runId, ttlHours: ttl, now: clock() })
      profileId = created.profileId
      createdProfileIds.push(profileId)
      scenarioByProfile.set(profileId, scenario)
    } catch (err) {
      logger.warn('failed to create synthetic profile', { scenario_id: scenario.scenario_id, error: err?.message })
      evaluations.push(
        evaluateDiscovery(scenario, profileId, null, { error: `profile_create_failed: ${err?.message}`, runId }),
      )
      continue
    }

    // Snapshot the real discovery stamp BEFORE the run so a skipped/thrown
    // result can still be recognized as crawled when the stamp advanced.
    const stampBefore = await readLastDiscoveryAt(db, profileId)
    try {
      // The slider-floor crawler event: at least one real discovery run per profile.
      const result = await runDiscovery({ db, profileId, dryRun: dryRunDiscovery, floor: sliderFloor, fetcher })
      evaluations.push(evaluateDiscovery(scenario, profileId, result, { runId }))
      // Only count it as crawled when discovery actually ran (not skipped) —
      // with a belt-and-suspenders check: if the result SAID skipped but the
      // profile's last_discovery_at advanced during the call, the crawl really
      // happened (persistRun stamps it) and the profile must count as crawled,
      // or cleanup would skip a genuinely-crawled synthetic forever.
      if (result && !result?.run?.skipped) {
        await markProfileCrawled(db, profileId, { now: clock(), floor: sliderFloor })
        crawledProfileIds.push(profileId)
      } else if (await discoveryStampAdvanced(db, profileId, stampBefore)) {
        await markProfileCrawled(db, profileId, { now: clock(), floor: sliderFloor })
        crawledProfileIds.push(profileId)
      }
    } catch (err) {
      logger.warn('discovery threw for synthetic profile', { scenario_id: scenario.scenario_id, profile_id: profileId, error: err?.message })
      evaluations.push(evaluateDiscovery(scenario, profileId, null, { error: err?.message, runId }))
      // Same belt-and-suspenders for the THROW path (the prod failure mode:
      // discovery persisted — stamping last_discovery_at — then errored in a
      // post-persist step, leaving a crawled profile counted as not-crawled).
      try {
        if (await discoveryStampAdvanced(db, profileId, stampBefore)) {
          await markProfileCrawled(db, profileId, { now: clock(), floor: sliderFloor })
          crawledProfileIds.push(profileId)
        }
      } catch { /* crawled-signal rescue is best-effort, never fatal */ }
    }
  }

  const summary = summarizeEvaluations(evaluations)
  const handoff = buildAnyaHandoff({
    runId,
    evaluations,
    meta: {
      startedAt: startedAtDate.toISOString(),
      completedAt: clock().toISOString(),
      dryRun: dryRunDiscovery,
      options: { categories: categories.length, targetCount: targetCount ?? null, floor: sliderFloor },
    },
  })

  // ── MEASURE: cohort quality + floor sweep (always; cheap, no I/O on cohort) ──
  let currentFloor = sliderFloor
  try {
    const read = await thresholdEditor.read()
    if (Number.isFinite(Number(read))) currentFloor = Number(read)
  } catch {
    currentFloor = sliderFloor
  }
  const before = cohortMetricsAtFloor(evaluations, currentFloor)
  const { sweep, best } = sweepFloors(evaluations)
  const decision = decideFloorChange({ currentFloor, best, currentMetrics: before, opts: tuningOpts })
  const approvalQueue = buildApprovalQueue(evaluations)

  // ── MEASURE + LEARN per ARCHETYPE (the Amy→crawler flywheel) ────────────
  // Metrics: per-archetype qualified / ineligible-accept counts for THIS run —
  // the verifiable before/after unit (persisted below as rolling history).
  // Learning: gap classes the cohort proved (institution/hyperlocal/low_results),
  // which the live crawl consumes via attachLearnedGaps → buildWebQueries so
  // the NEXT crawl for any real profile of that archetype targets the miss.
  const archetypeMetrics = buildArchetypeMetrics(evaluations)
  const archetypeUpdate = buildArchetypeLearningUpdate(evaluations, {
    runId,
    at: clock().toISOString(),
    minEvidence: tuningOpts.archetype?.minEvidence,
  })
  let archetypeLearningApplied = null
  if (improve && applyLearning) {
    try {
      // Per-archetype cohort sizes: an archetype may only CLEAR a prior lesson
      // when this run exercised it with real evidence (same bar as learning).
      const cohortArchetypes = Object.fromEntries(
        Object.entries(archetypeMetrics).map(([key, m]) => [key, m.profiles]),
      )
      archetypeLearningApplied = await saveArchetypeLearning(db, archetypeUpdate, {
        runId,
        at: clock().toISOString(),
        cohortArchetypes,
        minEvidence: tuningOpts.archetype?.minEvidence,
      })
      if (Object.keys(archetypeUpdate).length > 0) {
        logger.info('Amy recorded archetype query-steering lessons', {
          run_id: runId,
          archetypes: Object.keys(archetypeUpdate),
        })
      }
    } catch (err) {
      logger.warn('Amy archetype learning persist failed', { error: err?.message })
    }
  }

  // ── IMPROVE: apply the proven floor change (bounded, backed-up, reversible) ──
  let tuningApplied = null
  let after = before
  if (improve && applyTuning && decision.change) {
    try {
      tuningApplied = await thresholdEditor.apply(decision.to, { now: clock() })
      if (tuningApplied?.applied) {
        after = decision.projected
        logger.info('Amy applied crawler floor tuning', { from: decision.from, to: decision.to, gain: decision.gain })
      }
    } catch (err) {
      logger.warn('Amy floor tuning failed', { error: err?.message })
      tuningApplied = { applied: false, reason: err?.message }
    }
  }
  const operatingFloor = tuningApplied?.applied ? decision.to : currentFloor

  // Re-crawl a sample of the (still-live) profiles and recompute cohort quality.
  // This is the EMPIRICAL validator for scoring-weight + source-coverage edits:
  // unlike the floor (which we can re-score offline), changing weights/coverage
  // changes the scores/candidates themselves, so we must actually re-crawl.
  const sampleIds = crawledProfileIds.slice(0, Math.max(1, validationSampleSize))
  const sampleEvals = evaluations.filter((e) => sampleIds.includes(e.profile_id))
  const baselineQuality = cohortMetricsAtFloor(sampleEvals, operatingFloor).quality_score
  // NEED-ANCHORED SPLIT (owner directive 2026-07-06): the FINAL match score is
  // need-coverage × eligibility/geo gates, so a W_* weight change no longer
  // moves final scores at all — weights act only inside the topical-evidence
  // blend (scoreBreakdown.topical_evidence, retained on candidates[].topical).
  // Validating a WEIGHT change on final scores would therefore always show
  // "no improvement" and auto-revert every change. The weight validator instead
  // measures cohort quality on the topical subscale at the (legacy-scale)
  // strong bar; coverage validation keeps the final-score lens, because adding
  // sources changes the candidates themselves.
  const baselineTopicalQuality = cohortMetricsAtFloor(
    sampleEvals,
    TOPICAL_EVIDENCE_STRONG_BAR,
    { scoreKey: 'topical' },
  ).quality_score
  async function recrawlQuality({ floor = operatingFloor, scoreKey = 'score' } = {}) {
    const reEvals = []
    for (const pid of sampleIds) {
      const scn = scenarioByProfile.get(pid)
      if (!scn) continue
      try {
        const r = await runDiscovery({ db, profileId: pid, dryRun: dryRunDiscovery, floor: sliderFloor, fetcher })
        reEvals.push(evaluateDiscovery(scn, pid, r, { runId }))
      } catch (err) {
        reEvals.push(evaluateDiscovery(scn, pid, null, { error: err?.message, runId }))
      }
    }
    return { quality: cohortMetricsAtFloor(reEvals, floor, { scoreKey }).quality_score, evals: reEvals }
  }

  // ── IMPROVE: scoring weights (empirical re-crawl validation + auto-revert) ──
  let weightTuning = null
  if (improve && applyWeights && crawledProfileIds.length >= (tuningOpts.weights?.minCohort ?? 12)) {
    try {
      const currentWeights = await weightEditor.read()
      const wd = decideWeightChange({ currentWeights, cohort: summarizeCohort(evaluations, operatingFloor), opts: tuningOpts.weights })
      weightTuning = { ...wd, applied: null, validation: null }
      if (wd.change) {
        const applied = await weightEditor.apply(wd.to, { now: clock() })
        weightTuning.applied = applied
        if (applied?.applied) {
          // Topical lens (see the scale-split note in crawlerMetrics.js):
          // weights only move scoreBreakdown.topical_evidence, never the
          // final score (true on the data-point scale as on the retired
          // need-anchored one).
          const rv = await recrawlQuality({ floor: TOPICAL_EVIDENCE_STRONG_BAR, scoreKey: 'topical' })
          if (rv.quality > baselineTopicalQuality) {
            weightTuning.validation = { kept: true, lens: 'topical_evidence', baseline: baselineTopicalQuality, after: rv.quality }
            after = cohortMetricsAtFloor(rv.evals, operatingFloor)
            logger.info('Amy kept scoring-weight change', { baseline: baselineTopicalQuality, after: rv.quality, lens: 'topical_evidence' })
          } else {
            await weightEditor.restore(applied)
            weightTuning.validation = { kept: false, reverted: true, lens: 'topical_evidence', baseline: baselineTopicalQuality, after: rv.quality }
            logger.info('Amy reverted scoring-weight change (no improvement)', { baseline: baselineTopicalQuality, after: rv.quality, lens: 'topical_evidence' })
          }
        }
      }
    } catch (err) {
      logger.warn('Amy weight tuning failed', { error: err?.message })
      weightTuning = { change: false, error: err?.message }
    }
  }

  // ── IMPROVE: source coverage (empirical re-crawl validation + auto-revert) ──
  let coverageTuning = null
  if (improve && applyCoverage && crawledProfileIds.length >= (tuningOpts.coverage?.minCohort ?? 12)) {
    try {
      const liveOverrides = await coverageEditor.read()
      const cp = proposeCoverageOverrides(evaluations, { liveOverrides, opts: tuningOpts.coverage })
      coverageTuning = { change: cp.change, additions: cp.additions, reason: cp.reason, applied: null, validation: null }
      if (cp.change) {
        const applied = await coverageEditor.apply(cp.next, { now: clock(), db })
        coverageTuning.applied = applied
        if (applied?.applied) {
          const rv = await recrawlQuality()
          if (rv.quality > baselineQuality) {
            coverageTuning.validation = { kept: true, baseline: baselineQuality, after: rv.quality }
            after = cohortMetricsAtFloor(rv.evals, operatingFloor)
            logger.info('Amy kept source-coverage change', { baseline: baselineQuality, after: rv.quality })
          } else {
            await coverageEditor.revert(applied.from, applied.backup_path, { db })
            coverageTuning.validation = { kept: false, reverted: true, baseline: baselineQuality, after: rv.quality }
            logger.info('Amy reverted source-coverage change (no improvement)', { baseline: baselineQuality, after: rv.quality })
          }
        }
      }
    } catch (err) {
      logger.warn('Amy coverage tuning failed', { error: err?.message })
      coverageTuning = { change: false, error: err?.message }
    }
  }

  // ── HAND OFF: Anya (root cause) → Sam (verified safe fixes) ──────────────
  let chain = null
  if (improve) {
    chain = await runPipeline({
      db,
      amyResult: { report: handoff },
      options: { anyaEnabled, anyaApply, samEnabled, samApply },
      logger,
    }).catch((err) => {
      logger.warn('Amy pipeline failed', { error: err?.message })
      return { error: String(err?.message || err) }
    })
  }

  // ── AUDIT TRAIL: mark approval-queue items an auto-applied lever addressed ──
  // A queue item that a validated, kept evolution already acted on is annotated
  // (not removed) so the panel shows WHAT changed, WHICH run changed it, and
  // which Amy finding caused it — instead of the same item reappearing dead.
  const coverageKept = Boolean(coverageTuning?.validation?.kept)
  const weightsKept = Boolean(weightTuning?.validation?.kept)
  const coverageCategories = new Set((coverageTuning?.additions || []).map((a) => a.category))
  const learnedArchetypes = new Set(Object.keys(archetypeUpdate))
  for (const item of approvalQueue) {
    if (coverageKept && item.lever === 'source_keyword_coverage' && coverageCategories.has(item.category)) {
      item.auto_applied = { lever: 'source_coverage_overrides', run_id: runId, kept: true }
    } else if (weightsKept && item.lever === 'scoring_weights') {
      item.auto_applied = { lever: 'scoring_weights', run_id: runId, kept: true }
    } else if (item.lever === 'source_keyword_coverage') {
      // Query-steering learning fires for the item's archetype on the next crawl.
      const archetypesForCategory = evaluations
        .filter((e) => e.category === item.category)
        .map((e) => evaluationArchetype(e))
      const steered = archetypesForCategory.find((a) => learnedArchetypes.has(a))
      if (steered) item.auto_applied = { lever: 'archetype_query_learning', archetype: steered, run_id: runId, kept: true }
    }
  }

  const completedAtDate = clock()
  const combined = {
    generator: 'Amy',
    goal: 'improve_crawlers',
    run_id: runId,
    started_at: startedAtDate.toISOString(),
    completed_at: completedAtDate.toISOString(),
    slider_floor: sliderFloor,
    improve_enabled: improve,
    crawler_events: {
      profiles: scenarios.length,
      created: createdProfileIds.length,
      crawled: crawledProfileIds.length,
      skipped: evaluations.filter((e) => e.status === 'skipped').length,
      errored: evaluations.filter((e) => e.status === 'error').length,
    },
    cohort: summarizeCohort(evaluations, operatingFloor),
    metrics: { current_floor: currentFloor, operating_floor: operatingFloor, before, after, sweep, best, baseline_quality: baselineQuality },
    tuning: { ...decision, applied: tuningApplied },
    weight_tuning: weightTuning,
    coverage_tuning: coverageTuning,
    // Fleet gap learning: the scoreboard Amy trained against this run, the
    // weights it derived, and the actionable/structural split (adapter
    // wishlist) — the owner-visible record that tasks came from real gaps.
    fleet_gap_learning: {
      enabled: gapLearning,
      scoreboard: fleetGaps
        ? {
            generated_at: fleetGaps.generated_at,
            profiles_scanned: fleetGaps.profiles_scanned,
            gap_classes: fleetGaps.gaps?.length || 0,
            top_gaps: (fleetGaps.gaps || []).slice(0, 5),
            top_missing_lanes: (fleetGaps.top_missing_lanes || []).slice(0, 5),
            top_unanswered_fields: (fleetGaps.top_unanswered_fields || []).slice(0, 5),
            adapter_wishlist: fleetGaps.adapter_wishlist || [],
          }
        : null,
      category_weights: categoryWeights,
      actions: gapActions,
    },
    // Per-archetype flywheel: this run's measurement + the steering it recorded.
    archetype_metrics: archetypeMetrics,
    archetype_learning: {
      update: archetypeUpdate,
      applied: Boolean(archetypeLearningApplied),
      store: archetypeLearningApplied,
    },
    chain,
    approval_queue: approvalQueue,
    amy: { summary, handoff },
  }

  // Daily flywheel scoreboard: fold this run's per-profile clean/issue verdicts
  // into the ET-day cohort; the first fully-clean full-target day sends the
  // owner's one-shot goal-reached notification. Recorded BEFORE the report is
  // persisted so the stored admin report carries the flywheel result. Never
  // fatal, but a failure is RECORDED on the report (G1: no silent failures).
  if (db && !dryRunDiscovery) {
    try {
      combined.flywheel_cohort = await recordFlywheelCohort(db, {
        evaluations,
        runId,
        at: completedAtDate.toISOString(),
      })
      if (combined.flywheel_cohort?.ok === false && !combined.flywheel_cohort?.skipped) {
        combined.degraded = true
        combined.flywheel_record_error = combined.flywheel_cohort?.error || 'flywheel cohort record failed'
        logger.error('Amy flywheel cohort record failed', { run_id: runId, error: combined.flywheel_record_error })
      }
    } catch (err) {
      combined.flywheel_cohort = null
      combined.degraded = true
      combined.flywheel_record_error = err?.message || String(err)
      logger.error('Amy flywheel cohort record failed', { run_id: runId, error: combined.flywheel_record_error })
    }
  }

  // Persist combined report for the admin panel (after the flywheel cohort is
  // attached). Non-fatal, but a persistence failure is recorded + logged (G1).
  if (saveReport && db) {
    try {
      const saved = await saveAmyReport(db, combined)
      if (saved === false) {
        combined.degraded = true
        combined.report_persistence_error = 'saveAmyReport returned false (persist failed; see reportStore logs)'
        logger.error('Amy report persistence failed', { run_id: runId, error: combined.report_persistence_error })
      }
    } catch (err) {
      combined.degraded = true
      combined.report_persistence_error = err?.message || String(err)
      logger.error('Amy report persistence failed', { run_id: runId, error: combined.report_persistence_error })
    }
  }

  // Persist per-archetype metrics history — the run-over-run PROOF that the
  // crawlers are improving (read by Sam/Anya via system_kv and surfaced on the
  // admin crawl-coverage dashboard). Always written (measurement, not a lever).
  if (db) {
    await appendArchetypeMetrics(db, {
      runId,
      at: completedAtDate.toISOString(),
      metrics: archetypeMetrics,
    }).catch(() => {})
  }

  // Write artifacts (best-effort).
  const artifacts = { handoffPath: null, runLogPath: null, combinedPath: null }
  if (typeof writeArtifact === 'function') {
    try {
      artifacts.handoffPath = await writeArtifact(`amy-to-anya-handoff-${runId}.json`, JSON.stringify(handoff, null, 2))
      artifacts.runLogPath = await writeArtifact(
        `amy-run-${runId}.json`,
        JSON.stringify({ run_id: runId, started_at: startedAtDate.toISOString(), completed_at: completedAtDate.toISOString(), summary, created_profile_ids: createdProfileIds, evaluations }, null, 2),
      )
      if (improve) {
        artifacts.combinedPath = await writeArtifact(`amy-crawler-improvement-${runId}.json`, JSON.stringify(combined, null, 2))
      }
    } catch (err) {
      logger.warn('failed to write Amy artifacts', { error: err?.message })
    }
  }

  // ── CLEANUP: only profiles crawled at least once; never before. ──────────
  let cleanup = null
  if (!keepProfiles) {
    cleanup = await cleanupAmyProfiles(db, {
      runId,
      onlyIds: crawledProfileIds,
      requireCrawled: true,
      force: true,
      now: clock(),
    })
  }
  combined.cleanup = cleanup

  // ── CLEANUP NET (owner directive 2026-07-06 "make sure those profiles are
  // getting deleted afterwards"): the pass above is scoped to THIS run's
  // crawled ids — when discovery skipped/errored for every profile the id list
  // is EMPTY and it deletes nothing, and leftovers from PRIOR runs are
  // permanently out of its scope (prod accumulated 13 live synthetics with a
  // lifetime reap count of 0). This second, UNscoped expired-only pass sweeps
  // expired synthetics from ANY run at the end of EVERY run, with all guards
  // intact (designated / allow_sam_cleanup / synthetic / crawled + TTL escape
  // hatch / 6h grace). The boot invariant enforceAmySyntheticExpiry is the
  // standing net behind this per-run gate.
  let expiredSweep = null
  if (!keepProfiles) {
    try {
      expiredSweep = await cleanupExpiredAmyProfiles(db, { now: clock() })
    } catch (err) {
      logger.warn('Amy expired-synthetic sweep failed (non-fatal)', { error: err?.message })
      expiredSweep = { error: String(err?.message || err), scanned: 0, deleted: 0, skipped: 0 }
    }
  }
  combined.cleanup_expired = expiredSweep

  // Agent Observability Rule: the sweep outcome must be visible to Sam + Anya,
  // not just in ephemeral run logs — emit the standard amy telemetry event.
  if (expiredSweep) {
    await Promise.resolve(recordActivity(db, {
      agent_name: 'amy',
      event_type: 'amy.cleanup.expired_sweep',
      status: expiredSweep.error ? 'failed' : 'succeeded',
      severity: expiredSweep.error ? 'medium' : 'info',
      title: `Amy expired-synthetic sweep: reaped ${expiredSweep.deleted ?? 0} leftover profile(s) (scanned ${expiredSweep.scanned ?? 0})`,
      description: expiredSweep.error
        ? `Sweep failed: ${expiredSweep.error}`
        : `End-of-run expired-only pass (unscoped): ${expiredSweep.deleted ?? 0} reaped, ${expiredSweep.skipped ?? 0} kept by guards; this run's scoped cleanup reaped ${cleanup?.deleted ?? 0}.`,
      metric_key: 'amy_expired_synthetics_reaped',
      metric_value: expiredSweep.deleted ?? 0,
      details_json: {
        run_id: runId,
        scanned: expiredSweep.scanned ?? 0,
        deleted: expiredSweep.deleted ?? 0,
        skipped: expiredSweep.skipped ?? 0,
        reaped_ids: expiredSweep.ids ?? [],
        this_run_cleanup_deleted: cleanup?.deleted ?? 0,
        ...(expiredSweep.error ? { error: expiredSweep.error } : {}),
      },
    })).catch(() => {})
  }

  logger.info('Amy training run complete', {
    run_id: runId,
    ...summary,
    crawled: crawledProfileIds.length,
    floor_tuned: tuningApplied?.applied ? `${decision.from}->${decision.to}` : 'none',
    weights_tuned: weightTuning?.validation?.kept ? 'kept' : weightTuning?.applied?.applied ? 'reverted' : 'none',
    coverage_tuned: coverageTuning?.validation?.kept ? 'kept' : coverageTuning?.applied?.applied ? 'reverted' : 'none',
    archetypes_learned: Object.keys(archetypeUpdate).length,
    fleet_gap_classes: fleetGaps ? (fleetGaps.gaps?.length || 0) : null,
    gap_weighted_cohort: Boolean(categoryWeights),
    adapter_wishlist: gapActions.structural.length,
    approval_items: approvalQueue.length,
    cleaned: cleanup?.deleted ?? 0,
    expired_swept: expiredSweep?.deleted ?? 0,
    kept: keepProfiles,
  })

  return {
    run_id: runId,
    summary,
    report: handoff,
    combined,
    artifacts,
    created_profile_ids: createdProfileIds,
    crawled_profile_ids: crawledProfileIds,
    kept_profiles: keepProfiles,
    cleanup,
    cleanup_expired: expiredSweep,
  }
}

export { cleanupAmyProfiles, cleanupExpiredAmyProfiles }
export default { runAmyTraining, cleanupAmyProfiles, cleanupExpiredAmyProfiles }
