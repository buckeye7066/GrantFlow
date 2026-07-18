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
import { createServer as createNetServer } from 'node:net'
import Database from 'better-sqlite3'

// A real authenticated user has a users row; without one, buildRequestContext
// resolves identityResolved=false and enforceResolvedIdentity treats the token as
// a deleted/invalid user (401). Seed the row so these tests exercise a genuine
// authenticated user against the colleges route.
function seedTestUser(dbPath) {
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    db.prepare('INSERT OR IGNORE INTO users (id, primary_email) VALUES (?, ?)').run(
      'test-user-id',
      'test@example.com',
    )
  } finally {
    db.close()
  }
}

const TEST_JWT_SECRET = 'test-secret'

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : null
      srv.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

async function waitForHealthz(port, { child, getLogs, timeoutMs = 60_000 }) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      const { stdout, stderr } = getLogs()
      throw new Error(`server exited before ready (code=${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return { port }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const { stdout, stderr } = getLogs()
  throw new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

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
  let child = null
  let stdout = ''
  let stderr = ''
  const ready = (async () => {
    const port = await reservePort()
    child = spawn(process.execPath, ['backend/server.js'], {
      cwd: path.resolve(process.cwd()),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        DB_PROVIDER: 'sqlite',
        SQLITE_DB_PATH: dbPath,
        DB_AUTO_MIGRATE: 'true',
        AUTH_JWT_SECRET: TEST_JWT_SECRET,
        SMOKE_MODE: 'true',
        DISABLE_BACKGROUND_SERVICES: 'true',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))

    return waitForHealthz(port, {
      child,
      getLogs: () => ({ stdout, stderr }),
    })
  })()

  async function stop() {
    if (child.killed) return
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { ready, stop, dbPath }
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
  seedTestUser(srv.dbPath)

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
  seedTestUser(srv.dbPath)

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
  seedTestUser(srv.dbPath)

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
