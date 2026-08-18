import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getSafeHealthSummary } from '../services/diagnosticsService.js'
import { ensureAdmin } from '../middleware/auth.js'
import { getImportValidationResult } from '../startup/validateImports.js'
import { ensureUploadsDirWritable, isLikelyPersistentPath } from '../utils/uploadsDir.js'
import { getDataReadiness, getSystemAlerts } from '../services/dataReadinessService.js'
import { getPipelineHealth } from '../middleware/pipelineMonitor.js'
import { MATCHER_VERSION } from '../services/matchEngine.js'
import { RELEVANCE_RULES } from '../services/relevanceFilterRules.js'
import { buildMissionHealth } from '../services/missionHealthService.js'
import { looksUnsafeJwtSecret } from '../config/env.js'
import { BOOT_ID } from '../config/bootId.js'
import { TASK_STATUSES } from '../services/hamilton/applicationTaskStore.js'
import { getOperationalMetricsSnapshot } from '../services/operationalMetrics.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:health')

const router = express.Router()

// Operational-detail endpoints (mission gate, alerts, data readiness,
// deployment identity, storage paths, import validation) leak catalog counts,
// funnel numbers, commit SHAs and filesystem detail — they are mounted BEHIND
// the identity middleware + admin gate in server.js (epic slice 9: the early
// public mount exposed them unauthenticated). /healthz, /readyz and the basic
// /api/health probe stay public for load balancers and uptime checks.
export const sensitiveHealthRouter = express.Router()
const sensitiveRouter = sensitiveHealthRouter
// The server mounts this router behind ensureAuth. Everything except
// /mission additionally requires ADMIN — /mission stays authenticated-only
// because the production-audit account is non-admin BY CONTRACT
// (scripts/production-audit/app-audit.mjs asserts audit_account_must_be_non_admin)
// and reads it as its status probe.
sensitiveRouter.use((req, res, next) => {
  if (req.path === '/mission') return next()
  return ensureAdmin(req, res, next)
})

const MISSION_READINESS_CACHE_MS = Math.max(5_000, Number(process.env.MISSION_READINESS_CACHE_MS) || 30_000)
let missionReadinessCache = { at: 0, db: null, payload: null }

async function getMissionReadiness(db) {
  const now = Date.now()
  if (
    missionReadinessCache.db === db &&
    missionReadinessCache.payload &&
    now - missionReadinessCache.at < MISSION_READINESS_CACHE_MS
  ) return missionReadinessCache.payload

  const payload = await buildMissionHealth(db)
  missionReadinessCache = { at: now, db, payload }
  return payload
}

