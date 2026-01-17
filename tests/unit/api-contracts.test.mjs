import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function isPortAvailable(port, host = '127.0.0.1') {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
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

  const proc = spawn('node', ['backend/server.js'], {
    cwd: rootDir,
    env,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  proc.stdout?.on('data', () => {})
  proc.stderr?.on('data', () => {})

  const ok = await waitForHttpOk(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 30_000 })
  if (!ok) {
    try { proc.kill('SIGTERM') } catch {}
    throw new Error('Backend did not become healthy for contract tests')
  }

  return proc
}

test('backend /api/health contract + request id header', async () => {
  const rootDir = process.cwd()
  const port = await pickPort()

  const proc = await startBackend({ rootDir, port })
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.equal(res.ok, true)

    const requestId = res.headers.get('x-request-id')
    assert.ok(requestId, 'expected X-Request-Id header to be present')

    const body = await res.json()
    assert.equal(typeof body, 'object')
    assert.ok(['ok', 'warning'].includes(body.status), `expected status ok|warning, got ${body.status}`)
  } finally {
    try { proc.kill('SIGTERM') } catch {}
  }
})
