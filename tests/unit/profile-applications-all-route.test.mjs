import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-profile-apps-'))
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

    child.stdout.on('data', () => {
      const match = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ port: Number(match[1]), dbPath })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    child.on('exit', (code) => {
      if (/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port/.test(stdout)) return
      clearTimeout(timeout)
      reject(new Error(`server exited before ready (code=${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })

  async function stop() {
    if (child.killed) return
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { ready, stop }
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

async function loginEmailOtp({ port, email, profileId }) {
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
      profile_id: profileId,
    }),
  })
  assert.equal(verify.status, 200)
  assert.ok(verify.json?.accessToken)
  return verify.json.accessToken
}

test('profiles applications/all: returns linked application rows without 500', async () => {
  const srv = startServer()
  const { port, dbPath } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)

    const userId = '30000000-0000-0000-0000-000000000001'
    const email = 'profile-applications@example.com'
    const profileId = '30000000-0000-0000-0000-000000000002'
    const appId = '30000000-0000-0000-0000-000000000003'

    db.exec(`
      CREATE TABLE IF NOT EXISTS grant_applications (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT,
        pipeline_grant_id TEXT,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        title TEXT,
        grant_name TEXT NOT NULL,
        funder_name TEXT,
        amount_requested REAL,
        amount_awarded REAL,
        deadline_date TEXT,
        submitted_at TIMESTAMP,
        response_expected_date TEXT,
        response_received_at TIMESTAMP,
        notes TEXT,
        contact_name TEXT,
        contact_email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'Profile Apps User', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('30000000-0000-0000-0000-000000000004', '${userId}', 'email_otp', '${email}', 0);

      INSERT INTO profiles (id, display_name, user_id, status)
      VALUES ('${profileId}', 'Profile Apps Test', '${userId}', 'active');

      INSERT INTO grant_applications (
        id, profile_id, user_id, status, grant_name, funder_name, amount_requested
      ) VALUES (
        '${appId}', '${profileId}', '${userId}', 'submitted', 'Community Help Grant', 'Local Foundation', 2500
      );
    `)
    db.close()

    const token = await loginEmailOtp({ port, email, profileId })
    const response = await fetchJson(
      `http://127.0.0.1:${port}/api/profiles/${profileId}/applications/all`,
      { headers: { Authorization: `Bearer ${token}` } },
    )

    assert.equal(response.status, 200)
    assert.equal(response.json?.success, true)
    assert.equal(response.json?.profile_id, profileId)
    assert.equal(response.json?.count, 1)
    assert.equal(response.json?.applications?.[0]?.id, appId)
    assert.equal(response.json?.applications?.[0]?.source_table, 'grant_applications')
    // Cohesion (goal #10): the unified view reconciles every tracked item onto
    // one canonical pipeline stage. A 'submitted' application → 'submitted'.
    assert.equal(response.json?.applications?.[0]?.canonical_stage, 'submitted')
  } finally {
    await srv.stop()
  }
})
