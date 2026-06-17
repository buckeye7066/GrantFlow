import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitForHttpOk(url, { timeoutMs = 30_000 } = {}) {
  const start = Date.now()
  while (true) {
    const elapsed = Date.now() - start
    if (elapsed > timeoutMs) return false
    try {
      const requestTimeoutMs = Math.max(1, Math.min(1_000, timeoutMs - elapsed))
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      if (res.ok) return true
    } catch {}
    await sleep(250)
  }
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
    server.on('error', reject)
  })
}

async function stopProcess(proc) {
  if (!proc) return
  try { proc.kill('SIGTERM') } catch {}
  // Give the process a moment to exit cleanly.
  await sleep(250)
  if (proc.exitCode == null) {
    try { proc.kill('SIGKILL') } catch {}
  }
}

async function startBackend({ rootDir }) {
  // IMPORTANT:
  // Unit tests must NEVER use the repo default SQLite DB path (`backend/data/grantflow.db`),
  // or parallel test runs can hit SQLITE_BUSY "database is locked" and crash the backend.
  // Always isolate the DB per test run.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-contracts-'))
  const sqlitePath = path.join(tempDir, 'grantflow-test.db')
  const port = await reservePort()

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SMOKE_MODE: 'true',
    PORT: String(port),
    DB_PROVIDER: 'sqlite',
    SQLITE_DB_PATH: sqlitePath,
    DB_AUTO_MIGRATE: 'true',
    AUTH_JWT_SECRET: 'test-secret-contracts',
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'test-admin-token',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
    AUTH_FRONTEND_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    DISABLE_BACKGROUND_SERVICES: 'true',
    ANYA_AUTONOMOUS_ENABLED: 'false',
    ANYA_RUN_ON_STARTUP: 'false',
    ANYA_RUN_ON_SCHEDULE: 'false',
    NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
    STARTUP_SMOKE_CRAWL_ENABLED: 'false',
  }

  // IMPORTANT: Use backend/start.js so dotenv is loaded consistently before server boot.
  // Running server.js directly can miss env initialization and cause flaky health readiness.
  const proc = spawn(process.execPath, ['backend/start.js'], {
    cwd: rootDir,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdoutChunks = []
  const stderrChunks = []
  proc.stdout?.on('data', (buf) => stdoutChunks.push(String(buf)))
  proc.stderr?.on('data', (buf) => stderrChunks.push(String(buf)))
  let spawnError = null
  proc.once('error', (err) => {
    spawnError = err
  })

  const start = Date.now()
  const timeoutMs = 60_000
  while (true) {
    if (spawnError) {
      const stdout = stdoutChunks.join('')
      const stderr = stderrChunks.join('')
      throw new Error(
        `Backend failed to spawn for contract tests.\n` +
          `--- error ---\n${spawnError?.message || String(spawnError)}\n` +
          `--- stdout ---\n${stdout || '(empty)'}\n` +
          `--- stderr ---\n${stderr || '(empty)'}\n`,
      )
    }
    if (proc.exitCode != null) {
      const stdout = stdoutChunks.join('')
      const stderr = stderrChunks.join('')
      throw new Error(
        `Backend exited before becoming healthy (exit=${proc.exitCode}).\n` +
          `--- stdout ---\n${stdout || '(empty)'}\n` +
          `--- stderr ---\n${stderr || '(empty)'}\n`,
      )
    }

    if (Date.now() - start > timeoutMs) break

    try {
      const ok = await waitForHttpOk(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 2_000 })
      if (ok) return { proc, tempDir, port }
    } catch {
      // keep polling
    }

    await sleep(250)
  }

  const stdout = stdoutChunks.join('')
  const stderr = stderrChunks.join('')
  await stopProcess(proc)
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {}
  throw new Error(
    `Backend did not become healthy for contract tests within ${timeoutMs}ms.\n` +
      `--- stdout ---\n${stdout || '(empty)'}\n` +
      `--- stderr ---\n${stderr || '(empty)'}\n`,
  )
}

test('backend /api/health contract + request id header', async () => {
  // Derive repo root from this test file location (more robust than process.cwd()).
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

  const entry = path.join(rootDir, 'backend', 'start.js')
  assert.ok(fs.existsSync(entry), `expected backend entry to exist at ${entry}`)

  const started = await startBackend({ rootDir })
  const proc = started.proc
  try {
    assert.ok(Number.isFinite(started.port) && started.port > 0, `expected backend to pick a real port, got ${started.port}`)
    const res = await fetch(`http://127.0.0.1:${started.port}/api/health`)
    assert.equal(res.ok, true)

    const requestId = res.headers.get('x-request-id')
    assert.ok(requestId, 'expected X-Request-Id header to be present')

    const body = await res.json()
    assert.equal(typeof body, 'object')

    // Backward-compatible: some deployments may still return legacy statuses.
    // Canonical statuses are: ok|warning|error.
    const allowedStatuses = new Set(['ok', 'warning', 'healthy', 'degraded'])
    assert.ok(
      allowedStatuses.has(body.status),
      `expected status ok|warning (or legacy healthy|degraded), got ${body.status}`,
    )
  } finally {
    await stopProcess(proc)
    try {
      fs.rmSync(started.tempDir, { recursive: true, force: true })
    } catch {}
  }
})
