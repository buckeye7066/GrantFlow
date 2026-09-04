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
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-auth-503-test-'))
  const dbPath = path.join(tmp, 'test.db')

  // Start with a clean environment for email service configuration
  const baseEnv = {
    ...process.env,
    NODE_ENV: 'production', // Force production mode
    PORT: undefined,
    DB_PROVIDER: 'sqlite',
    SQLITE_DB_PATH: dbPath,
    DB_AUTO_MIGRATE: 'true',
    AUTH_JWT_SECRET: 'test-secret-prod',
    CORS_ORIGIN: 'https://test.grantflow.invalid',
    ALLOW_SQLITE_IN_PROD: 'true',
    ALLOW_EPHEMERAL_SQLITE: 'true',
    ALLOW_EPHEMERAL_UPLOADS: 'true',
    ADMIN_EMAIL: 'ci-operator@grantflow.app',
    ADMIN_TOKEN: 'test-admin-token-ci',
    SMOKE_MODE: 'true',
    DISABLE_BACKGROUND_SERVICES: 'true',
    ANYA_AUTONOMOUS_ENABLED: 'false',
    ANYA_RUN_ON_STARTUP: 'false',
    ANYA_RUN_ON_SCHEDULE: 'false',
    NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
    STARTUP_SMOKE_CRAWL_ENABLED: 'false',
  }

  // Remove email service configuration to simulate unconfigured email service
  delete baseEnv.RESEND_API_KEY
  delete baseEnv.FROM_EMAIL
  delete baseEnv.EMAIL_FROM

  let child = null
  let stdout = ''
  let stderr = ''

  const ready = (async () => {
    const port = await reservePort()
    child = spawn(process.execPath, ['backend/server.js'], {
      cwd: path.resolve('.'),
      env: {
        ...baseEnv,
        PORT: String(port),
        ...Object.fromEntries(Object.entries(extraEnv).filter(([_, value]) => value !== undefined)),
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
  return { status: res.status, json, headers: res.headers }
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
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/setup/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 403, 'Expected 403 status code for unauthorized email in production')
    assert.ok(start.json)
    assert.equal(start.json.ok, false, 'Expected ok: false for unauthorized email')
    assert.equal(start.json.redirect_to, '/ServiceApplication', 'Expected redirect_to for unauthorized emails')
  } finally {
    await srv.stop()
  }
})

test('auth: password setup start returns 202 for authorized emails in production (matching profile, no password yet)', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
    // Configure email service for this test
    RESEND_API_KEY: 'test-key',
    FROM_EMAIL: 'test@example.com',
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

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/setup/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 202, 'Expected 202 for authorized email without password')
    assert.ok(start.json)
    assert.equal(start.json.status, 'password_setup_email_sent')
    assert.equal(start.json.previewCode, undefined, 'Must not return OTP/preview codes in production')
    assert.equal(start.json.preview_token, undefined, 'Must not return preview_token in production')
    assert.equal(start.json.token, undefined, 'Must not return raw setup token')
  } finally {
    await srv.stop()
  }
})

test('auth: password setup start returns 503 when email is NOT configured in production', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
    // Explicitly remove email configuration
    RESEND_API_KEY: undefined,
    FROM_EMAIL: undefined,
    EMAIL_FROM: undefined,
  })
  const { port } = await srv.ready

  try {
    const email = 'authorized@example.com'
    
    // Set up a profile with matching email in the database so we pass the access gate
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    
    const TEST_PROFILE_ID = '00000000-0000-0000-0000-000000000003'
    const TEST_SECTION_ID = '00000000-0000-0000-0000-000000000004'
    const TEST_DISPLAY_NAME = 'Test User'
    
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

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/setup/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 503, 'Expected 503 when email is not configured in production')
    assert.ok(start.json)
    assert.equal(start.json.error_type, 'email_not_configured')
    assert.ok(start.json.error.includes('not configured'), 'Expected error message about email not configured')
  } finally {
    await srv.stop()
  }
})

test('auth: password setup complete sets password, consumes token, and returns session tokens', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
  })
  const { port } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    const userId = '00000000-0000-0000-0000-0000000000aa'
    const email = 'authorized-complete@example.com'
    db.prepare(
      `INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
       VALUES (?, 'Test User', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(userId, email)

    const token = 'test-token-plaintext'
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex')
    const tokenId = '00000000-0000-0000-0000-0000000000bb'
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    db.prepare(
      `INSERT INTO password_setup_tokens (id, user_id, token_hash, expires_at, consumed_at, request_ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)`,
    ).run(tokenId, userId, tokenHash, expiresAt)
    db.close()

    const complete = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/setup/complete`, {
      method: 'POST',
      body: JSON.stringify({ token, password: 'a-very-strong-password' }),
    })

    assert.equal(complete.status, 200)
    assert.ok(complete.json?.accessToken)
    assert.equal(complete.json?.refreshToken, undefined)
    assert.match(String(complete.headers?.get?.('set-cookie') || ''), /grantflow_refresh=.*HttpOnly.*Secure.*SameSite=Strict/i)

    const db2 = new Database(srv.dbPath)
    const userRow = db2.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId)
    assert.ok(typeof userRow?.password_hash === 'string' && userRow.password_hash.length > 10, 'Expected password_hash set')
    const tokenRow = db2.prepare('SELECT consumed_at FROM password_setup_tokens WHERE id = ?').get(tokenId)
    assert.ok(tokenRow?.consumed_at, 'Expected token consumed_at to be set')
    db2.close()
  } finally {
    await srv.stop()
  }
})

