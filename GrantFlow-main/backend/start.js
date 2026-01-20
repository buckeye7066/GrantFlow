import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Load .env from the current working directory. Use override so .env wins over any stale
// machine-level values during local development.
dotenv.config({ override: true })

function isTruthy(value) {
  const v = String(value || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on'
}

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

function runMigrationsInBackground() {
  // IMPORTANT:
  // - `backend/db/migrate.js` calls `process.exit()`, so we must run it as a separate process.
  // - We run this *after* env is loaded, and *without* blocking server startup so Railway
  //   doesn't kill the process for taking too long to bind the PORT.
  try {
    const migratePath = fileURLToPath(new URL('./db/migrate.js', import.meta.url))
    const child = spawn(process.execPath, [migratePath], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => {
      if (code === 0) return
      console.error(`[startup] DB migrations failed (exit ${code}). App may be degraded until fixed.`)
    })
  } catch (error) {
    console.error('[startup] Failed to start DB migrations:', error?.message || error)
  }
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

// Run migrations in background after boot so we don't block PORT binding on Railway.
runMigrationsInBackground()

// Optional one-time SQLite → Postgres data migration (runs only if RUN_SQLITE_MIGRATION=1).
// This is best-effort and stored out-of-band; remove the env var after completion.
maybeRunSqliteToPostgresMigrationInBackground()