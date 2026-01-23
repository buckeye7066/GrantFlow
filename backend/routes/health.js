import express from 'express'
import fs from 'fs'
import { getSafeHealthSummary } from '../services/diagnosticsService.js'

const router = express.Router()

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

function checkUploadsDir(req) {
  const uploadsDir = req.uploadsDir
  if (!uploadsDir) return { ok: true, configured: false }
  try {
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK)
    return { ok: true, path: uploadsDir }
  } catch (error) {
    return { ok: false, reason: 'uploads_unwritable', path: uploadsDir, error: error?.message || String(error) }
  }
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

    return res.status(statusCode).json(body)
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

  const uploads = checkUploadsDir(req)
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

export default router