function publicFailure(code, timestampKey = 'timestamp') {
  return {
    ok: false,
    status: 'error',
    error_code: code,
    details_redacted: true,
    [timestampKey]: new Date().toISOString(),
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Read package version once at startup (cached) to avoid per-request file system access.
let _cachedPkgVersion = null
try {
  const pkgPath = path.resolve(__dirname, '../../package.json')
  const rawPkg = fs.readFileSync(pkgPath, 'utf8')
  let parsedPkg
  try {
    parsedPkg = JSON.parse(rawPkg)
  } catch (parseError) {
    console.warn('Failed to parse package.json:', parseError.message)
    parsedPkg = {}
  }
  _cachedPkgVersion = parsedPkg.version || null
} catch (error) {
  console.warn('Failed to load package.json version:', error.message)
  _cachedPkgVersion = 'unknown'
}

function getBuildInfo() {
  const commit =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null

  return {
    version: _cachedPkgVersion,
    commit_sha: commit ? String(commit) : null,
    node_env: process.env.NODE_ENV ? String(process.env.NODE_ENV) : null,
    runtime: process.env.RAILWAY_ENVIRONMENT ? 'railway' : process.env.VERCEL ? 'vercel' : null,
  }
}

async function checkDb(db) {
  if (!db) return { ok: false, reason: 'db_missing' }
  try {
    if (typeof db.healthcheck === 'function') {
      const hc = await db.healthcheck()
      if (!hc?.ok) return { ok: false, reason: 'db_healthcheck_failed', error: hc?.error || null }
    } else {
      await db.prepare('SELECT 1 as ok').get()
    }
    return { ok: true, dialect: db.dialect ?? null }
  } catch (error) {
    return { ok: false, reason: 'db_unreachable', error: error?.message || String(error) }
  }
}

function checkJwtSecret() {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  const secret = String(process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || '').trim()
  if (!isProd) return { ok: true, configured: Boolean(secret) }
  if (!secret) return { ok: false, reason: 'missing_auth_jwt_secret' }
  // Use the canonical weak-secret detector (config/env.js) so /readyz agrees with
  // the boot-time gate rather than only catching the single legacy literal.
  if (looksUnsafeJwtSecret(secret)) return { ok: false, reason: 'insecure_auth_jwt_secret' }
  return { ok: true, configured: true }
}

function redactFilesystemError(error) {
  const raw = String(error || '').trim()
  if (!raw) return null
  if (/ENOSPC|no space/i.test(raw)) return 'no_space_left'
  if (/EROFS|read-only/i.test(raw)) return 'read_only_filesystem'
  if (/EACCES|EPERM|permission/i.test(raw)) return 'permission_denied'
  if (/ENOENT|not found|no such file/i.test(raw)) return 'path_missing_or_unavailable'
  return 'upload_storage_unavailable'
}

function checkUploadSecurityPolicy() {
  const scannerConfigured = Boolean(String(process.env.CLAMAV_HOST || '').trim())
  const scannerRequired = /^(1|true|yes|on)$/i.test(String(process.env.CLAMAV_REQUIRED || '').trim())
  if (scannerRequired && !scannerConfigured) {
    return {
      ok: false,
      reason: 'malware_scanner_required_but_unconfigured',
      scanner_configured: false,
      scanner_required: true,
    }
  }
  return {
    ok: true,
    content_type_verification: true,
    scanner_configured: scannerConfigured,
    scanner_required: scannerRequired,
  }
}

async function checkRequiredSchema(db) {
  const required = [
    { table: 'users', column: 'is_admin' },
    { table: 'crawler_jobs', column: 'idempotency_key' },
    { table: 'crawler_jobs', column: 'dispatch_attempts' },
    { table: 'crawler_jobs', column: 'next_dispatch_at' },
    { table: 'crawler_jobs', column: 'profile_context_snapshot' },
    { table: 'dead_letter_queue', column: 'job_id' },
    { table: 'anya_runs', column: 'status' },
    { table: 'anya_run_logs', column: 'run_id' },
    { table: 'funding_opportunities', column: 'current_status' },
    { table: 'opportunity_change_history', column: 'changed_fields' },
    { table: 'profile_memory_entries', column: 'current_revision' },
    { table: 'profile_memory_revisions', column: 'payload_redacted' },
    { table: 'grant_transactions', column: 'source_object_id' },
    { table: 'opportunity_solicitations', column: 'opportunity_id' },
    { table: 'solicitation_versions', column: 'source_sha256' },
    { table: 'solicitation_requirements', column: 'normalized_value_json' },
    { table: 'application_lifecycle_subjects', column: 'canonical_task_id' },
    { table: 'draft_requirement_coverage', column: 'coverage_status' },
    { table: 'application_outcome_evidence', column: 'evidence_sha256' },
    { table: 'api_rate_limit_buckets', column: 'hit_count' },
  ]

  try {
    for (const item of required) {
      if (db?.dialect === 'postgres') {
        const row = await db
          .prepare(
            `
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = ?
                AND column_name = ?
              LIMIT 1
            `,
          )
          .get(item.table, item.column)
        if (!row) return { ok: false, reason: 'missing_schema', missing: item }
      } else {
        if (!/^[a-zA-Z0-9_]+$/.test(item.table)) return { ok: false, reason: 'invalid_table_identifier', table: item.table }
        if (!/^[a-zA-Z0-9_]+$/.test(item.column)) return { ok: false, reason: 'invalid_column_identifier', column: item.column }
        const stmt = db.prepare('SELECT * FROM pragma_table_info(?)')
        const rows = await stmt.all(item.table)
        const has = (rows || []).some((r) => String(r?.name || '') === item.column)
        if (!has) return { ok: false, reason: 'missing_schema', missing: item }
      }
    }
    if (db?.dialect === 'postgres') {
      const constraint = await checkApplicationTaskStatusConstraint(db)
      if (!constraint.ok) return constraint
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'schema_check_failed', error: error?.message || String(error) }
  }
}

function extractQuotedSqlValues(definition) {
  const values = []
  const quotedLiteral = /'((?:''|[^'])*)'(?:\s*::\s*(?:text|character varying))?/gi
  for (const match of String(definition || '').matchAll(quotedLiteral)) {
    values.push(match[1].replace(/''/g, "'"))
  }
  return [...new Set(values)].sort()
}

