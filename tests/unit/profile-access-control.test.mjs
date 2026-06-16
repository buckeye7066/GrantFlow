import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-profile-access-test-'))
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

  const ready = new Promise((resolve, reject) => {
    let resolved = false

    const tryResolveReady = () => {
      if (resolved) return true
      const match = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/) || stderr.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (!match) return false
      resolved = true
      clearTimeout(timeout)
      resolve({ port: Number(match[1]) })
      return true
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk
      tryResolveReady()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk
      tryResolveReady()
    })

    tryResolveReady()

    const timeout = setTimeout(() => {
      if (tryResolveReady()) return
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    child.on('error', (err) => {
      if (resolved) return
      clearTimeout(timeout)
      reject(new Error(`server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    child.on('exit', (code) => {
      if (resolved || tryResolveReady()) return
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
    }),
  })
  assert.equal(verify.status, 200)
  assert.ok(verify.json?.accessToken)
  return verify.json.accessToken
}

test('profile access: only owner + admin can access /api/profiles/:id', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const email1 = 'user1@grantflow.local'
    const email2 = 'user2@grantflow.local'
    const adminEmail = 'buckeye7066@gmail.com'

    const user1Id = '00000000-0000-0000-0000-00000000a001'
    const user2Id = '00000000-0000-0000-0000-00000000a002'
    const adminUserId = '00000000-0000-0000-0000-00000000a003'

    const profile1Id = '00000000-0000-0000-0000-00000000b001'
    const profile2Id = '00000000-0000-0000-0000-00000000b002'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES
        ('${user1Id}', 'User One', '${email1}', 0),
        ('${user2Id}', 'User Two', '${email2}', 0),
        ('${adminUserId}', 'Admin', '${adminEmail}', 1);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES
        ('00000000-0000-0000-0000-00000000c001', '${user1Id}', 'email_otp', '${email1}', 0),
        ('00000000-0000-0000-0000-00000000c002', '${user2Id}', 'email_otp', '${email2}', 0),
        ('00000000-0000-0000-0000-00000000c003', '${adminUserId}', 'email_otp', '${adminEmail}', 0);

      INSERT INTO profiles (id, display_name, user_id, status, tags)
      VALUES
        ('${profile1Id}', 'Profile One', '${user1Id}', 'active', '[]'),
        ('${profile2Id}', 'Profile Two', '${user2Id}', 'active', '[]');
    `)
    db.close()

    const tokenUser1 = await loginEmailOtp({ port, email: email1 })
    const tokenUser2 = await loginEmailOtp({ port, email: email2 })
    const tokenAdmin = await loginEmailOtp({ port, email: adminEmail })

    const own1 = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${profile1Id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenUser1}` },
    })
    assert.equal(own1.status, 200)

    const tamper1 = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${profile2Id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenUser1}` },
    })
    assert.equal(tamper1.status, 403)

    const own2 = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${profile2Id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenUser2}` },
    })
    assert.equal(own2.status, 200)

    const tamper2 = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${profile1Id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenUser2}` },
    })
    assert.equal(tamper2.status, 403)

    const adminCanAccess1 = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${profile1Id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    })
    assert.equal(adminCanAccess1.status, 200)

    const adminCanAccess2 = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${profile2Id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    })
    assert.equal(adminCanAccess2.status, 200)
  } finally {
    await srv.stop()
  }
})

test('profile access: basic_information email grants access', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const email1 = 'user1@grantflow.local'
    const email2 = 'anastasia@grantflow.local'

    const user1Id = '00000000-0000-0000-0000-00000000d001'
    const user2Id = '00000000-0000-0000-0000-00000000d002'

    const profileByEmailId = '00000000-0000-0000-0000-00000000e001'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES
        ('${user1Id}', 'User One', '${email1}', 0),
        ('${user2Id}', 'Anastasia', '${email2}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES
        ('00000000-0000-0000-0000-00000000f001', '${user1Id}', 'email_otp', '${email1}', 0),
        ('00000000-0000-0000-0000-00000000f002', '${user2Id}', 'email_otp', '${email2}', 0);

      -- Profile is NOT owned (user_id is NULL), but the profile's saved email matches email2.
      INSERT INTO profiles (id, display_name, user_id, status, tags)
      VALUES
        ('${profileByEmailId}', 'Profile By Email', NULL, 'active', '[]');

      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES
        ('${profileByEmailId}', 'basic_information', '{"email":"${email2}"}', 'test');
    `)
    db.close()

    const tokenUser2 = await loginEmailOtp({ port, email: email2 })

    const canAccess = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${profileByEmailId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenUser2}` },
    })
    assert.equal(canAccess.status, 200)

    const listRes = await fetchJson(`http://127.0.0.1:${port}/api/profiles`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenUser2}` },
    })
    assert.equal(listRes.status, 200)
    assert.ok(Array.isArray(listRes.json))
    assert.ok(listRes.json.some((p) => p?.id === profileByEmailId))
  } finally {
    await srv.stop()
  }
})

