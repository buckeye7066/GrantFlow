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
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 20_000)

    const onData = () => {
      const match = stdout.match(/\[Server\] Ready on port\s+(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ port: Number(match[1]), dbPath })
      }
    }

    child.stdout.on('data', onData)
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
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
    headers: {
      'X-Admin-Token': 'grantflow-bulk-2026',
    },
  })

  assert.equal(res.status, 401)
  await srv.stop()
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
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  db.exec(`
    INSERT INTO profiles (id, display_name, status)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Test Profile', 'active');
  `)
  db.close()

  const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
    headers: {
      Authorization: 'Bearer 00000000-0000-0000-0000-000000000001',
    },
  })
  assert.equal(res.status, 401)
  await srv.stop()
})

