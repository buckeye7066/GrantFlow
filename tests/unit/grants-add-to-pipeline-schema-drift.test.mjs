import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'

function startServer({ dbPath }) {
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '0',
      DB_PROVIDER: 'sqlite',
      SQLITE_DB_PATH: dbPath,
      DB_AUTO_MIGRATE: 'true',
      AUTH_JWT_SECRET: 'test-secret-grants-schema-drift',
      SMOKE_MODE: '1',
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

    const checkReady = (chunk = '') => {
      if (resolved) return
      stdout += chunk
      const match = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (match) {
        resolved = true
        clearInterval(readyPoll)
        clearTimeout(timeout)
        resolve({ port: Number.parseInt(match[1], 10), child })
      }
    }
    child.stdout.on('data', checkReady)
    readyPoll = setInterval(checkReady, 50)
    checkReady()
  })

  return ready
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve()
    child.on('exit', resolve)
    try {
      child.kill('SIGTERM')
    } catch {
      resolve()
    }
  })
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const text = await resp.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: resp.status, json, text }
}

test('DiscoverGrants: add-to-pipeline does not 500 when grants.profile_id is missing (self-heals)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-grants-drift-test-'))
  const dbPath = path.join(tmp, 'test.db')
  const { port, child } = await startServer({ dbPath })

  try {
    const email = 'grants-drift@example.com'

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    assert.equal(start.status, 202)
    assert.ok(start.json?.previewCode)
    assert.ok(start.json?.verification_token)

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

    const token = verify.json.accessToken

    const createProfile = await fetchJson(`http://127.0.0.1:${port}/api/profiles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ display_name: 'Schema Drift Profile', primary_type: 'individual_need' }),
    })
    assert.equal(createProfile.status, 201)
    assert.ok(createProfile.json?.id)

    const profileId = String(createProfile.json.id)

    // Simulate production schema drift by dropping `grants.profile_id` (older deployments).
    // This used to cause GET /api/grants and POST /api/grants/from-opportunity to 500 when the UI sent X-Profile-Id.
    const db = new Database(dbPath)
    try {
      db.exec('ALTER TABLE grants DROP COLUMN profile_id;')
    } catch {
      // If column didn't exist for some reason, that's fine; the route must still work.
    } finally {
      db.close()
    }

    const opportunityUrl = 'https://www.unitedway.org/find-your-united-way'

    const add = await fetchJson(`http://127.0.0.1:${port}/api/grants/from-opportunity`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Profile-Id': profileId,
      },
      body: JSON.stringify({
        profile_id: profileId,
        organization_id: null,
        match_score: 88,
        match_reasons: ['directory resource'],
        opportunity_id: null,
        opportunity_data: {
          title: 'United Way Finder',
          sponsor: 'United Way',
          url: opportunityUrl,
          deadline: 'rolling',
          source: 'local_directory_united_way',
        },
      }),
    })
    assert.ok(add.status === 200 || add.status === 201, `expected 200/201, got ${add.status} (${add.text})`)
    assert.ok(add.json?.id)
    assert.ok(add.json?.organization_id)

    const list = await fetchJson(
      `http://127.0.0.1:${port}/api/grants?organization_id=${encodeURIComponent(String(add.json.organization_id))}&url=${encodeURIComponent(opportunityUrl)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Profile-Id': profileId,
        },
      },
    )

    assert.equal(list.status, 200, `expected 200, got ${list.status} (${list.text})`)
    assert.ok(Array.isArray(list.json), 'expected array response')
    assert.ok(list.json.length >= 1, 'expected at least one grant returned for duplicate check')
  } finally {
    await stopServer(child)
  }
})
