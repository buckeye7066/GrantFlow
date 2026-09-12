/**
 * metricEnvelope.js — the ONE shape every owner-facing coverage / cohort /
 * benchmark metric must carry so two numbers can never be compared across
 * different windows or populations without saying so.
 *
 * Why this exists (2026-09-12): the 24-profile coverage scoreboard reported
 * "zero gap classes" on the same morning the seven-day live-crawl window
 * reported 1,722 of 1,774 crawls with a gap, the 50-profile Amy cohort was
 * 0/50 clean, and the Google-bar benchmark was 0/100. All four were true;
 * they measure different populations over different windows. A point-in-time
 * zero on one population cannot close a seven-day regression on another, and
 * a metric that does not name its window, population, code version, provider
 * state, sample size and freshness invites exactly that conflation.
 *
 * Usage: spread `buildMetricEnvelope({...})` into any persisted or reported
 * metric object. Every field is plain JSON; unknown values are `null`, never
 * omitted, so a consumer can tell "not measured" from "not reported".
 */

/** Same precedence as /api/health build.commit_sha (routes/health.js). */
export function resolveCodeVersion(env = process.env) {
  const sha = String(
    env.RAILWAY_GIT_COMMIT_SHA
      || env.GIT_COMMIT_SHA
      || env.COMMIT_SHA
      || env.VERCEL_GIT_COMMIT_SHA
      || '',
  ).trim()
  return {
    commit_sha: sha || null,
    short_sha: sha ? sha.slice(0, 12) : null,
    runtime: env.RAILWAY_ENVIRONMENT_NAME || env.VERCEL_ENV || env.NODE_ENV || null,
  }
}

function num(v) {
  return Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null
}

/**
 * @param {object} p
 * @param {{kind:string, start?:string|null, end?:string|null, days?:number|null, label?:string}} p.window
 *   `kind` is one of 'rolling_days' | 'point_in_time' | 'run' | 'lifetime'.
 * @param {{kind:string, description:string, selector?:string|null}} p.population
 *   Who was measured: e.g. {kind:'live_crawls', description:'every runProfileDiscoveryLive on a non-Amy profile'}.
 * @param {number|null} p.evaluated       units that were actually evaluated
 * @param {number|null} p.unevaluated     units planned/eligible but NOT evaluated (skipped, errored, blocked)
 * @param {number|null} [p.sampleSize]    denominator used for any rate (defaults to evaluated)
 * @param {object|null} [p.providerHealth] e.g. {search:'healthy'|'degraded'|'unavailable'|'unknown', llm:'unavailable', detail?:{}}
 * @param {string|null} [p.freshnessAt]   ISO timestamp the underlying data was last written
 * @param {object} [p.codeVersion]        override (tests); defaults to resolveCodeVersion()
 * @param {object} [p.extra]              free-form additional context (e.g. run_id, thresholds)
 */
export function buildMetricEnvelope({
  window,
  population,
  evaluated = null,
  unevaluated = null,
  sampleSize,
  providerHealth = null,
  freshnessAt = null,
  codeVersion = null,
  extra = null,
} = {}) {
  const w = window && typeof window === 'object' ? window : {}
  const pop = population && typeof population === 'object' ? population : {}
  const ev = num(evaluated)
  const un = num(unevaluated)
  return {
    metric_envelope_version: 1,
    measurement_window: {
      kind: w.kind || 'unknown',
      start: w.start ?? null,
      end: w.end ?? null,
      days: num(w.days),
      label: w.label ?? null,
    },
    evaluated_population: {
      kind: pop.kind || 'unknown',
      description: pop.description || null,
      selector: pop.selector ?? null,
    },
    evaluated_count: ev,
    unevaluated_count: un,
    sample_size: num(sampleSize) ?? ev,
    code_version: codeVersion && typeof codeVersion === 'object' ? codeVersion : resolveCodeVersion(),
    provider_health: providerHealth && typeof providerHealth === 'object' ? providerHealth : { status: 'unknown' },
    freshness_at: freshnessAt ?? null,
    ...(extra && typeof extra === 'object' ? { context: extra } : {}),
  }
}

/**
 * A point-in-time metric may NOT close a rolling-window regression. This is
 * the one predicate a report or a Sam check should call before it treats a
 * green number as resolving a red one.
 */
export function canCloseRegression(candidate, regression) {
  const c = candidate?.measurement_window
  const r = regression?.measurement_window
  const cp = candidate?.evaluated_population
  const rp = regression?.evaluated_population
  if (!c || !r || !cp || !rp) return { ok: false, reason: 'missing_envelope' }
  if (cp.kind !== rp.kind) return { ok: false, reason: 'different_population' }
  if (r.kind === 'rolling_days' && c.kind !== 'rolling_days') return { ok: false, reason: 'point_in_time_cannot_close_window' }
  if (r.kind === 'rolling_days' && c.kind === 'rolling_days' && num(c.days) !== null && num(r.days) !== null && num(c.days) < num(r.days)) {
    return { ok: false, reason: 'shorter_window' }
  }
  if (num(candidate.sample_size) !== null && num(regression.sample_size) !== null && num(candidate.sample_size) < Math.min(20, num(regression.sample_size))) {
    return { ok: false, reason: 'insufficient_sample' }
  }
  return { ok: true, reason: null }
}

export default { buildMetricEnvelope, resolveCodeVersion, canCloseRegression }
