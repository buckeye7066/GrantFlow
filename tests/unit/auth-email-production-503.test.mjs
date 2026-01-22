import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-auth-503-test-'))
  const dbPath = path.join(tmp, 'test.db')

  // Start with a clean environment for email service configuration
  const baseEnv = {
    ...process.env,
    NODE_ENV: 'production', // Force production mode
    PORT: '0',
    DB_PROVIDER: 'sqlite',
    SQLITE_DB_PATH: dbPath,
    DB_AUTO_MIGRATE: 'true',
    AUTH_JWT_SECRET: 'test-secret-prod',
    ALLOW_SQLITE_IN_PROD: 'true', // Allow SQLite in production for testing
    ALLOW_EPHEMERAL_SQLITE: 'true', // Allow ephemeral SQLite paths for testing
  }

  // Remove email service configuration to simulate unconfigured email service
  delete baseEnv.RESEND_API_KEY
  delete baseEnv.FROM_EMAIL
  delete baseEnv.EMAIL_FROM

  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...baseEnv,
      // Merge extraEnv, filtering out undefined values to ensure they're truly unset
      ...Object.fromEntries(
        Object.entries(extraEnv).filter(([_, value]) => value !== undefined)
      ),
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
      } catch {
        // ignore
      }
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    const onData = () => {
      const match = stdout.match(/\[Server\] Ready on port\s+(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
      }
    }

    child.stdout.on('data', onData)

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    child.on('exit', (code) => {
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

test('auth: email start returns 503 when email fails in production without preview code enabled', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
    // Ensure preview code flags are not set by explicitly removing them from parent env
    AUTH_ALLOW_PREVIEW_CODE_IN_PROD: undefined,
    AUTH_ALLOW_PREVIEW_CODE: undefined,
    AUTH_ALLOW_ADMIN_PREVIEW_CODE: undefined,
  })
  const { port } = await srv.ready

  try {
    const email = 'test@example.com'
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 503, 'Expected 503 status code when email fails in production')
    assert.ok(start.json)
    assert.equal(start.json.error_type, 'email_delivery_unavailable')
    assert.ok(start.json.error.includes('Email delivery is unavailable'))
    assert.equal(start.json.previewCode, undefined, 'Preview code should not be returned')
  } finally {
    await srv.stop()
  }
})

test('auth: email start returns preview code when AUTH_ALLOW_PREVIEW_CODE_IN_PROD is enabled', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
    AUTH_ALLOW_PREVIEW_CODE_IN_PROD: 'true',
  })
  const { port } = await srv.ready

  try {
    const email = 'test@example.com'
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    // With AUTH_ALLOW_PREVIEW_CODE_IN_PROD enabled, we should get 202 with preview code
    assert.equal(start.status, 202, 'Expected 202 status code when preview code is allowed')
    assert.ok(start.json)
    assert.equal(start.json.email_sent, false)
    assert.equal(typeof start.json.previewCode, 'string', 'Preview code should be returned when explicitly allowed')
    assert.equal(start.json.previewCode.length, 6)
    assert.equal(start.json.preview_reason, 'preview_enabled_in_prod')
  } finally {
    await srv.stop()
  }
})

test('auth: email start returns preview code when AUTH_ALLOW_PREVIEW_CODE is enabled', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
    AUTH_ALLOW_PREVIEW_CODE: 'true',
  })
  const { port } = await srv.ready

  try {
    const email = 'test@example.com'
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 202, 'Expected 202 status code when preview code is allowed')
    assert.ok(start.json)
    assert.equal(start.json.email_sent, false)
    assert.equal(typeof start.json.previewCode, 'string', 'Preview code should be returned when explicitly allowed')
    assert.equal(start.json.previewCode.length, 6)
    assert.equal(start.json.preview_reason, 'preview_enabled_in_prod')
  } finally {
    await srv.stop()
  }
})

test('auth: admin user gets preview code via AUTH_ALLOW_ADMIN_PREVIEW_CODE failsafe', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
    AUTH_ALLOW_ADMIN_PREVIEW_CODE: 'true',
    ADMIN_EMAIL: 'admin@example.com',
  })
  const { port } = await srv.ready

  try {
    const email = 'admin@example.com'
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 202, 'Expected 202 status code for admin with failsafe')
    assert.ok(start.json)
    assert.equal(typeof start.json.previewCode, 'string', 'Admin should get preview code')
    assert.equal(start.json.previewCode.length, 6)
    assert.equal(start.json.preview_reason, 'admin_failsafe_email_failed')
  } finally {
    await srv.stop()
  }
})

test('auth: non-admin user gets 503 even when AUTH_ALLOW_ADMIN_PREVIEW_CODE is enabled', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
    AUTH_ALLOW_ADMIN_PREVIEW_CODE: 'true',
    ADMIN_EMAIL: 'admin@example.com',
  })
  const { port } = await srv.ready

  try {
    const email = 'user@example.com' // Not an admin
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 503, 'Non-admin should get 503 when email fails')
    assert.ok(start.json)
    assert.equal(start.json.error_type, 'email_delivery_unavailable')
    assert.equal(start.json.previewCode, undefined, 'Non-admin should not get preview code')
  } finally {
    await srv.stop()
  }
})

test('auth: non-production always gets preview code regardless of email failure', async () => {
  const srv = startServer({
    NODE_ENV: 'development',
  })
  const { port } = await srv.ready

  try {
    const email = 'test@example.com'
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 202, 'Expected 202 in development')
    assert.ok(start.json)
    assert.equal(typeof start.json.previewCode, 'string', 'Development should always get preview code')
    assert.equal(start.json.previewCode.length, 6)
  } finally {
    await srv.stop()
  }
})
