import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-anya-autonomous-test-'))
  const dbPath = path.join(tmp, 'test.db')

  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '0',
      DB_PROVIDER: 'sqlite',
      SQLITE_DB_PATH: dbPath,
      DB_AUTO_MIGRATE: 'true',
      AUTH_JWT_SECRET: 'test-secret',
      // Provide a deterministic admin token so the function test tool can auth its own HTTP checks.
      ADMIN_TOKEN: 'test-admin-token',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => (stderr += d))

  const ready = new Promise((resolve, reject) => {
    let resolved = false
    const timeout = setTimeout(() => {
      if (resolved) return
      try {
        child.kill('SIGTERM')
      } catch {}
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    const checkReady = (newChunk) => {
      if (resolved) return true
      const textToCheck = stdout + (newChunk || '')
      const match = textToCheck.match(/\[Server\] Ready on port\s+(\d+)/)
      if (match) {
        resolved = true
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
        return true
      }
      return false
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk
      checkReady(chunk)
    })

    child.on('error', (err) => {
      if (resolved) return
      clearTimeout(timeout)
      reject(new Error(`server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    child.on('exit', (code) => {
      if (resolved) return
      if (stdout.includes('[Server] Ready on port')) return
      clearTimeout(timeout)
      reject(new Error(`server exited before ready (code=${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })

  async function stop() {
    if (child.killed) return
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
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

