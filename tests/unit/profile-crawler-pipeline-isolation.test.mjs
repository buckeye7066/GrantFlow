// CUTOVER (Crawler OS): this file exercises the legacy crawler route/engine that
// is now a superseded no-op shim (backend/services/legacyCrawlSuperseded.js). The
// discovery/matching invariants it checked are owned + tested by the Crawler OS
// (backend/crawler-os/tests, 149 tests). Skipped pending a re-point to the OS pipeline.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-phase5-'))
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
      // Ensure crawler uses deterministic fixtures.
      CRAWLER_DATA_DIR: path.resolve('tests/fixtures/crawlers'),
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
    }, Number(process.env.PHASE5_SERVER_READY_TIMEOUT_MS) || 90_000)

    child.stdout.on('data', () => {
      const m = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (m) {
        clearTimeout(timeout)
        resolve({ port: Number(m[1]), dbPath })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    child.on('exit', (code) => {
      if (/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port/.test.skip(stdout)) return
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

async function loginEmailOtp({ port, email, profileId }) {
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
      profile_id: profileId ?? null,
    }),
  })
  assert.equal(verify.status, 200)
  assert.ok(verify.json?.accessToken)
  return verify.json.accessToken
}

async function createCrawlerJob({ port, token, profileId, type, force = false }) {
  const res = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type, profile_id: profileId, parameters: {}, force }),
  })
  assert.ok(
    res.status === 200 || res.status === 201,
    `unexpected status ${res.status}: ${JSON.stringify(res.json)}`,
  )
  assert.ok(res.json?.id)
  return res.json
}

async function waitForJobComplete({ port, token, jobId }) {
  // This boots the full server and runs a real crawler job end-to-end. On a
  // cold filesystem cache (isolated run) or a loaded CI machine, the first
  // boot + migrate + crawl legitimately takes longer than a warm in-suite run,
  // so a tight 60s deadline flakes even though the job DOES complete. Allow a
  // generous, load-tolerant window (override via PHASE5_JOB_TIMEOUT_MS).
  const deadline = Date.now() + (Number(process.env.PHASE5_JOB_TIMEOUT_MS) || 180_000)
  while (Date.now() < deadline) {
    const res = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs/${jobId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    if (res.json?.status === 'completed') return res.json
    if (res.json?.status === 'failed') {
      throw new Error(`job failed: ${res.json?.error || 'unknown error'}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('timed out waiting for job completion')
}

async function listGrantsForProfile({ port, token, profileId }) {
  const res = await fetchJson(`http://127.0.0.1:${port}/api/grants?limit=200`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Profile-Id': profileId,
    },
  })
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.json))
  return res.json
}

test.skip('phase5: crawler runs persist pipeline per-profile and are idempotent', async () => {
  const srv = startServer()
  const { port, dbPath } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)

    const user1Id = '00000000-0000-0000-0000-00000000a101'
    const user2Id = '00000000-0000-0000-0000-00000000a102'
    const profile1Id = '00000000-0000-0000-0000-00000000b101'
    const profile2Id = '00000000-0000-0000-0000-00000000b102'
    const email1 = 'phase5-user1@example.com'
    const email2 = 'phase5-user2@example.com'

    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES
        ('${user1Id}', 'User One', '${email1}', 0),
        ('${user2Id}', 'User Two', '${email2}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES
        ('00000000-0000-0000-0000-00000000c101', '${user1Id}', 'email_otp', '${email1}', 0),
        ('00000000-0000-0000-0000-00000000c102', '${user2Id}', 'email_otp', '${email2}', 0);

      INSERT INTO profiles (id, display_name, user_id, status, primary_type, tags)
      VALUES
        ('${profile1Id}', 'Profile One', '${user1Id}', 'active', 'nonprofit', '["nonprofit","community","capacity building"]'),
        ('${profile2Id}', 'Profile Two', '${user2Id}', 'active', 'small_business', '["community","small business","entrepreneurship"]');

      INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by)
      VALUES
        ('00000000-0000-0000-0000-00000000d101', '${profile1Id}', 'basic_information', '{"full_name":"Profile One","city":"Columbus","state":"OH","zip":"43004","profile_category":"nonprofit"}', 'test'),
        ('00000000-0000-0000-0000-00000000d102', '${profile2Id}', 'basic_information', '{"full_name":"Profile Two","city":"San Francisco","state":"CA","zip":"94105","profile_category":"small_business"}', 'test'),
        ('00000000-0000-0000-0000-00000000d103', '${profile1Id}', 'narrative', '{"primary_goal":"Need community grants for nonprofit capacity building","target_population":"Ohio communities","geographic_focus":"Columbus OH"}', 'test'),
        ('00000000-0000-0000-0000-00000000d104', '${profile2Id}', 'narrative', '{"primary_goal":"Seeking small business startup grants and community impact funding","target_population":"Small businesses in California","geographic_focus":"San Francisco CA"}', 'test');
    `)
    db.close()

    const token1 = await loginEmailOtp({ port, email: email1, profileId: profile1Id })
    const token2 = await loginEmailOtp({ port, email: email2, profileId: profile2Id })

    // Run the same crawler type for each profile.
    const job1 = await createCrawlerJob({ port, token: token1, profileId: profile1Id, type: 'local', force: true })
    const job2 = await createCrawlerJob({ port, token: token2, profileId: profile2Id, type: 'local', force: true })

    const job1Result = await waitForJobComplete({ port, token: token1, jobId: job1.id })
    const job2Result = await waitForJobComplete({ port, token: token2, jobId: job2.id })

    const grants1a = await listGrantsForProfile({ port, token: token1, profileId: profile1Id })
    const grants2a = await listGrantsForProfile({ port, token: token2, profileId: profile2Id })
    assert.ok(grants1a.length > 0, 'expected profile 1 to receive pipeline grants')
    assert.ok(grants2a.length > 0, 'expected profile 2 to receive pipeline grants')

    assert.ok(grants1a.every((g) => g.profile_id === profile1Id), 'profile 1 list should be profile-scoped')
    assert.ok(grants2a.every((g) => g.profile_id === profile2Id), 'profile 2 list should be profile-scoped')

    // Idempotency: rerun and ensure counts do not increase.
    const job1b = await createCrawlerJob({ port, token: token1, profileId: profile1Id, type: 'local', force: true })
    await waitForJobComplete({ port, token: token1, jobId: job1b.id })

    const grants1b = await listGrantsForProfile({ port, token: token1, profileId: profile1Id })
    assert.equal(grants1b.length, grants1a.length, 'rerun should not duplicate pipeline grants for same profile')
  } finally {
    await srv.stop()
  }
})

