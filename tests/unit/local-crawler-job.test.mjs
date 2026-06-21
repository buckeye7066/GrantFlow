import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
      const match = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
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

// 90s budget: the local crawl does real work (now multi-state + county/city
// expansion) and can run slowly under full-suite concurrency. It completes well
// under this standalone; the larger budget only prevents load-flakiness.
async function waitForJob({ port, accessToken, jobId, timeoutMs = 90_000 }) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const res = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs/${jobId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    assert.equal(res.status, 200)
    const status = res.json?.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return res.json
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for job ${jobId}`)
}

test('queued crawler: local job completes even with legacy keyword formats and derives state from ZIP signals', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const email = 'localjob@example.com'
    const userId = '00000000-0000-0000-0000-00000000bbb1'
    const credentialId = '00000000-0000-0000-0000-00000000bbb2'
    const orgId = '00000000-0000-0000-0000-00000000bbb3'
    const profileId = '00000000-0000-0000-0000-00000000bbb4'
    const oppId = '00000000-0000-0000-0000-00000000bbb5'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'localjob', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credentialId}', '${userId}', 'email_otp', '${email}', 0);

      -- Intentionally omit state so the crawler must derive it from ZIP via signals.
      INSERT INTO organizations (id, name, city, state, zip)
      VALUES ('${orgId}', 'Test Org', 'Nashville', NULL, '37209');

      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileId}', '${userId}', '${orgId}', 'Local Job Profile', 'individual_need', 'active', '["education"]');

      -- Legacy keyword formats (not JSON) previously crashed JSON.parse in the local job.
      INSERT INTO funding_opportunities (
        id, title, sponsor, source, description, is_active, state, requires_match, keywords, categories, eligibility_bullets
      ) VALUES (
        '${oppId}',
        'Education Microgrant',
        'Local Foundation',
        'local_seed',
        'Support for education-related needs.',
        1,
        'TN',
        0,
        'education, youth, community',
        '["community"]',
        'veterans; students'
      );
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

    const create = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${verify.json.accessToken}` },
      body: JSON.stringify({
        type: 'local',
        profile_id: profileId,
        parameters: { match_threshold: 60, max_results: 10 },
      }),
    })
    assert.equal(create.status, 201)
    assert.ok(create.json?.id)

    const finalJob = await waitForJob({
      port,
      accessToken: verify.json.accessToken,
      jobId: create.json.id,
    })

    assert.equal(finalJob.status, 'completed')
    assert.equal(finalJob.type, 'local')
    assert.equal(finalJob.profile_id, profileId)
    assert.equal(typeof finalJob.result_count, 'number')
    assert.ok(finalJob.result_count >= 0)
  } finally {
    await srv.stop()
  }
})
