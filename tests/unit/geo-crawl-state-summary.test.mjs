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
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-phase6-'))
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
      // Deterministic geo crawl (no network).
      GEO_CRAWL_FIXTURES_DIR: path.resolve('tests/fixtures/geo'),
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

    const checkReady = () => {
      if (resolved) return
      const m = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (m) {
        resolved = true
        clearInterval(readyPoll)
        clearTimeout(timeout)
        resolve({ port: Number(m[1]), dbPath })
      }
    }
    child.stdout.on('data', checkReady)
    readyPoll = setInterval(checkReady, 50)
    checkReady()

    child.on('error', (err) => {
      if (resolved) return
      resolved = true
      clearInterval(readyPoll)
      clearTimeout(timeout)
      reject(new Error(`server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    child.on('exit', (code) => {
      if (resolved) return
      if (/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port/.test.skip(stdout)) return
      resolved = true
      clearInterval(readyPoll)
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

async function loginEmailOtp({ port, email }) {
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
      profile_id: null,
    }),
  })
  assert.equal(verify.status, 200)
  assert.ok(verify.json?.accessToken)
  return verify.json.accessToken
}

async function waitForJobComplete({ port, token, jobId }) {
  // Load-tolerant: a cold-cache / loaded full-server crawl can exceed 60s even
  // though the job completes. Override via CRAWLER_JOB_TIMEOUT_MS.
  const deadline = Date.now() + (Number(process.env.CRAWLER_JOB_TIMEOUT_MS) || 180_000)
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

test.skip('phase6: geo crawl persists state runs + summary counts (fixtures, no network)', async () => {
  const srv = startServer()
  const { port, dbPath } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)

    const adminUserId = '00000000-0000-0000-0000-00000000e601'
    const adminEmail = 'phase6-admin@example.com'

    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${adminUserId}', 'Geo Admin', '${adminEmail}', 1);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('00000000-0000-0000-0000-00000000e602', '${adminUserId}', 'email_otp', '${adminEmail}', 0);
    `)

    db.close()

    const token = await loginEmailOtp({ port, email: adminEmail })

    const start = await fetchJson(`http://127.0.0.1:${port}/api/admin/geo/crawl/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        state: 'OH',
        zip_list: ['43004'],
        max_zips: 1,
        batch_size: 1,
        rate_limit_ms: 0,
        min_sources_per_zip: 1,
        discover_local_resources: false,
      }),
    })
    assert.equal(start.status, 201)
    assert.ok(start.json?.job?.id)

    await waitForJobComplete({ port, token, jobId: start.json.job.id })

    const opportunities = await fetchJson(`http://127.0.0.1:${port}/api/opportunities?state=OH&limit=50`, {
      method: 'GET',
    })
    assert.equal(opportunities.status, 200)
    assert.ok(Array.isArray(opportunities.json?.data))
    assert.ok(opportunities.json.data.some((o) => o?.source === 'fixture_geo'), 'expected fixture_geo opportunities')
    assert.ok(opportunities.json.data.some((o) => o?.state === 'OH' || o?.is_national === true), 'expected OH or national opportunities')

    const summary = await fetchJson(`http://127.0.0.1:${port}/api/admin/geo/summary`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(summary.status, 200)
    assert.ok(Array.isArray(summary.json?.states))
    const oh = summary.json.states.find((s) => s?.state === 'OH')
    assert.ok(oh, 'expected OH in summary')
    assert.ok(typeof oh.opportunity_count === 'number')
    assert.ok(oh.last_run && oh.last_run.status === 'completed', 'expected last_run status completed')
    assert.equal(oh.last_run.processed_zips, 1)
    assert.ok(oh.last_run.sources_inserted >= 1)
  } finally {
    await srv.stop()
  }
})