export async function checkApplicationTaskStatusConstraint(db) {
  if (db?.dialect !== 'postgres') return { ok: true, applicable: false }

  const row = await db.prepare(`
    SELECT
      pg_get_constraintdef(c.oid) AS definition,
      c.convalidated AS validated
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'application_tasks'
      AND c.conname = 'application_tasks_status_check'
      AND c.contype = 'c'
    LIMIT 1
  `).get()

  if (!row || row.validated !== true) {
    return { ok: false, reason: 'application_task_status_constraint_invalid' }
  }

  const expected = [...TASK_STATUSES].sort()
  const actual = extractQuotedSqlValues(row.definition)
  if (
    actual.length !== expected.length
    || actual.some((status, index) => status !== expected[index])
  ) {
    return { ok: false, reason: 'application_task_status_constraint_invalid' }
  }

  return { ok: true, applicable: true }
}

export async function checkBootMigrationHealth(
  db,
  appLocals = {},
  { requireCurrentBoot = false } = {},
) {
  if (appLocals.migrate_boot_error) {
    return { ok: false, reason: 'boot_migration_failed' }
  }
  if (
    requireCurrentBoot
    &&
    appLocals.migrate_boot_attempted === false
    && appLocals.migrate_boot_complete === false
  ) {
    return { ok: false, reason: 'boot_migration_not_run' }
  }
  if (
    requireCurrentBoot
    &&
    appLocals.migrate_boot_attempted === true
    && appLocals.migrate_boot_complete !== true
  ) {
    return { ok: false, reason: 'boot_migration_incomplete' }
  }

  const localFailures = Array.isArray(appLocals.migrate_boot_failed_migrations)
    ? appLocals.migrate_boot_failed_migrations
    : []
  if (localFailures.length > 0) {
    return {
      ok: false,
      reason: 'boot_migrations_incomplete',
      failed_count: localFailures.length,
    }
  }

  try {
    const row = await db
      .prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1')
      .get('migrate_boot_failed_migrations')
    if (!row || typeof row.value !== 'string') {
      return { ok: false, reason: 'boot_migration_health_unavailable' }
    }
    const failed = JSON.parse(row.value)
    if (!Array.isArray(failed)) {
      return { ok: false, reason: 'boot_migration_health_invalid' }
    }
    if (failed.length > 0) {
      return {
        ok: false,
        reason: 'boot_migrations_incomplete',
        failed_count: failed.length,
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'boot_migration_health_unavailable' }
  }
}

async function checkUploadsDir(req) {
  const uploadsDir = req.uploadsDir
  if (!uploadsDir) return { ok: true, configured: false }

  const writable = await ensureUploadsDirWritable(uploadsDir)
  if (!writable.ok) {
    return { ok: false, reason: 'uploads_unwritable', configured: true, error: redactFilesystemError(writable.error) || 'unwritable' }
  }

  return { ok: true, configured: true }
}

// Public health summary (safe, non-admin)
router.get('/api/health', async (req, res) => {
  try {
    const healthSummary = await getSafeHealthSummary(req.db)
    const rawStatus = String(healthSummary?.status ?? 'error').toLowerCase()
    const status =
      rawStatus === 'healthy'
        ? 'ok'
        : rawStatus === 'degraded'
          ? 'warning'
          : rawStatus === 'unhealthy'
            ? 'error'
            : rawStatus || 'error'

    const statusCode = status === 'error' ? 500 : 200
    const body =
      rawStatus === status
        ? healthSummary
        : { ...healthSummary, status, legacy_status: rawStatus }
    const slo = getOperationalMetricsSnapshot()

    return res.status(statusCode).json({
      ...body,
      build: getBuildInfo(),
      slo: {
        status: slo.overall.status,
        requests: slo.overall.requests,
        availability: slo.overall.availability,
        latency_p95_ms: slo.overall.latency_p95_ms,
        window_ms: slo.window_ms,
      },
    })
  } catch (error) {
    routeLogger.error('public health summary failed', { error: error?.message || String(error) })
    return res.status(500).json({
      ...publicFailure('health_summary_failed'),
      summary: 'Failed to retrieve health information',
    })
  }
})

// Liveness probe + schema-bootstrap gate.
//
// Returns 503 when the boot-time schema apply silently failed or any
// required base table is missing. This is the single signal smoke-mode
// integration tests (e.g. tests/unit/auth-access-check.test.mjs) check
// before opening their own better-sqlite3 connection — without it,
// /healthz would return 200 against a half-bootstrapped DB and the test
// would race "INSERT INTO users" against a missing table.
//
// Mission rule: "Counts displayed in the UI must map 1:1 to backend
// response fields" — same principle for liveness: the body must reflect
// the actual boot state, not just "we're listening".
router.get('/healthz', (req, res) => {
  const locals = req.app?.locals || {}
  const schemaBootstrapFailed = Boolean(locals.schema_bootstrap_failed)
  const dbStartupError = locals.db_startup_error || null
  const missingTables = Array.isArray(locals.schema_bootstrap_missing_tables)
    ? locals.schema_bootstrap_missing_tables
    : []

  if (schemaBootstrapFailed || dbStartupError) {
    return res.status(503).json({
      ok: false,
      status: 'degraded',
      reason: schemaBootstrapFailed ? 'schema_bootstrap_failed' : 'db_startup_error',
      schema_bootstrap_failed: schemaBootstrapFailed,
      missing_table_count: missingTables.length,
      details_redacted: true,
      timestamp: new Date().toISOString(),
    })
  }

  res.status(200).json({
    ok: true,
    status: 'ok',
    schema_bootstrap_failed: false,
    timestamp: new Date().toISOString(),
  })
})

// Storage health (safe, read-only)
sensitiveRouter.get('/storage', async (req, res) => {
  const uploadsDir = req.uploadsDir || null
  const configured = Boolean(uploadsDir)
  const likelyPersistent = uploadsDir ? isLikelyPersistentPath(uploadsDir) : false
  const writableCheck = uploadsDir ? await ensureUploadsDirWritable(uploadsDir) : { ok: false, error: 'uploads_not_configured' }

  let fileCount = null
  const includeCount = String(req.query?.include_count || '').toLowerCase() === 'true'
  if (includeCount && uploadsDir) {
    try {
      const entries = await fs.promises.readdir(uploadsDir)
      fileCount = Array.isArray(entries) ? entries.length : null
    } catch {
      fileCount = null
    }
  }

  const ok = Boolean(writableCheck?.ok)
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  const allowEphemeral = String(process.env.ALLOW_EPHEMERAL_UPLOADS || '').toLowerCase() === 'true'
  const missingEnv = isProd && !String(process.env.UPLOADS_DIR || '').trim()

  const degraded = !ok || (isProd && (!likelyPersistent || missingEnv) && !allowEphemeral)
  const uploadSecurity = checkUploadSecurityPolicy()
  const unavailable = degraded || !uploadSecurity.ok

  return res.status(unavailable ? 503 : 200).json({
    ok: !unavailable,
    status: unavailable ? 'degraded' : 'ok',
    configured,
    writable: ok,
    likely_persistent: likelyPersistent,
    missing_uploads_dir_env: missingEnv,
    allow_ephemeral_uploads: allowEphemeral,
    file_count: fileCount,
    last_error: ok ? null : (redactFilesystemError(writableCheck?.error) || null),
    upload_security: uploadSecurity,
    details_redacted: true,
    timestamp: new Date().toISOString(),
  })
})

// Readiness checks DB + schema + secrets + uploads volume
router.get('/readyz', async (req, res) => {
  const jwt = checkJwtSecret()
  const dbCheck = await checkDb(req.db)

  if (!dbCheck.ok) {
    return res.status(503).json({
      ok: false,
      status: 'not_ready',
      reason: dbCheck.reason,
      details_redacted: true,
      timestamp: new Date().toISOString(),
    })
  }

  const migrations = await checkBootMigrationHealth(
    req.db,
    req.app?.locals || {},
    { requireCurrentBoot: String(process.env.NODE_ENV || '').toLowerCase() === 'production' },
  )
  if (!migrations.ok) {
    return res.status(503).json({
      ok: false,
      status: 'not_ready',
      reason: migrations.reason,
      failed_migration_count: migrations.failed_count ?? null,
      details_redacted: true,
      timestamp: new Date().toISOString(),
    })
  }

  const schema = await checkRequiredSchema(req.db)
  if (!schema.ok) {
    return res.status(503).json({
      ok: false,
      status: 'not_ready',
      reason: schema.reason,
      missing: schema.missing || null,
      details_redacted: true,
      timestamp: new Date().toISOString(),
    })
  }

  if (!jwt.ok) {
    return res.status(503).json({
      ok: false,
      status: 'not_ready',
      reason: jwt.reason,
      timestamp: new Date().toISOString(),
    })
  }

  const uploads = await checkUploadsDir(req)
  if (!uploads.ok) {
    return res.status(503).json({
      ok: false,
      status: 'not_ready',
      reason: uploads.reason,
      uploads_configured: uploads.configured ?? null,
      error_code: uploads.error || null,
      details_redacted: true,
      timestamp: new Date().toISOString(),
    })
  }

  const uploadSecurity = checkUploadSecurityPolicy()
  if (!uploadSecurity.ok) {
    return res.status(503).json({
      ok: false,
      status: 'not_ready',
      reason: uploadSecurity.reason,
      scanner_required: uploadSecurity.scanner_required,
      scanner_configured: uploadSecurity.scanner_configured,
      details_redacted: true,
      timestamp: new Date().toISOString(),
    })
  }

  const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  const skipMissionGate =
    String(process.env.GRANTFLOW_SKIP_MISSION_GATE || '').toLowerCase() === 'true' ||
    String(process.env.NODE_ENV || '').toLowerCase() === 'test'

  if (isProduction && !skipMissionGate) {
    const mission = await getMissionReadiness(req.db)
    if (mission?.production_gate !== true) {
      return res.status(503).json({
        ok: false,
        status: 'not_ready',
        reason: 'mission_gate_failed',
        release_blockers: Array.isArray(mission?.release_blockers)
          ? mission.release_blockers.map((item) => item?.code).filter(Boolean)
          : ['mission_gate_unavailable'],
        details_redacted: true,
        timestamp: new Date().toISOString(),
      })
    }
  }

  const pipeline = getPipelineHealth()
  const slo = getOperationalMetricsSnapshot()

  return res.status(200).json({
    ok: true,
    status: 'ready',
    dialect: dbCheck.dialect ?? null,
    pipeline_status: pipeline.overall,
    slo_status: slo.overall.status,
    upload_security: uploadSecurity,
    mission_gate: isProduction && !skipMissionGate ? 'passed' : 'not_enforced',
    timestamp: new Date().toISOString(),
  })
})

// Data readiness: is the funding_opportunities catalog populated and fresh?
sensitiveRouter.get('/data-readiness', async (req, res) => {
  try {
    const readiness = await getDataReadiness(req.db)
    const statusCode = readiness.status === 'ready' ? 200 : 503
    return res.status(statusCode).json({
      ...readiness,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      status: 'error',
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    })
  }
})

// Alerts: surface operational issues (stuck jobs, empty catalog, crawler errors, etc.)
sensitiveRouter.get('/alerts', async (req, res) => {
  try {
    const { alerts, healthy } = await getSystemAlerts(req.db)
    return res.status(healthy ? 200 : 503).json({
      ok: healthy,
      alerts,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      alerts: [{ code: 'internal_error', severity: 'critical', message: error?.message || String(error) }],
      timestamp: new Date().toISOString(),
    })
  }
})

// Deployment verification: shows what code version is actually running
sensitiveRouter.get('/deployment', (_req, res) => {
  res.json({
    version: process.env.npm_package_version || _cachedPkgVersion || 'unknown',
    commit: process.env.GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'unknown',
    branch: process.env.GIT_BRANCH || process.env.RAILWAY_GIT_BRANCH || 'unknown',
    deployedAt: process.env.DEPLOY_TIMESTAMP || 'unknown',
    uptime: process.uptime(),
    // Minted once per process (config/bootId.js). The production-audit bridge
    // compares this against the boot_id inside system_kv.automation_posture to
    // prove that posture row was written by THIS process, not a prior deploy
    // with different flags. Not a secret and not a credential — a random id
    // whose only meaning is "same process or not".
    bootId: BOOT_ID,
    nodeVersion: process.version,
    matcherVersion: MATCHER_VERSION,
    relevanceFilterRuleCount: RELEVANCE_RULES.length,
    timestamp: new Date().toISOString(),
  })
})

// Mission-level production health dashboard (Phase 10).
// Exposes the metrics that map directly to the mission goals: verified
// opportunity count + percentage, broken links, directories, placeholder
// rows, verification events in the last 24h, coverage by source, and the
// application funnel by status. Returns 503 when ok=false (mission rule:
// CI fails if placeholders inserted, etc.).
sensitiveRouter.get('/mission', async (req, res) => {
  try {
    const payload = await getMissionReadiness(req.db)
    const code = payload?.ok === false || payload?.production_gate === false ? 503 : 200
    return res.status(code).json(payload)
  } catch (err) {
    routeLogger.error('mission health failed', { err: err?.message })
    return res.status(500).json(publicFailure('mission_health_failed', 'generated_at'))
  }
})

// Import validation: surfaces modules that failed to load at startup
sensitiveRouter.get('/imports', (_req, res) => {
  const result = getImportValidationResult()
  if (!result) {
    return res.status(503).json({
      ok: false,
      status: 'pending',
      message: 'Import validation has not run yet',
      timestamp: new Date().toISOString(),
    })
  }
  const statusCode = result.ok ? 200 : 503
  return res.status(statusCode).json({
    ...result,
    timestamp: new Date().toISOString(),
  })
})

export default router
