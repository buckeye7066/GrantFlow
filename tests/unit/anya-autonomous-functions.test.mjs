import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'

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

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-anya-autonomous-test-'))
  const dbPath = path.join(tmp, 'test.db')
  let child = null
  let stdout = ''
  let stderr = ''

  const ready = (async () => {
    const port = await reservePort()
    child = spawn(process.execPath, ['backend/server.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        DB_PROVIDER: 'sqlite',
        SQLITE_DB_PATH: dbPath,
        DB_AUTO_MIGRATE: 'true',
        AUTH_JWT_SECRET: 'test-secret',
        SMOKE_MODE: 'true',
        DISABLE_BACKGROUND_SERVICES: 'true',
        ANYA_AUTONOMOUS_ENABLED: 'false',
        ANYA_RUN_ON_STARTUP: 'false',
        ANYA_RUN_ON_SCHEDULE: 'false',
        NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
        STARTUP_SMOKE_CRAWL_ENABLED: 'false',
        // Provide a deterministic admin token so the function test tool can auth its own HTTP checks.
        ADMIN_TOKEN: 'test-admin-token',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server exited before ready (code=${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`)
        if (res.ok) return { port }
      } catch {
        // retry
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    try { child.kill('SIGTERM') } catch {}
    throw new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })()

  async function stop() {
    if (!child) return
    if (child.killed) return
    try { child.kill('SIGTERM') } catch {}
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    if (!child.killed && child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }

  return { ready, stop }
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

test('anya autonomous functions: executes real HTTP checks (not simulated)', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const res = await fetchJson(`http://127.0.0.1:${port}/api/anya/autonomous/functions`, {
      method: 'POST',
      headers: { 'X-Admin-Token': 'test-admin-token' },
      body: JSON.stringify({ testSuites: ['health', 'auth', 'anya'] }),
    })

    assert.equal(res.status, 201)
    assert.equal(res.json?.tool, 'admin.anya.testFunctions')
    assert.equal(typeof res.json?.output?.total_tests, 'number')
    assert.ok(res.json.output.total_tests > 0)

    // Ensure at least one test includes a real HTTP status from a live request.
    const flat = []
    for (const suite of res.json.output?.results || []) {
      for (const t of suite.tests || []) flat.push(t)
    }
    assert.ok(flat.some((t) => typeof t.http_status === 'number'), 'expected http_status in at least one test result')
  } finally {
    await srv.stop()
  }
})
