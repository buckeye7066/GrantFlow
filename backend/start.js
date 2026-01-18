import dotenv from 'dotenv'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Load .env from the current working directory. Use override so .env wins over any stale
// machine-level values during local development.
dotenv.config({ override: true })

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

// Start server AFTER env is loaded (ESM imports are hoisted).
await import('./server.js')

// Run migrations in background after boot so we don't block PORT binding on Railway.
runMigrationsInBackground()