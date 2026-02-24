import express from 'express'
import fs from 'fs'
import { getSafeHealthSummary } from '../services/diagnosticsService.js'
import { ensureUploadsDirWritable, isLikelyPersistentPath } from '../utils/uploadsDir.js'
import { getDataReadiness, getSystemAlerts } from '../services/dataReadinessService.js'

const router = express.Router()

function getBuildInfo() {
  const commit =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null

  return {
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
  if (secret === 'grantflow-dev-secret') return { ok: false, reason: 'insecure_auth_jwt_secret' }
  return { ok: true, configured: true }
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
        const rows = await db.prepare(`PRAGMA table_info(${item.table})`).all()
        const has = (rows || []).some((r) => String(r?.name || '') === item.column)
        if (!has) return { ok: false, reason: 'missing_schema', missing: item }
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'schema_check_failed', error: error?.message || String(error) }
  }
}

async function checkUploadsDir(req) {
  const uploadsDir = req.uploadsDir
  if (!uploadsDir) return { ok: true, configured: false }

  const writable = await ensureUploadsDirWritable(uploadsDir)
  if (!writable.ok) {
    return { ok: false, reason: 'uploads_unwritable', path: uploadsDir, error: writable.error || 'unwritable' }
  }

  return { ok: true, path: uploadsDir }
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

    return res.status(statusCode).json({
      ...body,
      build: getBuildInfo(),
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      status: 'error',
      summary: 'Failed to retrieve health information',
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    })
  }
})

// Liveness only
router.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, status: 'ok', timestamp: new Date().toISOString() })
})

// Storage health (safe, read-only)
router.get('/api/health/storage', async (req, res) => {
  const uploadsDir = req.uploadsDir || null
  const legacyUploadsDir = req.legacyUploadsDir || null
  const configured = Boolean(uploadsDir)
  const likelyPersistent = uploadsDir ? isLikelyPersistentPath(uploadsDir) : false
  const writableCheck = uploadsDir ? await ensureUploadsDirWritable(uploadsDir) : { ok: false, error: 'uploads_not_configured' }

  const storageStatus = req.storageStatus || null

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

  return res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    status: degraded ? 'degraded' : 'ok',
    uploadsDir,
    legacyUploadsDir,
    configured,
    writable: ok,
    likely_persistent: likelyPersistent,
    missing_uploads_dir_env: missingEnv,
    allow_ephemeral_uploads: allowEphemeral,
    file_count: fileCount,
    last_error: ok ? null : (writableCheck?.error || null),
    storage_status: storageStatus,
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
      error: dbCheck.error || null,
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
      error: schema.error || null,
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
      uploads_dir: uploads.path,
      error: uploads.error || null,
      timestamp: new Date().toISOString(),
    })
  }

  return res.status(200).json({
    ok: true,
    status: 'ready',
    dialect: dbCheck.dialect ?? null,
    timestamp: new Date().toISOString(),
  })
})

// Data readiness: is the funding_opportunities catalog populated and fresh?
router.get('/api/health/data-readiness', async (req, res) => {
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
router.get('/api/health/alerts', async (req, res) => {
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

export default router

