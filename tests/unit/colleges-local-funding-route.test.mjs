/**
 * Unit tests for GET /api/colleges/local-funding zip validation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'

const TEST_JWT_SECRET = 'test-secret'

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function makeAuthToken() {
  const header = base64url({ alg: 'HS256', typ: 'JWT' })
  const payload = base64url({
    sub: 'test-user-id',
    role: 'user',
    email: 'test@example.com',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  const sig = createHmac('sha256', TEST_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${sig}`
}

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-colleges-test-'))
  const dbPath = path.join(tmp, 'test.db')

  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve(process.cwd()),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '0',
      DB_PROVIDER: 'sqlite',
      SQLITE_DB_PATH: dbPath,
      DB_AUTO_MIGRATE: 'true',
      AUTH_JWT_SECRET: TEST_JWT_SECRET,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch (killErr) {
        // process may have already exited; ignore but log for observability
        process.stderr.write(`[test] kill failed: ${killErr.message}\n`)
      }
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    child.on('error', (spawnErr) => {
      clearTimeout(timeout)
      reject(new Error(`server spawn failed: ${spawnErr.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    const onData = () => {
      const match = stdout.match(/\[Server\] Ready on port\s+(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
      }
    }
    child.stdout.on('data', onData)
  })

  async function stop() {
    if (child.killed) return
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { ready, stop }
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

test('colleges local-funding: 401 when not authenticated', async () => {
  const srv = startServer()
  let port
  try {
    ;({ port } = await srv.ready)
  } catch (err) {
    await srv.stop()
    throw err
  }

  try {
    const { status } = await fetchJson(`http://127.0.0.1:${port}/api/colleges/local-funding?zip=43210`)
    assert.equal(status, 401)
  } finally {
    await srv.stop()
  }
})

test('colleges local-funding: 400 when zip missing', async () => {
  const srv = startServer()
  let port
  try {
    ;({ port } = await srv.ready)
  } catch (err) {
    await srv.stop()
    throw err
  }

  try {
    const { status, json } = await fetchJson(`http://127.0.0.1:${port}/api/colleges/local-funding`, {
      headers: { Authorization: `Bearer ${makeAuthToken()}` },
    })
    assert.equal(status, 400)
    assert.equal(json?.error, 'zip_missing')
  } finally {
    await srv.stop()
  }
})

test('colleges local-funding: 400 when zip invalid', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const { status, json } = await fetchJson(
      `http://127.0.0.1:${port}/api/colleges/local-funding?zip=bad`,
      { headers: { Authorization: `Bearer ${makeAuthToken()}` } },
    )
    assert.equal(status, 400)
    assert.equal(json?.error, 'zip_invalid')
  } finally {
    await srv.stop()
  }
})

test('colleges local-funding: 200 with valid zip', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const { status, json } = await fetchJson(
      `http://127.0.0.1:${port}/api/colleges/local-funding?zip=43210`,
      { headers: { Authorization: `Bearer ${makeAuthToken()}` } },
    )
    assert.equal(status, 200)
    assert.equal(json?.success, true)
    assert.equal(json?.zip, '43210')
    assert.ok(Array.isArray(json?.results))
    assert.ok(typeof json?.radiusFilteringApplied === 'boolean')
  } finally {
    await srv.stop()
  }
})

