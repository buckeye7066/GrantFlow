import './installFetchGlobals.js'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { captureException, flushObservability, initObservability } from './utils/observability.js'
import { getActiveJobsSnapshot } from './utils/activeJobTracker.js'

// Prevent unhandled promise rejections from crashing the server process.
// Background tasks (crawlers, cron jobs, health checks) may fire DB queries that reject
// when the database is temporarily unavailable. Crashing on these creates a perpetual 502
// and blocks recovery via admin endpoints. Log the error and keep the process alive.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[process] Unhandled promise rejection (server staying alive):', reason?.message || reason)
  captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    source: 'process.unhandledRejection',
    promise: String(promise),
  })
  if (reason?.stack) {
    console.error('[process] Stack:', reason.stack)
  }
})

process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught exception:', error?.stack || error?.message || error)
  captureException(error instanceof Error ? error : new Error(String(error)), {
    source: 'process.uncaughtException',
  })
  process.exitCode = 1
  const forceExit = setTimeout(() => process.exit(1), 2500)
  forceExit.unref?.()
  flushObservability(2000).finally(() => process.exit(1))
})

// Durable crash visibility (2026-09-12 investigation: an unexplained prod
// restart at 04:01Z left NO uncaughtException/unhandledRejection/OOM log line
// anywhere — the container was killed by something that never gave Node a
// chance to run a handler, e.g. a platform/OOM SIGKILL. Node cannot catch
// SIGKILL, so the 'exit' handler below only ever fires for a normal
// process.exit()/signal-handled shutdown — it is not a fix for that case, only
// a permanent record of every OTHER kind of exit. The periodic heartbeat is
// the actual forensic instrument for the SIGKILL case: it is the last thing
// that gets a chance to log before such a kill, so the next silent restart
// has a "this job had been running N ms, memory was at X MB" trail instead of
// requiring a from-scratch log reconstruction.
process.on('exit', (code) => {
  try {
    console.error(`[process] exiting: code=${code}`)
  } catch { /* stdout may already be gone during exit */ }
})

const HEARTBEAT_INTERVAL_MS = Number(process.env.PROCESS_HEARTBEAT_INTERVAL_MS || 15_000)
if (
  String(process.env.NODE_ENV || '').toLowerCase() !== 'test' &&
  Number.isFinite(HEARTBEAT_INTERVAL_MS) &&
  HEARTBEAT_INTERVAL_MS > 0
) {
  let highWaterRssBytes = 0
  const heartbeatTimer = setInterval(() => {
    try {
      const mem = process.memoryUsage()
      highWaterRssBytes = Math.max(highWaterRssBytes, mem.rss)
      const activeJobs = getActiveJobsSnapshot()
      const toMb = (bytes) => Math.round(bytes / 1048576)
      console.log('[process] heartbeat', JSON.stringify({
        rss_mb: toMb(mem.rss),
        rss_high_water_mb: toMb(highWaterRssBytes),
        heap_used_mb: toMb(mem.heapUsed),
        heap_total_mb: toMb(mem.heapTotal),
        external_mb: toMb(mem.external),
        active_jobs: activeJobs.length ? activeJobs : undefined,
      }))
    } catch { /* the heartbeat must never be able to take the process down */ }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()
}

function isTruthy(value) {
  const v = String(value || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on'
}

function isSmokeLikeRuntime() {
  const explicitSmoke = isTruthy(process.env.SMOKE_MODE)
  const inferredSmoke =
    String(process.env.PORT || '').trim() === '0' &&
    isTruthy(process.env.DB_AUTO_MIGRATE) &&
    String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production'
  return explicitSmoke || inferredSmoke
}

const shouldOverrideDotenv =
  !isTruthy(process.env.SMOKE_MODE) &&
  !(
    String(process.env.PORT || '').trim() === '0' &&
    isTruthy(process.env.DB_AUTO_MIGRATE) &&
    String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production'
  )

// Load .env from the current working directory.
//
// IMPORTANT:
// - In normal local development, we want `.env` to win over stale machine-level values.
// - In SMOKE_MODE / automation (tests), we must NOT override the env passed by the test runner
//   (especially PORT/DB paths), otherwise parallel tests can collide and hang.
dotenv.config({ override: shouldOverrideDotenv })
initObservability()

function findSqliteDbPath() {
  const explicit = String(process.env.SQLITE_DB_PATH || '').trim()
  if (explicit && fs.existsSync(explicit)) return explicit

  const candidates = [
    '/data/grantflow.db',
    '/data/grantflow.dev.db',
    '/app/data/grantflow.db',
    '/app/backend/data/grantflow.db',
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  const scanDirs = ['/data', '/app/data', '/app/backend/data']
  for (const dir of scanDirs) {
    try {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.db'))
        .map((d) => d.name)
        .sort()

      const match =
        entries.find((n) => n.toLowerCase() === 'grantflow.db') ||
        entries.find((n) => n.toLowerCase().startsWith('grantflow') && n.toLowerCase().endsWith('.db')) ||
        null

      if (match) return path.posix.join(dir, match)
    } catch {
      // directory may not exist in this runtime
    }
  }

  return null
}

function maybeRunSqliteToPostgresMigrationInBackground() {
  if (!isTruthy(process.env.RUN_SQLITE_MIGRATION)) return

  const sqlitePath = findSqliteDbPath()
  if (!sqlitePath) {
    console.error('[migrate] RUN_SQLITE_MIGRATION=1 but no SQLite DB file was found (set SQLITE_DB_PATH to override)')
    return
  }

  try {
    const scriptPath = fileURLToPath(
      new URL('./scripts/migrate-sqlite-to-postgres.mjs', import.meta.url),
    )
    console.log(`[migrate] Starting SQLite→Postgres data migration from ${sqlitePath}`)

    const assertFresh = process.env.MIGRATE_ASSERT_FRESH !== undefined ? String(process.env.MIGRATE_ASSERT_FRESH) : 'true'
    const verifyCounts = process.env.MIGRATE_VERIFY_COUNTS !== undefined ? String(process.env.MIGRATE_VERIFY_COUNTS) : 'true'

    const child = spawn(
      process.execPath,
      [scriptPath, '--sqlite', sqlitePath, '--assert-fresh', assertFresh, '--verify-counts', verifyCounts],
      {
      stdio: 'inherit',
      env: process.env,
      },
    )

    child.on('exit', (code) => {
      if (code === 0) {
        console.log('[migrate] Migration finished successfully')
        return
      }
      console.error(`[migrate] Migration failed (exit ${code})`)
    })
  } catch (error) {
    console.error('[migrate] Failed to start migration process:', error?.message || error)
  }
}

// Start server AFTER env is loaded (ESM imports are hoisted).
await import('./server.js')

// Schema migrations have exactly one owner: server.js runs the canonical
// boot-policy-controlled migration pass before readiness.

// Optional one-time SQLite → Postgres data migration (runs only if RUN_SQLITE_MIGRATION=1).
// This is best-effort and stored out-of-band; remove the env var after completion.
maybeRunSqliteToPostgresMigrationInBackground()
