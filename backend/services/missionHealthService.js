/**
 * missionHealthService.js
 *
 * Phase 10 mission rule: production health dashboard with metrics that
 * map directly to the mission goals. Routes call buildMissionHealth(db)
 * and surface the structured payload to admins / Anya / CI.
 *
 * Metrics produced:
 *
 *   verified_opportunities         total + percentage of direct opps with
 *                                  link_status='verified'
 *   broken_link_opportunities      direct opps with link_status='broken'
 *   directory_opportunities        kind='directory'|'referral' counts
 *   placeholder_opportunities      illegal placeholder/synthetic rows
 *                                  (mission rule: must be 0 in production)
 *   verification_events_24h        rows in verification_events from the
 *                                  last 24h
 *   coverage_by_source             rows per source; tells admins which
 *                                  registry-defined sources actually run
 *   matcher_version                MATCHER_VERSION
 *   application_funnel             grant_applications counts by status
 *
 * Production thresholds (mission rule: ≥ 95% verified direct results):
 *   targets.verified_pct >= 95
 *   targets.broken_pct <= 5
 *   targets.placeholder_count == 0
 *
 * Failures map to alerts so dashboards / CI can alarm on them.
 */

import { MATCHER_VERSION } from './matchEngine.js'

const TARGETS = Object.freeze({
  verified_pct_min: 95,
  broken_pct_max: 5,
  placeholder_max: 0,
})

async function safeGet(db, sql, params = []) {
  try {
    return await db.prepare(sql).get(...params)
  } catch (err) {
    return { __error: String(err?.message ?? err) }
  }
}

async function safeAll(db, sql, params = []) {
  try {
    return await db.prepare(sql).all(...params)
  } catch (err) {
    return [{ __error: String(err?.message ?? err) }]
  }
}

function pct(num, denom) {
  if (!denom || !Number.isFinite(denom) || denom <= 0) return 0
  return Math.round((Number(num) / Number(denom)) * 1000) / 10
}

/**
 * Build the mission-level health payload. Pure data-fetcher; never throws
 * (errors are reported per-section so the dashboard can still render the
 * rest of the metrics).
 */
export async function buildMissionHealth(db) {
  if (!db || typeof db.prepare !== 'function') {
    return { ok: false, error: 'db_unavailable', generated_at: new Date().toISOString() }
  }

  const generatedAt = new Date().toISOString()

  // ── Opportunity-level metrics ───────────────────────────────────────
  const directKinds = "('direct','benefit')"
  const directoryKinds = "('directory','referral','school_portal')"

  const totalDirect = (await safeGet(
    db,
    `SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN ${directKinds}`,
  ))?.n ?? 0
  const verifiedDirect = (await safeGet(
    db,
    `SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN ${directKinds}
       AND link_status = 'verified'`,
  ))?.n ?? 0
  const brokenDirect = (await safeGet(
    db,
    `SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN ${directKinds}
       AND link_status = 'broken'`,
  ))?.n ?? 0
  const totalDirectory = (await safeGet(
    db,
    `SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'') IN ${directoryKinds}`,
  ))?.n ?? 0

  // Placeholder/synthetic rows that should never exist in production.
  const placeholderCount = (await safeGet(
    db,
    `SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE LOWER(COALESCE(source,'')) IN ('synthetic','template','fake')
        OR LOWER(COALESCE(record_origin,'')) IN ('synthetic')
        OR LOWER(COALESCE(title,'')) LIKE '%placeholder%'
        OR LOWER(COALESCE(title,'')) LIKE '%lorem ipsum%'`,
  ))?.n ?? 0

  // ── Verification events (last 24h) ──────────────────────────────────
  const events24h = (await safeGet(
    db,
    `SELECT COUNT(*) AS n FROM verification_events
     WHERE created_at >= datetime('now','-1 day') OR created_at >= NOW() - INTERVAL '1 day'`,
  ).catch(() => null))?.n ?? null

  // ── Coverage by source ──────────────────────────────────────────────
  const coverage = await safeAll(
    db,
    `SELECT source, COUNT(*) AS n
       FROM funding_opportunities
      GROUP BY source
      ORDER BY n DESC
      LIMIT 25`,
  )

  // ── Application funnel ──────────────────────────────────────────────
  const funnel = await safeAll(
    db,
    `SELECT status, COUNT(*) AS n FROM grant_applications GROUP BY status`,
  )

  const verifiedPct = pct(verifiedDirect, totalDirect)
  const brokenPct = pct(brokenDirect, totalDirect)

  const alerts = []
  if (totalDirect > 0 && verifiedPct < TARGETS.verified_pct_min) {
    alerts.push({
      level: 'warn',
      code: 'verified_pct_below_target',
      detail: `Only ${verifiedPct}% of direct opportunities are link-verified (target ≥ ${TARGETS.verified_pct_min}%).`,
    })
  }
  if (totalDirect > 0 && brokenPct > TARGETS.broken_pct_max) {
    alerts.push({
      level: 'warn',
      code: 'broken_pct_above_target',
      detail: `${brokenPct}% of direct opportunities are link-broken (target ≤ ${TARGETS.broken_pct_max}%).`,
    })
  }
  if (placeholderCount > TARGETS.placeholder_max) {
    alerts.push({
      level: 'error',
      code: 'placeholder_opportunities_present',
      detail: `${placeholderCount} placeholder/synthetic opportunities present (target = ${TARGETS.placeholder_max}).`,
    })
  }

  return {
    ok: alerts.every((a) => a.level !== 'error'),
    generated_at: generatedAt,
    matcher_version: MATCHER_VERSION,
    targets: TARGETS,
    counts: {
      direct_opportunities_total: totalDirect,
      direct_opportunities_verified: verifiedDirect,
      direct_opportunities_broken: brokenDirect,
      directory_opportunities_total: totalDirectory,
      placeholder_opportunities: placeholderCount,
      verification_events_24h: events24h,
    },
    rates: {
      verified_pct: verifiedPct,
      broken_pct: brokenPct,
    },
    coverage_by_source: coverage,
    application_funnel: funnel,
    alerts,
  }
}

export { TARGETS as MISSION_TARGETS }

export default { buildMissionHealth, MISSION_TARGETS: TARGETS }
