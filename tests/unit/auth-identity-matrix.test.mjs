/**
 * Auth identity matrix tests.
 *
 * Starts a real backend server (PORT=0, SQLite in-memory) and exercises every
 * authentication identity type against GET /api/auth/me:
 *
 *   ✓ No token          → 401
 *   ✓ Malformed token   → 401
 *   ✓ Admin token (X-Admin-Token header)              → 200
 *   ✓ Admin token (Authorization: Bearer header)      → 200
 *   ✓ Anya API key (X-Anya-Token header)              → 200
 *   ✓ Signed JWT, admin role, no backing user         → 401 (fail closed, not auto-elevated)
 *   ✓ Signed JWT, sub collides with synthetic id       → 403 on /api/admin/* (provenance-bound)
 *
 * Source-level assertion: ANYA_ADMIN_TOKEN is honoured as a fallback for
 * ADMIN_TOKEN (verified by inspecting server.js, no extra server spawn needed).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// Shared server fixture
// ---------------------------------------------------------------------------

const TEST_ADMIN_TOKEN = 'test-admin-token-identity-matrix'
const TEST_ANYA_API_KEY = 'test-anya-api-key-identity-matrix'
const TEST_JWT_SECRET = 'test-jwt-secret-identity-matrix'

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

async function waitForHealthz(port, { child, getLogs, dbPath, timeoutMs = 60_000 }) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      const { stdout, stderr } = getLogs()
      throw new Error(`server exited before ready (code=${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return { port, dbPath }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const { stdout, stderr } = getLogs()
  throw new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-auth-matrix-'))
  const dbPath = path.join(tmp, 'test.db')
  let child = null
  let stdout = ''
  let stderr = ''
  const ready = (async () => {
    const port = await reservePort()
    child = spawn(process.execPath, ['backend/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        DB_PROVIDER: 'sqlite',
        SQLITE_DB_PATH: dbPath,
        DB_AUTO_MIGRATE: 'true',
        AUTH_JWT_SECRET: TEST_JWT_SECRET,
        ADMIN_TOKEN: TEST_ADMIN_TOKEN,
        ANYA_API_KEY: TEST_ANYA_API_KEY,
        // Keep boot fast
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
      dbPath,
      getLogs: () => ({ stdout, stderr }),
    })
  })()

  async function stop() {
    if (!child || child.killed) return
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { child, ready, stop }
}

// ---------------------------------------------------------------------------
// Sign a JWT for test purposes (using the built-in crypto — no dep needed)
// ---------------------------------------------------------------------------

async function signJwt(payload, secret) {
  const { default: jwt } = await import('jsonwebtoken')
  return jwt.sign(payload, secret, { expiresIn: '1h' })
}

// ---------------------------------------------------------------------------
// Tests — share one server to reduce boot overhead
// ---------------------------------------------------------------------------

let sharedSrv
let sharedPort

test('auth identity matrix — setup shared server', { timeout: 120_000 }, async () => {
  sharedSrv = startServer()
  const { port } = await sharedSrv.ready
  sharedPort = port
  assert.ok(port > 0, 'server should bind to a random port')
})

test('auth/me: no token → 401', { timeout: 15_000 }, async () => {
  const res = await fetch(`http://127.0.0.1:${sharedPort}/api/auth/me`)
  assert.strictEqual(res.status, 401, 'request with no token should be rejected')
})

test('auth/me: malformed / invalid JWT → 401', { timeout: 15_000 }, async () => {
  const res = await fetch(`http://127.0.0.1:${sharedPort}/api/auth/me`, {
    headers: { Authorization: 'Bearer this-is-not-a-valid-jwt' },
  })
  assert.strictEqual(res.status, 401, 'malformed JWT should be rejected')
})

test('auth/me: admin token via X-Admin-Token header → 200', { timeout: 15_000 }, async () => {
  const res = await fetch(`http://127.0.0.1:${sharedPort}/api/auth/me`, {
    headers: { 'X-Admin-Token': TEST_ADMIN_TOKEN },
  })
  assert.strictEqual(res.status, 200, 'valid admin token in X-Admin-Token should be accepted')
  const body = await res.json()
  assert.ok(body && typeof body === 'object', 'response should be a JSON object')
})

test('auth/me: admin token via Authorization: Bearer header → 200', { timeout: 15_000 }, async () => {
  const res = await fetch(`http://127.0.0.1:${sharedPort}/api/auth/me`, {
    headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
  })
  assert.strictEqual(
    res.status,
    200,
    'admin token supplied as Bearer token should also be accepted',
  )
})

test('auth/me: Anya API key via X-Anya-Token header → 200', { timeout: 15_000 }, async () => {
  const res = await fetch(`http://127.0.0.1:${sharedPort}/api/auth/me`, {
    headers: { 'X-Anya-Token': TEST_ANYA_API_KEY },
  })
  assert.strictEqual(
    res.status,
    200,
    'valid Anya API key in X-Anya-Token should be accepted',
  )
})

test('auth/me: signed JWT with admin role but NO backing user is NOT auto-elevated (fail closed)', { timeout: 15_000 }, async () => {
  // SECURITY: a signed JWT carrying roles:['admin'] for a userId with no users
  // row (and not the configured admin email) must NOT be auto-created as an admin
  // — that self-heal was a privilege-escalation path (a stale/forged admin-role
  // token minting a DB admin). Admin is DB-backed + fail-closed now; only the
  // validated synthetic ADMIN_TOKEN / Anya key (asserted above) grant token-admin.
  const token = await signJwt(
    { sub: 'jwt-admin-user', email: 'admin@test.example', roles: ['admin'] },
    TEST_JWT_SECRET,
  )
  const res = await fetch(`http://127.0.0.1:${sharedPort}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.strictEqual(
    res.status,
    401,
    'a signed admin-role JWT for a non-existent user must be denied, not auto-elevated to admin',
  )
})

test('admin route: signed JWT whose sub COLLIDES with a synthetic service id is NOT admin (403)', { timeout: 15_000 }, async () => {
  // SECURITY: synthetic-admin authority is bound to service-token PROVENANCE
  // (a serviceToken flag set only inside a safeTokenEqual branch), NOT to the id
  // value. A signed JWT that sets sub:'system_admin_token' has no serviceToken
  // flag, so requestContext denies it (and refuses to honor the synthetic DB row
  // the real ADMIN_TOKEN may have persisted). It must be forbidden on /api/admin/*.
  const token = await signJwt(
    { sub: 'system_admin_token', email: 'attacker@test.example', roles: ['admin'] },
    TEST_JWT_SECRET,
  )
  const collision = await fetch(`http://127.0.0.1:${sharedPort}/api/admin/agent-control-probe-does-not-exist`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.strictEqual(
    collision.status,
    403,
    'a JWT with sub colliding with a synthetic service id must be forbidden on admin routes',
  )

  // Control: the REAL safeTokenEqual ADMIN_TOKEN passes the admin gate (not 403;
  // 404 for the probe path is fine — it cleared ensureAdmin).
  const real = await fetch(`http://127.0.0.1:${sharedPort}/api/admin/agent-control-probe-does-not-exist`, {
    headers: { 'X-Admin-Token': TEST_ADMIN_TOKEN },
  })
  assert.notStrictEqual(real.status, 403, 'the real ADMIN_TOKEN service token must still clear the admin gate')

  // /api/auth/me must report is_admin:false for the colliding JWT — even though a
  // users.id='system_admin_token' row was self-healed by the real ADMIN_TOKEN
  // flow above (is_admin comes from ctx.isAdmin, never dbUser.is_admin).
  const me = await fetch(`http://127.0.0.1:${sharedPort}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (me.status === 200) {
    const body = await me.json()
    assert.notStrictEqual(body?.user?.is_admin, true, 'colliding JWT must NOT be reported is_admin:true by /auth/me')
    assert.ok(!Array.isArray(body?.profiles) || body.profiles.length === 0, 'colliding JWT must not receive admin-scoped profiles')
  }
})

test('auth identity matrix — teardown shared server', async () => {
  await sharedSrv?.stop()
})

// ---------------------------------------------------------------------------
// Source-level assertion: ANYA_ADMIN_TOKEN is used as fallback for ADMIN_TOKEN
// ---------------------------------------------------------------------------

test('server.js uses ANYA_ADMIN_TOKEN as fallback for ADMIN_TOKEN', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/server.js'), 'utf8')
  assert.ok(
    src.includes('ANYA_ADMIN_TOKEN'),
    'server.js should reference ANYA_ADMIN_TOKEN as an admin token source',
  )
  // The canonical line is: ADMIN_TOKEN || ANYA_ADMIN_TOKEN
  assert.ok(
    /ADMIN_TOKEN.*\|\|.*ANYA_ADMIN_TOKEN|ANYA_ADMIN_TOKEN.*\|\|.*ADMIN_TOKEN/.test(src),
    'server.js should fall back to ANYA_ADMIN_TOKEN when ADMIN_TOKEN is not set',
  )
})
