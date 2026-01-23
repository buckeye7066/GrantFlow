import express from 'express'
import fs from 'fs'
import { getJwtSecretOrThrow } from '../config/env.js'

async function checkDbConnectivity(db) {
  if (!db) return { ok: false, error: 'db_missing' }
  try {
    if (typeof db.healthcheck === 'function') {
      const hc = await db.healthcheck()
      if (!hc?.ok) return { ok: false, error: hc?.error || 'db_healthcheck_failed' }
    } else {
      await db.prepare('SELECT 1 as ok').get()
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

async function checkRequiredTables(db) {
  // Tables required for core authenticated flows.
  const requiredTables = [
    'users',
    'profiles',
    'organizations',
    'grants',
    'crawler_jobs',
    'user_sessions',
    'funding_opportunities',
  ]

  const missing = []
  for (const table of requiredTables) {
    try {
      await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    } catch {
      missing.push(table)
    }
  }

  if (missing.length > 0) return { ok: false, missing_tables: missing }

  // Minimal column checks required by stability requirements.
  const missingColumns = []
  try {
    await db.prepare('SELECT is_admin FROM users LIMIT 1').get()
  } catch {
    missingColumns.push('users.is_admin')
  }
  if (missingColumns.length > 0) return { ok: false, missing_columns: missingColumns }

  return { ok: true }
}

function checkUploadsDir(uploadsDir) {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'uploads_dir_unwritable',
      uploads_dir: uploadsDir,
      message: error?.message || String(error),
    }
  }
}

function checkJwtSecret(env) {
  try {
    getJwtSecretOrThrow(env || {})
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'missing_jwt_secret', message: error?.message || String(error) }
  }
}

export default function healthRouter({ db, uploadsDir, env }) {
  const router = express.Router()

  // Liveness: fast, no external dependencies.
  router.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
    })
  })

  // Readiness: checks secrets + DB connectivity + schema + uploads persistence.
  router.get('/readyz', async (_req, res) => {
    const jwt = checkJwtSecret(env)
    if (!jwt.ok) {
      return res.status(503).json({
        status: 'not_ready',
        reason: jwt.reason,
        message: jwt.message,
        timestamp: new Date().toISOString(),
      })
    }

    const dbCheck = await checkDbConnectivity(db)
    if (!dbCheck.ok) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'database_unreachable',
        message: dbCheck.error,
        timestamp: new Date().toISOString(),
      })
    }

    const tables = await checkRequiredTables(db)
    if (!tables.ok) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'schema_incomplete',
        ...tables,
        timestamp: new Date().toISOString(),
      })
    }

    const uploads = checkUploadsDir(uploadsDir)
    if (!uploads.ok) {
      return res.status(503).json({
        status: 'not_ready',
        ...uploads,
        timestamp: new Date().toISOString(),
      })
    }

    return res.status(200).json({
      status: 'ready',
      dialect: db?.dialect ?? null,
      timestamp: new Date().toISOString(),
    })
  })

  return router
}