test('auth: password login succeeds after password is set', async () => {
  const srv = startServer({
    NODE_ENV: 'production',
  })
  const { port } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    const bcrypt = (await import('bcryptjs')).default
    const userId = '00000000-0000-0000-0000-0000000000cc'
    const email = 'password-login@example.com'
    const hash = await bcrypt.hash('a-very-strong-password', 10)
    db.prepare(
      `INSERT INTO users (id, display_name, primary_email, is_admin, password_hash, created_at, updated_at)
       VALUES (?, 'Test User', ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(userId, email, hash)

    // Production gate requires admin OR profile email match.
    const profileId = '00000000-0000-0000-0000-0000000000c1'
    const sectionId = '00000000-0000-0000-0000-0000000000c2'
    db.prepare(
      `INSERT INTO profiles (id, user_id, display_name, created_at, updated_at)
       VALUES (?, NULL, 'Test Profile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(profileId)
    db.prepare(
      `INSERT INTO profile_sections (id, profile_id, section_key, data, created_at, updated_at)
       VALUES (?, ?, 'basic_information', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(sectionId, profileId, JSON.stringify({ email }))

    db.close()

    const login = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password: 'a-very-strong-password' }),
    })

    assert.equal(login.status, 200)
    assert.ok(login.json?.accessToken)
    assert.equal(login.json?.refreshToken, undefined)
    assert.match(String(login.headers?.get?.('set-cookie') || ''), /grantflow_refresh=.*HttpOnly.*Secure.*SameSite=Strict/i)
  } finally {
    await srv.stop()
  }
})

test('auth: password setup token reuse fails', async () => {
  const srv = startServer({ NODE_ENV: 'production' })
  const { port } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    const userId = '00000000-0000-0000-0000-0000000000dd'
    const email = 'reuse@example.com'
    db.prepare(
      `INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
       VALUES (?, 'Test User', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(userId, email)

    const token = 'reuse-token-plaintext'
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex')
    const tokenId = '00000000-0000-0000-0000-0000000000ee'
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    db.prepare(
      `INSERT INTO password_setup_tokens (id, user_id, token_hash, expires_at, consumed_at, request_ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)`,
    ).run(tokenId, userId, tokenHash, expiresAt)
    db.close()

    const first = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/setup/complete`, {
      method: 'POST',
      body: JSON.stringify({ token, password: 'a-very-strong-password' }),
    })
    assert.equal(first.status, 200)

    const second = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/setup/complete`, {
      method: 'POST',
      body: JSON.stringify({ token, password: 'a-very-strong-password' }),
    })
    assert.equal(second.status, 400)
    assert.equal(second.json?.error_type, 'invalid_or_expired_token')
  } finally {
    await srv.stop()
  }
})

test('auth: expired password setup token fails', async () => {
  const srv = startServer({ NODE_ENV: 'production' })
  const { port } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    const userId = '00000000-0000-0000-0000-0000000000ff'
    const email = 'expired@example.com'
    db.prepare(
      `INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
       VALUES (?, 'Test User', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(userId, email)

    const token = 'expired-token-plaintext'
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex')
    const tokenId = '00000000-0000-0000-0000-000000000111'
    const expiresAt = new Date(Date.now() - 60 * 1000).toISOString()
    db.prepare(
      `INSERT INTO password_setup_tokens (id, user_id, token_hash, expires_at, consumed_at, request_ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)`,
    ).run(tokenId, userId, tokenHash, expiresAt)
    db.close()

    const complete = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/setup/complete`, {
      method: 'POST',
      body: JSON.stringify({ token, password: 'a-very-strong-password' }),
    })
    assert.equal(complete.status, 400)
    assert.equal(complete.json?.error_type, 'invalid_or_expired_token')
  } finally {
    await srv.stop()
  }
})

test('auth: dev password setup start returns preview token when email is unconfigured', async () => {
  const srv = startServer({
    NODE_ENV: 'development',
    // Ensure email service is unconfigured so we exercise preview flow.
    RESEND_API_KEY: undefined,
    FROM_EMAIL: undefined,
    EMAIL_FROM: undefined,
  })
  const { port } = await srv.ready

  try {
    const email = 'dev-preview@example.com'
    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/password/setup/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(start.status, 202)
    assert.ok(start.json)
    assert.equal(start.json.status, 'password_setup_email_sent')
    assert.equal(start.json.email_sent, false)
    assert.ok(typeof start.json.preview_token === 'string' && start.json.preview_token.length > 10)
    assert.ok(typeof start.json.preview_url === 'string' && start.json.preview_url.includes('set-password'))
  } finally {
    await srv.stop()
  }
})
