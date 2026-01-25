import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-access-check-'))
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
      } catch {
        // ignore
      }
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
    ALLOW_SQLITE_IN_PROD: 'true',  // Allow SQLite in test environment
    ALLOW_EPHEMERAL_SQLITE: 'true'  // Allow ephemeral SQLite path in test
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
