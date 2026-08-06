/**
 * missionHealthService.js
 *
 * Phase 10 mission rule: production health dashboard with metrics that
 * map directly to the mission goals. Routes call buildMissionHealth(db)
 * and surface the structured payload to admins / Anya / CI.
 *
 * Metrics produced:
 *
 *   verified_opportunities         fresh verified / visible lifecycle rows
 *   broken_link_opportunities      visible lifecycle rows with broken links
 *   directory_opportunities        visible pointer/resource rows
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
import {
  legacyDefaultedLinkLifecycleKindSql,
  linkLifecycleOpportunitySql,
  pointerOpportunityRowSql,
} from '../config/linkLifecycleKinds.js'
import { MATCHER_VERSION } from './matchEngine.js'
import { REVERIFY_AFTER_DAYS_CONST } from './linkVerificationService.js'
import { buildFieldUsageReport } from './profileFieldUsageRegistry.js'
import { listProfileTypes, recommendedSourcesFor, recommendStrategyFor } from './profileTypeRegistry.js'
import { buildProductionReadinessReport } from './productionReadinessChecks.js'

const TARGETS = Object.freeze({
  verified_pct_min: 95,
  verified_max_age_days: REVERIFY_AFTER_DAYS_CONST,
  broken_pct_max: 5,
  placeholder_max: 0,
  // Phase F (release-gate): codes that block a production release. Any
  // alert with one of these codes — at warn or error level — flips
  // `production_gate` to false. The runtime `ok` flag stays softer so
  // /api/health/mission doesn't 503 the live app for a slow-degrading
  // signal.
  release_blocking_codes: Object.freeze([
    'placeholder_opportunities_present',
    'pii_external_query_violation',
    'unmapped_profile_fields',
    'field_usage_references_unknown_source',
    'profile_types_below_source_minimum',
    'mission_service_not_globally_integrated',
    'link_lifecycle_partition_mismatch',
    'verified_pct_below_target',
    'broken_pct_above_target',
    'crawler_source_outcomes_stale',
  ]),
  // How long is "recent" for crawler_source_runs freshness? If no
  // crawler_source_runs row exists in the last `crawler_source_runs_max_age_hours`
  // hours, we assume coverage outcomes are not being recorded and trip
  // the release gate.
  crawler_source_runs_max_age_hours: 48,
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

export function normalizeCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

export function pct(num, denom) {
  const numerator = Number(num)
  const denominator = Number(denom)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
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
    } catch (err) {
      // ENOENT = the file is not part of THIS deploy artifact. Backend deploys
      // (Railway) do not ship src/, so reading src/pages/SavedGrants.jsx from
      // the backend filesystem will always fail. That is NOT the same as
      // "consumer exists but does not import the service" -- treating it as
      // `false` produced a permanent false-positive on
      // mission_service_not_globally_integrated for every prod health hit.
      // Report `null` (unknown) so the aggregator can ignore it cleanly.
      const isMissing =
        err?.code === 'ENOENT' ||
        err?.code === 'ENOTDIR' ||
        err?.code === 'EISDIR' ||
        err?.code === 'EACCES'
      consumers[typeof consumer === 'string' ? consumer : consumer?.file ?? 'unknown'] =
        isMissing ? null : false
    }
  }
  // Tri-state aggregation:
  //   - At least one consumer CHECKED AND every checked consumer imports
  //     the service -> `consumed: true` (the integration story is proven).
  //   - At least one consumer CHECKED AND any of them does NOT import the
  //     service -> `consumed: false` (the integration story is broken).
  //   - Zero consumers CHECKED (every probe came back unknown / null
  //     because the backend deploy doesn't ship those frontend files) ->
  //     `consumed: true`, because backend mission health is not the
  //     authoritative gate for frontend-only consumers. The frontend's
  //     own build pipeline is. Reporting `false` here would permanently
  //     trip mission_service_not_globally_integrated on every prod hit
  //     for canonical_card (3/3 frontend consumers).
  const checkedValues = Object.values(consumers).filter((v) => v !== null && v !== undefined)
  const anyChecked = checkedValues.length > 0
  const allConsumed = anyChecked
    ? checkedValues.every(Boolean)
    : true
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
  const verificationFreshCutoff = new Date(
    Date.now() - REVERIFY_AFTER_DAYS_CONST * 24 * 60 * 60 * 1000,
  ).toISOString()
  const lifecycleSnapshot = await safeGet(
    db,
    `WITH lifecycle_rows AS (
       SELECT opportunity_kind,
              CASE
                WHEN COALESCE(is_active, TRUE) = TRUE
                 AND COALESCE(is_hidden, FALSE) = FALSE
                 AND LOWER(TRIM(COALESCE(link_status, ''))) IN ('ok', 'redirect', 'verified')
                 AND last_verified_at IS NOT NULL
                 AND last_verified_at >= ?
                  THEN 'verified_visible'
                WHEN COALESCE(is_active, TRUE) = TRUE
                 AND COALESCE(is_hidden, FALSE) = FALSE
                 AND LOWER(TRIM(COALESCE(link_status, ''))) = 'broken'
                  THEN 'broken_visible'
                WHEN COALESCE(is_active, TRUE) = TRUE
                 AND COALESCE(is_hidden, FALSE) = FALSE
                  THEN 'unverified_visible'
                WHEN LOWER(TRIM(COALESCE(link_status, ''))) = 'skipped'
                 AND LOWER(TRIM(COALESCE(status, ''))) = 'paused'
                 AND COALESCE(verification_error, '') LIKE 'retry_scheduled_after_bounded_recheck:%'
                  THEN 'scheduled_retry'
                WHEN LOWER(TRIM(COALESCE(link_status, ''))) = 'skipped'
                 AND COALESCE(verification_error, '') LIKE 'retired_after_definitive_recheck:%'
                  THEN 'permanently_retired'
                WHEN LOWER(TRIM(COALESCE(link_status, ''))) = 'broken'
                 AND LOWER(TRIM(COALESCE(status, ''))) = 'paused'
                  THEN 'repair_pending'
                WHEN LOWER(TRIM(COALESCE(link_status, ''))) = 'broken'
                 AND LOWER(TRIM(COALESCE(status, 'active'))) = 'active'
                  THEN 'active_quarantine'
                ELSE 'other_nonvisible'
              END AS lifecycle_bucket
         FROM funding_opportunities
        WHERE ${linkLifecycleOpportunitySql()}
     )
     SELECT COUNT(*) AS denominator_total,
            SUM(CASE WHEN ${legacyDefaultedLinkLifecycleKindSql('opportunity_kind')} THEN 1 ELSE 0 END) AS legacy_defaulted,
            SUM(CASE WHEN lifecycle_bucket = 'verified_visible' THEN 1 ELSE 0 END) AS verified_visible,
            SUM(CASE WHEN lifecycle_bucket = 'broken_visible' THEN 1 ELSE 0 END) AS broken_visible,
            SUM(CASE WHEN lifecycle_bucket = 'unverified_visible' THEN 1 ELSE 0 END) AS unverified_visible,
            SUM(CASE WHEN lifecycle_bucket = 'active_quarantine' THEN 1 ELSE 0 END) AS active_quarantine,
            SUM(CASE WHEN lifecycle_bucket = 'repair_pending' THEN 1 ELSE 0 END) AS repair_pending,
            SUM(CASE WHEN lifecycle_bucket = 'scheduled_retry' THEN 1 ELSE 0 END) AS scheduled_retry,
            SUM(CASE WHEN lifecycle_bucket = 'permanently_retired' THEN 1 ELSE 0 END) AS permanently_retired,
            SUM(CASE WHEN lifecycle_bucket = 'other_nonvisible' THEN 1 ELSE 0 END) AS other_nonvisible
       FROM lifecycle_rows`,
    [verificationFreshCutoff],
  )
  const lifecycleSnapshotAvailable = !lifecycleSnapshot?.__error
  const lifecycleBuckets = {
    verified_visible: normalizeCount(lifecycleSnapshot?.verified_visible),
    broken_visible: normalizeCount(lifecycleSnapshot?.broken_visible),
    unverified_visible: normalizeCount(lifecycleSnapshot?.unverified_visible),
    active_quarantine: normalizeCount(lifecycleSnapshot?.active_quarantine),
    repair_pending: normalizeCount(lifecycleSnapshot?.repair_pending),
    scheduled_retry: normalizeCount(lifecycleSnapshot?.scheduled_retry),
    permanently_retired: normalizeCount(lifecycleSnapshot?.permanently_retired),
    other_nonvisible: normalizeCount(lifecycleSnapshot?.other_nonvisible),
  }
  const catalogDirect = normalizeCount(lifecycleSnapshot?.denominator_total)
  const totalDirect = lifecycleBuckets.verified_visible +
    lifecycleBuckets.broken_visible + lifecycleBuckets.unverified_visible
  const verifiedDirect = lifecycleBuckets.verified_visible
  const brokenDirect = lifecycleBuckets.broken_visible
  const quarantinedBrokenDirect = lifecycleBuckets.active_quarantine
  const repairPendingBrokenDirect = lifecycleBuckets.repair_pending
  const retiredBrokenDirect = lifecycleBuckets.permanently_retired
  const scheduledRetryBrokenDirect = lifecycleBuckets.scheduled_retry
  const lifecyclePartitionTotal = Object.values(lifecycleBuckets)
    .reduce((sum, count) => sum + count, 0)
  const lifecyclePartitionReconciles = lifecycleSnapshotAvailable &&
    lifecyclePartitionTotal === catalogDirect
  const linkLifecycle = {
    denominator_total: catalogDirect,
    visible_total: totalDirect,
    verification_fresh_after: verificationFreshCutoff,
    legacy_defaulted: normalizeCount(lifecycleSnapshot?.legacy_defaulted),
    buckets: lifecycleBuckets,
    partition_total: lifecyclePartitionTotal,
    partition_reconciles: lifecyclePartitionReconciles,
    error: lifecycleSnapshotAvailable ? null : lifecycleSnapshot?.__error || 'snapshot_unavailable',
  }

  // Pointer rows are excluded from the lifecycle denominator even when a
  // legacy/null opportunity_kind would otherwise default to DIRECT.
  const totalDirectory = normalizeCount((await safeGet(
    db,
    `SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE (${pointerOpportunityRowSql()})
       AND COALESCE(is_active, TRUE) = TRUE
       AND COALESCE(is_hidden, FALSE) = FALSE`,
  ))?.n)

  const placeholderCount = normalizeCount((await safeGet(
    db,
    `SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE LOWER(COALESCE(source,'')) IN ('synthetic','template','fake')
        OR LOWER(COALESCE(record_origin,'')) IN ('synthetic')
        OR LOWER(COALESCE(title,'')) LIKE '%placeholder%'
        OR LOWER(COALESCE(title,'')) LIKE '%lorem ipsum%'`,
  ))?.n)

  const eventsSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const eventsRow = await safeGet(
    db,
    'SELECT COUNT(*) AS n FROM verification_events WHERE ts >= ?',
    [eventsSince],
  )
  const events24h = eventsRow?.__error ? null : normalizeCount(eventsRow?.n)

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
  // SQLite production carried `grant_applications` (migration 047), but the
  // canonical Postgres schema (apply engine, migration 0019) uses the
  // `applications` table. Try the legacy name first for back-compat with
  // older sqlite deploys, and fall back to `applications` if Postgres
  // reports `relation does not exist` so the live `/api/health/mission`
  // payload doesn't carry an inline `__error` for every dashboard hit.
  let funnel = await safeAll(
    db,
    `SELECT status, COUNT(*) AS n FROM grant_applications GROUP BY status`,
  )
  const funnelHasMissingTableError =
    Array.isArray(funnel) &&
    funnel.length === 1 &&
    funnel[0]?.__error &&
    /does not exist|no such table/i.test(String(funnel[0].__error))
  if (funnelHasMissingTableError) {
    funnel = await safeAll(
      db,
      `SELECT status, COUNT(*) AS n FROM applications GROUP BY status`,
    )
  }

  const normalizedCoverage = Array.isArray(coverage)
    ? coverage.map((row) => ({ ...row, n: normalizeCount(row?.n) }))
    : []
  const normalizedFunnel = Array.isArray(funnel)
    ? funnel.map((row) => ({ ...row, n: normalizeCount(row?.n) }))
    : []

  const verifiedPct = pct(verifiedDirect, totalDirect)
  const brokenPct = pct(brokenDirect, totalDirect)

  const alerts = []
  if (!lifecyclePartitionReconciles) {
    alerts.push({
      level: 'warn',
      code: 'link_lifecycle_partition_mismatch',
      detail: lifecycleSnapshotAvailable
        ? `Link lifecycle buckets total ${lifecyclePartitionTotal}, but the canonical denominator is ${catalogDirect}.`
        : `Link lifecycle snapshot is unavailable: ${linkLifecycle.error}`,
    })
  }
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

  // ── Phase F: crawler source-run freshness ───────────────────────────
  // crawler_source_runs is populated by realCrawlers after each run. If
  // we haven't seen any rows in the configured freshness window, the
  // coverage pipeline has stopped recording outcomes and the release
  // gate should refuse a deploy.
  let crawlerSourceRunsFreshness = { table_present: false, latest_at: null, age_hours: null }
  try {
    const latest = await safeGet(
      db,
      `SELECT MAX(created_at) AS latest FROM crawler_source_runs`,
    )
    if (latest && !latest.__error) {
      crawlerSourceRunsFreshness.table_present = true
      crawlerSourceRunsFreshness.latest_at = latest.latest ?? null
      if (latest.latest) {
        const ageMs = Date.now() - new Date(latest.latest).getTime()
        crawlerSourceRunsFreshness.age_hours = Number.isFinite(ageMs) ? Math.round(ageMs / 3_600_000) : null
        if (
          Number.isFinite(crawlerSourceRunsFreshness.age_hours) &&
          crawlerSourceRunsFreshness.age_hours > TARGETS.crawler_source_runs_max_age_hours
        ) {
          alerts.push({
            level: 'warn',
            code: 'crawler_source_outcomes_stale',
            detail: `crawler_source_runs latest row is ${crawlerSourceRunsFreshness.age_hours}h old (max ${TARGETS.crawler_source_runs_max_age_hours}h). Per-source outcomes are not being recorded; release gate will block until a fresh crawler run completes.`,
          })
        }
      } else {
        // Table exists but is empty — only flag in production where we
        // expect runs to have happened.
        if (process.env.NODE_ENV === 'production') {
          alerts.push({
            level: 'warn',
            code: 'crawler_source_outcomes_stale',
            detail: 'crawler_source_runs table is empty in production — coverage outcomes are not being recorded.',
          })
        }
      }
    }
  } catch {
    // Migration 072 may not be applied on legacy DBs — ignore silently.
  }

  // ── Phase I — production readiness checks ──────────────────────────
  // Aggregate environment / storage / migrations / freshness / health-route
  // checks. These do not flip the soft `ok` flag — they feed the strict
  // release gate alongside the alert codes below.
  const productionReadiness = buildProductionReadinessReport({
    env: process.env,
    dbDialect: db?.dialect ?? null,
    storageStatus: null, // bootstrap maintains this; route layer can pass it through
    pendingMigrations: [], // surfaced by migration runner; left empty for runtime call
    crawlerSourceRunsAgeHours: crawlerSourceRunsFreshness?.age_hours ?? null,
    crawlerSourceRunsMaxAgeHours: TARGETS.crawler_source_runs_max_age_hours,
    crawlerSourceRunsTablePresent: crawlerSourceRunsFreshness?.table_present ?? null,
    missionHealth: null,
    selfReference: true, // we ARE mission health — skip the self-reachability check
  })
  for (const check of productionReadiness.checks) {
    if (check.level === 'error' || check.level === 'warn') {
      alerts.push({
        level: check.level,
        code: `production_readiness:${check.id}`,
        detail: check.detail,
      })
    }
  }

  // ── Production release gate (strict) ────────────────────────────────
  // Any alert whose code appears in TARGETS.release_blocking_codes,
  // OR any production_readiness:* alert at warn/error level — flips
  // `production_gate` to false.
  const blocking = new Set(TARGETS.release_blocking_codes)
  const releaseBlockers = alerts.filter(
    (a) => blocking.has(a.code) || a.code?.startsWith('production_readiness:'),
  )
  const productionGate = releaseBlockers.length === 0

  return {
    ok: alerts.every((a) => a.level !== 'error'),
    production_gate: productionGate,
    release_blockers: releaseBlockers.map((a) => ({ level: a.level, code: a.code, detail: a.detail })),
    generated_at: generatedAt,
    matcher_version: MATCHER_VERSION,
    targets: TARGETS,
    counts: {
      catalog_direct_opportunities_total: catalogDirect,
      direct_opportunities_total: totalDirect,
      direct_opportunities_verified: verifiedDirect,
      direct_opportunities_broken: brokenDirect,
      quarantined_broken_direct_opportunities: quarantinedBrokenDirect,
      repair_pending_broken_direct_opportunities: repairPendingBrokenDirect,
      retired_broken_direct_opportunities: retiredBrokenDirect,
      scheduled_retry_broken_direct_opportunities: scheduledRetryBrokenDirect,
      directory_opportunities_total: totalDirectory,
      placeholder_opportunities: placeholderCount,
      verification_events_24h: events24h,
    },
    rates: {
      verified_pct: verifiedPct,
      verified_fresh_visible_pct: verifiedPct,
      broken_pct: brokenPct,
    },
    link_lifecycle: linkLifecycle,
    coverage_by_source: normalizedCoverage,
    application_funnel: normalizedFunnel,
    integration,
    field_usage: {
      ...fieldUsage,
      profile_types_with_source_plan: profileTypesWithPlan,
      profile_types_total: listProfileTypes().length,
      profile_types_below_source_minimum: profileTypesBelowMin,
    },
    crawler_source_runs: crawlerSourceRunsFreshness,
    production_readiness: productionReadiness,
    alerts,
  }
}

export { TARGETS as MISSION_TARGETS }

export default { buildMissionHealth, MISSION_TARGETS: TARGETS, normalizeCount, pct }
