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

import { promises as fsPromises } from 'fs'
import path from 'path'
import { MATCHER_VERSION } from './matchEngine.js'
import { buildFieldUsageReport } from './profileFieldUsageRegistry.js'
import { listProfileTypes, recommendedSourcesFor, recommendStrategyFor } from './profileTypeRegistry.js'

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
 * Lightweight, dependency-free integration check.
 *
 * Given a mission "service" file (e.g. zeroResultLadder.js) and a list
 * of "consumer" files that should import it, return whether each consumer
 * actually references the service module by basename.
 *
 * Pure file-scan (no AST), so it is safe to call from a request handler:
 *   - Reads each consumer once with fs.readFile
 *   - Looks for `<basename>.js` or `<basename>'` (import statement)
 *   - Caches results in-process for 5 minutes (REPO_INTEGRATION_CACHE)
 *
 * Reports `{ consumed: bool, consumers: { path: bool, ... } }`.
 *
 * Mission rule: until a service is actually consumed, the mission goal
 * it serves can't clear 0.90, so this surface is intentionally noisy
 * when integration is missing.
 */
const REPO_ROOT = process.env.GRANTFLOW_REPO_ROOT
  ? path.resolve(process.env.GRANTFLOW_REPO_ROOT)
  : path.resolve(process.cwd())
const REPO_INTEGRATION_CACHE = new Map()
const REPO_INTEGRATION_TTL_MS = 5 * 60 * 1000

