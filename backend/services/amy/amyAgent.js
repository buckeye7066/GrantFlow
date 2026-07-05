/**
 * amyAgent.js
 *
 * Amy — synthetic crawler-training agent (orchestrator). The GOAL is to IMPROVE
 * THE CRAWLERS, provably and reversibly.
 *
 * runAmyTraining():
 *   1. Generate varied synthetic profiles across categories (no real PII).
 *   2. Insert each (tagged synthetic + Sam-cleanable + traceable).
 *   3. Run a REAL crawler event for each profile at the 75% slider
 *      (floor = DEFAULT_MIN_SCORE) via runProfileDiscoveryLive, retaining the
 *      scored candidates. Mark each profile crawled_at.
 *   4. MEASURE cohort crawler quality (coverage / zero / false-positive) and
 *      SWEEP the score floor over the cohort to find the best threshold.
 *   5. IMPROVE (when enabled): auto-apply the proven, bounded, reversible floor
 *      change (edits matchThresholds.js with backup); hand the implicated files
 *      to Anya (root cause) → Sam (verified safe fixes); stage deeper levers
 *      (source coverage, scoring weights) into an approval queue.
 *   6. Persist a combined report (admin panel) + JSON artifacts.
 *   7. Clean up ONLY profiles that were crawled at least once (never before).
 *
 * Everything is dependency-injected so the agent is unit-testable offline.
 */

import { getDb } from '../../db/index.js'
import { runProfileDiscoveryLive } from '../crawlerOsService.js'
import { createLogger } from '../../utils/logger.js'
import { DEFAULT_MIN_SCORE } from '../../config/matchThresholds.js'
import { newRunId, clampTtlHours } from './amyMetadata.js'
import { generateScenarios, CATEGORY_IDS } from './syntheticProfileCatalog.js'
import { createAmyProfile, cleanupAmyProfiles, markProfileCrawled } from './amyProfileStore.js'
import { evaluateDiscovery, buildAnyaHandoff, summarizeEvaluations } from './amyReport.js'
import { cohortMetricsAtFloor, sweepFloors, summarizeCohort } from './crawlerMetrics.js'
import { decideFloorChange, decideWeightChange, proposeCoverageOverrides, buildApprovalQueue } from './crawlerTuner.js'
import { getEffectiveMinScore, getEffectiveWeights, setScoringTuning, persistScoringTuning } from '../../config/scoringTuning.js'
import { readLiveOverrides, applyCoverageOverrides, revertCoverageOverrides } from './crawlerCoverageEditor.js'
import { buildArchetypeMetrics, buildArchetypeLearningUpdate, saveArchetypeLearning, appendArchetypeMetrics, evaluationArchetype } from './archetypeLearning.js'
import { runAmyAnyaSamPipeline } from './amyPipeline.js'
import { saveAmyReport } from './amyReportStore.js'
import { recordFlywheelCohort } from './flywheelCohort.js'

const defaultLog = createLogger('services:amy:agent')

/**
 * @param {object} options  (all optional)
 *   db, categories, perCategory, targetCount, dryRunDiscovery=true,
 *   floor (defaults DEFAULT_MIN_SCORE=75 — the slider), keepProfiles=false,
 *   ttlHours=48, runDiscovery, fetcher, logger, clock, writeArtifact, runId,
 *   improve=false (run the Anya→Sam chain + tuning), applyTuning=false (write
 *   the floor change), anyaApply=false, samApply=false, saveReport=true,
 *   runPipeline (inject), thresholdEditor (inject {read,apply}), tuningOpts.
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

  const scenarios = generateScenarios({ runId, categories, perCategory, targetCount })
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

    try {
      // The 75% crawler event: at least one real discovery run per profile.
      const result = await runDiscovery({ db, profileId, dryRun: dryRunDiscovery, floor: sliderFloor, fetcher })
      evaluations.push(evaluateDiscovery(scenario, profileId, result, { runId }))
      // Only count it as crawled when discovery actually ran (not skipped).
      if (result && !result?.run?.skipped) {
        await markProfileCrawled(db, profileId, { now: clock(), floor: sliderFloor })
        crawledProfileIds.push(profileId)
      }
    } catch (err) {
      logger.warn('discovery threw for synthetic profile', { scenario_id: scenario.scenario_id, profile_id: profileId, error: err?.message })
      evaluations.push(evaluateDiscovery(scenario, profileId, null, { error: err?.message, runId }))
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
  const baselineQuality = cohortMetricsAtFloor(
    evaluations.filter((e) => sampleIds.includes(e.profile_id)),
    operatingFloor,
  ).quality_score
  async function recrawlQuality() {
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
    return { quality: cohortMetricsAtFloor(reEvals, operatingFloor).quality_score, evals: reEvals }
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
          const rv = await recrawlQuality()
          if (rv.quality > baselineQuality) {
            weightTuning.validation = { kept: true, baseline: baselineQuality, after: rv.quality }
            after = cohortMetricsAtFloor(rv.evals, operatingFloor)
            logger.info('Amy kept scoring-weight change', { baseline: baselineQuality, after: rv.quality })
          } else {
            await weightEditor.restore(applied)
            weightTuning.validation = { kept: false, reverted: true, baseline: baselineQuality, after: rv.quality }
            logger.info('Amy reverted scoring-weight change (no improvement)', { baseline: baselineQuality, after: rv.quality })
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

  // Persist combined report for the admin panel (best-effort).
  if (saveReport && db) {
    await saveAmyReport(db, combined).catch(() => {})
  }

  // Daily flywheel scoreboard: fold this run's per-profile clean/issue verdicts
  // into the ET-day cohort; the first fully-clean full-target day sends the
  // owner's one-shot goal-reached notification. Best-effort, never fatal.
  if (db && !dryRunDiscovery) {
    combined.flywheel_cohort = await recordFlywheelCohort(db, {
      evaluations,
      runId,
      at: completedAtDate.toISOString(),
    }).catch(() => null)
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

  logger.info('Amy training run complete', {
    run_id: runId,
    ...summary,
    crawled: crawledProfileIds.length,
    floor_tuned: tuningApplied?.applied ? `${decision.from}->${decision.to}` : 'none',
    weights_tuned: weightTuning?.validation?.kept ? 'kept' : weightTuning?.applied?.applied ? 'reverted' : 'none',
    coverage_tuned: coverageTuning?.validation?.kept ? 'kept' : coverageTuning?.applied?.applied ? 'reverted' : 'none',
    archetypes_learned: Object.keys(archetypeUpdate).length,
    approval_items: approvalQueue.length,
    cleaned: cleanup?.deleted ?? 0,
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
  }
}

export { cleanupAmyProfiles }
export default { runAmyTraining, cleanupAmyProfiles }
