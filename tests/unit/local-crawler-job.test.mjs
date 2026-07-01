import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Retired-crawler HTTP-layer guard.
 *
 * The legacy per-type discovery crawlers (including 'local') were retired in the
 * Crawler-OS cutover — see shared/supersededCrawlerTypes.js. Profile discovery
 * now runs synchronously through the Crawler OS; the old 'local' job path is
 * gone. This test used to drive that retired path end-to-end (expecting a job to
 * be created + completed); it now asserts the CURRENT contract at the HTTP edge:
 * POST /api/crawlers/jobs with a superseded type is rejected with 400
 * invalid_crawler_type and never enqueues a job. (The service-layer retirement
 * contract is covered by backend/tests/supersededCrawlerRetirement.test.js.)
 */

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-local-job-test-'))
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
    let resolved = false
    let readyPoll = null
    const timeout = setTimeout(() => {
      if (resolved) return
      clearInterval(readyPoll)
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    const onData = () => {
      if (resolved) return
      // ANSI-tolerant: match the port from the "Ready on port N" banner regardless
      // of any color escape codes around the [Server] prefix.
      const match = stdout.match(/Ready on port\s+(\d+)/)
      if (match) {
        resolved = true
        clearInterval(readyPoll)
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
      }
    }

    child.stdout.on('data', onData)
    readyPoll = setInterval(onData, 50)
    onData('')
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

test('retired "local" crawler type is rejected at the HTTP layer (superseded by Crawler OS)', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const email = 'localjob@example.com'
    const userId = '00000000-0000-0000-0000-00000000bbb1'
    const credentialId = '00000000-0000-0000-0000-00000000bbb2'
    const orgId = '00000000-0000-0000-0000-00000000bbb3'
    const profileId = '00000000-0000-0000-0000-00000000bbb4'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'localjob', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credentialId}', '${userId}', 'email_otp', '${email}', 0);

      INSERT INTO organizations (id, name, city, state, zip)
      VALUES ('${orgId}', 'Test Org', 'Nashville', 'TN', '37209');

      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileId}', '${userId}', '${orgId}', 'Local Job Profile', 'individual_need', 'active', '["education"]');
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
    assert.ok(verify.json?.accessToken)

    // A retired discovery type must be rejected at the route before any job row
    // is enqueued — the Crawler OS owns discovery now.
    const create = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${verify.json.accessToken}` },
      body: JSON.stringify({
        type: 'local',
        profile_id: profileId,
        parameters: { match_threshold: 60, max_results: 10 },
      }),
    })
    assert.equal(create.status, 400)
    assert.equal(create.json?.error, 'invalid_crawler_type')
  } finally {
    await srv.stop()
  }
})
