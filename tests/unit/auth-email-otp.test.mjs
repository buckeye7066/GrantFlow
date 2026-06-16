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
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-auth-test-'))
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

test('auth: email OTP start + verify works on sqlite', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const email = 'test@example.com'
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 202)
    assert.ok(start.json)
    assert.equal(typeof start.json.previewCode, 'string')
    assert.equal(start.json.previewCode.length, 6)
    assert.equal(typeof start.json.verification_token, 'string')

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

    const me = await fetchJson(`http://127.0.0.1:${port}/api/auth/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${verify.json.accessToken}`,
      },
    })

    assert.equal(me.status, 200)
    assert.ok(me.json?.user?.id)
    assert.ok(Array.isArray(me.json?.profiles))
    assert.ok(me.json.profiles.length > 0, 'expected at least one profile for signed-in user')
  } finally {
    await srv.stop()
  }
})

test('auth: existing email user with zero linked profiles is auto-attached on verify', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const email = 'existing@example.com'
    const userId = '00000000-0000-0000-0000-00000000abcd'
    const credentialId = '00000000-0000-0000-0000-00000000cdef'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'existing', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credentialId}', '${userId}', 'email_otp', '${email}', 0);
    `)
    db.close()

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    assert.equal(start.status, 202)

    const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
      method: 'POST',
      body: JSON.stringify({
        email,
        code: start.json.previewCode,
        verification_token: start.json.verification_token,
      }),
    })

    assert.equal(verify.status, 200)
    assert.ok(verify.json?.user?.profiles?.length > 0, 'expected profiles to be attached in login response')
  } finally {
    await srv.stop()
  }
})
