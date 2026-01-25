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

test('auth: email start returns 403 for unauthorized emails in production (no matching profile)', async () => {
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

    assert.equal(start.status, 403, 'Expected 403 status code for unauthorized email in production')
    assert.ok(start.json)
    assert.equal(start.json.error_type, 'unauthorized_email')
    assert.ok(start.json.error.includes('not authorized'))
    assert.equal(start.json.previewCode, undefined, 'Preview code should not be returned')
    assert.equal(start.json.redirect_to, '/ServiceApplication', 'Expected redirect_to for unauthorized emails')
  } finally {
    await srv.stop()
  }
})

test('auth: email start returns 202 with preview code for authorized emails in production (matching profile)', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
  })
  const { port } = await srv.ready

  try {
    const email = 'authorized@example.com'
    
    // Set up a profile with matching email in the database
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    
    // Use test fixtures with known safe values (not user input)
    const TEST_PROFILE_ID = '00000000-0000-0000-0000-000000000001'
    const TEST_SECTION_ID = '00000000-0000-0000-0000-000000000002'
    const TEST_DISPLAY_NAME = 'Test User'
    
    // Insert profile using parameterized queries
    const insertProfile = db.prepare(`
      INSERT INTO profiles (id, user_id, display_name, created_at, updated_at)
      VALUES (?, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    insertProfile.run(TEST_PROFILE_ID, TEST_DISPLAY_NAME)
    
    const insertSection = db.prepare(`
      INSERT INTO profile_sections (id, profile_id, section_key, data, created_at, updated_at)
      VALUES (?, ?, 'basic_information', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    insertSection.run(TEST_SECTION_ID, TEST_PROFILE_ID, JSON.stringify({ email, name: TEST_DISPLAY_NAME }))
    
    db.close()

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 202, 'Expected 202 even when email delivery is unconfigured in production')
    assert.ok(start.json)
    assert.ok(/^\d{6}$/.test(String(start.json.previewCode || '')), 'Expected previewCode to be a 6-digit string')
    assert.equal(start.json.email_sent, false, 'email_sent should be false when provider is unconfigured')
    assert.ok(
      typeof start.json.notice === 'string' && start.json.notice.length > 0,
      'Expected a notice when email delivery may be delayed/unavailable',
    )
  } finally {
    await srv.stop()
  }
})

test('auth: admin email is authorized even without matching profile in production', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
    ADMIN_EMAIL: 'admin@example.com',
  })
  const { port } = await srv.ready

  try {
    const email = 'admin@example.com'
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 202, 'Expected 202 even when email delivery is unconfigured in production')
    assert.ok(start.json)
    assert.ok(/^\d{6}$/.test(String(start.json.previewCode || '')), 'Expected previewCode to be a 6-digit string')
    assert.equal(start.json.email_sent, false, 'email_sent should be false when provider is unconfigured')
    assert.ok(
      typeof start.json.notice === 'string' && start.json.notice.length > 0,
      'Expected a notice when email delivery may be delayed/unavailable',
    )
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
