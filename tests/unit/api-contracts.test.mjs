import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function isPortAvailable(port, host = '127.0.0.1') {
  // Prefer connect-probing over bind-probing.
  // On Windows, some listeners can allow a second bind probe to succeed (SO_REUSEADDR),
  // but connect() will still succeed if a service is already bound and accepting.
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.once('connect', () => {
      try { socket.destroy() } catch {}
      resolve(false)
    })
    socket.once('error', (err) => {
      try { socket.destroy() } catch {}
      if (err?.code === 'ECONNREFUSED') return resolve(true)
      // Conservative default: treat unknown errors as "in use" so we pick another port.
      resolve(false)
    })
  })
}

async function pickPort({ start = 18080, count = 30 } = {}) {
  for (let i = 0; i < count; i += 1) {
    const port = start + i
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) return port
  }
  throw new Error('No available port found for backend test')
}

async function waitForHttpOk(url, { timeoutMs = 30_000 } = {}) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) return false
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return true
    } catch {}
    // eslint-disable-next-line no-await-in-loop
    await sleep(250)
  }
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

async function startBackend({ rootDir, port }) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SMOKE_MODE: 'true',
    PORT: String(port),
    DB_AUTO_MIGRATE: 'true',
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'dev-admin-token',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
    AUTH_FRONTEND_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
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
  // eslint-disable-next-line no-constant-condition
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
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'GET' })
      if (res.ok) return proc
    } catch {
      // keep polling
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(250)
  }

  const stdout = stdoutChunks.join('')
  const stderr = stderrChunks.join('')
  await stopProcess(proc)
  throw new Error(
    `Backend did not become healthy for contract tests within ${timeoutMs}ms.\n` +
      `--- stdout ---\n${stdout || '(empty)'}\n` +
      `--- stderr ---\n${stderr || '(empty)'}\n`,
  )
}

test('backend /api/health contract + request id header', async () => {
  // Derive repo root from this test file location (more robust than process.cwd()).
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const port = await pickPort()

  const entry = path.join(rootDir, 'backend', 'start.js')
  assert.ok(fs.existsSync(entry), `expected backend entry to exist at ${entry}`)

  const proc = await startBackend({ rootDir, port })
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
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
  }
})
