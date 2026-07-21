// EVA summary — pure aggregation for the Anya morning email plus stale/heartbeat
// analysis. The loader (defaultLoadEvaPortfolioQa) reads the store; the pure
// summarizer (summarizeEvaPortfolioQa) turns that raw data into the exact shape
// the email renders. Keeping the summarizer pure means the owner-report tests
// can feed fixtures with no DB.
import { LIMITS, SEVERITY_RANK } from './evaTypes.js'
import { expectedAppIds } from './evaRegistry.js'
import {
  latestRun,
  getAppRunsForRun,
  getActionableFindings,
  getRecentlyResolved,
  latestHeartbeat,
  getJourneyResult,
} from './evaRunStore.js'

/**
 * Load a self-contained snapshot of EVA state for the report. Best-effort:
 * returns null on any error so a broken EVA loader never blocks the Sam
 * section of the morning email. NEVER throws.
 */
export async function defaultLoadEvaPortfolioQa(db, { now = null } = {}) {
  try {
    const run = await latestRun(db)
    const heartbeat = await latestHeartbeat(db)
    // Nothing has EVER been received — return null so the summarizer yields null
    // and the renderer emits the explicit "not run / not a pass" block rather
    // than an all-zero table that could read as benign.
    if (!run && !heartbeat) return null

    const appRuns = run ? await getAppRunsForRun(db, run.id) : []
    const findings = await getActionableFindings(db, { limit: 60 })
    // "Resolved since yesterday" window.
    const sinceIso = new Date((now ? new Date(now).getTime() : Date.now()) - 26 * 60 * 60 * 1000).toISOString()
    const resolved = await getRecentlyResolved(db, { sinceIso, limit: 30 })

    // Attach the latest journey-result detail to each actionable finding so the
    // email can render repro/impact/fix without a second query in the renderer.
    const detailed = []
    for (const f of findings) {
      const detail = f.latest_journey_result_id ? await getJourneyResult(db, f.latest_journey_result_id) : null
      detailed.push({ ...f, detail })
    }

    const expected = expectedAppIds()
    return { run, heartbeat, appRuns, findings: detailed, resolved, expectedAppIds: expected }
  } catch {
    return null
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/**
 * Pure summarizer. Given the loader snapshot (or null) and `now`, returns the
 * exact object the email renders — or null when there is genuinely nothing to
 * show (no run and no heartbeat ever). Distinguishes fresh / stale / never-run
 * so an untested portfolio can never read as all-clear.
 */
export function summarizeEvaPortfolioQa(data, { now = null, staleMs = LIMITS.DEFAULT_STALE_MS } = {}) {
  if (!data) return null
  const nowMs = now ? new Date(now).getTime() : Date.now()
  const { run, heartbeat, appRuns = [], findings = [], resolved = [], expectedAppIds: expected = [] } = data

  // Freshness of the latest run.
  const runAgeMs = run ? nowMs - new Date(run.completed_at || run.received_at).getTime() : Infinity
  const runFresh = run && runAgeMs <= staleMs
  const runStale = run && runAgeMs > staleMs

  // Heartbeat freshness (a runner that cannot test still beats).
  const hbAgeMs = heartbeat ? nowMs - new Date(heartbeat.last_seen_at).getTime() : Infinity
  const heartbeatState = !heartbeat ? 'missing' : hbAgeMs > staleMs ? 'stale' : 'ok'

  // Per-app rollup from the latest run (only trusted when the run is fresh).
  const appsById = {}
  for (const ar of appRuns) appsById[ar.app_id] = ar
  const statusCounts = { tested: 0, blocked: 0, not_run: 0, startup_failed: 0, other: 0 }
  for (const ar of appRuns) {
    if (ar.app_status === 'tested') statusCounts.tested++
    else if (ar.app_status === 'blocked') statusCounts.blocked++
    else if (ar.app_status === 'not_run') statusCounts.not_run++
    else if (ar.app_status === 'startup_failed') statusCounts.startup_failed++
    else statusCounts.other++
  }

  // Apps expected but absent from the latest fresh run = "not tested".
  const testedIds = new Set(appRuns.map((a) => a.app_id))
  const notTested = expected.filter((id) => !testedIds.has(id))

  // Journey rollup.
  const journeysTotal = run ? Number(run.journeys_total) || 0 : 0
  const journeysPassed = run ? Number(run.journeys_passed) || 0 : 0
  const journeysFailed = run ? Number(run.journeys_failed) || 0 : 0
  const passRate = journeysTotal > 0 ? Math.round((journeysPassed / journeysTotal) * 100) : null

  // Coverage percentage across tested apps.
  let featTotal = 0
  let featCovered = 0
  const unautomated = []
  for (const ar of appRuns) {
    featTotal += Number(ar.features_total) || 0
    featCovered += Number(ar.features_covered) || 0
    for (const uf of parseJson(ar.unautomated_features_json, [])) unautomated.push({ app: ar.display_name || ar.app_id, feature: uf })
  }
  const coveragePct = featTotal > 0 ? Math.round((featCovered / featTotal) * 100) : null

  // Finding lifecycle buckets.
  const bucket = { new: 0, recurring: 0, worsened: 0, intermittent: 0, blocked: 0, stale: 0 }
  for (const f of findings) {
    if (bucket[f.lifecycle_state] !== undefined) bucket[f.lifecycle_state]++
  }

  // Actionable findings, critical/high first, shaped for the renderer.
  const actionable = findings
    .slice()
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4))
    .map((f) => {
      const d = f.detail || {}
      return {
        app_id: f.app_id,
        program: f.display_name || f.app_id,
        journey: f.journey_name || f.journey_id,
        severity: f.severity || 'medium',
        lifecycle_state: f.lifecycle_state,
        expected: d.expected_behavior || null,
        observed: d.observed_behavior || null,
        repro_steps: parseJson(d.repro_steps_json, []),
        impact: d.user_impact || null,
        likely_cause: d.likely_root_cause || null,
        suggested_fix: d.recommended_fix || null,
        candidate_files: parseJson(d.candidate_files_json, []),
        confidence: typeof d.diagnostic_confidence === 'number' ? d.diagnostic_confidence : null,
        missing_evidence: d.missing_evidence || null,
        first_seen: f.first_seen_at,
        last_seen: f.last_seen_at,
        recurrence_count: Number(f.recurrence_count) || 1,
        last_passing_run: f.last_passing_at || null,
        evidence: parseJson(d.evidence_json, []).map((e) => ({ kind: e.kind, ref: e.ref })),
        route: f.route_or_control || null,
        failure_class: f.failure_class || null,
      }
    })

  const resolvedList = resolved.map((f) => ({
    program: f.display_name || f.app_id,
    journey: f.journey_name || f.journey_id,
    severity: f.severity || 'medium',
    resolved_at: f.resolved_at,
    closing_run: f.resolved_run_id,
  }))

  // Blocked / not-tested detail.
  const blockedApps = appRuns
    .filter((a) => a.app_status !== 'tested')
    .map((a) => ({ program: a.display_name || a.app_id, status: a.app_status, reason: a.blocker_reason || null }))

  // Headline: overall status must never be "all clear" when data is stale/missing.
  let headline
  if (!run && heartbeatState === 'missing') headline = 'Portfolio testing has never reported and no runner heartbeat was received.'
  else if (!run) headline = 'No EVA portfolio run has been received; runner is alive but has not uploaded results.'
  else if (runStale) headline = `Last portfolio run is STALE (${Math.round(runAgeMs / 3600000)}h old) — results below are from the last upload, not overnight.`
  else if (journeysFailed > 0) headline = `${journeysFailed} user journey${journeysFailed === 1 ? '' : 's'} failed across ${statusCounts.tested} tested program${statusCounts.tested === 1 ? '' : 's'}.`
  else headline = `All ${journeysPassed} executed user journeys passed across ${statusCounts.tested} program${statusCounts.tested === 1 ? '' : 's'}.`

  return {
    headline,
    freshness: runFresh ? 'fresh' : run ? 'stale' : 'none',
    run_age_hours: run ? Math.round(runAgeMs / 3600000) : null,
    heartbeat_state: heartbeatState,
    heartbeat_age_hours: heartbeat ? Math.round(hbAgeMs / 3600000) : null,
    apps_expected: expected.length,
    apps_tested: statusCounts.tested,
    apps_blocked: statusCounts.blocked,
    apps_startup_failed: statusCounts.startup_failed,
    apps_not_run: statusCounts.not_run + notTested.length,
    not_tested: notTested,
    journeys_total: journeysTotal,
    journeys_passed: journeysPassed,
    journeys_failed: journeysFailed,
    pass_rate: passRate,
    coverage_pct: coveragePct,
    unautomated_features: unautomated.slice(0, 25),
    lifecycle: bucket,
    actionable,
    resolved: resolvedList,
    blocked_apps: blockedApps,
  }
}
