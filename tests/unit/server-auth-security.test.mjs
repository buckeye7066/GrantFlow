import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-test-'))
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
      // Ensure we don't leak a hung server on failure.
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    const onData = () => {
      const match = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ port: Number(match[1]), dbPath })
      }
    }

    child.stdout.on('data', onData)
    onData('')

    child.on('error', (err) => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      reject(new Error(`server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    child.on('exit', (code) => {
      // If the server exits before becoming ready, surface logs to the test output.
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

  return { child, ready, stop }
}

test('security: default bulk populate key is not accepted', async () => {
  const srv = startServer({
    // Ensure there is no configured admin/bulk key.
    ADMIN_TOKEN: '',
    ANYA_ADMIN_TOKEN: '',
    BULK_POPULATE_KEY: '',
  })

  const { port } = await srv.ready
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: {
        'X-Admin-Token': 'grantflow-bulk-2026',
      },
    })
    assert.equal(res.status, 401)
  } finally {
    await srv.stop()
  }
})

test('security: legacy profile-id bearer token requires explicit opt-in', async () => {
  // Boot WITHOUT opt-in and ensure profile-id bearer token does not authenticate.
  const srv = startServer({
    ADMIN_TOKEN: '',
    ANYA_ADMIN_TOKEN: '',
    ALLOW_LEGACY_PROFILE_TOKEN: '',
  })
  const { port, dbPath } = await srv.ready

  // Insert a profile row directly so the legacy path would have succeeded if enabled.
  let Database
  try {
    Database = (await import('better-sqlite3')).default
  } catch (importErr) {
    throw new Error(`better-sqlite3 not available in test environment â cannot seed profile row: ${importErr.message}`)
  }
  const db = new Database(dbPath)
  try {
    db.exec(`
      INSERT INTO profiles (id, display_name, status)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Test Profile', 'active');
    `)
  } finally {
    db.close()
  }

  const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
    headers: {
      Authorization: 'Bearer 00000000-0000-0000-0000-000000000001',
    },
  })
  assert.equal(res.status, 401)
  await srv.stop()
})

test('designated profiles: baseline seed creates full profile set', async () => {
  const srv = startServer({
    ADMIN_TOKEN: 'test-admin',
    ANYA_ADMIN_TOKEN: '',
    BULK_POPULATE_KEY: '',
    ALLOW_LEGACY_PROFILE_TOKEN: '',
  })

  const { port } = await srv.ready
  const res = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
    headers: {
      'X-Admin-Token': 'test-admin',
    },
  })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data))
  // The repo seed currently defines 15 baseline profiles; guard against regressions.
  assert.ok(data.length >= 15, `expected >= 15 profiles, got ${data.length}`)
  await srv.stop()
})