export async function detectModuleUsage(serviceFiles = [], consumerFiles = []) {
  const cacheKey = JSON.stringify({ serviceFiles, consumerFiles })
  const now = Date.now()
  const hit = REPO_INTEGRATION_CACHE.get(cacheKey)
  if (hit && now - hit.cachedAt < REPO_INTEGRATION_TTL_MS) return hit.value

  const basenames = serviceFiles.map((f) => path.basename(String(f)))
  const consumers = {}
  for (const consumer of consumerFiles) {
    const consumerFile = typeof consumer === 'string' ? consumer : consumer?.file
    const explicitMatch = typeof consumer === 'object' ? consumer?.match : null
    if (!consumerFile) continue
    try {
      const filePath = path.resolve(REPO_ROOT, consumerFile)
      const text = await fsPromises.readFile(filePath, 'utf8')
      let consumed
      if (explicitMatch) {
        consumed = text.includes(String(explicitMatch))
      } else {
        consumed = basenames.some((b) => {
          const stem = b.replace(/\.[a-z]+$/i, '')
          return text.includes(`/${stem}.`) ||
            text.includes(`/${stem}'`) ||
            text.includes(`/${stem}"`) ||
            text.includes(`'${stem}'`) ||
            text.includes(b)
        })
      }
      consumers[consumerFile] = consumed
    } catch {
      consumers[typeof consumer === 'string' ? consumer : consumer?.file ?? 'unknown'] = false
    }
  }
  const allConsumed = Object.values(consumers).length > 0 && Object.values(consumers).every(Boolean)
  const value = {
    service_files: serviceFiles,
    consumed: allConsumed,
    consumers,
  }
  REPO_INTEGRATION_CACHE.set(cacheKey, { cachedAt: now, value })
  return value
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
  // ── Phase 10 integration metrics ────────────────────────────────────
  // Surface boolean integration flags so the dashboard can show
  // "service exists ✓ + integrated ✓" at a glance, and the audit can
  // tell at a glance whether each mission service is globally consumed.
  // Each entry checks that the named mission service is consumed by every
  // expected consumer file. UI consumers are matched by either the
  // imported component name (e.g. `FundingResultCard`) or the API path
  // they call (e.g. `/api/application-workflow/`).
  const integration = {
    canonical_card: await detectModuleUsage(
      ['src/components/funding/FundingResultCard.jsx'],
      [
        { file: 'src/pages/FundingResults.jsx', match: 'FundingResultCard' },
        { file: 'src/pages/SavedGrants.jsx', match: 'FundingResultCard' },
        { file: 'src/components/discovery/SearchResults.jsx', match: 'FundingResultCard' },
      ],
    ),
    zero_result_ladder: await detectModuleUsage(
      ['backend/services/zeroResultLadder.js'],
      ['backend/routes/matching.js', 'backend/routes/discovery.js'],
    ),
    coverage_planning: await detectModuleUsage(
      ['backend/services/sourceRegistry.js'],
      ['backend/routes/realCrawlers.js'],
    ),
    application_workflow: await detectModuleUsage(
      ['backend/services/applicationWorkflow.js'],
      [
        'backend/routes/applicationWorkflow.js',
        { file: 'src/components/workflow/ApplicationWorkflowPanel.jsx', match: '/api/application-workflow/' },
        { file: 'src/pages/GrantDetail.jsx', match: 'ApplicationWorkflowPanel' },
      ],
    ),
    anya_grounding: await detectModuleUsage(
      ['backend/services/anyaToolRegistry.js'],
      [
        'backend/services/anyaOrchestrator.js',
        { file: 'backend/routes/anya.js', match: 'page_context' },
        { file: 'src/components/anya/AnyaChat.jsx', match: 'pageContextPayload' },
        { file: 'src/lib/anyaClient.js', match: 'page_context' },
      ],
    ),
  }
  const integrationsOk = Object.values(integration).every((v) => v?.consumed)
  if (!integrationsOk) {
    alerts.push({
      level: 'warn',
      code: 'mission_service_not_globally_integrated',
      detail: 'One or more mission services are not yet consumed by their target routes/pages. Run repo audit and wire them in.',
    })
  }

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

  // ── Goal 11: field-to-funding accountability ────────────────────────
  // Surface field-usage coverage and per-profile-type source coverage so
  // the dashboard can show "Field usage coverage: 100% / Unused
  // requested fields: 0 / PII query violations: 0 / Profile source
  // coverage: 100%" the way the audit asked for.
  const fieldUsage = buildFieldUsageReport()
  if (fieldUsage.unmapped_fields > 0) {
    alerts.push({
      level: 'warn',
      code: 'unmapped_profile_fields',
      detail: `${fieldUsage.unmapped_fields} profile fields are missing usage contracts (Goal 11).`,
    })
  }
  if (fieldUsage.pii_external_query_violations > 0) {
    alerts.push({
      level: 'error',
      code: 'pii_external_query_violation',
      detail: `${fieldUsage.pii_external_query_violations} PII fields are configured for external/crawler use (Goal 11 forbids this).`,
    })
  }
  if (fieldUsage.unknown_source_categories.length > 0) {
    alerts.push({
      level: 'warn',
      code: 'field_usage_references_unknown_source',
      detail: `Field-usage registry references ${fieldUsage.unknown_source_categories.length} source ids that are not in sourceRegistry: ${fieldUsage.unknown_source_categories.join(', ')}`,
    })
  }

  const profileTypesBelowMin = []
  let profileTypesWithPlan = 0
  for (const pt of listProfileTypes()) {
    const sources = recommendedSourcesFor(pt.id)
    const hasStrategy = !!recommendStrategyFor(pt.id)
    const hasMin = sources.length >= 3
    if (hasStrategy && hasMin) profileTypesWithPlan += 1
    if (!hasMin) profileTypesBelowMin.push({ id: pt.id, recommended_sources: sources.length })
  }
  if (profileTypesBelowMin.length > 0) {
    alerts.push({
      level: 'warn',
      code: 'profile_types_below_source_minimum',
      detail: `${profileTypesBelowMin.length} profile types have fewer than 3 recommended sources (Goal 11).`,
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
    integration,
    field_usage: {
      ...fieldUsage,
      profile_types_with_source_plan: profileTypesWithPlan,
      profile_types_total: listProfileTypes().length,
      profile_types_below_source_minimum: profileTypesBelowMin,
    },
    alerts,
  }
}

export { TARGETS as MISSION_TARGETS }

export default { buildMissionHealth, MISSION_TARGETS: TARGETS }
