import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

function startServer({ dbPath, extraEnv = {} } = {}) {
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '0',
      DB_PROVIDER: 'sqlite',
      SQLITE_DB_PATH: dbPath,
      DB_AUTO_MIGRATE: 'true',
      BASELINE_SEED_MODE: 'force',
      AUTH_JWT_SECRET: 'test-secret',
      ADMIN_TOKEN: 'test-admin-token',
      ALLOW_EPHEMERAL_UPLOADS: 'true',
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
    const timeout = setTimeout(() => {
      if (resolved) return
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    child.stdout.on('data', (chunk) => {
      if (resolved) return
      const match = String(stdout + chunk).match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (match) {
        resolved = true
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
      }
    })

    child.on('exit', (code) => {
      if (resolved) return
      clearTimeout(timeout)
      reject(new Error(`server exited before ready (code=${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })

  async function stop() {
    if (child.killed) return
    try { child.kill('SIGTERM') } catch {}
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { ready, stop, logs: () => ({ stdout, stderr }) }
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

test('tombstoned baseline profile does not reappear after restart + re-seed', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-tombstone-'))
  const dbPath = path.join(tmp, 'test.db')

  const profileId = 'profile-focus-forward-ministries'

  // Boot server once; baseline seed should create the profile.
  const srv1 = startServer({ dbPath })
  const { port: port1 } = await srv1.ready
  try {
    const p1 = await fetchJson(`http://127.0.0.1:${port1}/api/profiles/${profileId}`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(p1.status, 200, `expected baseline profile ${profileId} to exist before deletion`)

    const del = await fetchJson(`http://127.0.0.1:${port1}/api/admin/profiles/${profileId}/hard-delete`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ force: true, reason: 'unit-test tombstone', tombstone: true }),
    })
    assert.equal(del.status, 200)
    assert.equal(del.json.ok, true)
  } finally {
    await srv1.stop()
  }

  // Verify tombstone exists in DB file.
  const db = new Database(dbPath)
  const t = db.prepare('SELECT profile_id FROM profile_tombstones WHERE profile_id = ? LIMIT 1').get(profileId)
  assert.equal(t?.profile_id, profileId)
  db.close()

  // Boot server again with forced baseline seeding; tombstone must prevent resurrection.
  const srv2 = startServer({ dbPath })
  const { port: port2 } = await srv2.ready
  try {
    const p2 = await fetchJson(`http://127.0.0.1:${port2}/api/profiles/${profileId}`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(p2.status, 404, 'tombstoned profile should not be re-seeded')
  } finally {
    await srv2.stop()
  }
})

