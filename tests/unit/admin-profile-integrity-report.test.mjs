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
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-integrity-smoke-'))
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
        if (res.ok) return { port, dbPath }
      } catch {
        // retry
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
    throw new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })()

  async function stop() {
    if (!child) return
    if (child.killed) return
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    if (!child.killed && child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }

  return { ready, stop, dbPath }
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

async function loginEmailOtp({ port, email }) {
  const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  assert.equal(start.status, 202)
  assert.equal(typeof start.json?.previewCode, 'string')
  assert.equal(typeof start.json?.verification_token, 'string')

  const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
    method: 'POST',
    body: JSON.stringify({
      email,
      code: start.json.previewCode,
      verification_token: start.json.verification_token,
    }),
  })
  assert.equal(verify.status, 200)
  assert.ok(verify.json?.accessToken)
  return verify.json.accessToken
}

test('admin profile integrity report is admin-only and returns counts', async () => {
  const srv = startServer()
  const { port, dbPath } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)

    const adminUserId = '00000000-0000-0000-0000-00000000e901'
    const adminEmail = 'integrity-admin@example.com'
    const userId = '00000000-0000-0000-0000-00000000e902'
    const userEmail = 'integrity-user@example.com'

    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES
        ('${adminUserId}', 'Integrity Admin', '${adminEmail}', 1),
        ('${userId}', 'Integrity User', '${userEmail}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES
        ('00000000-0000-0000-0000-00000000e903', '${adminUserId}', 'email_otp', '${adminEmail}', 0),
        ('00000000-0000-0000-0000-00000000e904', '${userId}', 'email_otp', '${userEmail}', 0);

      INSERT INTO profiles (id, display_name, user_id, status, tags)
      VALUES
        ('00000000-0000-0000-0000-00000000e911', 'Owned Profile', '${userId}', 'active', '[]'),
        ('00000000-0000-0000-0000-00000000e912', 'Unowned Profile', NULL, 'active', '[]');
    `)
    db.close()

    const adminToken = await loginEmailOtp({ port, email: adminEmail })
    const userToken = await loginEmailOtp({ port, email: userEmail })

    const asUser = await fetchJson(`http://127.0.0.1:${port}/api/admin/profiles/integrity`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userToken}` },
    })
    assert.equal(asUser.status, 403)

    const asAdmin = await fetchJson(`http://127.0.0.1:${port}/api/admin/profiles/integrity?limitDuplicateGroups=5`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert.equal(asAdmin.status, 200)
    assert.equal(asAdmin.json?.ok, true)
    assert.ok(asAdmin.json?.totals?.profiles >= 2)
    assert.ok(Array.isArray(asAdmin.json?.profiles?.by_status))
    assert.equal(typeof asAdmin.json?.profiles?.unowned, 'number')
  } finally {
    await srv.stop()
  }
})
