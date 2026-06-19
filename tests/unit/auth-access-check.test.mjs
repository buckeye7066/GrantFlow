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
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-access-check-'))
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
        if (res.ok) {
          // Don't return until /healthz also confirms the schema bootstrap
          // is healthy. Without this gate, this test (and others that open
          // their own better-sqlite3 connection) used to race
          // "INSERT INTO users" against a not-yet-created users table, with
          // the schema apply failing silently inside server.js.
          let body = null
          try { body = await res.json() } catch { body = null }
          if (body && body.schema_bootstrap_failed === false) return { port }
        }
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

test('auth/access/check: admin email returns allowed=true with reason=admin', async () => {
  const srv = startServer({ ADMIN_EMAIL: 'admin@test.com' })
  const { port } = await srv.ready

  try {
    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@test.com' }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.json.allowed, true)
    assert.equal(result.json.reason, 'admin')
    assert.equal(typeof result.json.hasPassword, 'boolean')
  } finally {
    await srv.stop()
  }
})

test('auth/access/check: email with matching profile returns allowed=true with reason=profile_match', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    // Create a user with a profile that has email in basic_information section
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    const userId = '00000000-0000-0000-0000-00000000test'
    const profileId = '00000000-0000-0000-0000-00000000prof'
    const email = 'user@example.com'

    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'Test User', '${email}', 0);

      INSERT INTO profiles (id, user_id, display_name)
      VALUES ('${profileId}', '${userId}', 'Test Profile');

      INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('00000000-0000-0000-0000-00000000sect', '${profileId}', 'basic_information', '{"email":"${email}"}');
    `)
    db.close()

    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.json.allowed, true)
    assert.equal(result.json.reason, 'profile_match')
    assert.equal(typeof result.json.hasPassword, 'boolean')
  } finally {
    await srv.stop()
  }
})

test('auth/access/check: email without profile or admin returns 403 in production', async () => {
  const srv = startServer({ 
    NODE_ENV: 'production',
    ALLOW_SQLITE_IN_PROD: 'true',
    ALLOW_EPHEMERAL_SQLITE: 'true',
    ADMIN_TOKEN: 'test-admin-token-ci',
    ALLOW_EPHEMERAL_UPLOADS: 'true', // Explicitly allow ephemeral uploads in test harness
  })
  const { port } = await srv.ready

  try {
    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({ email: 'unknown@example.com' }),
    })

    assert.equal(result.status, 403)
    assert.equal(result.json.allowed, false)
    assert.equal(result.json.reason, 'no_profile_match')
    assert.equal(result.json.redirect_to, '/ServiceApplication')
  } finally {
    await srv.stop()
  }
})

test('auth/access/check: email without profile or admin returns 403 in development too', async () => {
  const srv = startServer({ 
    NODE_ENV: 'development',  // Explicitly development
  })
  const { port } = await srv.ready

  try {
    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({ email: 'unknown-dev@example.com' }),
    })

    // Even in dev, we return 403 for consistency (no profile match = no access)
    assert.equal(result.status, 403)
    assert.equal(result.json.allowed, false)
    assert.equal(result.json.reason, 'no_profile_match')
    assert.equal(result.json.redirect_to, '/ServiceApplication')
  } finally {
    await srv.stop()
  }
})

test('auth/access/check: hasPassword=true when user has password_hash', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    const userId = '00000000-0000-0000-0000-00000000pass'
    const profileId = '00000000-0000-0000-0000-00000000prof'
    const email = 'haspass@example.com'

    db.exec(`
      INSERT INTO users (id, display_name, primary_email, password_hash, is_admin)
      VALUES ('${userId}', 'Test User', '${email}', 'hash123', 0);

      INSERT INTO profiles (id, user_id, display_name)
      VALUES ('${profileId}', '${userId}', 'Test Profile');

      INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('00000000-0000-0000-0000-00000000sect', '${profileId}', 'basic_information', '{"email":"${email}"}');
    `)
    db.close()

    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.json.hasPassword, true)
  } finally {
    await srv.stop()
  }
})

test('auth/access/check: hasPassword=false when user has no password_hash', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    const userId = '00000000-0000-0000-0000-00000000nopass'
    const profileId = '00000000-0000-0000-0000-00000000prof'
    const email = 'nopass@example.com'

    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'Test User', '${email}', 0);

      INSERT INTO profiles (id, user_id, display_name)
      VALUES ('${profileId}', '${userId}', 'Test Profile');

      INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('00000000-0000-0000-0000-00000000sect', '${profileId}', 'basic_information', '{"email":"${email}"}');
    `)
    db.close()

    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.json.hasPassword, false)
  } finally {
    await srv.stop()
  }
})

test('auth/access/check: users.primary_email grants access when profile_sections has no email', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    const userId = '00000000-0000-0000-0000-00000000usr'
    const profileId = '00000000-0000-0000-0000-00000000pf2'
    const email = 'user-primary-only@example.com'

    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'Primary Email User', '${email}', 0);

      INSERT INTO profiles (id, user_id, display_name)
      VALUES ('${profileId}', '${userId}', 'Test Profile');

      INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('00000000-0000-0000-0000-00000000s2', '${profileId}', 'basic_information', '{"phone":"555-1234"}');
    `)
    db.close()

    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.json.allowed, true)
    assert.equal(result.json.reason, 'profile_match')
  } finally {
    await srv.stop()
  }
})

test('auth/access/check: validates email format', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    })

    assert.equal(result.status, 400)
    assert.equal(result.json.error_type, 'validation_error')
  } finally {
    await srv.stop()
  }
})

test('auth/access/check: requires email parameter', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const result = await fetchJson(`http://127.0.0.1:${port}/api/auth/access/check`, {
      method: 'POST',
      body: JSON.stringify({}),
    })

    assert.equal(result.status, 400)
    assert.equal(result.json.error_type, 'validation_error')
  } finally {
    await srv.stop()
  }
})
